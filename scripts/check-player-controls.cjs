const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const videoEnhancementStub = {
  __esModule: true, default: () => null, VideoEnhancementControls: () => null,
  useVideoEnhancement: () => ({ mode: 'original', strength: 50, update() {}, status: {}, setStatus() {} }),
};
const shortcutModule = { exports: {} };
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/shortcuts.js'), 'utf8'), { loader: 'js', format: 'cjs' }).code, { module: shortcutModule, exports: shortcutModule.exports });
const source = transformSync(fs.readFileSync(path.join(__dirname, '../src/components/PlayerControls.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code;

(async () => {
  const slots = [], effects = [], cleanups = [], listeners = new Map(), documentListeners = new Map(), stageListeners = new Map(), windowListeners = new Map(), timers = new Map();
  let nextTimer = 0, now = 0;
  const advance = (milliseconds = 2000) => {
    const until = now + milliseconds;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at; timers.delete(next[0]); next[1].fn();
    }
    now = until;
  };
  let needsRender = false;
  let cursor = 0, tree, plays = 0, pauses = 0, fullscreenCalls = 0, selectedRate;
  // 原生窗口全屏的退出请求（PlayerControls.jsx:158–167 的 Esc 通道）
  const windowFullscreen = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(slots[i], next)) needsRender = true; slots[i] = next; }]; },
    useRef: value => { const i = cursor++; return slots[i] ||= { current: value }; },
    useMemo: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, j) => v !== slots[i].deps[j])) slots[i] = { deps, value: fn() }; return slots[i].value; },
    useEffect: (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, j) => v !== slots[i][j])) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const media = { paused: true, ended: false, currentTime: 12, duration: 100, muted: false, volume: 0.7,
    play: async () => { plays++; media.paused = false; listeners.get('play')?.(); },
    pause: () => { pauses++; media.paused = true; listeners.get('pause')?.(); },
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) };
  // 控制条显隐的 DOM 面：真实浏览器里始终存在，夹具补上才能观察 attach/detach 的效果
  // （PlayerControls.jsx 的 attach/detach 用 document.body / document.querySelector）。
  const classList = () => ({ names: new Set(),
    add(name) { this.names.add(name); }, remove(name) { this.names.delete(name); }, contains(name) { return this.names.has(name); } });
  const controlBar = { classList: classList() };
  const dlText = { classList: classList() };
  const document = { fullscreenElement: null, body: { classList: classList() },
    querySelector: selector => (selector === '.ctrl-bar' ? controlBar : selector === '.dl-text' ? dlText : null),
    addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: name => documentListeners.delete(name), exitFullscreen: async () => { document.fullscreenElement = null; documentListeners.get('fullscreenchange')?.(); } };
  const stage = { addEventListener: (name, fn) => stageListeners.set(name, fn), removeEventListener: name => stageListeners.delete(name), getBoundingClientRect: () => ({ top: 0, left: 0 }), requestFullscreen: async () => { fullscreenCalls++; document.fullscreenElement = stage; documentListeners.get('fullscreenchange')?.(); } };
  const props = { videoRef: { current: media }, stageRef: { current: stage }, source: 'one', available: true, rate: 1, onRateChange: rate => { selectedRate = rate; } };
  // 竖屏也走同一条原生全屏路径（旧实现里另有 windowFill 分支，已随移植删除）
  props.onToggleFullscreen = async () => {
    if (document.fullscreenElement === stage) await document.exitFullscreen();
    else await stage.requestFullscreen();
  };
  // 音量持久化会读写 localStorage，夹具需要最小实现（真实浏览器里始终存在）
  const storage = new Map();
  const localStorage = { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) };
  const context = { module: { exports: {} }, document, ResizeObserver: class { observe() {} disconnect() {} }, window: { localStorage, addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: name => windowListeners.delete(name), electronAPI: { setWindowFullscreen: value => { windowFullscreen.push(value); return Promise.resolve({ success: true }); } } }, setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, at: now + delay }); return nextTimer; }, clearTimeout: id => timers.delete(id), require: name => name === 'react' ? react : name === '../shortcuts' ? shortcutModule.exports : name === './VideoEnhancement' ? videoEnhancementStub : {} };
  context.exports = context.module.exports; vm.runInNewContext(source, context);
  const nodes = () => { const out = []; const visit = node => { if (!node || typeof node !== 'object') return; out.push(node); node.children?.forEach(visit); }; visit(tree); return out; };
  const find = label => nodes().find(node => node.props['aria-label'] === label);
  const contains = (node, target) => node === target || !!node?.children?.some(child => contains(child, target));
  const render = () => { do { needsRender = false; cursor = 0; tree = context.module.exports.default(props); for (const node of nodes()) if (node.props.ref) node.props.ref.current = { contains: target => contains(node, target), focus() {}, querySelector: () => null, getBoundingClientRect: () => ({ top: 0, left: 0 }) }; effects.splice(0).forEach(fn => fn()); } while (needsRender); };
  render(); render();
  props.shortcuts = { ...shortcutModule.exports.DEFAULT_SHORTCUTS, play: 'shift+j', fullscreen: 'g' }; render();
  assert.equal(find('播放').props.title, '播放/暂停（Shift + J）');
  assert.equal(find('全屏').props.title, '全屏（G）');
  props.shortcuts = shortcutModule.exports.DEFAULT_SHORTCUTS; render();
  // 进度条刻度：随播放器移植改为源的 0–1000 归一化模型（源 #seek 是 max="1000"）。
  // 这里不仅改断言值，还补上"拖动后 currentTime 必须正确"的往返验证 —— 刻度换模型后
  // 最容易坏的就是换算，只断言 max/value 抓不到。
  assert.equal(Number(find('播放进度').props.max), 1000, '刻度改为 0–1000');
  assert.equal(find('播放进度').props.value, 120, 'currentTime=12 / duration=100 应归一化为 120');
  await find('播放').props.onClick(); render(); assert.equal(plays, 1); assert.ok(find('暂停'));
  find('暂停').props.onClick(); render(); assert.equal(pauses, 1);
  find('播放进度').props.onChange({ target: { value: '375' } });
  assert.equal(media.currentTime, 37.5, '拖动到 375/1000 应换算成 37.5 秒');
  find('静音').props.onClick(); listeners.get('volumechange')?.(); render(); assert.equal(media.muted, true); assert.ok(find('取消静音'));
  find('音量').props.onChange({ target: { value: '0.4' } }); assert.equal(media.volume, 0.4); assert.equal(media.muted, false);
  // 音量持久化（用户反馈"重进立马最大声音"）：改动应写入 localStorage，且换集后重新套用。
  {
    // 真实浏览器里赋值 video.volume 会自动派发 volumechange；夹具是普通对象，需显式触发
    listeners.get('volumechange')?.(); render();
    const saved = JSON.parse(storage.get('hongguo:player-volume:v1'));
    assert.equal(saved.v, 0.4, '拖动音量后应持久化新值');
    assert.equal(saved.muted, false, '应同时持久化静音状态');
    // 模拟新一集加载：媒体把音量重置为默认 1.0，然后触发 loadedmetadata
    media.currentSrc = 'episode-2.mp4'; media.volume = 1; media.muted = false;
    listeners.get('loadedmetadata')?.(); render();
    assert.equal(media.volume, 0.4, '换集后必须重新套用已保存音量（否则又变最大声）');
    // 同一媒体内的后续同步不得把用户的调整复原
    media.volume = 0.9; listeners.get('volumechange')?.(); render();
    assert.equal(media.volume, 0.9, '同一媒体内用户的音量调整必须保持');
    assert.equal(JSON.parse(storage.get('hongguo:player-volume:v1')).v, 0.9, '调整后的值应被持久化');
  }
  assert.equal(find('播放速度'), undefined, 'speed belongs in the lower-right menu');
  assert.ok(find('增加播放速度'), 'speed number must be an independent button');
  find('增加播放速度').props.onClick(); render(); assert.equal(selectedRate, 1.25); assert.equal(find('播放速度'), undefined);
  props.rate = 3.75; render(); find('增加播放速度').props.onClick(); assert.equal(selectedRate, 4);
  props.rate = 4; render(); find('增加播放速度').props.onClick(); assert.equal(selectedRate, 1);
  find('更多播放选项').props.onClick(); render(); assert.ok(find('播放速度'));
  assert.deepEqual(find('播放速度').children.map(node => node.props.value), Array.from({ length: 16 }, (_, i) => (i + 1) / 4));
  find('播放速度').props.onChange({ target: { value: '4' } }); assert.equal(selectedRate, 4);
  documentListeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); render(); assert.equal(find('播放速度'), undefined);
  find('更多播放选项').props.onClick(); render(); documentListeners.get('pointerdown')({ target: {} }); render(); assert.equal(find('播放速度'), undefined);
  await find('全屏').props.onClick(); render(); assert.equal(fullscreenCalls, 1); assert.ok(find('退出全屏'));
  // ── 自动隐藏控制条（新机制）────────────────────────────────────────────────
  // 移植前本节有 55 处 `hidden()` 断言，读的是 React 状态 `controlsHidden` →
  // 控制条根元素上的 `.controls-hidden` → `opacity:0`（见 git HEAD 版本）。
  // 移植后显隐是纯 DOM + CSS：`attachAutoHideCtrls()` 给 `.ctrl-bar` / `.dl-text` 加
  // `.fs-show`、3 秒无操作移除（PlayerControls.jsx:99–115），由 Player.jsx 在全屏
  // 变化时调用（Player.jsx:828/852/861/869）。**组件自身不再持有显隐状态**，所以
  // 原先那些"React 状态机"断言（暂停/菜单/拖动/焦点/快捷键白名单/静止指针/换源/
  // 竖屏守卫）没有等价物，已删除 —— 逐条清单见报告。
  // 机制本身（监听绑定、幂等、悬挂定时器、hold 计数）在
  // scripts/check-native-auto-hide.cjs 里断言；下面只断言本文件能观察到的部分：
  // 把机制显式挂上之后，用户在控制条上看到的效果。
  const { attachAutoHideCtrls, detachAutoHideCtrls } = context.module.exports;
  const barShown = () => controlBar.classList.contains('fs-show');
  const dlShown = () => dlText.classList.contains('fs-show');
  const keyTarget = { closest: () => null };
  await find('退出全屏').props.onClick(); render(); render();
  assert.equal(document.fullscreenElement, null, '再点一次必须退出全屏');
  assert.ok(find('全屏'), '退出全屏后按钮回到「全屏」');
  // 等价旧断言「playing in landscape fullscreen must hide idle controls」：
  // 全屏挂上机制后，3 秒无操作即隐藏（旧实现是 2000ms 的 React 定时器）。
  attachAutoHideCtrls();
  assert.ok(barShown() && dlShown(), '进入全屏（attach）后控制条与下载进度条必须显示');
  advance(3000);
  assert.ok(!barShown() && !dlShown(), '全屏下 3 秒无操作必须隐藏控制条与进度条');
  // 等价旧断言「real pointer movement / clicking the video reveals controls」：
  // 任一活动事件重新显示。keydown 的绑定在 check-native-auto-hide.cjs 里断言 ——
  // 本夹具的 document 监听表是"一个事件名一个处理函数"，菜单打开时会覆盖 keydown，
  // 用它断言会读到菜单的 Esc 处理器而不是 autohide 的 show()。
  documentListeners.get('mousemove')({});
  assert.ok(barShown() && dlShown(), '鼠标移动必须重新显示控制条');
  advance(3000); assert.ok(!barShown());
  documentListeners.get('wheel')({});
  assert.ok(barShown(), '滚轮活动必须重新显示控制条');
  advance(3000); assert.ok(!barShown());
  documentListeners.get('mousedown')({});
  assert.ok(barShown(), '按住鼠标必须重新显示控制条');
  // 等价旧断言「open menu prevents hiding」：控制条内的弹出面板打开期间不得隐藏
  // （移植后新增的例外，源实现没有；理由是面板是 .ctrl-bar 的后代，整条隐藏会让
  // 面板既看不见又点不动 —— 见报告「疑似产品缺陷」一节）。
  assert.ok(find('更多播放选项'), '控制条必须有「更多播放选项」面板入口');
  find('更多播放选项').props.onClick(); render();
  assert.ok(barShown(), '打开面板必须立刻显示控制条');
  advance(10000);
  assert.ok(barShown(), '「更多播放选项」打开期间无论多久都不得隐藏');
  assert.ok(find('播放速度'), '面板内容在打开期间必须仍然存在');
  find('更多播放选项').props.onClick(); render();
  advance(2999); assert.ok(barShown(), '关闭面板后重新开始 3 秒计时');
  advance(1); assert.ok(!barShown(), '关闭面板后 3 秒无操作必须隐藏');
  // 弹幕设置面板走同一个 panelOpen 判据（menuOpen || danmakuOpen || qualityOpen）
  props.danmaku = { enabled: true, supported: true, toggle() {} }; render();
  find('弹幕设置').props.onClick(); render();
  advance(10000);
  assert.ok(barShown(), '弹幕设置面板打开期间无论多久都不得隐藏');
  find('弹幕设置').props.onClick(); render();
  advance(3000); assert.ok(!barShown(), '关闭弹幕设置面板后恢复 3 秒自动隐藏');
  delete props.danmaku; render();
  detachAutoHideCtrls();
  assert.ok(!barShown() && !dlShown(), 'detach 必须清掉 fs-show');
  // 原生窗口全屏不会自己响应 Esc（源 index.html 里没有这段，是本仓库的必要补充，
  // 见 PlayerControls.jsx:189–200）。旧断言只把 nativeFullscreen 当作驱动自动隐藏的
  // 开关；移植后该 prop 在场内唯一的行为就是这条 Esc 通道，故改为对它断言。
  props.nativeFullscreen = true; render();
  assert.ok(find('退出全屏'), '原生全屏下按钮必须显示为「退出全屏」（expanded = fullscreen || nativeFullscreen）');
  assert.equal(typeof windowListeners.get('keydown'), 'function', '原生全屏下必须注册 Esc 退出全屏通道（PlayerControls.jsx:158–167）');
  windowListeners.get('keydown')({ key: 'Escape', target: keyTarget, defaultPrevented: false });
  assert.deepEqual(windowFullscreen, [false], '原生全屏下按 Esc 必须请求退出窗口全屏');
  windowListeners.get('keydown')({ key: 'Escape', target: { closest: query => (query.includes('.danmaku-settings') ? {} : null) }, defaultPrevented: false });
  assert.deepEqual(windowFullscreen, [false], '弹幕设置面板打开时 Esc 必须先关面板，不得退出全屏');
  windowListeners.get('keydown')({ key: 'ArrowDown', target: keyTarget, defaultPrevented: false });
  assert.deepEqual(windowFullscreen, [false], '其他按键不得触发退出全屏');
  props.nativeFullscreen = false; render();
  assert.ok(find('全屏'), '退出原生全屏后按钮回到「全屏」');
  // 组件自身不得再起自动隐藏定时器：定时器只归 attachAutoHideCtrls()。
  // 反面例子正是被删掉的旧机制（组件内的 2000ms setTimeout）。
  render(); advance(5000); render();
  assert.equal(timers.size, 0, '控制条组件自身不得创建自动隐藏定时器（机制已交给 attachAutoHideCtrls）');

  media.duration = NaN; listeners.get('durationchange')(); render(); assert.equal(find('播放进度').props.disabled, true);
  props.available = false; render(); assert.equal(find('播放').props.disabled, true);
  cleanups.forEach(fn => fn?.()); assert.equal(listeners.size, 0); assert.equal(documentListeners.size, 0); assert.equal(windowListeners.size, 0); assert.equal(timers.size, 0);
  assert.equal(stageListeners.size, 0, '控制条不得再把显隐监听绑到 stage 上（移植后只绑 document，见 check-native-auto-hide.cjs）');
  const { mount } = require('./check-player-resume.cjs');
  const controls = ui => ui.find(node => node.props.onRateChange && node.props.videoRef);
  for (const local of [true, false]) {
    let finishNext;
    const ui = mount({ local, props: { setEpisodesOpen() {}, target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, prepare: p => p.vidIndex === 1 ? { success: true, url: 'mock:first' } : new Promise(resolve => { finishNext = resolve; }) });
    await ui.flush(); ui.metadata(); await ui.flush();
    assert.equal(typeof controls(ui).props.onToggleFullscreen, 'function', 'parent supplies the shared fullscreen action');
    assert.equal(controls(ui).props.shortcuts.play, 'space', 'parent supplies effective shortcut preferences');
    assert.equal(controls(ui).props.autoContinue, true, 'parent marks whether an unlocked next episode can follow');
    ui.find(node => node.type === 'video').props.onEnded(); await ui.flush();
    assert.equal(controls(ui).props.continuing, true, `parent retains auto-next intent through source preparation (local=${local})`);
    assert.equal(controls(ui).props.autoContinue, false, 'final episode has no following episode');
    if (!local) { finishNext({ success: true, url: 'mock:second' }); await ui.flush(); }
    assert.equal(controls(ui).props.continuing, true, 'auto-next intent remains until playback actually starts');
    ui.metadata(); await ui.flush();
    assert.equal(controls(ui).props.continuing, false, 'playing clears the transition so later manual pause is visible');
    ui.unmount();
  }
  for (const local of [true, false]) {
    for (const custom of [false, true]) {
      for (const direction of ['previous', 'next']) {
        let finish;
        const bindings = { ...shortcutModule.exports.DEFAULT_SHORTCUTS, ...(custom ? { previous: 'shift+j', next: 'shift+k' } : {}) };
        const storage = new Map([[shortcutModule.exports.SHORTCUT_STORAGE_KEY, JSON.stringify(bindings)]]);
        const ui = mount({ local, storage, episodeCount: 3, settings: { cache_next_episode: false },
          props: { setEpisodesOpen() {}, target: { seriesId: 'A', vidIndex: 2, ts: 1 } },
          prepare: p => p.vidIndex === 2 ? { success: true, url: 'mock:middle' } : new Promise(resolve => { finish = resolve; }) });
        await ui.flush(); ui.metadata(); await ui.flush();
        const key = custom ? (direction === 'previous' ? 'j' : 'k') : (direction === 'previous' ? 'ArrowUp' : 'ArrowDown');
        const init = { key, code: custom ? `Key${key.toUpperCase()}` : key, shiftKey: custom, target: keyTarget };
        // Input/menu events must never be redirected to an episode.
        for (const target of [{ isContentEditable: true }, { closest: query => query.includes('input') ? {} : null }, { closest: query => query.includes('[data-player-menu]') ? {} : null }]) {
          const event = ui.dispatchKey('keydown', { ...init, target });
          assert.equal(event.defaultPrevented, false, 'typing and menu navigation are not hijacked');
          assert.equal(controls(ui).props.continuing, false);
        }
        assert.equal(ui.dispatchKey('keydown', init).defaultPrevented, true);
        await ui.flush();
        assert.equal(controls(ui).props.continuing, true, `${local ? 'local' : 'online'} ${direction} ${custom ? 'custom' : 'default'} shortcut retains transition intent after reset`);
        ui.dispatchKey('keyup', { ...init, shiftKey: false });
        if (!local) { finish({ success: true, url: `mock:${direction}` }); await ui.flush(); }
        assert.equal(controls(ui).props.continuing, true, 'shortcut transition persists until actual playing');
        const play = ui.media.play;
        ui.media.play = async () => { ui.media.paused = false; };
        ui.metadata(); await ui.flush();
        assert.equal(controls(ui).props.continuing, true, 'metadata and an accepted play request do not end the transition before playing');
        ui.media.play = play; await play(); await ui.flush();
        assert.equal(controls(ui).props.continuing, false, 'actual playing releases shortcut transition state');
        assert.equal(ui.find(node => node.type === 'video').props.src, local ? `file:///mock-${direction === 'previous' ? 1 : 3}.mp4` : `mock:${direction}`);
        if (direction === 'previous') {
          ui.find(node => node.type === 'video').props.onEnded(); await ui.flush();
          assert.equal(controls(ui).props.continuing, true, 'automatic next after previous renews transition protection');
          assert.equal(ui.find(node => node.type === 'video').props.src, local ? 'file:///mock-2.mp4' : 'mock:middle');
          ui.metadata(); await ui.flush();
          assert.equal(controls(ui).props.continuing, false, 'second handoff ends only when automatic next plays');
        }
        ui.unmount();
      }
    }
  }
  for (const trigger of ['ended', 'shortcut']) {
    const failed = mount({ props: { setEpisodesOpen() {}, target: { seriesId: 'A', vidIndex: 1, ts: 1 } }, prepare: p => p.vidIndex === 1 ? { success: true, url: 'mock:first' } : { success: false, error: 'test preparation failure' } });
    await failed.flush(); failed.metadata(); await failed.flush();
    if (trigger === 'ended') failed.find(node => node.type === 'video').props.onEnded();
    else failed.dispatchKey('keydown', { key: 'ArrowDown', code: 'ArrowDown', target: keyTarget });
    await failed.flush();
    assert.equal(controls(failed).props.continuing, false, 'failed online preparation must restore ordinary pause behavior');
    failed.unmount();
    const blocked = mount({ local: true, props: { setEpisodesOpen() {} } });
    await blocked.flush(); blocked.metadata(); await blocked.flush();
    if (trigger === 'ended') blocked.find(node => node.type === 'video').props.onEnded();
    else blocked.dispatchKey('keydown', { key: 'ArrowDown', code: 'ArrowDown', target: keyTarget });
    await blocked.flush();
    blocked.media.play = async () => { throw new Error('test autoplay denied'); };
    blocked.metadata(); await blocked.flush();
    assert.equal(controls(blocked).props.continuing, false, 'autoplay rejection must leave the play control accessible');
    blocked.unmount();
  }
  // ── 控制条显隐的接线（移植机制的入口，本仓库曾经的"全屏丢失控制条"）──────────
  // 机制本身（attach/detach 的 DOM+CSS 行为）在 scripts/check-native-auto-hide.cjs 里断言；
  // 这里断言 Player.jsx 真的在正确时机调用它 —— 单测那五个用例在接线断掉时仍会全绿。
  {
    let broadcast = null;
    const ui = mount({ props: { setEpisodesOpen() {}, active: true, nativeFullscreen: true, target: { seriesId: 'A', vidIndex: 1, ts: 1 } },
      apiOverrides: { onWindowFullscreenChanged: fn => { broadcast = fn; return () => { broadcast = null; }; } } });
    await ui.flush();
    assert.ok(ui.autoHide.attach > 0, '进入原生全屏必须挂上自动隐藏（attachAutoHideCtrls）');
    assert.equal(typeof broadcast, 'function', '播放器必须订阅主进程的全屏变化广播（源第二处调用点）');
    const attached = ui.autoHide.attach, detached = ui.autoHide.detach;
    broadcast(false); await ui.flush();
    assert.ok(ui.autoHide.detach > detached, '主进程广播退出全屏必须摘掉自动隐藏');
    broadcast(true); await ui.flush();
    assert.ok(ui.autoHide.attach > attached, '主进程广播进入全屏必须重新挂上自动隐藏');
    const beforeUnmount = ui.autoHide.detach;
    ui.unmount();
    assert.equal(broadcast, null, '卸载必须退订主进程的全屏广播');
    assert.ok(ui.autoHide.detach > beforeUnmount, '离开播放器必须摘掉自动隐藏，不留定时器与 document 监听');
  }
  console.log('PASS video controls: source 0–1000 seek scale with drag round-trip, play/pause, volume with persistence, lower-right 4× menu (Escape/outside close), fullscreen enter/exit with shortcut tooltips, native-fullscreen Escape channel incl. danmaku-panel guard, no component-owned auto-hide timer, local/online parent wiring for fullscreen/shortcut/continuing transitions, input/menu shortcut boundaries, failure/end recovery, and the fullscreen→attachAutoHideCtrls wiring; control-bar hide/show behavior itself is covered by scripts/check-native-auto-hide.cjs');
})().catch(error => { console.error(error); process.exitCode = 1; });
