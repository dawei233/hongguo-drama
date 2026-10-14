'use strict';

/**
 * 全屏指针轮询的单元测试。
 *
 * 这个模块的存在理由见其头部注释：页面失焦时 Blink 会抑制 hover/指针语义，导致渲染层
 * 收不到 pointermove，因此改用主进程轮询 screen.getCursorScreenPoint()。这里用假的
 * screen / window 验证它的判定逻辑与资源管理，不需要真实显示器。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFullscreenPointerController } = require('./fullscreen-pointer.js');

/** 造一个可控的假环境：手动推进定时器、手动设置光标与窗口。 */
function harness({ fullscreen = true } = {}) {
  const sent = [];
  let cursor = { x: 0, y: 0 };
  const bounds = { x: -1080, y: 481, width: 1080, height: 1920 };
  const win = {
    isDestroyed: () => false,
    isFullScreen: () => fullscreen,
    getBounds: () => bounds,
    webContents: { send: channel => sent.push(channel) },
  };
  const timers = new Set();
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  // 用可手动触发的假定时器替换，避免测试依赖真实时间
  global.setInterval = fn => { const t = { fn, unref() {} }; timers.add(t); return t; };
  global.clearInterval = t => timers.delete(t);
  const controller = createFullscreenPointerController({ screen: { getCursorScreenPoint: () => cursor }, getWindow: () => win, intervalMs: 10 });
  const tick = () => [...timers].forEach(t => t.fn());
  const restore = () => { global.setInterval = realSetInterval; global.clearInterval = realClearInterval; };
  return { controller, sent, tick, restore, timers, setCursor: p => { cursor = p; }, setFullscreen: v => { fullscreen = v; } };
}

test('未启用时不轮询：不注册定时器，也不发消息', () => {
  const h = harness();
  try {
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.sent, []);
  } finally { h.restore(); }
});

test('启用后指针在窗口内移动会通知渲染层', () => {
  const h = harness();
  try {
    h.controller.setEnabled(true);
    assert.equal(h.timers.size, 1, '启用后应有且只有一个定时器');

    h.setCursor({ x: -540, y: 1440 }); // 窗口范围内
    h.tick();
    assert.deepEqual(h.sent, ['fullscreen-pointer-move'], '窗口内移动应上报一次');

    // 指针没动就不该重复上报（避免每 120ms 无谓地唤醒渲染层）
    h.tick();
    assert.equal(h.sent.length, 1, '指针未移动时不应重复上报');

    h.setCursor({ x: -500, y: 1400 });
    h.tick();
    assert.equal(h.sent.length, 2, '再次移动应再上报');
  } finally { h.restore(); }
});

test('指针在窗口外时不上报', () => {
  const h = harness();
  try {
    h.controller.setEnabled(true);
    // 副屏窗口在负坐标区；主屏上的点必须被判为"不在窗口内"
    h.setCursor({ x: 1000, y: 400 });
    h.tick();
    assert.deepEqual(h.sent, [], '窗口外的移动不应上报');

    h.setCursor({ x: -1080, y: 481 }); // 左上角边界，属于窗口内
    h.tick();
    assert.deepEqual(h.sent, ['fullscreen-pointer-move'], '左上角边界点应在窗口内');
  } finally { h.restore(); }
});

test('非全屏时不轮询：这是本模块的省电前提', () => {
  const h = harness({ fullscreen: false });
  try {
    h.controller.setEnabled(true);
    h.setCursor({ x: -540, y: 1440 });
    h.tick();
    assert.deepEqual(h.sent, [], '非全屏下不应上报（此场景 DOM 指针事件本来就正常）');
  } finally { h.restore(); }
});

test('停用与 dispose 都会清掉定时器，且销毁后不再上报', () => {
  const h = harness();
  try {
    h.controller.setEnabled(true);
    assert.equal(h.timers.size, 1);
    h.controller.setEnabled(false);
    assert.equal(h.timers.size, 0, '停用应清理定时器');
    h.setCursor({ x: -540, y: 1440 });
    h.tick();
    assert.deepEqual(h.sent, [], '停用后不应再上报');

    h.controller.setEnabled(true);
    h.controller.dispose();
    assert.equal(h.timers.size, 0, 'dispose 应清理定时器');
    assert.equal(h.controller.enabled, false);
  } finally { h.restore(); }
});

test('窗口已销毁时安全跳过，不抛异常', () => {
  const sent = [];
  let destroyed = false;
  const win = { isDestroyed: () => destroyed, isFullScreen: () => true, getBounds: () => ({ x: 0, y: 0, width: 10, height: 10 }), webContents: { send: c => sent.push(c) } };
  const timers = new Set();
  const realSetInterval = global.setInterval, realClearInterval = global.clearInterval;
  global.setInterval = fn => { const t = { fn, unref() {} }; timers.add(t); return t; };
  global.clearInterval = t => timers.delete(t);
  try {
    const controller = createFullscreenPointerController({ screen: { getCursorScreenPoint: () => ({ x: 5, y: 5 }) }, getWindow: () => win });
    controller.setEnabled(true);
    destroyed = true;
    assert.doesNotThrow(() => [...timers].forEach(t => t.fn()));
    assert.deepEqual(sent, [], '窗口销毁后不应上报');
    controller.dispose();
  } finally { global.setInterval = realSetInterval; global.clearInterval = realClearInterval; }
});
