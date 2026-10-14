// Run: node scripts/check-native-auto-hide.cjs
//
// ══ 覆盖对象 ═══════════════════════════════════════════════════════════════════
// 「全屏自动隐藏控制条」的新机制：纯 DOM + CSS，逻辑在
//   src/components/PlayerControls.jsx:72–111（attachAutoHideCtrls / detachAutoHideCtrls）
// 逐字移植自用户自有项目 hongguo-monorepo/pc/backend/static/index.html 第 2181–2216 行。
//
// 本文件断言的是**源的源码事实**，不是本仓库旧实现的行为：
//   · attach：body 加 pv-active；.ctrl-bar 与 .dl-text 加 fs-show；
//     mousemove/keydown/wheel/mousedown 四个活动事件绑在 **document** 上；
//   · 任一活动 → 重新 show()，并把隐藏计时重置为 3000ms；
//   · 3000ms 无操作 → 移除 fs-show（旧实现是 2000ms，且带暂停/菜单/拖动/焦点等一堆
//     React 守卫 —— 那些守卫随移植**整体删除**，在源里不存在，故本文件也不断言它们）；
//   · detach：摘掉四个监听、移除 pv-active 与两处 fs-show、清掉未触发的隐藏定时器。
//
// 静态调用方是 src/components/Player.jsx:828/852/861/869（全屏变化 / 进入播放器 /
// 卸载），接线回归断言在 scripts/check-player-controls.cjs 的沙箱集成段。
//
// ══ 看门狗（两层，失败绝不表现为挂住）════════════════════════════════════════
//   1) 异步挂起：真实 setTimeout 看门狗，到点直接 process.exit(1)；
//   2) 同步死锁：夹具是虚拟时钟，advance() 的推进循环有步数上限，超限抛错。
//      （单线程下真实定时器无法打断同步死循环，只能靠第 2 层兜住。）
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/components/PlayerControls.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;
const shortcutModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/shortcuts.js'), 'utf8'), { loader: 'js', format: 'cjs' }).code, { module: shortcutModule, exports: shortcutModule.exports });

/** 源里绑在 document 上的四个活动事件（PlayerControls.jsx:93–96）。 */
const ACTIVITY = ['mousemove', 'keydown', 'wheel', 'mousedown'];
/** 源的隐藏延时（PlayerControls.jsx:89）；旧实现是 2000，移植时改的就是这个值。 */
const HIDE_DELAY = 3000;
const WATCHDOG_MS = 5000;
const ADVANCE_STEP_LIMIT = 1000;

// ── 看门狗第 1 层：异步挂起 ──────────────────────────────────────────────────
// 刻意 unref 掉是不行的：若主流程挂在一个永不 settle 的 await 上，事件循环会空转退出
// （exit 0）从而被误判为通过。必须保持被引用。
const watchdog = setTimeout(() => {
  console.error(`FAIL native auto-hide: 看门狗超时 ${WATCHDOG_MS}ms —— 测试挂起了，判定为失败`);
  process.exit(1);
}, WATCHDOG_MS);

// ── 沙箱 ─────────────────────────────────────────────────────────────────────
class FakeClassList {
  constructor(...names) { this.names = new Set(names); }
  add(name) { this.names.add(name); }
  remove(name) { this.names.delete(name); }
  contains(name) { return this.names.has(name); }
  toString() { return [...this.names].join(' '); }
}

/** 一个带监听登记的假事件目标（同一函数重复注册只记一次，与 DOM 语义一致）。 */
const makeTarget = () => {
  const listeners = new Map();
  return {
    addEventListener: (name, fn) => listeners.set(name, new Set([...(listeners.get(name) || []), fn])),
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
    count: name => listeners.get(name)?.size || 0,
    total: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    names: () => [...listeners].filter(([, set]) => set.size).map(([name]) => name).sort(),
    emit: (name, event = {}) => { for (const fn of [...(listeners.get(name) || [])]) fn(event); },
  };
};

const elements = new Map([
  ['.ctrl-bar', { classList: new FakeClassList() }],
  ['.dl-text', { classList: new FakeClassList() }],
]);
const document = {
  ...makeTarget(),
  body: { classList: new FakeClassList() },
  // 与源一致：只按选择器取，取不到返回 null（.dl-text 只在下载/缓冲条可见时才渲染）
  querySelector: selector => elements.get(selector) || null,
};
const window = makeTarget();

