# PC 版「副屏全屏后控制条不可见」踩坑记录

核对时间：2026-10-14
**当前状态：未解决。** 到 v1.72.9 为止共发布 5 个版本尝试修复，真机均未解决。

本文的目的不是宣布结论，而是**把已排除的方向、已确证的事实、以及下一步的决定性诊断方案固定下来** ——
因为这个问题的排查过程中，我（AI 维护者）连续几轮在错误方向上投入，用户的一句现象描述就推翻了我的主假设。
记录下来，后续排查不必重走。

---

## 一、症状（按轮次，用户原话）

| 轮次 | 用户报告 | 当时版本 |
|---|---|---|
| 1 | 「放到副屏以后全屏。下面设置消失以后动鼠标没用不会再出来了。只能 esc 退出全屏才行」 | 1.72.2 |
| 2 | 「副屏的问题没修复。主屏幕现在有问题了没法正常全屏了，而且音量不能记录」 | 1.72.6 |
| 3 | 「第三项还是没修复」（并提出参考其自有项目） | 1.72.7 |
| 4 | **「控制条不是没出来。是出来了我看不到。下面是全黑的。我把鼠标放下去。盲点是可以控制的」** | 1.72.8 |
| 5 | 「还是没修复」 | 1.72.9 |

**第 4 轮是唯一一次真正推进认知的输入**，它把问题从"唤出失败"改写为"绘不出来"。

环境（实测）：主屏 `DISPLAY1` 3840×2160 横屏、缩放 1.5；副屏 `DISPLAY2` 1080×1920 **竖屏**、
位于 **x 负半轴**（`-1080,481`）、缩放 1.0。即**混合 DPI + 负坐标副屏**。

---

## 二、已确证的事实

标注约定：`CODE FACT` = 读过源码/实测得出；`DOC CLAIM` = 一手文档；`INFERENCE` = 推断。

1. `CODE FACT` **Electron 的 DOM 全屏与原生全屏在窗口层是同一套实现**。
   `WebContents::SetHtmlApiFullscreen()` 最终调用 `owner_window_->SetFullScreen(...)`，
   函数体内没有任何 focus/激活调用；Chromium 在 Windows 用
   `SetWindowPos(..., SWP_NOACTIVATE | ...)` 执行全屏 —— **全屏动作本身不激活窗口**。
   出处见 `docs/research/electron-fullscreen-multimonitor.md` §1。

2. `DOC CLAIM` **`WM_MOUSEMOVE` 发给"光标下的窗口"，不是前台窗口**，且不需要窗口处于激活状态
   （Microsoft Learn, Mouse Input Overview / `WM_MOUSEMOVE`）。
   我在 commit `91c66a9` 里写的「鼠标消息被投递给那个前台窗口」**是错的**，已在后续 commit 更正。

3. `CODE FACT`（本地可复现）**旧 CSS 存在"能点但看不见"的窗口期**。
   控制条显示/隐藏原先只靠 `transition: opacity .18s`。实测（容器 Chromium + 真实构建产物）：

   | | 去类后**立刻** | 下一帧 | 250ms 后 | pointerEvents |
   |---|---|---|---|---|
   | 旧 CSS | **0** | 0.262 | 1 | **auto** |
   | 新 CSS（显示侧 `transition: none`） | **1** | 1 | 1 | auto |

   即 `pointer-events` 是离散属性、立即生效，而 `opacity` 需要过渡推进。
   过渡一旦不推进，`opacity` 就永久停在 0 —— 现象正是「点得到、看不见」。

4. `CODE FACT`（本地复现）**播放器布局本身没问题**。
   用真实 CSS + 1080×1920 竖屏视口渲染 `.app-layout.player-fullscreen` 与
   `.layout-portrait + .player-window-fill` 两种布局，控制条都正常绘制在底部。
   所以**不是布局/定位错误**。

5. `CODE FACT` 竖屏布局下，播放器「全屏」走的是前端 `setWindowFill`（CSS 模式），
   **窗口并不是 Electron 原生全屏**，`win.isFullScreen()` 为 `false`。
   副屏正是竖屏，因此这条路径优先级很高。

---

## 三、被排除 / 已被削弱的假设

