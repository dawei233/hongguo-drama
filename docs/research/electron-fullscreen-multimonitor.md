# Electron 多显示器「播放器全屏」调研

核对时间：2026-10-14。项目基线：Electron `44.6.0`（`package.json`）。
本文所有结论只依据**一手来源**（官方文档、源码、issue tracker、库自身源码/README），
不采信二手博客的转述。每条结论都标注了 `CODE FACT`（读到的源码/文档原文）、
`DOC CLAIM`（官方文档的表述）或 `INFERENCE`（我的推断）。

---

## 一、调研问题

1. Electron 官方文档对 `BrowserWindow.setFullScreen(true)`（原生窗口全屏）与 DOM Fullscreen API
   （`element.requestFullscreen()`，即 html5 fullscreen）的说明与区别；有没有官方 issue
   记录「DOM 全屏在多显示器/失焦下丢鼠标或键盘事件」。
2. `BrowserWindow.setFullScreen` 在多显示器下的已知问题（全屏跳到主屏 / 全屏到错误的显示器 /
   全屏后焦点异常），以及是否有官方推荐绕法。
3. `win.focus()` 是否可靠（Windows `SetForegroundWindow` 的 foreground lock）；Electron 官方
   是否说明过 `focus()` 何时无效；有没有官方推荐的可靠做法。
4. npm / GitHub 上是否已有专门解决「Electron 多显示器全屏 / 全屏焦点管理」的库。
5. 成熟 React/Web 视频播放器（video.js / Plyr / Vidstack / react-player / media-chrome / Shaka）
   如何进入全屏，是否支持「由宿主应用接管全屏」。

---

## 二、结论速览（最关键的三条）

**1. Electron 的 DOM 全屏并不是另一套全屏实现，它在 Electron 内部直接调用了同一个原生
`SetFullScreen`；而且两条路都**不会**把窗口变成前台窗口。**

- `CODE FACT` DOM 全屏在 Electron 里的落点是 `WebContents::SetHtmlApiFullscreen()`
  （`shell/browser/api/electron_api_web_contents.cc:6357`），它最后调用了
  `native_lifecycle_->owner_window_->SetFullScreen(enter_fullscreen)`（同文件 `:6379-6380`）。
- `CODE FACT` 该函数体内没有任何 `focus()` / 激活调用。
- `CODE FACT` Chromium 在 Windows 上进入全屏用的是 `SetWindowPos(..., SWP_NOZORDER |
  SWP_NOACTIVATE | SWP_FRAMECHANGED)`（`ui/views/win/fullscreen_handler.cc:109`）——
  **`SWP_NOACTIVATE` 意味着全屏这个动作本身不会激活窗口**。

**2. 「全屏后窗口不是前台」是 Electron 自己测试套件里被明确记录过的事实。**

- `CODE FACT` Electron PR #54883（2026-10-13 合并，已进入 `main`）在
  `spec/api-browser-window.spec.ts` 留下注释：

  > `// Chromium refuses requestFullscreen() from a page that doesn't have focus,`
  > `// even with a user gesture, so make sure the window is key and`
  > `// the page is focused after entering simple fullscreen.`
  > `// webContents.focus() only activates the app when no other app is`
  > `// active, and the earlier fullscreen specs can leave another app`
  > `// frontmost, so take activation explicitly first.`
  > `app.focus({ steal: true });`

  我已在 `main` 分支的 `spec/api-browser-window.spec.ts`（约 7688 行附近）核对到这段文字确实存在。

**3. 没有现成的轮子。所有成熟播放器库都调用同一个 DOM Fullscreen API，无法解决「窗口失焦后
收不到指针事件」这个层面的问题。** 详见 §七。

---

## 三、一手来源清单

| # | 来源 | URL |
|---|---|---|
| S1 | Electron BrowserWindow API 文档（源文件） | https://github.com/electron/electron/blob/main/docs/api/browser-window.md |
| S2 | Electron app API 文档（源文件） | https://github.com/electron/electron/blob/main/docs/api/app.md |
| S3 | Electron webPreferences 文档（源文件） | https://github.com/electron/electron/blob/main/docs/api/structures/web-preferences.md |
| S4 | Electron BaseWindow 选项文档（`windowStatePersistence`） | https://github.com/electron/electron/blob/main/docs/api/structures/base-window-options.md |
| S5 | Electron `session` 文档（`fullscreen` 权限） | https://github.com/electron/electron/blob/main/docs/api/session.md |
| S6 | Electron 源码：`electron_api_web_contents.cc`（DOM 全屏落点） | https://github.com/electron/electron/blob/main/shell/browser/api/electron_api_web_contents.cc |
| S7 | Electron 源码：`native_window_views.cc`（Windows 窗口全屏 / focus / moveTop） | https://github.com/electron/electron/blob/main/shell/browser/native_window_views.cc |
| S8 | Electron 源码：`native_window.cc`（构造期全屏目标显示器） | https://github.com/electron/electron/blob/main/shell/browser/native_window.cc |
| S9 | Electron PR #54883（已合并，记录「无焦点页拒绝 requestFullscreen」） | https://github.com/electron/electron/pull/54883 |
| S10 | Electron issue #2867（`focus()` 在 Win10 不置前） | https://github.com/electron/electron/issues/2867 |
| S11 | Electron issue #1836（按显示器定位窗口，wontfix） | https://github.com/electron/electron/issues/1836 |
| S12 | Electron issue #54625（按显示器全屏，Linux/Wayland，open） | https://github.com/electron/electron/issues/54625 |
| S13 | Chromium 源码：`ui/views/win/fullscreen_handler.cc` | https://chromium.googlesource.com/chromium/src/+/main/ui/views/win/fullscreen_handler.cc |
| S14 | Chromium 源码：`ui/views/win/hwnd_message_handler.cc`（`Activate` → `SetForegroundWindow`） | https://chromium.googlesource.com/chromium/src/+/main/ui/views/win/hwnd_message_handler.cc |
| S15 | Chromium 源码：`desktop_window_tree_host_win.cc` | https://chromium.googlesource.com/chromium/src/+/main/ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc |
| S16 | Chromium 源码：Blink `core/input/mouse_event_manager.cc`（hover 的 active 门禁） | https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/input/mouse_event_manager.cc |
| S17 | Chromium 源码：Blink `runtime_enabled_features.json5` | https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/runtime_enabled_features.json5 |
| S18 | Microsoft Learn：`SetForegroundWindow` | https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow |
| S19 | Microsoft Learn：Mouse Input Overview（窗口激活一节） | https://learn.microsoft.com/en-us/windows/win32/inputdev/about-mouse-input |
| S20 | Microsoft Learn：`WM_MOUSEMOVE` | https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-mousemove |
| S21 | video.js 源码：`src/js/fullscreen-api.js` | https://github.com/videojs/video.js/blob/v8.21.0/src/js/fullscreen-api.js |
| S22 | video.js 源码：`src/js/player.js` | https://github.com/videojs/video.js/blob/v8.21.0/src/js/player.js |
| S23 | Plyr 源码：`src/js/fullscreen.js` | https://github.com/sampotts/plyr/blob/master/src/js/fullscreen.js |
| S24 | Plyr 默认配置：`src/js/config/defaults.js` | https://github.com/sampotts/plyr/blob/master/src/js/config/defaults.js |
| S25 | media-chrome 源码：`src/js/media-fullscreen-button.ts` | https://github.com/muxinc/media-chrome/blob/main/src/js/media-fullscreen-button.ts |
| S26 | media-chrome 源码：`src/js/media-store/state-mediator.ts` | https://github.com/muxinc/media-chrome/blob/main/src/js/media-store/state-mediator.ts |
| S27 | media-chrome 源码：`src/js/utils/fullscreen-api.ts` | https://github.com/muxinc/media-chrome/blob/main/src/js/utils/fullscreen-api.ts |
| S28 | Shaka Player 源码：`ui/controls.js` | https://github.com/shaka-project/shaka-player/blob/main/ui/controls.js |
| S29 | Shaka Player：`lib/polyfill/fullscreen.js` | https://github.com/shaka-project/shaka-player/blob/main/lib/polyfill/fullscreen.js |
| S30 | vidstack 依赖与产物（`fscreen`） | https://www.npmjs.com/package/vidstack |
| S31 | electron-window-state 源码 | https://github.com/mawie81/electron-window-state/blob/master/index.js |
| S32 | electron-multi-monitor（npm） | https://www.npmjs.com/package/electron-multi-monitor |
| S33 | react-player（npm，v3.4.0） | https://www.npmjs.com/package/react-player |

