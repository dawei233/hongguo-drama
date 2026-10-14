# ADR-0002：加密 App 片源改为「边解密边播」

- 状态：**已实施，真机未验证**（单元/离线回归全绿；起播速度需要真机 + 真片源实测，本文不宣称已解决）
- 日期：2026-10-15
- 基线：commit `6c02aa0` + 工作区（渲染层另有并行改动，见文末「边界」）
- 相关文件：`main.js`（`prepare-online-play` / `STREAM_SCHEME` 处理器 / 在线缓存与回收 / 兼容模式输入）、
  `src/native/progressive-media.js`、`src/native/progressive-media.test.cjs`、`scripts/check-app-media.cjs`
- 上游参考：用户自有项目 `dawei233/hongguo-monorepo` 的 `hongguo_core.py`（同片源实测数据，见 §1）

## 1. 问题

用户抱怨"缓冲慢"。加密的 App 片源（`playInfo.contentKey`，CENC）在改造前要跑**三遍整集数据**才可能播放：

1. **CODE FACT** `main.js:fetchDecryptedEpisodeOnce`（改造前 `:2107-2137`）：整集下载到 `encrypted.mp4`。
2. **CODE FACT** `main.js:decryptContentKeyFile`（改造前 `:2055-2099`）：`-movflags +faststart` 整集解密 remux。
   `+faststart` 必须写完整个文件才能把 moov 前置 → **写完才能播**。
3. **CODE FACT** 解密结果 `fsp.readFile` 整个进内存，再由 `bufferedMediaResponse` 供给。

**DOC CLAIM**（用户项目注释 + 其 PC 版实测）：让 ffmpeg 直接读远端 URL、一边解密一边写**分片 MP4**
（`-movflags frag_keyframe+empty_moov+default_base_moof`），写到约 21MB / 约 2 秒即可起播；
产出不含 CENC 信令 box，解码 0 错误。
**INFERENCE**（未在本仓库复现）：分片 MP4 的 moov 为空且排在最前，所以"写到哪就能播到哪"；
Chromium 对「200 + chunked + 无 `Content-Length` + 不支持 Range」按流式源处理，边到边播
（代价：`duration` 为 `Infinity`、此阶段不能拖动）。

## 2. 决策

**加密 App 片源改走"ffmpeg 直读远端地址 → 边解密边写分片 MP4 → 够播的一小段落盘就返回地址"，写完后终态化。**

主进程侧规则（全部落在 `main.js`）：

1. **起播门（R3 兜底）**：`prepare-online-play` 不等整集，但也不返回"零字节的流"——
   等到分片文件 `PROGRESSIVE_FIRST_BYTES = 256 KiB`（empty_moov 让 moov 排在最前，这个量已含完整
   init segment），或生产者正常结束；上限 `PROGRESSIVE_FIRST_BYTES_TIMEOUT = 20s`：
   超时且有字节 → 放行（界面显示"正在加载视频…"），超时且零字节 → **如实失败**（`mediaRetryable`，
   走既有换候选/恢复路径）。等待期间照发 `online-play-progress`，既有占位层不消失。
2. **供给**：`STREAM_SCHEME` 在 `entry.filePath`/`entry.buffer` 之后新增 `entry.stream` 分支 →
   `createGrowingFileStream`（读到 EOF 等生产者、生产者结束才收尾），响应
   **200 + `video/mp4` + `Cache-Control: no-store`，不带 `Content-Length`/`Accept-Ranges`**，忽略 Range。
3. **终态化**：生产者正常结束 → 本地 remux `-c copy -movflags +faststart`（不带密钥）到
   `entry.disk.directory/video.mp4`，ffprobe 校验有有效视频轨与时长后：
   `state.finalized/filePath/size` 置位 → 供片改走既有 `diskMediaResponse`（Range、时长、拖动）；
   同时把该条目按既有规则放进 `onlineCache`。终态化失败**不打断正在播的分片流**，只是不入缓存、不可拖动。
4. **不在"读到一半"时换媒体表示**：只有 `!state.readers`（本次流式响应已读完）才切到终态文件。
   分片 MP4 与 faststart MP4 字节布局不同，混进同一个解复用器会解析错乱（**INFERENCE**，按保守取舍处理）。
5. **所有权**：写入进程的生死只看"还有没有会话持有这份分片流"（`stopProgressiveStream`），
   与 `disposeOnlineDisk` 同一原则；**最后一个持有者**才停进程、才删临时目录。