| # | 假设 | 检验方式 | 结论 |
|---|---|---|---|
| 1 | 焦点是根因，改用原生全屏可修 | Windows-MCP 受控实验：失焦→控制条不可见；强制置前→可见 | **方向错**。焦点确实与现象相关，但由事实 1，原生全屏并不改变焦点行为。v1.72.3~1.72.5 无效 |
| 2 | 鼠标消息被投递给前台窗口 | 对照微软文档 | **描述错误**（见事实 2） |
| 3 | 事件到不了渲染层（Blink 抑制 hover/指针语义） | 用户报告"盲点可点" | **被推翻**：能点说明唤出逻辑已执行、命中区域已存在 |
| 4 | `screenX/screenY` 在副屏不可靠，去重挡掉了真实移动 | 无直接证据 | **未证实**。已放宽为双信号取或（无害，保留） |
| 5 | 轮询被 `isFullScreen()` 门槛挡掉（竖屏走 windowFill） | 推断 | **未证实**，但由事实 5，该推断成立性较高 |
| 6 | `opacity` 过渡卡住导致不可见 | 本地实测机制成立（事实 3） | **机制存在，但真机 v1.72.9 无效** → 不是主因，或不是唯一原因 |
| 7 | 视频硬件覆盖层压住 DOM 覆盖层 | 加了 `will-change: opacity` 仍无效 | **未证实 / 被削弱** |

---

## 四、仍然未知（下一步必须回答的）

**最关键的一条：真机上控制条到底处于什么状态？** 三种可能，各自修法完全不同：

- **(A) 页面停止产生帧**（Chromium 判定页面不可见/被遮挡 → 不再重绘 DOM），
  而**视频走独立的覆盖层/合成路径仍在显示**。
  → 这能同时解释"视频在放、控制条不重绘、区域全黑、但仍可点击"。
  → 修法：阻止 Chromium 判定页面不可见（`backgroundThrottling` 等），或让控制条不依赖页面重绘。
- **(B) 控制条计算样式仍是 `opacity: 0`**（过渡/样式没生效）。→ 属于样式问题。
- **(C) 计算样式正常（opacity=1）、rect 也在视口内，但就是看不见**。→ 属于合成/图层问题。

我此前 5 轮都是**在没有区分这三种情况的前提下**改代码，这是最大的失误。

---

## 五、期间做过但未解决问题的改动（保留现状说明）

| 版本 | 改动 | 动机（当时的假设） | 现状 |
|---|---|---|---|
| 1.72.3~1.72.5 | 改用 Electron 原生窗口全屏 + 状态广播修复 | 假设 1 | 保留（用户明确要求过原生全屏；但**不解决本问题**） |
| 1.72.6 | 主进程轮询光标位置 | 假设 3 | 保留（无害的保险；非本问题原因） |
| 1.72.7 | `document` 上挂 `mousemove/wheel/mousedown`；轮询常驻 | 假设 3/4 | 保留 |
| 1.72.7 | **主屏全屏回归修复**（`.player-container` 未覆盖 `max-width:1000px`） | 用户报告 2 | **有效修复，保留** |
| 1.72.7 | **音量持久化** | 用户报告 2 | **有效修复，保留** |
| 1.72.8 | 放宽去重、轮询去掉全屏门槛 | 假设 4/5 | 保留 |
| 1.72.9 | 显示侧 `transition: none` + `will-change: opacity` | 假设 6 | 保留（本地确有改善，且不劣化）；**未解决本问题** |

诊断上报（渲染层每 2 秒写 `<userData>/pointer-diag.log`）目前仍在，用于下一步采集数据；
定位完成后应与上面那些为错误方向加的机制一并清理。

---

## 六、方法论教训（我认为最有价值的部分）

1. **无法在本地复现时，先上仪器，再上修复。**
   我在 5 个版本里"盲改"，而用户一句"盲点可以控制"一秒推翻了我的主方向。
   若第一轮就先采集 DOM/渲染状态并拿回真机数据，代价会小一个数量级。
   **写过 5 个 commit 才第一次拿到"控制条是否真的出现了"的直接证据，这是流程失败，不是运气不好。**

2. **用户的现象描述比我的实验推断更可靠。**
   我的 Windows-MCP 实验把"控制条不可见"误读成"控制条没被唤出"，据此推出了整条错误的技术路线。

3. **「能点但看不见」是具有辨识力的信号。**
   命中测试与绘制是两条独立路径。二者不一致时，应优先怀疑**绘制/合成**，而不是事件投递。
   我花了三轮才意识到这个不对称的含义。

4. **"机制存在" ≠ "这就是主因"。**
   `opacity` 过渡卡住在本地确实可复现，但真机无效。存在一个可复现的缺陷，不代表它就是当前故障的原因。

5. **先找现成的做法，再动手。**
   用户已提醒过一次「不重新造轮子」。其自有项目 `dawei233/hongguo-monorepo/pc` 在同一台机器、
   同一双屏环境下播放器工作正常，是**优先级最高的参考实现**，我一开始没有查。