> 说明：Chromium 源码用 `chromium.googlesource.com/.../+/{ref}/path?format=TEXT` 取原始文件，
> 文中引用的行号是 `main` 分支在 2026-10-14 的快照。Electron 与各库源码同理，
> 行号对应该次快照；用 `main`/`master` 分支时行号可能随上游提交漂移，
> 定位时以文中给出的**函数名与代码片段**为准。

---

## 四、逐条回答

### Q1. 官方文档怎么讲「原生全屏」与「DOM 全屏」的区别

#### 1.1 官方文档的实际表述

| API | 文档原文 | 出处 |
|---|---|---|
| `win.setFullScreen(flag)` | "Sets whether the window should be in fullscreen mode." 唯一补充是 macOS 异步的 NOTE | `DOC CLAIM` S1 |
| `win.isFullScreen()` | "Returns `boolean` - Whether the window is in fullscreen mode." | `DOC CLAIM` S1 |
| `win.setFullScreenable(fullscreenable)` | "Sets whether the maximize/zoom window button toggles fullscreen mode or maximizes the window." | `DOC CLAIM` S1 |
| `disableHtmlFullscreenWindowResize` | "Whether to prevent the window from resizing when entering HTML Fullscreen. Default is `false`." | `DOC CLAIM` S3 |
| `enter-html-full-screen` / `leave-html-full-screen` | "Emitted when the window enters a full-screen state triggered by HTML API." | `DOC CLAIM` S1（BrowserWindow）与 `web-contents.md` |

关键观察：**Electron 文档从未把「原生全屏」和「DOM 全屏」并列成两套方案来比较**，也没有任何
一句提示「DOM 全屏不会让窗口成为前台窗口」。

`DOC CLAIM` 另外，`session` 文档把全屏列为一种可拦截的权限 `fullscreen`——
"Request control of the app's fullscreen state via the Fullscreen API"（S5）。
即宿主可以在 `setPermissionRequestHandler` 里**拒绝** DOM 全屏请求
（`WebContentsPermissionHelper::RequestFullscreenPermission`，`CODE FACT`
`shell/browser/web_contents_permission_helper.cc:260-266` 使用
`blink::PermissionType::ELECTRON_FULLSCREEN`）。这是一个官方支持、但文档很少人注意的
**「拦下 DOM 全屏、由宿主改走原生全屏」**的钩子。对本项目而言，这条路比换播放器库更轻。

#### 1.2 两者在实现上的真实区别（读源码）

`CODE FACT` DOM 全屏在 Electron 里最终走的是同一个原生全屏：

```
// shell/browser/api/electron_api_web_contents.cc:6357
void WebContents::SetHtmlApiFullscreen(bool enter_fullscreen) {
  // 已经是窗口全屏 → 只标记 html 全屏，不动窗口
  if (enter_fullscreen && (owner_window()->IsFullscreen() ||
                           owner_window()->IsSimpleFullScreen())) { ... return; }
  ...
  bool html_fullscreenable =
      web_preferences ? !web_preferences->ShouldDisableHtmlFullscreenWindowResize() : true;
  if (html_fullscreenable)
    native_lifecycle_->owner_window_->SetFullScreen(enter_fullscreen);   // :6379-6380
  UpdateHtmlApiFullscreen(enter_fullscreen);
  native_fullscreen_ = false;
}
```

所以两者的**差别只在渲染层语义**，不在窗口层：

| | 原生 `setFullScreen(true)` | DOM `requestFullscreen()` |
|---|---|---|
| 窗口是否全屏 | 是 | 是（复用同一个 `SetFullScreen`） |
| `:fullscreen` CSS 伪类 | **不生效** | 生效 |
| `document.fullscreenElement` | 不变 | 变为该元素 |
| Electron 事件 | `enter-full-screen` | `enter-html-full-screen`（并伴随 `enter-full-screen`） |
| 能否被 `disableHtmlFullscreenWindowResize` 阻止改窗口 | 不适用 | 可以（只标记 html 全屏，窗口不动） |
| **是否激活/前置窗口** | **否** | **否** |

最后一行是本次问题的核心，见 Q3。

#### 1.3 有没有官方 issue 记录「DOM 全屏在多显示器/失焦下丢鼠标或键盘事件」

**没有找到。** 这是本次调研里一个诚实的「未找到」，而不是「没有」。

- `INFERENCE` 我通过 GitHub 搜索 API 检索了 `repo:electron/electron` 下的多组关键词
  （`requestFullscreen focus`、`html fullscreen focus`、`requestFullscreen mouse`、
  `fullscreen mouse events not working`、`fullscreen keyboard events not received`、
  `fullscreen page not active mouse hover controls`），**没有**命中一条明确描述
  「DOM 全屏 + 多显示器/失焦 → 指针或键盘事件丢失」的 issue。