6. **缓存与回收语义**（本次最容易改坏的地方，逐条对照既有实现）：
   | 既有机制 | 本次处理 |
   |---|---|
   | `onlineCache` 只放"已完成"条目 | 流式进行中的条目 **`complete` 保持 false，根本不进 `onlineCache`**，另存 `onlineStreaming`（vid → 在途 state） |
   | `trimOnlineCache` 按 `size` 淘汰最久未用 | 在途条目不在缓存 ⇒ 不会被淘汰逻辑删掉正在写的文件；终态化后带真实 `size` 入缓存，照旧参与淘汰 |
   | `disposeOnlineDisk` 惰性删目录（有读者/仍在缓存里则保留） | 流式响应也累计 `entry.disk.readers`（与 `diskMediaResponse` 同一套账），并在响应收尾出口重试一次回收；目录清理因此不会删掉正在读的文件（Windows 删除被占用文件会失败） |
   | `releaseOnlineSession`（切集/卸载/清缓存都会调用） | 先 `stopProgressiveStream` 停写盘进程 → 再取消在途响应（读者计数归零）→ 再 `disposeOnlineDisk`；最后一个持有者释放时进程被 abort 信号结束，不留孤儿进程 |
   | `onlineCache` 条目被下载/兼容模式复用 | 兼容模式输入新增 `cached?.complete` 前置校验（见 §3.4） |
   | 终态化后分片文件 | 分片只为边写边播存在：终态化成功且无读者时删除，避免缓存里长期留两份同内容文件 |

**不改**：`spadeA` 仍走 worker 整集解密（`decrypt-worker.cjs` 是 buffer API，没有 ffmpeg 命令行路径）；
HLS 仍整份下载 + remux（`prepareHlsEntry`）；明文片源的惰性代理供给不变。

## 3. 被否决的方案

### 3.1 去掉 `+faststart`，写完整集再播（其余不变）
否决。仍然要等整集下载 + 整集解密，用户抱怨的根因没动。

### 3.2 自建 relay：自己剥离/重写 MP4 box，把解密后的字节自己喂给播放器
否决。等于在 JS 里重做一个 MP4 复用器 + CENC 解密，`saiz/saio/senc` 三种布局都要自己处理，
而且**自建 relay 无法替代 CDN/文件层的 Range 语义**（这正是本项目"自建 relay 出 Range/seek bug 就应当让开"的教训）。
交给 ffmpeg 做，它本来就有 `-decryption_key` 与分片输出。

### 3.3 用 Chromium 的 EME（Widevine/CENC）自己解密播放
否决。需要 license server 与 CDM；本项目的片源密钥是 App 协议下发的自有密钥，没有 EME 通路。

### 3.4 兼容模式的输入"等终态化完成"
**在途条目绝不进 `onlineCache`**（第 6 条），兼容模式因此拿不到半成品；再补一道
`cached?.complete && cached.filePath` 前置校验。选择**拒绝而非等待**的理由：
等待意味着让主进程把一份不完整的解密输入挂住（可能整集时长），而兼容模式本来就是"用户可见的显式重建"操作；
拒绝是**可恢复**的——该集终态化完成并入缓存后，重试即命中 `cached.filePath`；即使会话已释放，
只要条目还在 `onlineCache` 里，终态文件就不会被删（`disposeOnlineDisk` 的既有语义）。
渲染层侧的配合见 §6.2。

### 3.5 顺带把 `spadeA`（worker 解密）也改流式
否决（本次范围外）。worker 是"整块 buffer 进、整块 buffer 出"的接口，要流式得先把 worker 改成
增量解密（还涉及 `saiz/saio` 布局判断）。单独一件事，别混在这次里。

## 4. 架构

```
prepare-online-play (contentKey)
  └─ startProgressiveOnlineEntry
       ├─ 同 vid 同片源已在途？→ 复用（不为同一集起第二个 ffmpeg）
       ├─ createDecryptStream: ffmpeg -decryption_key K -i URL -c copy
       │                        -movflags frag_keyframe+empty_moov+default_base_moof video.part.mp4
       ├─ waitForProgressiveStart（阈值/超时/失败/取消）
       └─ entry = { stream: state, disk, streamPath, playInfo }   ← complete 保持 false
                                  │
STREAM_SCHEME://play/<id> ────────┼─ entry.filePath（终态化后）→ diskMediaResponse（Range/拖动）
                                  ├─ entry.stream.finalized && !readers → diskMediaResponse
                                  ├─ entry.stream.result 是错误      → 502（让播放器走恢复路径）
                                  └─ 否则 → progressiveMediaResponse（200 + chunked，不带 CL/Accept-Ranges）
                                                     └─ createGrowingFileStream(onClose = 唯一收尾出口)
生产者结束 → finalizeProgressiveEntry
  ├─ remuxFragmented（本地 -c copy +faststart）→ video.mp4
  ├─ ffprobe 校验（半成品不得当完整产物）
  ├─ state.finalized/filePath/size；删分片文件（无读者时）
  └─ 仍是"当前那唯一一份在途流"→ onlineCache.set + trimOnlineCache；发一次 phase:'ready'
```