// 可控虚拟时钟。setTimeout/clearTimeout 通过 vm context 注入，模块内取到的就是它们。
let now = 0, nextTimerId = 0;
const timers = new Map();
const clearedIds = [];
const setTimer = (fn, delay) => { const id = ++nextTimerId; timers.set(id, { fn, at: now + delay }); return id; };
const clearTimer = id => { clearedIds.push(id); timers.delete(id); };
const pendingTimers = () => [...timers.entries()].map(([id, timer]) => ({ id, at: timer.at, delay: timer.at - now }));
const advance = milliseconds => {
  const until = now + milliseconds;
  for (let steps = 0; ; steps++) {
    // 看门狗第 2 层：定时器若不断自我续期，这个循环会永远转下去。
    if (steps > ADVANCE_STEP_LIMIT) throw new Error(`看门狗：虚拟时钟 ${ADVANCE_STEP_LIMIT} 步内未收敛，判定为逻辑死锁`);
    const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    now = due[1].at;
    timers.delete(due[0]);
    due[1].fn();
  }
  now = until;
};

const context = {
  module: { exports: {} },
  require: name => (name === '../shortcuts' ? shortcutModule.exports : {}),
  document, window, setTimeout: setTimer, clearTimeout: clearTimer, console,
};
context.exports = context.module.exports;
vm.runInNewContext(source, context);

const { attachAutoHideCtrls: attach, detachAutoHideCtrls: detach, holdAutoHideCtrls: hold, releaseAutoHideCtrls: release } = context.module.exports;
const bar = elements.get('.ctrl-bar').classList;
const dlText = elements.get('.dl-text').classList;
const body = document.body.classList;