- 命中的近似项只有：
  - Electron issue **#54816**（`[Bug]: setSimpleFullScreen with the cursor over the window
    stops all mousemove / :hover events on macOS`，open，2026-10-10，Electron 43.1.0）：
    症状是「`setSimpleFullScreen` 后收不到 `mousemove`，`:hover` 停止更新，Cmd+Tab 切走再切回
    即恢复」。`DOC CLAIM` 报告者自述根因是 AppKit 的 `SetStyleMask`，
    **是 macOS 且是 simple fullscreen，与本项目的 Windows 原生全屏不是同一条路**。
    但它证明「全屏切换与鼠标事件投递之间存在 Electron 层的坑」这件事是被上游承认过的。
  - Electron issue **#49905**（Wayland/Ozone 单窗口输入冻结，closed `NOT_PLANNED`）：
    仅 Linux/Wayland，与本项目无关。

- 最强的一手证据其实是 **PR #54883**（S9）：它不是 issue，而是一次**已合并的测试修复**，
  却白纸黑字写下了本次问题的机理。原文见本文 §二第 2 条。

---

### Q2. `setFullScreen` 在多显示器下的已知问题

#### 2.1 全屏会不会「跳到主显示器」？——大概率不会

`CODE FACT` Chromium 在 Windows 上选择全屏目标显示器时，如果没有显式指定
`target_display_id`，用的是**窗口当前所在的显示器**，而且用的是 `MONITOR_DEFAULTTONEAREST`：

```cpp
// ui/views/win/fullscreen_handler.cc:95-106
// Set the window rect to the rcMonitor of the targeted or current display.
const display::win::ScreenWinDisplay screen_win_display =
    display::win::ScreenWinDisplayWithDisplayId(target_display_id);
gfx::Rect window_rect = screen_win_display.screen_rect();
if (target_display_id == display::kInvalidDisplayId ||
    screen_win_display.display().id() != target_display_id) {
  HMONITOR monitor = ::MonitorFromWindow(hwnd_, MONITOR_DEFAULTTONEAREST);
  MONITORINFO monitor_info;
  monitor_info.cbSize = sizeof(monitor_info);
  ::GetMonitorInfo(monitor, &monitor_info);
  window_rect = gfx::Rect(monitor_info.rcMonitor);
}
```

`CODE FACT` 而 Electron 调 `SetFullScreen` 时**没有传** `target_display_id`：

```cpp
// shell/browser/native_window_views.cc:861
widget()->SetFullscreen(fullscreen);      // 第二参数 target_display_id 取默认值
```

`INFERENCE` 因此「全屏后跳到主屏」这个担心在当前 Electron 版本上**缺乏依据**：
没有指定目标显示器时，Chromium 走的是「窗口当前所在显示器」。
本项目实测中副屏窗口矩形 `(-1080,481)-(0,2401)` 在进全屏前后位置本身正确，
与这条代码事实一致——**副屏没有跑错屏，问题不在显示器选择**。

> ⚠️ 但要注意负坐标：MSDN 明确提醒多显示器下坐标可能为负，
> 「Do not use the `LOWORD` or `HIWORD` macros to extract the x- and y- coordinates ...
> Systems with multiple monitors can have negative x- and y- coordinates」（S20）。
> 本项目主屏在右、副屏在左（x 为负），属于这个已文档化的场景。

#### 2.2 相关的官方 issue

| Issue | 标题 | 状态 | 与本问题的关系 |
|---|---|---|---|
| **#1836** | `BrowserWindow should be capable of targeting dedicated monitors` | **closed / COMPLETED（wontfix）**，2020-03-25 由 MEMBER `codebytere` 关闭 | 直接相关。原文抱怨：「Fullscreen works only on the primary monitor and placing windows on different monitors requires knowledge about the user's actual setup to do this by coordinates only.」`codebytere` 回复：「Given that this is not currently on a roadmap for the core team and has been open for years, i'm going to go ahead and label this a `wontfix`. However, should someone determine a workable solution we would be very open to accepting a PR.」 |
| **#54625** | `[Feature Request]: request fullscreen on a specific display on Linux/Wayland` | **open（reopened）**，2026-10-01 | 仅 Linux/Wayland（COSMIC / KDE Plasma）。报告者实测 Electron 43.2.0 与 44.5.1 上多窗口全屏会全部落在同一输出。**不涉及 Windows。** |
| **#2867** | `Windows 10: Window is not put to front on focus()` | **closed / COMPLETED**，2018-09-23 | 见 Q3，焦点问题的核心 issue。 |

**官方推荐绕法**：`CODE FACT` #1836 里没有官方提供的 API 绕法（因此被 wontfix），
但维护者 `anaisbetts`（`CODE OF CONDUCT` 之外的另一位 MEMBER）在早期回复中把方向指给了
`screen` API：「Have you seen the Screen API? You should be able to pretty easily target
specific monitors by getting their working area.」社区后来给出的可工作写法是
**先把窗口放到目标显示器，再全屏**——这正是本项目已经在做的事（`main.js` 的
`set-window-layout` 用 `screen.getDisplayMatching(current).workArea` 计算 bounds）。
`DOC CLAIM` #1836 里社区结论明确写着：「Fullscreen works as long as the window is
positioned on the correct monitor.」

#### 2.3 关于「多显示器上的 alwaysOnTop」

`DOC CLAIM` Electron issue **#24096**（`Always on top on multiple displays`，
closed `NOT_PLANNED`，2022-11-07）记录了「窗口在副屏时 alwaysOnTop 失效」的现象。
如果本项目将来考虑用 `setAlwaysOnTop` 做焦点兜底，这条是一个已知反例。

---

### Q3. `win.focus()` 可靠吗？——不可靠，而且本项目当前用法有更根本的问题

#### 3.1 Windows 的 foreground lock（微软官方原文）

`DOC CLAIM` `SetForegroundWindow` 的 Remarks（S18）原文：

> The system restricts which processes can set the foreground window.
> A process can set the foreground window by calling **SetForegroundWindow** only if:
>
> - All of the following conditions are true:
>   - The calling process belongs to a desktop application, not a UWP app or a Windows Store app...
>   - The foreground process has not disabled calls to **SetForegroundWindow** by a previous call to the **LockSetForegroundWindow** function.
>   - No menus are active.
> - Additionally, at least one of the following conditions is true:
>   - The foreground lock time-out has expired (see **SPI_GETFOREGROUNDLOCKTIMEOUT**...).
>   - **The calling process is the foreground process.**
>   - The calling process was started by the foreground process.
>   - There is currently no foreground window, and thus no foreground process.
>   - **The calling process received the last input event.**
>   - Either the foreground process or the calling process is being debugged.
>
> It is possible for a process to be denied the right to set the foreground window even if it meets these conditions.
>
> **An application cannot force a window to the foreground while the user is working with another window. Instead, Windows flashes the taskbar button of the window to notify the user.**

最后两段决定了 `focus()` 的天花板：**即使用户态满足条件，也可能被拒绝；
而且当用户正在操作别的窗口时，系统在语义上就不允许抢前台。**

#### 3.2 Electron 的 `focus()` 究竟是什么

`CODE FACT` Electron 的 `win.focus()` 在 Windows 上的实现：

```cpp
// shell/browser/native_window_views.cc:595-605
void NativeWindowViews::Focus(bool focus) {
  // For hidden window focus() should do nothing.
  if (!IsVisible())
    return;                       // ← 隐藏窗口直接 no-op
  if (focus) {
    widget()->Activate();
  } else {
    widget()->Deactivate();
  }
}
```

激活一路向下：

```cpp
// ui/views/widget/desktop_aura/desktop_window_tree_host_win.cc:533-539
void DesktopWindowTreeHostWin::Activate() {
  if (WidgetActivationDelegate::Get()) { ... MaybeActivate(...); }
  message_handler_->Activate();
}