6. **区分"我以为的故障"和"用户看到的故障"。**
   每轮都应先确认：用户看到的具体是什么？哪一部分是好的、哪一部分坏了？
   第 4 轮之前，我一直在修一个可能并不存在的事件投递问题。

---

## 七、下一步：决定性诊断方案

**不再盲改。** 先让真机把下列字段写进日志，据此判定属于 (A)/(B)/(C) 哪一类。

渲染层需采集（每 2 秒一次，窗口失焦期间尤其关键）：

| 字段 | 判读作用 |
|---|---|
| **`requestAnimationFrame` 计数** | **最关键**。若失焦期间该计数停止增长 → 页面已停止产生帧 → 命中情况 (A)，可解释全部现象 |
| `document.visibilityState` / `document.hidden` | 确认 Chromium 是否把页面判为不可见 |
| `document.hasFocus()` | 焦点状态 |
| 控制条的 `getComputedStyle().opacity / visibility / display` | 区分 (B) |
| 控制条与 stage 的 `getBoundingClientRect()` | 区分 (C)（是否在视口内） |
| `window.innerWidth/innerHeight`、`devicePixelRatio` | 窗口尺寸与 DPI |
| `screen.width/height/availWidth/availHeight` | 与窗口尺寸对照，判断窗口是否被撑到屏幕之外 |

主进程侧同时记录 `win.getBounds()`、`win.isFullScreen()`、`display.bounds/scaleFactor`。

**对照实验**：同时提供一个把 `webPreferences.backgroundThrottling` 设为 `false` 的构建版本。
若该版本恢复正常 → 直接确证 (A)，且修法明确。

判读表：

| rAF 计数 | opacity | rect 在视口内 | 结论 |
|---|---|---|---|
| 停止增长 | — | — | (A) 页面停止渲染 → 查遮挡/可见性判定 |
| 正常 | 0 | — | (B) 样式问题 → 继续查过渡/样式优先级 |
| 正常 | 1 | 否 | 布局问题（与本地复现矛盾，需重新核对真机布局） |
| 正常 | 1 | 是 | (C) 合成/图层问题 → 查视频覆盖层与 GPU 合成 |

---

## 八、可复现的核对方式

```bash
# 1) 本地复现「能点看不见」的窗口期（需把构建产物 CSS 内联进 HTML）
#    注意：容器浏览器拒绝 file://，需用 http 提供
cd /workspace/红果/refs/hongguo-drama && npm run build:react
ls dist-react/assets/*.css        # 取产物 CSS 内联进夹具页
#    夹具脚本：先加 controls-hidden、再移除，立刻读 getComputedStyle(el).opacity
#    并把结果写入页面文本后截图

# 2) 布局复现：用真实 CSS + 1080x1920 视口渲染
#    .app-layout.player-fullscreen.layout-landscape 与
#    .app-layout.layout-portrait + .player-stage.player-window-fill 两种布局

# 3) 调研文档（Electron/Chromium 源码与文档出处）
cat docs/research/electron-fullscreen-multimonitor.md

# 4) 真机诊断日志（安装版运行后产生）
#    %APPDATA%\红果短剧\pointer-diag.log
```

---

## 九、后续（2026-10-14 晚，用户决定转向）

用户在看到「竖屏版」切换按钮后做出决定：

> 「回滚之前的修复吧。我感觉把竖屏模式的真全屏搞好就行了。有没有可能这个软件的横屏全屏
> 和竖屏全屏的问题导致的。」

### 已执行：回滚

commit `c4be90b` 把本文第五章列出的全部尝试回滚到 `2c3f539`。保留与全屏无关的两项
（403/画质修复、音量持久化）以及全部文档。

### 已执行：竖屏真全屏

对照代码查清了根因性质：**基线里竖屏根本没有"真全屏"**。

```js
// 基线 Player.jsx::toggleFullscreen
if (portrait) { setWindowFill(fill => !fill); return; }   // 只加个 CSS 类
// .layout-portrait .player-stage.player-window-fill { position: fixed; inset: 48px 0 0; ... }
```

即：**横屏走 DOM 全屏、竖屏走"CSS 填满窗口"**，两条完全不同的路径，且竖屏那条还刻意
留出 48px 给工具栏 —— 用户"竖屏没有真全屏"的判断是准确的，这也印证了他对
「横竖屏全屏不一致」的怀疑。

改动（commit 见下）：