try {
  assert.equal(typeof attach, 'function', 'PlayerControls 必须导出 attachAutoHideCtrls（Player.jsx 依赖它）');
  assert.equal(typeof detach, 'function', 'PlayerControls 必须导出 detachAutoHideCtrls（Player.jsx 依赖它）');
  assert.equal(typeof hold, 'function', '控制条内的面板打开时要能压住自动隐藏（holdAutoHideCtrls）');
  assert.equal(typeof release, 'function', '面板关闭时要能释放压住（releaseAutoHideCtrls）');

  // ── 1. attach 契约：body.pv-active + 两处 .fs-show + 四个 document 监听 ──────
  // 未 attach 就 detach（Player.jsx 卸载时无条件调用）不得抛错。
  assert.doesNotThrow(() => detach(), '未 attach 时 detach 不得抛错');
  assert.equal(document.total(), 0);

  attach();
  assert.ok(body.contains('pv-active'), 'attach 必须给 document.body 加 pv-active');
  assert.ok(bar.contains('fs-show'), 'attach 必须立刻给 .ctrl-bar 加 fs-show（刚进全屏不能是隐藏态）');
  assert.ok(dlText.contains('fs-show'), 'attach 必须立刻给 .dl-text 加 fs-show');
  assert.deepEqual(document.names(), ACTIVITY.slice().sort(), '四个活动事件必须绑在 document 上（源用 document，不是 stage/window）');
  assert.equal(document.count('mousemove'), 1);
  assert.equal(document.count('keydown'), 1);
  assert.equal(document.count('wheel'), 1);
  assert.equal(document.count('mousedown'), 1);
  assert.equal(document.total(), ACTIVITY.length, '除这四个活动事件外不得多绑任何 document 监听');
  assert.equal(window.total(), 0, '不得把活动事件绑到 window 上（旧实现绑 window/stage，已随移植删除）');
  assert.equal(timers.size, 1, 'attach 后应恰好有一个待触发的隐藏定时器');
  assert.equal(pendingTimers()[0].delay, HIDE_DELAY, `attach 必须按 ${HIDE_DELAY}ms 起隐藏计时（旧实现是 2000ms）`);

  // ── 2. 四种活动各自都能重新显示，且随后仍按时隐藏 ────────────────────────────
  advance(HIDE_DELAY);
  assert.ok(!bar.contains('fs-show') && !dlText.contains('fs-show'), `${HIDE_DELAY}ms 无操作必须移除 .ctrl-bar 与 .dl-text 的 fs-show`);
  for (const name of ACTIVITY) {
    document.emit(name);
    assert.ok(bar.contains('fs-show') && dlText.contains('fs-show'), `${name} 必须重新显示控制条`);
    advance(HIDE_DELAY);
    assert.ok(!bar.contains('fs-show'), `${name} 之后 ${HIDE_DELAY}ms 无操作必须再次隐藏`);
  }

  // ── 3. 3 秒边界 + 中间活动重置计时 ──────────────────────────────────────────
  document.emit('mousemove');
  advance(HIDE_DELAY - 1);
  assert.ok(bar.contains('fs-show'), `距上次活动 ${HIDE_DELAY - 1}ms 时仍应可见（延时必须是 ${HIDE_DELAY}ms）`);
  advance(1);
  assert.ok(!bar.contains('fs-show'), `正好 ${HIDE_DELAY}ms 时才隐藏`);
  // 累计 5 秒，但距最后一次活动只有 2.5 秒：没有重置就会在这里被误隐藏。
  document.emit('mousemove');
  advance(2500);
  assert.ok(bar.contains('fs-show'), '距上次活动 2.5 秒仍应可见');
  document.emit('wheel');
  advance(2500);
  assert.ok(bar.contains('fs-show'), '中途活动必须重置计时：累计 5 秒但距最后一次活动仅 2.5 秒，不得隐藏');
  advance(600);
  assert.ok(!bar.contains('fs-show'), `距最后一次活动超过 ${HIDE_DELAY}ms 后才隐藏`);

  // ── 4. 重复 attach 不得叠加（源在 attach 开头先 detach）─────────────────────
  // 真实调用方会连续触发多次：toggleFullscreen（Player.jsx:828）、主进程广播
  // （:852）、[active, nativeFullscreen] 副作用（:869）。
  document.emit('mousemove');
  attach();
  assert.equal(document.total(), ACTIVITY.length, '重复 attach 不得叠加监听');
  assert.equal(document.count('mousemove'), 1);
  assert.equal(timers.size, 1, '重复 attach 后仍只应有一个待触发的隐藏定时器');
  document.emit('mousemove');
  assert.equal(timers.size, 1, '重复 attach 后一次活动仍只应重排一个定时器');
  assert.ok(bar.contains('fs-show'));

  // ── 5. detach：摘监听、清类、不留悬挂定时器 ─────────────────────────────────
  const pendingBefore = pendingTimers();
  assert.equal(pendingBefore.length, 1, 'detach 前应有一个未触发的隐藏定时器');
  const clearedBefore = clearedIds.length;
  detach();
  assert.equal(document.total(), 0, 'detach 必须移除全部 document 监听');
  assert.deepEqual(document.names(), []);
  assert.ok(!body.contains('pv-active'), 'detach 必须移除 body 的 pv-active');
  assert.ok(!bar.contains('fs-show'), 'detach 必须移除 .ctrl-bar 的 fs-show');
  assert.ok(!dlText.contains('fs-show'), 'detach 必须移除 .dl-text 的 fs-show');
  assert.equal(timers.size, 0, 'detach 不得留下悬挂定时器');
  assert.ok(clearedIds.slice(clearedBefore).includes(pendingBefore[0].id), 'detach 必须真的 clearTimeout 掉那个待触发的定时器 id');
  // 只把类名清掉不够：若监听还在，事件会立刻把 fs-show 加回来。
  for (const name of ACTIVITY) document.emit(name);
  assert.ok(!bar.contains('fs-show') && !dlText.contains('fs-show'), 'detach 之后活动事件不得再显示控制条');
  assert.equal(timers.size, 0, 'detach 之后活动事件不得再起定时器');
  // 也不得存在"迟到的副作用"：推进虚拟时钟不应再改变任何类名。
  advance(10000);
  assert.equal(timers.size, 0);
  assert.ok(!bar.contains('fs-show') && !dlText.contains('fs-show') && !body.contains('pv-active'), 'detach 之后推进时间不得再改变类名');
  assert.doesNotThrow(() => detach(), '重复 detach 不得抛错');
  assert.equal(document.total(), 0);

  // ── 6. 面板打开期间"压住"自动隐藏（hold / release）──────────────────────────
  // 这不是源的行为，是本仓库**必要的新增例外**：控制条里嵌着弹出面板
  // （更多播放选项 / 弹幕设置 / 画质列表），它们都是 .ctrl-bar 的 DOM 后代，
  // 而 NativePlayer.css:91–93 的 opacity / pointer-events 作用在 .ctrl-bar 上，
  // 所以 3 秒一到，打开着的面板会跟着整条控制条一起既看不见又点不动。
  attach();
  assert.equal(timers.size, 1);
  hold();
  assert.ok(bar.contains('fs-show') && dlText.contains('fs-show'), 'hold 必须先把控制条显示出来');
  assert.equal(timers.size, 0, 'hold 必须撤掉待触发的隐藏定时器');
  advance(10 * HIDE_DELAY);
  assert.ok(bar.contains('fs-show') && dlText.contains('fs-show'), 'hold 期间无论多久都不得隐藏');
  document.emit('mousemove');
  assert.equal(timers.size, 0, 'hold 期间的活动事件不得重新排隐藏定时器');
  assert.ok(bar.contains('fs-show'));
  // 计数可嵌套：多处同时打开面板时，必须逐个 release 才解除
  hold();
  release();
  advance(10 * HIDE_DELAY);
  assert.ok(bar.contains('fs-show'), '嵌套 hold 必须逐个 release 才解除（只 release 一次仍应保持显示）');
  assert.equal(timers.size, 0);
  release();
  assert.equal(timers.size, 1, '全部 release 后必须重新开始 3 秒计时');
  advance(HIDE_DELAY - 1);
  assert.ok(bar.contains('fs-show'), `release 后 ${HIDE_DELAY - 1}ms 仍应可见`);
  advance(1);
  assert.ok(!bar.contains('fs-show') && !dlText.contains('fs-show'), `release 后无操作，${HIDE_DELAY}ms 才隐藏`);
  // detach 必须把持有计数归零：否则退出全屏后计数残留，下次进入全屏控制条再也不自动隐藏
  attach(); hold();
  advance(5 * HIDE_DELAY);
  assert.ok(bar.contains('fs-show'));
  detach();
  assert.ok(!bar.contains('fs-show'), 'detach 即使处于 hold 中也必须清掉 fs-show');
  attach();
  assert.equal(timers.size, 1, '重新 attach 后必须恢复计时');
  advance(HIDE_DELAY);
  assert.ok(!bar.contains('fs-show'), 'detach 必须归零持有计数：重新进入全屏后 3 秒规则必须照常生效');
  detach();

  // 回归：面板打开期间若发生一次全屏状态变化（Alt+Enter / F11 / 主进程 window-fullscreen-changed
  // 广播都会触发 attach），那次 hold **不得被丢掉**。
  // attach 原先以 detach 开头，而 detach 会把持有计数归零 → 计数被清、面板还开着却跟着控制条一起
  // 隐藏。修法是把清场拆成内部 teardown（不清计数），attach 只调 teardown。
  attach(); hold(); attach();
  advance(5 * HIDE_DELAY);
  assert.ok(bar.contains('fs-show'), '全屏状态变化后被重新 attach，也不能丢掉未释放的 hold');
  assert.equal(timers.size, 0, '被 hold 期间不得因为重新 attach 而排出隐藏定时器');
  release();
  advance(HIDE_DELAY);
  assert.ok(!bar.contains('fs-show'), '释放后仍应恢复 3 秒隐藏规则');
  detach();
  // 未 attach / 计数为 0 时调用都不得抛错（Player.jsx 的调用时机不受面板状态约束）
  assert.doesNotThrow(() => { release(); release(); }, '计数为 0 时 release 不得抛错');
  assert.doesNotThrow(() => { hold(); release(); }, '未 attach 时 hold/release 不得抛错');
  assert.equal(timers.size, 0, '未 attach 时 hold/release 不得留下定时器');

  // ── 7. .dl-text 缺席不得影响 .ctrl-bar ──────────────────────────────────────
  // 真实 DOM 里 .dl-text 只在下载/缓冲条可见时渲染（NativePlayerOverlay.jsx:158–161），
  // 而 attachAutoHideCtrls 只拿到一个可能为 null 的查询结果。
  elements.delete('.dl-text');
  assert.doesNotThrow(() => attach(), '.dl-text 不存在时 attach 不得抛错');
  assert.ok(bar.contains('fs-show'), '.dl-text 缺席时 .ctrl-bar 仍须被显示');
  advance(HIDE_DELAY);
  assert.ok(!bar.contains('fs-show'), `.dl-text 缺席时 .ctrl-bar 仍须按 ${HIDE_DELAY}ms 隐藏`);
  assert.doesNotThrow(() => detach(), '.dl-text 不存在时 detach 不得抛错');
  assert.ok(!body.contains('pv-active'));

  clearTimeout(watchdog);
  console.log('PASS native auto-hide: attach adds pv-active + fs-show on .ctrl-bar/.dl-text with the four activity listeners bound on document; each of mousemove/keydown/wheel/mousedown re-shows; 3000ms idle removes fs-show at the exact boundary and any activity resets the timer; repeated attach does not stack listeners or timers; detach removes every listener, both classes and the pending timer (no late side effects) and zeroes the hold counter; hold/release keep panels open indefinitely, nest correctly and re-arm the timer on the final release; a missing .dl-text is tolerated');
} catch (error) {
  clearTimeout(watchdog);
  console.error(error);
  process.exitCode = 1;
}