// ui/views/win/hwnd_message_handler.cc:884-896
void HWNDMessageHandler::Activate() {
  if (IsMinimized()) { notify_restore_on_activate_ = true; ::ShowWindow(hwnd(), SW_RESTORE); ... }
  ::SetWindowPos(hwnd(), HWND_TOP, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE);
  ::SetForegroundWindow(hwnd());          // ← 就是 SetForegroundWindow
}
```

`INFERENCE` 结论：**Electron 的 `win.focus()` 就是一次 `SetWindowPos(HWND_TOP)`
+ `SetForegroundWindow`，因此它完整继承 §3.1 的全部限制。** 这与 Electron 维护者
`zcbenz` 在 issue #2867 中的原话一致：

> `DOC CLAIM`（S10，`zcbenz`，CONTRIBUTOR，2015-09-23）
> "Under the hood `focus()` just called [SetForegroundWindow] API, from the description
> it only brings window to foreground if the calling process is a foreground process."

#### 3.3 Electron 官方文档对 `focus()` 的说明：几乎没有

`DOC CLAIM` S1 里 `win.focus()` 的全文只有两行：

> #### `win.focus()`
> Focuses on the window.
>
> On Wayland (Linux), the desktop environment may show a notification or flash the app icon
> if the window or app is not already focused.

**Windows 上一个字的限制说明都没有。** 对比之下 `app.focus()` 反而诚实一些：

> `DOC CLAIM`（S2）"On macOS, makes the application the active app. **On Windows, focuses on
> the application's first window.**" 且 `steal` 选项是 _macOS_ 专属。

`INFERENCE` 这是一个**文档缺口**：`win.focus()` 的 Windows 语义（受 foreground lock 约束、
可能只是任务栏闪烁）没有被写进官方文档。issue #2867 里也有用户提出同一诉求：
"At a minimum, the Electron docs should be updated."

#### 3.4 `moveTop()` / `setAlwaysOnTop()` / `show()` 能不能替代

| 方法 | 文档原文 | 实际实现 | 能否置前 |
|---|---|---|---|
| `win.moveTop()` | "Moves window to top(z-order) regardless of focus." | `SetWindowPos(HWND_TOP, ..., SWP_NOACTIVATE \| SWP_NOMOVE \| SWP_NOSIZE \| SWP_SHOWWINDOW)`（S7 `native_window_views.cc:1055-1063`） | **不能**。`SWP_NOACTIVATE` + 文档直说 "regardless of focus"，只改 Z 序不改前台 |
| `win.show()` | "Shows and gives focus to the window."（S1） | `native_window_views.cc:611-633`：`Show(...)` 之后显式 `widget()->Activate()` | **相对最接近官方推荐**。文档承诺「gives focus」，实现走 `Activate()` → `SetForegroundWindow`，但仍受 §3.1 约束 |
| `win.showInactive()` | "Shows the window but doesn't focus on it." | `widget()->ShowInactive()` | 明确不置前 |
| `win.setAlwaysOnTop(true)` | "Sets whether the window should show always on top of other windows. After setting this, the window is still a normal window, not a toolbox window which can not be focused on."（S1） | `widget()->SetZOrderLevel(...)` + `MoveBehindTaskBarIfNeeded()`（S7 `:1189-1212`） | 置顶 ≠ 置前。`SetWindowPos(HWND_TOPMOST, ..., SWP_NOACTIVATE)`（S14 `:909-911`），**不激活** |

`INFERENCE` 因此 **`moveTop()` 和 `setAlwaysOnTop()` 都不能真正解决「窗口不是前台」**，
它们只解决「被别的窗口挡住」。`win.show()` 是文档层面唯一承诺「gives focus」的方法。

**社区绕法（非官方，无维护者背书）**，来自 issue #2867 的评论，取舍要看清：

| 绕法 | 提出者/时间 | 已知副作用 |
|---|---|---|
| `win.setAlwaysOnTop(true); win.show(); win.setAlwaysOnTop(false);` | `liuyike98` 2021；`darklightblue` 2022 复现 | `skident` 2023 报告：**Windows 11 上关闭应用窗口时，系统会把一两个无关窗口拉到前台** |
| `win.minimize(); win.restore(); win.focus();` | `gkourpa` 2022 | `sinamotamedi` 2023：Windows 可用，但 **macOS 会让应用启动即最小化到 Dock** |
| `win.minimize(); win.show(); win.setAlwaysOnTop(true); app.focus(); win.setAlwaysOnTop(false);` | `ikarofelix` 2025 | 仅在应用「最小化或在托盘」时有效；用户 Alt+Tab 切走再切回的场景无效 |
| `robot.mouseToggle("up"); win.show(); win.focus();`（robotjs 合成输入） | `TreeOfAlpha` 2023 | 需要原生模块；作者自称 "very hacky"；会干扰键盘输入 |

`DOC CLAIM` 该 issue 里 `ericblade`（2021）的总结我个人认为最接近事实：

> "unfortunately, the TLDR on this thread is -- there's not really anything to fix.
> Windows (the product)'s window management features don't explicitly allow this to occur,
> and pretty much every way around it is garbage, so the best thing to do if you need to
> foreground windows explicitly, over the top of other applications, is to determine which
> workaround you can most live with the drawbacks of."

> **注意**：以上全部是社区评论，**Electron 官方从未推荐过其中任何一种**。
> #2867 已于 2018-09-23 关闭，`zcbenz` 曾提出的 `AllowSetForegroundWindow` 修复方案
> （"I can probably fix this by calling `AllowSetForegroundWindow` in the renderer process
> to allow browser process to set foreground window"）**没有落地**——
> `CODE FACT` 我在 `shell/browser/native_window_views.cc` 中检索
> `AllowSetForegroundWindow` **零命中**。这是一个 upstream 层面长期未修的已知限制。

---

### Q4. 有没有现成的轮子

我用 npm registry 搜索 API（`/-/v1/search`）检索了
`electron fullscreen`、`electron display fullscreen`、`electron multi monitor`、
`electron window manager`、`electron kiosk`、`electron fullscreen focus`、
`electron focus window foreground` 等关键词，逐个核对了候选包的源码。

| 候选 | 最近发布 | 它到底做了什么 | 判断 |
|---|---|---|---|
| `electron-window-state` v5.0.3 | **2018-11-25** | 只做「保存/恢复窗口位置尺寸」。`CODE FACT` 源码里有一行 `win.setFullScreen(true)`（`index.js:136-137`，在 `manage()` 里恢复上次的全屏状态），**全文没有任何 `focus` 调用** | **不解决问题**，而且如果引入，反而会再制造一次「全屏但没置前」。另外它已被官方取代：Electron 新增了 `windowStatePersistence` + `name` 选项（S4，_Experimental_） |
| `electron-multi-monitor` v1.0.0 | **2021-03-26**（仅此一个版本，2022-05 后无更新） | `CODE FACT` 我解包核对了 `dist/` 全部文件：**检索 `setFullScreen` / `FullScreen` / `kiosk` 零命中**。它的功能是「把多个显示器的窗口连成同一套 JS `window` 对象」 | **完全无关**。它不碰全屏，也不碰焦点 |
| `electron-window-manager` v1.0.6 | 2018-01-29 | 通用窗口管理（开窗/关窗/注册），非全屏专项 | 过时，无关 |
| `@2o3t/electron-window-manager` v0.0.6 | 2019-06-20 | 同上 | 过时，无关 |
| `@lynker-desktop/electron-window-manager` v0.0.9-alpha.91 | 2026-01-12 | alpha、私人命名空间、无描述 | 不可评估 |
| `react-full-screen` v1.1.1 | 2022-06-01 | `CODE CLAIM` "Component and Hook for handling full screen components" —— 是 **DOM Fullscreen API** 的 React 包装 | **方向相反**，会把项目推回 DOM 全屏 |
| `electron-pixel-picker` v1.0.2 | 2026-03-28 | 屏幕取色器，碰巧用全屏遮罩 | 语义不同，无关 |

**结论（`INFERENCE`，但证据充分）：不存在专门解决「Electron 多显示器全屏 + 全屏焦点管理」
的现成库。** 诚实地说，这个问题的可复用部分只有十几行应用代码，
而它的难点（Windows foreground lock）是操作系统层面的策略，任何库都绕不过去——
这一点由 §3.1 的微软原文和 §3.4 的社区共识共同支撑。

---

### Q5. 成熟播放器库是怎么进全屏的，能不能「由宿主接管全屏」

#### 5.1 逐个库的实际做法（都读的是库自己发布的源码）

**video.js**（v8.21.0）
- `CODE FACT` 有专门的 fullscreen 抽象层 `src/js/fullscreen-api.js`：用一张 `apiMap` 同时
  映射标准 API 与 WebKit 前缀 API，逐个探测 `document` 上是否存在 `exitFullscreen`：

  ```js
  const apiMap = [
    ['requestFullscreen','exitFullscreen','fullscreenElement','fullscreenEnabled',
     'fullscreenchange','fullscreenerror','fullscreen'],
    // WebKit
    ['webkitRequestFullscreen','webkitExitFullscreen','webkitFullscreenElement', ...]
  ];
  for (let i = 0; i < apiMap.length; i++) {
    if (apiMap[i][1] in document) { browserApi = apiMap[i]; break; }
  }
  ```
- `CODE FACT` 进入全屏走 `player.js:3025-3032`
  `const promise = this.el_[this.fsApi_.requestFullscreen](fsOptions);`
  ——**标准 DOM Fullscreen API**。
- `CODE FACT` 但它有两个值得注意的逃生口：
  1. `player.js:379-380` 注释 "Hold our own reference to fullscreen api **so it can be mocked
     in tests**" —— `this.fsApi_` 是实例属性，可以在构造后替换。
  2. `player.js:3105` `enterFullWindow()` —— 非全屏的「填满视口」兜底模式，
     并设置 `this.isFullWindow = true`；配合公开的 `player.isFullscreen(bool)`
     getter/setter（`player.js:2936`）可以自行驱动 `fullscreenchange` 事件。
- `INFERENCE` 所以 video.js **理论上**可以被宿主接管（替换 `fsApi_` 或用 `isFullscreen(true)`
  假装），但这是**未文档化的内部手段**，且 `FullscreenApi` **没有从 `video.js` 入口导出**
  （`CODE FACT` `src/js/video.js` 只有 `export default videojs`）。另外 video.js 会自己监听
  `document` 的 `fullscreenchange`（`player.js:501-503`）来同步状态，
  如果宿主改用原生窗口全屏，这些监听永远不会触发，`isFullscreen_` 会与实际不符。

**Plyr**（v3.8.5）
- `CODE FACT` `fullscreen.js:255-258`：

  ```js
  } else if (!Fullscreen.nativeSupported || this.forceFallback) {
    this.toggleFallback(true);
  } else if (!this.prefix) {
    this.target.requestFullscreen({ navigationUI: 'hide' });   // ← DOM API
  }
  ```
- `CODE FACT` 它有一个**受支持的配置项**可以彻底避开 DOM 全屏：
  `config/defaults.js:115` `fallback: true, // Fallback using full viewport/window`，
  传 `'force'` 时 `this.forceFallback = true`（`fullscreen.js:26`），
  于是走 `toggleFallback` —— 只是给容器加一个 CSS 类
  `plyr--fullscreen-fallback`（`defaults.js:372`），**在窗口内铺满，不是 OS 级全屏**。