- 竖屏全屏改为 Electron 原生窗口全屏（`set-window-fullscreen` IPC），与横屏"整屏只留
  播放器"的观感一致；
- 新增 `.layout-portrait.player-fullscreen` 布局规则**（严格限定竖屏，横屏的 DOM 全屏
  路径不动）**，隐藏侧边栏/工具栏、播放器铺满。已按第五章教训处理：
  覆盖 `.player-container` 的 `max-width:1000px`、z-index 取 500（低于提示条 999）；
- 原生全屏不自带 Esc 退出，补了 Esc 处理（挂在 window 冒泡阶段，优先级低于菜单那套）；
- 退出全屏抽成 `exitPlayerFullscreen()` 单一出口，切页/切布局/进隐身小窗都走它；
- 移除已无用的 `windowFill`（状态、CSS 类、prop、测试桩），避免死代码。

**本地布局验证**（§8 的方法）：真实构建产物 + 1080×1920 视口，三种场景截图核对 ——
竖屏+真全屏（外壳隐藏、播放器铺满、控制条横跨全宽）、竖屏非全屏（保持原样）、
横屏非全屏（不受影响）。

**仍未解决**：本文 §四 的三种可能（页面停止出帧 / 样式仍隐藏 / 合成图层）**尚未取得真机
数据**。特别地，用户在 1.72.9 上反馈"还是没修复"时，测试的是**旧实现**（竖屏只有 CSS 填充、
横屏 DOM 全屏）；本轮换成竖屏原生全屏后，原来的现象路径已改变，需重新确认。
若新实现下仍出现"控制条能点但看不见"，§7 的诊断方案（尤其是 rAF 计数）可直接沿用。

---

## 十、决定转向：原样移植用户的播放器（2026-10-14 深夜）

用户明确指示：

> 「不止播放链。还有前台播放器。全屏丢失控制条的问题。现在版本的实现确实不行，
> 直接把我的切过来装进去。」

**范围经用户确认为「只换播放器」**：移植播放器 UI/交互 + 播放链，
**保留**本仓库其余功能（下载管理、弹幕、观看历史、设置、更新、CI 发布），**不引入 Python 运行时**。

### 为什么这次不再"自研"

前十节的结论是：我在无法本地复现的前提下反复重构控制条显隐与全屏实现，五轮无效。
用户自有项目（`dawei233/hongguo-monorepo` 的 `pc/`）在同一台机器、同一双屏环境下工作正常，
**照搬其已验证实现**比继续推测成本更低、也更可能一次到位。

### 对照后确认的两处关键技术差异

**1. 控制条显隐（源实现更稳，必须照搬）**

```css
.ctrl-bar { opacity:0; transition:opacity .25s; pointer-events:none; }
.player-wrap:hover .ctrl-bar, .ctrl-bar.show { opacity:1; pointer-events:auto; }
/* 全屏：主动禁用 hover，只允许 .fs-show 显示，且 !important 压过一切 */
body.fs-mode .ctrl-bar { opacity:0; pointer-events:none; }
body.fs-mode .player-wrap:hover .ctrl-bar { opacity:0; pointer-events:none; }
body.fs-mode .ctrl-bar.fs-show { opacity:1 !important; pointer-events:auto !important; }
```

JS 侧：`mousemove/keydown/wheel/mousedown` **全绑在 `document`**，任一活动即加 `.fs-show`，
3 秒无操作移除；`body.fs-mode` 由 Electron 原生全屏切换驱动。
本仓库原先由 React `controlsHidden` 状态驱动 `opacity`，**这正是被替换掉的部分**。

**2. 起播快（根因是数据要跑三遍）**

本仓库加密 App 片源原路径：整集下载到临时文件 → `-movflags +faststart` 整集解密 remux
（**+faststart 必须写完整个文件才能前置 moov**）→ 整个文件读进内存 → 才能供给播放。

源实现：让 ffmpeg 直接读远端 URL、一边解密一边写**分片 MP4**
（`-movflags frag_keyframe+empty_moov+default_base_moof`），写到约 21MB / 2 秒即可起播；
Chromium 把「200 + chunked + 无 Content-Length / 无 Range」判定为流式源边到边播。

已在 `src/native/progressive-media.js` 实现这两件事并配单元测试
（`createDecryptStream` / `createGrowingFileStream`）。

### 渲染层消费地图与必须先处理的既有契约

新增 `docs/research/renderer-playback-consumption.md`（421 行）记录了改造风险，其中三条必须先解决：

