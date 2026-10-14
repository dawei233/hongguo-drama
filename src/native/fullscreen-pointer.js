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
 * 仅在窗口处于全屏时轮询；指针在窗口内且位置发生变化时，通知渲染层"该唤出控制条了"。
 * 不读 DOM、不依赖焦点，因此失焦场景同样有效。
 */

// 轮询间隔：与 stealth-window.js 保持一致（100ms 量级）。这个频率足以让控制条跟手，
// 同时远低于会明显耗电的程度。
const DEFAULT_INTERVAL_MS = 120;

function createFullscreenPointerController({ screen, getWindow, intervalMs = DEFAULT_INTERVAL_MS }) {
  let timer = null;
  let enabled = false;
  let last = null;

  const tick = () => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    // 只在全屏时上报：非全屏下 DOM 指针事件本来就是好的，没必要走这条通道。
    if (!win.isFullScreen()) return;
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const inside = point.x >= bounds.x && point.x < bounds.x + bounds.width
      && point.y >= bounds.y && point.y < bounds.y + bounds.height;
    const moved = !last || last.x !== point.x || last.y !== point.y;
    last = { x: point.x, y: point.y };
    if (!inside || !moved) return;
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
  };
}

module.exports = { createFullscreenPointerController, DEFAULT_INTERVAL_MS };