- `DOC CLAIM` Plyr README 也这么写：「`fallback`: Allow fallback to a full-window solution
  (`true`/`false`/`'force'`)」。
- `INFERENCE` Plyr 的「逃生口」是**有文档、有配置的**，比 video.js 干净。但它只能做到
  「填满窗口」，**做不到「让窗口变成 OS 全屏」**——真正把窗口变全屏仍必须由宿主自己做。

**Vidstack**（v1.15.7）
- `CODE FACT` 依赖第三方 `fscreen@^1.2.0`，产出的 chunk 里：
  ```js
  async enter() { ... return fscreen.requestFullscreen(this.el); }
  async exit()  { ... return fscreen.exitFullscreen(); }
  ```
  并派发自己的 `fullscreen-change` / `fullscreen-error` 事件。
- `INFERENCE` 仍是 DOM API（`fscreen` 是标准的 Fullscreen API 跨浏览器封装）；
  未发现宿主接管的扩展点。

**media-chrome**（v4.19.3）—— **唯一一个真正把「请求全屏」和「执行全屏」解耦的库**
- `CODE FACT` 全屏按钮不发命令，而是**派发可冒泡的 CustomEvent**：
  ```ts
  // media-fullscreen-button.ts:136-148
  const event = this.mediaIsFullscreen
    ? new CustomEvent(MediaUIEvents.MEDIA_EXIT_FULLSCREEN_REQUEST, { composed: true, bubbles: true })
    : new CustomEvent(MediaUIEvents.MEDIA_ENTER_FULLSCREEN_REQUEST, { composed: true, bubbles: true });
  ```
  （`constants.ts:10-11` 定义为 `'mediaenterfullscreenrequest'` / `'mediaexitfullscreenrequest'`）
