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
function harness({ fullscreen = true, sameDisplay = true, displayApi = true } = {}) {
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
  const screen = { getCursorScreenPoint: () => cursor };
  if (displayApi) {
    // 模拟 Electron 的 screen 模块：光标与窗口是否落在同一块显示器
    screen.getDisplayNearestPoint = () => ({ id: sameDisplay ? 7 : 9 });
    screen.getDisplayMatching = () => ({ id: 7 });
  }
  const controller = createFullscreenPointerController({ screen, getWindow: () => win, intervalMs: 10 });
  const tick = () => [...timers].forEach(t => t.fn());
  const restore = () => { global.setInterval = realSetInterval; global.clearInterval = realClearInterval; };
  return { controller, sent, tick, restore, timers, screen, setCursor: p => { cursor = p; }, setFullscreen: v => { fullscreen = v; } };
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

test('同一屏内（即使在窗口 bounds 之外）也上报——这是刻意的宽判', () => {
  // 判定优先看"是否同一块显示器"，而不是死抠窗口矩形。原因：混合 DPI + 负坐标显示器下
  // getCursorScreenPoint 与 getBounds 的换算最容易出偏差，一旦把"在窗口内"算错，
  // 用户就会遇到"鼠标明明在播放器上却唤不出控制条"。放宽到"同一屏"，最坏情况只是
  // 鼠标移到同屏别处时控制条也出现（无害），却避免了整类误判。
  const h = harness();
  try {
    h.controller.setEnabled(true);
    h.setCursor({ x: 1000, y: 400 }); // 在 bounds 之外，但仍是同一块显示器
    h.tick();
    assert.deepEqual(h.sent, ['fullscreen-pointer-move'], '同屏移动应上报');

    h.controller.setEnabled(false);
    h.controller.setEnabled(true);
    h.setCursor({ x: -1080, y: 481 }); // 左上角边界
    h.tick();
    assert.deepEqual(h.sent, ['fullscreen-pointer-move', 'fullscreen-pointer-move']);
  } finally { h.restore(); }
});

test('不判断全屏状态：竖屏 windowFill（isFullScreen 为 false）也必须上报', () => {
  // 这条钉住一个真实踩过的坑：竖屏布局下播放器"全屏"走的是前端 setWindowFill（CSS 模式），
  // 窗口并非 Electron 原生全屏，isFullScreen() 为 false。曾经用全屏状态当门槛，
  // 结果这条路径下一次都不上报，症状与"完全没修"一模一样。
  const h = harness({ fullscreen: false });
  try {
    h.controller.setEnabled(true);
    h.setCursor({ x: -540, y: 1440 });
    h.tick();
    assert.deepEqual(h.sent, ['fullscreen-pointer-move'], '非原生全屏（竖屏铺满）同样要上报');
  } finally { h.restore(); }
});

test('光标在另一块显示器上时不上报', () => {
  const h = harness({ sameDisplay: false });
  try {
    h.controller.setEnabled(true);
    h.setCursor({ x: 1000, y: 400 }); // 判为落在别的屏幕上
    h.tick();
    assert.deepEqual(h.sent, [], '用户在别的屏上操作时不应唤出本播放器的控制条');
  } finally { h.restore(); }
});

test('screen 缺少显示器 API 时退回 bounds 比较', () => {
  const h = harness({ displayApi: false });
  try {
    h.controller.setEnabled(true);
    h.setCursor({ x: -540, y: 1440 }); // 在 bounds 内
    h.tick();
    assert.deepEqual(h.sent, ['fullscreen-pointer-move'], '无显示器 API 时应能用 bounds 判断');

    h.controller.setEnabled(false);
    h.controller.setEnabled(true);
    h.setCursor({ x: 5000, y: 5000 }); // 远在 bounds 外
    h.tick();
    assert.equal(h.sent.length, 1, 'bounds 之外不应上报');
  } finally { h.restore(); }
});

test('screen 抛错时安全跳过，不产生未捕获异常', () => {
  // app 尚未 ready 时调用 screen API 会抛错；轮询是常驻定时器，绝不能因此把异常抛到顶层。
  const h = harness();
  try {
    h.controller.setEnabled(true);
    h.screen.getCursorScreenPoint = () => { throw new Error('screen not ready'); };
    assert.doesNotThrow(() => h.tick(), '一次抛错不得冒泡出去');
    assert.deepEqual(h.sent, [], '取不到光标位置时不应上报');

    // 恢复正常后应继续工作，说明不是一次性失效
    h.screen.getCursorScreenPoint = () => ({ x: -540, y: 1440 });
    h.tick();
    assert.deepEqual(h.sent, ['fullscreen-pointer-move'], '恢复后应继续上报');
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