## 5. 验证

全部离线、可复现（`node <script>`）：

- `src/native/progressive-media.test.cjs` **11/11 PASS**（原 8 项 + 3 项新增）
- `scripts/check-app-media.cjs` **8/8 PASS**（按新契约改写，见 §5.2）
- `scripts/check-streaming.cjs` PASS、`check-media-recovery.cjs` PASS、
  `check-online-disk-lifecycle.cjs` PASS、`check-media-access.cjs` PASS、`check-compat-lifecycle.cjs` PASS
- `npm run build:react` 成功；`for f in scripts/check-*.cjs; do node "$f"; done` 的失败项与改动前一致
  （环境类：缺 macOS lipo / 缺 Windows EXE / 缺打包 ffmpeg / 需夹具路径 / 需 CLI 参数；渲染层并行改动导致的
  `check-player-controls` 漂移；`check-ui-state` 早已失效）——**未新增失败**

### 5.1 交付模块里发现的 Critical 缺陷（本次最重要的收获）

**CODE FACT**：`createGrowingFileStream` 原实现在"读到 EOF 但生产者仍在写"这条路径上
`await wait(pollMs); return;`（**不入队**）。按 ReadableStream 语义，pull 完成回调只在
"入队 / 新的 `read()` 请求 / 上一次 pull 尚未完成"时再次触发；此路径下消费者正阻塞在 `read()` 上、
不会产生新请求 ⇒ **pull 再也不会被调用，流永久停住**。
实测：`node src/native/progressive-media.test.cjs` 在第 5 项起永久挂住（前 4 项通过后无输出，
进程最后静默 `exit 0`——事件循环空了），也就是"线上声明 8 项已通过"来自对这个现象的误读。

修复（最小改动，API 不变）：把等待循环放进 `pull` **内部**（pull 的 promise 一直挂到"有数据"或
"生产者结束"），`cancel`/`abort` 能唤醒等待，并新增 **`onClose` 单一收尾出口**（EOF/出错/cancel/abort 恰好调用一次）。
新增 3 个测试，其中：
- 「回归：EOF 处等待生产者时必须继续送出迟到字节（不得死锁）」带 **3 秒看门狗**，
  把"挂住"变成"失败"；已用旧实现验证：看门狗胜出 ⇒ 旧实现下该测试**失败**，不挂住。
- 「同一集在途解密……写入进程跟随'最后一个持有者'」已用"去掉 `owned` 守卫"的临时改动验证过会失败（回归有牙）。

### 5.2 `check-app-media.cjs` 的契约变更（原断言锁的是旧设计）

原文件三条**实现细节**断言与新设计逻辑上不可共存，已按新契约改写，并**保留了全部安全断言**：
`streaming` false→true；一次播放会看到两次 ffmpeg（解密一次带密钥、终态化一次不带密钥）；
播完临时目录里有分片/终态文件（不再是"内存里、磁盘全空"）。
安全断言一条未放宽：密钥不进日志/不进错误信息、非法密钥不启动原生进程、取消要杀进程且不留残留文件；
并补：不留孤儿进程、半成品不得被当成完整产物（在途条目不在 `onlineCache`）、
流式响应未结束时不得切换媒体表示、兼容模式不得把半成品当输入且拒绝后可恢复。
文件顶部与相关断言处都写明了"这是随流式化改造更新的契约"。

## 6. 风险与未决事项

### 6.1 必须真机验证的清单（本文不宣称"缓冲慢已解决"）
1. **起播耗时**：真片源上 `PROGRESSIVE_FIRST_BYTES`(256 KiB) 与 20s 超时是否合理；ffmpeg 从远端
   取到第一个 moov 需要多久（CENC 片源的 moov 可能在文件尾部，ffmpeg 需要一次 Range 才能开始写输出）。