- `CODE FACT` 事件的落点是 media-store 的 request map：
  `request-map.ts:276` `MEDIA_ENTER_FULLSCREEN_REQUEST` → `stateMediator.mediaIsFullscreen.set(...)`
  → `state-mediator.ts:1013-1025`：

  ```ts
  mediaIsFullscreen: {
    get(stateOwners) { return isFullscreen(stateOwners); },
    set(value, stateOwners, event) {
      if (!value) { exitFullscreen(stateOwners); }
      else { enterFullscreen(stateOwners); ... }
    },
    rootEvents: ['fullscreenchange', 'webkitfullscreenchange'],
  ```
- `CODE FACT` **这个 `stateMediator` 是可注入的**：
  `media-store.ts:110` `stateMediator?: StateMediator;`、`:123` 默认取 `defaultStateMediator`；
  `media-controller.ts:164` `createMediaStore({...})`、`:199` `set mediaStore(value)`。
- `INFERENCE` 所以 media-chrome 是**唯一在源码层面允许宿主替换全屏实现、同时复用整套控制条
  与状态机**的库。代价是要自己写一个 store，且要理解它的 state/request 模型。

**Shaka Player**（v4.16.4）
- `CODE FACT` `ui/controls.js:819-820`：
  ```js
  const fullScreenElement = this.config_.fullScreenElement;
  await fullScreenElement.requestFullscreen({ navigationUI: 'hide' });
  ```
  `ui/ui.js:368` 默认 `fullScreenElement: this.videoContainer_`。即**可以配置「全屏谁」，
  但不能配置「怎么全屏」**——仍然是 DOM API。
- `CODE FACT` 另有 `lib/polyfill/fullscreen.js` 做前缀 polyfill。

**react-player**（v3.4.0）
- `CODE FACT` 我在其 `dist/` 里检索 `requestFullscreen` / `fullscreenElement` /
  `webkitEnterFullscreen` / `exitFullscreen`，**全部零命中**——它自己不实现全屏。
- `CODE FACT` 它的 `dependencies` 是 `@mux/mux-player-react`、`youtube-video-element`、
  `hls-video-element` 等第三方元素；`README.md:169,199` 推荐的 `MediaFullscreenButton`
  正是 **media-chrome** 的组件。
- `INFERENCE` react-player 只是 provider 分发层，全屏能力完全取决于底层元素，
  **引入它对本问题没有任何帮助，只是多一层间接**。

#### 5.2 它们能不能解决「多显示器 + 失焦后指针事件不到达」

**不能。** 理由是一条可验证的代码链：

- `CODE FACT` 上述每一个库最终都落到同一句 `element.requestFullscreen(...)`
  （video.js `player.js:3025`、Plyr `fullscreen.js:258`、Vidstack chunk
  `fscreen.requestFullscreen(this.el)`、media-chrome `fullscreen-api.ts:50`、
  Shaka `controls.js:820`）。
- `CODE FACT` 而 Electron 内部（§1.2）把 `requestFullscreen` 落到**同一个原生
  `SetFullScreen`**，并且 Chromium 在 Windows 上用 `SWP_NOACTIVATE` 执行它（S13:109），
  Electron 侧也**不调用 `focus()`**。
- `CODE FACT` Blink 确实存在「页面必须 active 才做鼠标 hover 处理」的门禁：
  ```cpp
  // third_party/blink/renderer/core/input/mouse_event_manager.cc:390-397
  const bool should_page_receive_mouse_hover =
      frame_->GetPage() &&
      (RuntimeEnabledFeatures::SyntheticMouseHoverOverInactivePageEnabled() ||
       frame_->GetPage()->GetFocusController().IsActive());
  if (!should_page_receive_mouse_hover) {
    return;
  }
  ```
  `CODE FACT` 而能放宽它的开关在 `runtime_enabled_features.json5:6481-6484` 里的
  `status: "experimental"`——**不是默认开启**。

`INFERENCE` 结论：**换成 video.js / Plyr / Vidstack / react-player / Shaka 中的任何一个，
全屏行为与现在用 `element.requestFullscreen()` 逐字等价**，问题会一模一样地复现。
media-chrome 是唯一能改变这条链的库，但改变的方式是「让宿主自己写全屏实现」——
而这恰恰是本项目**已经直接做到了**的事。

---

## 五、对本项目当前实现的评价

现状（`git log`）：

- `91c66a9` 播放器全屏改用 Electron 原生窗口全屏
- `05ee85c` 窗口重新获得焦点时唤醒控制条

代码位置：`main.js:3514-3536`（IPC）、`preload.js:40-47`、
`src/App.jsx:70-75`（`exitPlayerFullscreen` 统一出口）、
`src/components/Player.jsx:813-827`（`toggleFullscreen`）、
`src/components/PlayerControls.jsx:54-131`（控制条唤出）。

### Good：值得保留的

- **`Good`** 用原生窗口全屏替代 DOM 全屏，方向与 Electron 自己测试套件的做法一致
  （S9 要求测试里先让窗口 key/focused）。这是本次调研能给出的**支持**结论。
- **`Good`** `main.js:3520-3531` 用「等 `enter-full-screen` 事件 + 3s 超时」而不是
  `setFullScreen` 之后立刻读 `isFullScreen()`——`main.js:3540` 的注释解释了为什么，
  这与官方文档「macOS 全屏切换异步，需依赖 `enter-full-screen` / `leave-full-screen` 事件」
  的指引（S1）是同一种严谨。**这个写法比文档要求得更保守，是加分项。**
- **`Good`** `App.jsx:70-75` 抽出 `exitPlayerFullscreen()` 单一退出出口，
  切页（`:101`）、切布局、进隐身小窗（`:79`）都调用它。
  这正好符合「多路径必须共享同一个 finalize 出口」的原则——避免了「漏掉一条分支就把用户
  留在没有侧边栏的全屏界面里」。注释也把这个理由写清楚了。