- **R3**：起播早期的 media error（2/4）会被 `Player.jsx:1394-1416` 误判成"片源不可用"，
  进而强制重取源甚至走整集下载兜底；这条链被 `scripts/check-player-fallback.cjs:100-107` 固化为契约。
- **R9**：兼容模式（HEVC→H.264）直接把在线条目的 `.filePath`/`.buffer` 当 ffmpeg 输入
  （`main.js:2452-2464`），改成"增长中的分片文件"会让它拿到半成品。
- **R12**：写完之前不得把条目登记进 `onlineCache`，否则第二次播放会拿到残缺文件且无校验兜底。

另有一条护栏早已失效，改造前应先修：

- **R14**：`src/components/check-ui-state.cjs` 在本仓库 HEAD 上是 **31 条测试 30 条 FAIL**，
  根因是它的沙箱 `require` 桩没跟上 `Player.jsx` 新增的导入
  （`./VideoEnhancement`、`./danmakuSource.mjs` 等）。它保护的正是"迟到的 prepare 结果不得覆盖新集"，
  与本次改造直接相关。该脚本未被任何 CI 或其它脚本引用。

---

## 十一、移植落地（2026-10-14 深夜）

### 已落地

**播放器（渲染层）**：按源逐字搬运 `.fs-show` + `!important` + 全屏禁用 `hover` 的显隐方案、
`attachAutoHideCtrls`/`detachAutoHideCtrls`（四个活动事件绑 document、3 秒隐藏）、
原生全屏驱动 `body.fs-mode`、以及播放器的**准备/下载覆盖层**（`NativePlayerOverlay.jsx`，
它独立订阅进度事件，绕开 `Player.jsx:407` 开始播放后即丢弃事件的限制）。

**播放链（主进程）**：加密 App 片源改为"ffmpeg 直接读远端 URL、边解密边写分片 MP4、
写到够播即返回地址"；终态化后同一 URL 后续请求走 Range（恢复拖动）。决策与被否决方案见
`docs/ADR-0002-progressive-encrypted-playback.md`。

### 期间发现并修掉的真实缺陷

1. **交付模块里的 Critical 死锁**（我写的 `createGrowingFileStream`）：按 ReadableStream 规范，
   `pull()` 在"读到 EOF 但生产者仍在写"路径上 `await` 后直接 return 且不入队时，pull 不会再次被调用
   → 永久死锁；事件循环随后空掉、进程静默 `exit 0`，**看起来像跑完了**。
   已修（等待循环移进 pull 内部 + 可唤醒 cancel/abort + `onClose` 单一收尾出口），
   并补**看门狗回归测试**。我亲自把旧实现还原复跑验证：旧实现下**退出码 1（失败）而不是挂住**。
2. **生命周期洞**：释放"创建流的会话"会误杀另一个复用同片源的会话的写盘进程 → 加 `state.owned` 守卫。
3. **工具提示回退**：移植后「全屏」按钮丢了快捷键提示（同一条控制条上其他按钮都在）→ 已补回。
4. **面板被一起隐藏（必要例外）**：控制条内嵌「更多播放选项 / 弹幕设置 / 画质列表」，
   照搬源机制会导致面板打开 3 秒后**连面板一起消失**。已加最小例外
   `holdAutoHideCtrls()`/`releaseAutoHideCtrls()`（计数式，可嵌套，`detach` 时归零），
   并已由 `scripts/check-native-auto-hide.cjs` 覆盖。

### 验证（我独立复核，非采信 agent 自述）

- `progressive-media.test.cjs` 11/11；单元测试层 9/9；`npm run build:react` 通过。
- `check-app-media.cjs` 8/8，安全断言保留（密钥只出现在解密那一次调用、不进错误信息、不留孤儿进程）。
- 全量 56 个 check 脚本：**失败项与移植前完全一致（10 个既有/环境类）**，无新增失败。

### 移植带来的行为变化（用户需知）

源的机制只有"有活动就显示、3 秒无操作隐藏"。以下本仓库原有耦合**随移植消失**：
暂停时保持可见、键盘焦点保持可见、拖动进度条保持可见、"切源/自动连播过程中不得唤出"。
面板打开时的可见性属缺陷、已单独补回。

### 仍需真机验证（本文不宣称"缓冲慢已解决"）

见 `docs/ADR-0002-progressive-encrypted-playback.md` §6.1：起播阈值（256KiB/20s）、
Chromium 对自定义协议 200+chunked 的实际判定、HEVC/AVC 解码、终态化后拖动、临时卷空间。
以及 §6.2 需渲染层配合的三点（准备期状态、可重试 seek、缓冲中与片源故障的区分）。
