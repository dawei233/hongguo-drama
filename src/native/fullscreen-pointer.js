'use strict';

/**
 * 全屏播放时的指针轮询。
 *
 * ## 为什么需要这个（而不是靠 DOM 事件）
 *
 * 用户报告：主屏全屏正常；副屏全屏、控制条自动隐藏后，移动鼠标再也唤不出控制条，
 * 只能按 Esc。实测（Windows UI 自动化）确认故障时**前台窗口是别的程序**，把焦点切回
 * 本窗口后同样操作即恢复正常 —— 也就是说"焦点"是关键变量。
 *
 * 但进一步核查上游源码与微软文档后，机理与最初的判断不同，两点都要说准：
 *
 * 1. `WM_MOUSEMOVE` 是投递给**光标下的窗口**，不是前台窗口
 *    （Microsoft Learn, Mouse Input：`If the mouse is not captured, the message is posted
 *    to the window that contains the cursor.`）。所以消息确实送达了本窗口 ——
 *    我们的命中测试也印证了这一点（光标下就是本窗口）。
 * 2. 真正的拦截点在 Blink：页面不是 active 时，它抑制 hover/指针语义
 *    （`mouse_event_manager.cc` 要求 `GetFocusController().IsActive()`，而放宽它的
 *    `SyntheticMouseHoverOverInactivePage` 在 Chromium 中是非默认开启的 experimental）。
 *
 * 结论：这不是"消息没送到"，而是"送到了但渲染层被抑制"。因此**任何基于 DOM 指针事件的
 * 方案都不可靠** —— 这也是本项目已有的做法：`stealth-window.js` 早就用主进程轮询
 * `screen.getCursorScreenPoint()` 来判断鼠标进出，其注释写明
 * "polling restores it even when no DOM hover fires"。本模块复用同一模式。
 *
 * ## 行为
 *
 * 定时器常驻运行；指针在窗口所在的那一屏上发生位移时，就向渲染层上报一次。
 *
 * **刻意不判断全屏状态**。曾经用 `win.isFullScreen()` 作为门槛，但竖屏布局下播放器
 * "全屏"走的是前端的 setWindowFill（CSS 模式），窗口并不是 Electron 的原生全屏，
 * `isFullScreen()` 为 false —— 轮询因此一次都不上报，与"完全没修"的症状一模一样。
 * 用户的副屏正是 1080x1920 竖屏，很容易落进这条路径。现在不再设这个门槛：
 * 渲染层本来就只在播放页挂监听，多上报几次不会造成可见影响，却消除了整类失效可能。
 *
 * 不读 DOM、不依赖焦点，因此窗口失焦时同样有效。
 */

// 轮询间隔：与 stealth-window.js 保持一致（100ms 量级）。这个频率足以让控制条跟手，
// 同时远低于会明显耗电的程度。
const DEFAULT_INTERVAL_MS = 120;

function createFullscreenPointerController({ screen, getWindow, intervalMs = DEFAULT_INTERVAL_MS }) {
  let timer = null;
  let enabled = false;
  let last = null;
  let sent = 0;

  // 光标是否落在窗口这一屏上。
  // 优先用"是否同一块显示器"判断：getCursorScreenPoint 与 getDisplayMatching 都出自
  // Electron 的 screen 模块，坐标空间一致，比手写 bounds 比较更耐受**混合 DPI 与负坐标
  // 显示器**（用户的副屏是 1080x1920 竖屏、位于 x 负半轴、缩放 1.0，而主屏缩放 1.5）。
  const overWindow = (point, win) => {
    try {
      const here = screen.getDisplayNearestPoint(point);
      const own = screen.getDisplayMatching(win.getBounds());
      if (here && own) return here.id === own.id;
    } catch { /* 退回 bounds 比较 */ }
    const b = win.getBounds();
    return point.x >= b.x && point.x < b.x + b.width && point.y >= b.y && point.y < b.y + b.height;
  };

  const tick = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    let point;
    // app 未 ready 时 screen 会抛错；也不要把异常打到控制台刷屏。
    try { point = screen.getCursorScreenPoint(); } catch { return; }
    const moved = !last || last.x !== point.x || last.y !== point.y;
    last = { x: point.x, y: point.y };
    if (!moved) return;
    if (!overWindow(point, win)) return;
    sent++;
    win.webContents.send('fullscreen-pointer-move');
  };

  const start = () => {
    if (timer) return;
    last = null;
    timer = setInterval(tick, intervalMs);
    // 不要因为这个定时器阻止进程退出
    timer.unref?.();
  };

  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
    last = null;
  };

  const setEnabled = value => {
    enabled = value === true;
    if (enabled) start(); else stop();
  };

  return {
    setEnabled,
    dispose: () => { enabled = false; stop(); },
    get enabled() { return enabled; },
    get sent() { return sent; },
  };
}

module.exports = { createFullscreenPointerController, DEFAULT_INTERVAL_MS };