### Critical：`win.focus()` 是「一次性」的，救不了「之后才失焦」

- **`Critical`** `main.js:3533` `if (want) win.focus();` 在**进入全屏的那一刻**执行一次。
  但用户报告的场景是：进入全屏 → 控制条自动隐藏 → **之后**在别的屏上点了别的程序 → 移动鼠标唤不出。
  进入全屏时应用本来就是前台（用户点了全屏按钮），所以这一次 `focus()` 大概率是成功的；
  真正出问题的是**之后那一次失焦**，而此时没有任何代码会再调 `focus()`。
  - `INFERENCE` 也就是说：这次改动**很可能修好了它声称修的场景之外的某些情况**，
    而故障场景本身依赖的是 `05ee85c` 那条「窗口重新获得焦点时唤出控制条」的兜底
    （`PlayerControls.jsx:107-108`）。但那条兜底只在**窗口重新获得焦点**时生效，
    而「鼠标悬停在一个非前台窗口上」并不会让窗口获得焦点——**这个缺口仍然存在**。
  - **建议**：不要指望 `focus()` 兜住后续失焦。可以补一条：窗口 `blur` 时不隐藏控制条，
    或控制条隐藏后若检测到 `blur` 则保持可见/在下次 `pointerenter` 时唤出。
    另外要注意 `PlayerControls.jsx:84` 的 `onPointerMove` 会因
    「屏幕坐标与上次相同」而提前 return——失焦期间累积的移动不会被补投递，
    这会让「切回来时指针恰好没动」的情况更容易被感知成「坏了」（`05ee85c` 的注释自己也描述了这一点）。

### Major：隐身小窗与全屏的守卫是两个不同的真相来源

- **`Major`** `CODE FACT` 主进程侧：`src/native/stealth-window.js:33` 在进入隐身小窗时调用
  `win.setFullScreenable(false)`；而 `native_window_views.cc:824-826` 的
  `SetFullScreen` 开头是：
  ```cpp
  void NativeWindowViews::SetFullScreen(bool fullscreen) {
    if (!IsFullScreenable())
      return;                        // ← 静默 no-op，不报错
  ```
  也就是说 **`setFullScreenable(false)` 之后 `setFullScreen(true)` 会被静默忽略**。
  同时 `set-window-fullscreen` 的 IPC（`main.js:3515-3536`）**没有**像
  `set-window-layout`（`main.js:3553`）那样检查 `stealth.enabled`。
  渲染层的守卫是 `Player.jsx:814` 的 `if (document.querySelector('.stealth-mode'))` ——
  **一个 DOM 类名**，而主进程的约束源是 `stealth.enabled`。
  - `INFERENCE` 风险：一旦类名与主进程状态不同步（改名、渲染未及时更新、异常路径），
    用户会看到 `main.js:3528` 抛出的 `全屏切换超时`，而真实原因是
    「窗口被设为不可全屏」——**错误信息指向了错误的方向**。
  - **建议**：把守卫改成与 `set-window-layout` 一致的 `stealth.enabled` 检查，
    并在 `setFullScreen` 前用 `win.isFullScreenable()` 主动判断，
    像 `set-window-layout` 的注释那样「如实报错，不假装成功」。

### Minor：读写竞态与错误文案

- **`Minor`** `Player.jsx:820-821` 先 `getWindowFullscreen()` 再取反写回，
  两次 IPC 之间若被连点（按钮双击、或快捷键与按钮同时触发）会读到同一状态，
  导致两次切换互相抵消。原地加一个 in-flight 标志即可。
- **`Minor`** `Player.jsx:826` 的 `catch { showToast('无法进入或退出全屏，请重试') }`
  把两份不同的信息（进入失败 / 退出失败）合并成一句，且吞掉了 `result.error`。
  `main.js` 那边辛苦区分了「全屏切换超时」，到渲染层全丢了。
- **`Minor`** `main.js:3533` 的 `win.focus()` 之后没有校验 `win.isFocused()`。
  既然官方文档对 `focus()` 的 Windows 行为只字未提（§3.3），
  这里至少值得把「focus 之后实际有没有拿到前台」记进日志，否则以后再出问题还是只能靠 MCP 抓现场。

### 关于原判断的一处纠正（§六）

见下节——**根因的方向是对的，但机理描述与微软文档不符**。

---

## 六、与我不同的判断（直接指出，不迎合）

### 6.1 「鼠标消息被投递给那个前台窗口」——这个机理与微软官方文档不符

commit `91c66a9` 的说明里写：

> 结论：DOM Fullscreen API（stage.requestFullscreen）**不会让窗口成为前台窗口**。
> 用户在另一块屏上点过别的程序后，**鼠标消息被系统投递给那个前台窗口**，
> 播放器所在窗口收不到 pointermove

前半句（DOM 全屏不置前）**被本文 §1.2 / §3.2 的源码证实，我完全同意**。
但后半句的机理不是 Windows 的实际行为。微软官方文档两处说得很清楚：

> `DOC CLAIM`（S19，Mouse Input Overview）
> "When a mouse event occurs, the window that contains the hot spot typically receives the
> mouse message resulting from the event. **The window need not be active or have the
> keyboard focus to receive a mouse message.**"

> `DOC CLAIM`（S20，`WM_MOUSEMOVE`）
> "Posted to a window when the cursor moves. **If the mouse is not captured, the message is
> posted to the window that contains the cursor.**"

`INFERENCE` 也就是说：Win32 层面，`WM_MOUSEMOVE` 发给**光标下的窗口**，而**不是**前台窗口。
副屏全屏时红果窗口正好在光标下（commit 里 MCP 的命中测试
`HIT(-540,1440) = 红果窗口的 Chrome Legacy Window` 正是证据），
所以 **WM_MOUSEMOVE 事实上是送到了红果窗口的**。

那为什么症状仍然成立？`INFERENCE`（证据只能支持到这一步，我明确标注为推断）：
消息送到了 win32 窗口，但 **Chromium/Blink 在「页面不是 active」时会抑制 hover/指针语义**。
本文 §5.2 引到的 `mouse_event_manager.cc:390-397` 是一条直接证据——
它要求 `GetFocusController().IsActive()` 才继续做鼠标 hover 处理，
而放宽它的 `SyntheticMouseHoverOverInactivePage` 是 `experimental`（非默认开启）。
至于主分发路径上是否还有别的 active 门禁，**我没有把整条链读完，无法给出确证**。

- **为什么这个区别重要**：如果机理是「消息没送到」，那么修法应该是「让窗口变前台」
  （本项目现在的修法）；如果机理是「消息送到了但被渲染层丢弃」，
  那么**「让窗口变前台」只是碰巧同时也能让页面变 active，是间接修法**。
  这解释了为什么 §五 里那条 `Critical`——「一次性 `focus()` 救不了之后的失焦」——
  会成为一个真实的缺口。