2. **Chromium 的实际判定**：本机 `hongguo-stream://`（自定义协议 + `stream: true`）下，
   200 + chunked + 无 `Content-Length`/`Accept-Ranges` 是否真被当作流式源；`duration`/`seekable`/`buffered`
   的真实取值（仓库内此前无任何记录）。
3. **解码正确性**：分片 MP4 在 Windows/macOS 上 HEVC/AVC 是否都能起播（本仓库的 HEVC 兼容性问题见 `transcode-for-playback`）。
4. **终态化后的拖动**：同一 URL 后续请求改走 `diskMediaResponse` 后，渲染层是否真的能拿到 duration 并允许拖动。
5. **真机参数**：临时目录所在卷的剩余空间（分片 + 终态文件各一份，直到终态化删分片）。

### 6.2 需要渲染层配合的点（本次**没有**改渲染层）
- **R5（Major）准备期反馈**：`prepare` 立即返回后，`onlineProgress` 占位层几乎立刻消失。
  主进程已做到：等待起播门期间照发 `phase:'downloading'` 进度事件，占位层仍可见；
  但拿到地址后只有 `Player.jsx` 的 `mediaBuffering`（"正在加载视频…"）一个反馈，`PlayerControls` 无缓冲指示。
  **需要渲染层**：新增"正在准备（流式）"状态，或至少让 `onlineProgress` 覆盖到首个 `canplay`。
- **R8（Major）断点续播**：`handleMetadata` 一次性应用并清零 `pendingSeekRef`。分片阶段 `duration` 通常为
  `Infinity`（该分支成立、能跳），但若首帧 metadata 时 duration 尚未确定且小于 `seekTo + 3`，跳转被静默跳过。
  **需要渲染层**：改成"可重试的 seek"（例如 duration 变化时重试一次），不要依赖一次性 metadata。
- **R3 残余**：起播门大幅降低"零字节流"概率，但流式阶段若生产者中途失败，主进程只能结束流
  （200 已发出，无法改成错误码）→ 渲染层会看到媒体错误并按既有 `onError`(2/4) 走重连/下载兜底。
  **需要渲染层**：把"仍在缓冲中"（`buffered` 未到、`readyState < 2`）与"片源不可用"区分开，
  避免把缓冲中的正常状态误判成片源故障（`scripts/check-player-fallback.cjs:100-107` 固化了旧契约）。
- **R9 配合**：兼容模式在"该集仍在流式、尚未终态化"时会拒绝并回落到整集取源（可恢复但慢）。
  渲染层若要更好的体验（等一会儿再重试兼容），可用主进程新增的 `phase:'ready'` 事件作为信号
  （它在终态化完成时发给该 vid 的所有活动会话；注意 `Player.jsx:407` 会在 `request.prepared` 后丢弃进度事件，
  要用它必须新增钩子）。

### 6.3 已知取舍
- 流式阶段 `Content-Length` 未知 ⇒ 进度百分比恒为 0（只有"已写 X MB"可算）；界面文案需要渲染层配合（R6）。
- 同一 URL 在"流式响应进行中"与"终态化后"是两种媒体表示；主进程保证不在读到一半时切换（§2.4），
  代价是**首次播放期间仍不能拖动**，拖动力在后续请求（重播/重试/重新取源）才恢复。
- `spadeA`、HLS 两条路径仍是"整集准备好了才播"，本次未改。
- Windows 上删除被占用的文件会失败：已按既有 `disk.readers` 习惯在响应收尾出口重试一次回收，
  但极端时序下仍可能残留一个临时目录（下次清理/重启后由系统 temp 清理）。

## 7. 维护提示
- **密钥绝不进日志**：`runMediaFfmpeg` 是唯一跑本地 ffmpeg 的入口，统一丢弃 stderr；新增调用一律走它。
- **在途条目绝不进 `onlineCache`**：这是"半成品"防线的根；要加入缓存，必须先 `complete`。
- **写入进程的生死只看 `onlineStreaming` / `stopProgressiveStream` 的持有关系**，不要在别处直接 kill，
  否则"切集"会杀掉另一个会话正在读的写盘进程。
- **分片文件的删除交给"唯一收尾出口"**（`createGrowingFileStream({ onClose })` / `removeProgressivePartWhenIdle`）；
  不要自己再包一层流做收尾。
- 新增/修改任何"读增长中的文件"的代码前，先读 `progressive-media.js` 顶部注释里的死锁成因。