- **建议**：正文里把「鼠标消息被投递给那个前台窗口」改成更准确的表述，例如
  「窗口不是前台 → 页面不是 active → Chromium 不再把鼠标移动当作 hover/指针活动处理」，
  并注明这是推断。这样以后有人照着 commit message 去查 Win32 行为时才不会绕远路。
- **我没有推翻结论**：修复方向（用原生全屏 + 让窗口成为前台）依然是对的，
  而且和 Electron 自己测试套件的做法一致（S9）。

### 6.2 「DOM 全屏比原生全屏在多显示器下更不可靠」——这个前提需要限定

`CODE FACT` 按 §1.2 读到的实现，**DOM 全屏和原生全屏在窗口层走的是同一个
`SetFullScreen`**，而 Chromium 在 Windows 上执行全屏时用的是
「窗口当前所在显示器」（`MONITOR_DEFAULTTONEAREST`，S13:104）。
`INFERENCE` 所以「多显示器」本身**不是** DOM 全屏特有的弱点——
换屏不会因为用了 DOM API 而出错。真正的变量是「窗口是不是前台 / 页面是不是 active」，
而那与是否多显示器**只是相关、不是因果**：主屏不容易触发，是因为用户本来就主屏操作、
焦点天然在本窗口（这一点 commit message 自己也写了，我认为是对的）。

- **建议**：`main.js:3519` 附近的注释「多显示器下比 DOM 全屏可靠」
  改成「多显示器场景更容易暴露：窗口失焦后页面不再 active，控制条唤不出」，
  把因果写在真正的变量上。`preload.js:40` 的同类注释一并调整。

### 6.3 一个可能被忽略的官方钩子

`CODE FACT` §1.1 提到 Electron 的 `session` 支持 `fullscreen` 权限拦截
（S5；实现见 `web_contents_permission_helper.cc:260-266`）。
`INFERENCE` 如果将来还需要保留 DOM 全屏的某条路径（比如给某个内嵌 webview），
可以用 `setPermissionRequestHandler` **拒绝** `fullscreen`，
让请求方拿不到 DOM 全屏，再引导到宿主的原生全屏。
这比去替换播放器库的 `fsApi_` 内部属性要干净得多，也完全是官方支持的路径。
本项目目前用不上（自研播放器），但值得记在案。

---

## 七、现成轮子的最终取舍

| 方案 | 取舍 | 结论 |
|---|---|---|
| 引入 `electron-window-state` | 只解决窗口位置/尺寸的持久化，`CODE FACT` 源码**无任何 focus 逻辑**，且恢复全屏时会再制造一次「全屏但没置前」；Electron 已有一方 `windowStatePersistence`（S4，_Experimental_） | **不引入** |
| 引入 video.js / Plyr / Vidstack / Shaka | 每个都最终落到同一个 `requestFullscreen`（§5.1），对本问题**行为等价**；且会与项目现有弹幕、Anime4K、隐身小窗、自定义快捷键全面冲突 | **不引入** |
| 引入 `react-player` | `CODE FACT` 它自己不实现全屏，只是 provider 分发层，推荐用 media-chrome 的按钮 | **不引入** |
| 引入 media-chrome | **唯一**有真宿主接管点（可注入 `stateMediator`，§5.1）。但代价是整套控制条要重写并迁移到它的 state/request 模型，而它能给的东西——「全屏由宿主实现」——**项目已经自己做到了** | **不引入** |
| 改用 `app.focus({ steal: true })` | `DOC CLAIM` `steal` 是 **macOS 专属**（S2），Windows 上无此语义 | **不适用** |
| 加 `win.show()` | `DOC CLAIM` 官方文档承诺 "Shows and gives focus to the window."（S1），是文档层面最接近「可靠置前」的方法；`CODE FACT` 实现里确实显式 `widget()->Activate()`（`native_window_views.cc:620`） | **可选**，作为 `focus()` 之外的补充，但仍受 foreground lock 约束 |
| 社区 `setAlwaysOnTop(true/false)` 把戏 | 有实测副作用（Windows 11 拉起无关窗口）；**无官方背书** | **不建议** |
| 保持自研：原生全屏 + 焦点兜底 | 代码量约十几行，且**已经落地**；不存在可替代的库 | **维持现状，补齐兜底** |

**总的取舍（`INFERENCE`）**：这个问题的可复用部分太小、平台相关性太强，
自研是对的；但**「自研」不等于「已经做完」**——§五 的 `Critical` 指出的
「一次性 focus 救不了后续失焦」是当前实现里仍然存在的真实缺口，
它才是用户报的那个场景的最终落点。

---

## 八、复现与核对方式

本文档的源码引用取自以下可复现取法（2026-10-14）：

```bash
# Electron 文档与源码（raw）
curl -sL https://raw.githubusercontent.com/electron/electron/main/docs/api/browser-window.md
curl -sL https://raw.githubusercontent.com/electron/electron/main/shell/browser/native_window_views.cc
curl -sL https://raw.githubusercontent.com/electron/electron/main/shell/browser/api/electron_api_web_contents.cc

# Electron 已合并 PR 的 diff（含关键注释）
curl -sL https://patch-diff.githubusercontent.com/raw/electron/electron/pull/54883.diff

# Chromium 源码（googlesource 的 TEXT 格式需要 base64 -d）
curl -sL "https://chromium.googlesource.com/chromium/src/+/main/ui/views/win/fullscreen_handler.cc?format=TEXT" | base64 -d
curl -sL "https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/core/input/mouse_event_manager.cc?format=TEXT" | base64 -d

# 库的真实发布产物（比 main 分支更贴近「用户实际会装到什么」）
curl -sL https://registry.npmjs.org/video.js | python3 -c "import json,sys;print(json.load(sys.stdin)['dist-tags'])"
curl -sL https://registry.npmjs.org/plyr/-/plyr-3.8.5.tgz -o plyr.tgz && tar xzf plyr.tgz
curl -sL https://registry.npmjs.org/media-chrome/-/media-chrome-4.19.3.tgz -o mc.tgz && tar xzf mc.tgz
```

核对「Electron 的 DOM 全屏最终调用原生 `SetFullScreen`」只需一条命令：

```bash
curl -sL https://raw.githubusercontent.com/electron/electron/main/shell/browser/api/electron_api_web_contents.cc \
  | grep -n "owner_window_->SetFullScreen"
```

核对「Chromium 全屏不激活窗口」：

```bash
curl -sL "https://chromium.googlesource.com/chromium/src/+/main/ui/views/win/fullscreen_handler.cc?format=TEXT" \
  | base64 -d | grep -n "SWP_NOACTIVATE"
```
