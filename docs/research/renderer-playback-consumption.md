# 渲染层如何消费在线播放地址 —— 代码地图

- 调研对象：`/workspace/红果/refs/hongguo-drama`（Electron + React 中文短剧播放器）
- 基线：commit `6c02aa0`（2026-10-14 23:30），工作区源码与该提交一致（见文末「工作区状态」）
- 方式：**只读**。未修改任何既有文件；本文件是唯一新增产出。
- 标注约定：
  - **[事实]** 可直接在给出的 `文件:行号` 读到；
  - **[文档]** 仓库内文档的声明，非代码；
  - **[推断]** 我的推理，未在代码中直接证实；不确定处明确写「未找到/不确定」。

---

## 0. 结论速览（先看这五条）

1. **`prepare-online-play` 的返回值里，渲染层只消费 `success` / `url` / `streamId`（+`error`）。**
   `streaming`、`size`、`cached` 在渲染层**零消费**——`streaming` 全仓库只有主进程 `main.js:2221` 一处出现。[事实]
2. **渲染层没有任何「进度到 100% 就切换到终态地址」的逻辑。** `online-play-progress` 只用于画进度条和文案；而且一旦 `request.prepared === true`，整条事件在监听器第一行就被丢弃（`Player.jsx:407`）。[事实]
3. **换地址只有三条独立通路**：在线 → 本地已下载文件（2 秒轮询 + 下载任务完成，`Player.jsx:419-451`→`234-241`）、在线 → 转码产物（解码失败，`489-559`）、在线 → 重新取源（媒体错误，`668-676`）。三条都靠 `pendingSeekRef` + `onLoadedMetadata` 恢复播放位置（`801-805`）。[事实]
4. **主进程侧 `prepare-online-play` 是阻塞式的**：加密片源要整集下载 + 解密进内存才 return（`main.js:2199-2202`），HLS 要整份下载 + remux 完（`main.js:2197`）。所以现在的"准备中"占位层（含百分比进度条）是**唯一的准备期反馈**。[事实]
5. **渲染层确实会显式重设 `src`，但只有两处**：同地址重试（`Player.jsx:482`）与转码成功（`524`）。搜索不到任何"抢回 src"之类的防护代码或注释——因为进度事件根本不碰 `src`。真正的防护是"事件来源过滤"（`currentSrc === videoSrc`，`587/735/797/1386/1397`）。[事实＋搜索无结果]

---

## 1. 调用关系一览

| 函数 / 位置 | 文件:行号 | 作用 |
|---|---|---|
| `prepareOnlinePlay` | `preload.js:41` | `invoke('prepare-online-play')` 桥接 |
| `releaseOnlinePlay` | `preload.js:42` | `invoke('release-online-play')` 桥接 |
| `onOnlinePlayProgress` | `preload.js:45-49` | 订阅 `online-play-progress` |
| `onTranscodeProgress` | `preload.js:64-68` | 订阅 `transcode-progress`（兼容模式） |
| `startOnlinePlay` | `src/components/Player.jsx:614-666` | **唯一的在线播放发起口**：reset → prepare → 置 url/buffering |
| `releaseOnline` | `Player.jsx:127-131` | 释放当前在线会话（带 `requestId` + `streamId`） |
| `releasePrefetch` | `Player.jsx:133-137` | 释放下一集预取（只带 `requestId`） |
| `resetPlayback` | `Player.jsx:147-171` | **唯一收尾出口**：清 online/prefetch/compat/buffering/错误状态 |
| `stopPlayback` | `Player.jsx:173-179` | 记录当前位置 → resetPlayback → 显示错误 |
| 卸载清理 | `Player.jsx:181-191` | 卸载时保存进度 + `releaseOnline` + `releasePrefetch` |
| `usableLocal` | `Player.jsx:231-232` | 判断某集是否有可播本地文件 |
| `resumeLocal` | `Player.jsx:234-241` | 切到本地文件播放（保留 seekTo） |
| `recoverOnlineFailure` | `Player.jsx:247-280` | 在线失败 → 刷新详情 → 本地文件 / 加入下载并等待 |
| `refreshCacheInfo` | `Player.jsx:282-296` | 拉 `online-cache-status`（**缓存数字的真正来源**） |
| 进度监听 | `Player.jsx:403-416` | 把 `online-play-progress` 映射到 `onlineProgress` |
| 2 秒轮询 | `Player.jsx:419-451` | 等下载完成 → 自动切本地；失败/停止 → 报错 |
| 派生量 canPlay/playableSource | `Player.jsx:453-465` | 决定"能否播"与"用哪个地址" |
| src 同步 effect | `Player.jsx:475-484` | 同地址重试时显式 `v.src = …; v.load()` |
| `startCompatPlay` | `Player.jsx:489-559` | HEVC→H.264 转码播放，成功后写 `compatMap` |
| `handlePlaying` | `Player.jsx:583-608` | 首次 playing 落状态；2.6s 后判定"解不出画面" |
| `reconnectOnce` | `Player.jsx:668-676` | 单次强制重新取源（`force=true`） |
| `goToEpisode` | `Player.jsx:679-697` | 切集：本地→`resetPlayback`；否则→`startOnlinePlay` |
| `retryPlayback` | `Player.jsx:699-711` | 重试：优先刷新后的本地文件，否则重连片源 |
| `prepareNextEpisode` | `Player.jsx:731-748` | 播放中预取下一集（`prefetch: true`） |
| `handleEnded` | `Player.jsx:751-776` | 连播（可能触发新一次在线准备） |
| `handleMetadata` | `Player.jsx:794-809` | 应用 `pendingSeekRef`；转码生效后释放在线会话 |
| `switchSeries` | `Player.jsx:870-903` | 换剧：`resetPlayback` + 重置全部 ref |
| `clearCache` | `Player.jsx:976-987` | 清在线缓存（会 `stopPlayback`） |
| `<video>` 元素 | `Player.jsx:1359-1417` | 唯一的 video 节点；事件全部在这里 |
| 未就绪占位层 | `Player.jsx:1424-1494` | 错误 / 在线进度 / 等待下载 / 锁定 / 未下载 |
| 缓冲浮层 | `Player.jsx:1496-1501` | `mediaBuffering` →"正在加载视频…" |
| 转码浮层 | `Player.jsx:1504-1516` | `compatProgress` |
| 解码失败浮层 | `Player.jsx:1518-1537` | `decodeFailed` |
| 进度条 / 时间 | `Player.jsx:1422-1423` → `PlayerControls.jsx:232-237, 247-250` | 拖动仅 `duration>0` 时可用 |
| 主进程 prepare | `main.js:2170-2226` | 取源 / 下载 / 解密 / 建会话 / 返回 `url+streamId+size+cached+streaming` |
| 主进程 release | `main.js:2228-2234` | 按 `streamId` 或 `requestId` 释放会话 |
| 进度推送 | `main.js:2189-2193`（准备期）、`1939-1940`（惰性 HLS） | 只发 `downloading` / `decrypting` |
| 流协议服务 | `main.js:1903-1988`，分支：`diskMediaResponse:1883-1901` / `bufferedMediaResponse:1722-1732` / 明文代理回传 `1959-1981` | `hongguo-stream://play/<id>` 的三种内部形态 |
| 本地协议 | `main.js:1991-1994`（`localPlayUrl`）+ `2003-`（`registerLocalProtocol`） | `hongguo-local://f/<uuid>` |
| 兼容转码输入复用 | `main.js:2452-2464` | 把在线缓存（`.filePath`/`.buffer`）当 ffmpeg 输入 |

渲染层回归脚本（**基线全绿**，我已实跑）：

| 脚本 | 锁定的契约 |
|---|---|
| `scripts/check-player-fallback.cjs` | 在线失败→下载兜底→切本地，含"保留暂停态与播放秒数"（16 条全 PASS） |
| `scripts/check-player-resume.cjs` | 转码/恢复/全屏下"换源不换 video 节点"（含 `304-315`） |
| `scripts/check-ui-state.cjs` | 迟到结果不得覆盖新集（`64-84`）——**当前 31 条里 30 条 FAIL，见 §3 R14** |

---

## 2. 逐条回答

### Q1 渲染层在哪里调用 `prepareOnlinePlay`？返回值的每个字段怎么用？

**调用点只有两处**（都在 `Player.jsx`）：

1. 主路径 `startOnlinePlay`（`614-666`）：

```js
639  if (!res?.success) res = await window.electronAPI.prepareOnlinePlay({
640    requestId: request.requestId, vid: ep.vid, seriesId: activeSeriesId, vidIndex, force,
645  });
646  if (onlineRequestRef.current !== request) {   // 迟到结果：丢弃并释放
647    window.electronAPI.releaseOnlinePlay({ requestId: request.requestId, streamId: res?.streamId }).catch(() => {});
648    return;
649  }
650  if (!res || !res.success) { await recoverOnlineFailure(ep, res?.error || '在线播放准备失败'); return; }
654  request.streamId = res.streamId;
655  request.prepared = true;
656  setMediaBuffering(true);
657  setOnlineUrl(res.url);
658  setOnlineProgress(null);
659  refreshCacheInfo();
```

2. 预取下一集 `prepareNextEpisode`（`731-748`）：

```js
738  const request = { requestId: crypto.randomUUID(), vid: next.vid, seriesId: activeSeriesId, vidIndex: next.vid_index };
739  prefetchRef.current = request;
740  request.promise = window.electronAPI.prepareOnlinePlay({ ...request, prefetch: true })
743    .then(result => { if (prefetchRef.current !== request && onlineRequestRef.current !== request) {
744      window.electronAPI.releaseOnlinePlay({ requestId: request.requestId, streamId: result?.streamId }) ... } ... });
```

预取结果本身不直接播放：它被缓存在 `prefetchRef`，切集时 `startOnlinePlay` 用 `prefetched.promise` 直接 await（`624-628`, `637`）——**注意这不消耗返回值字段，只用 `success/url/streamId`**。

**各字段的归属：**

| 字段 | 渲染层处理 | 最终去向 |
|---|---|---|
| `url` | `setOnlineUrl(res.url)`（`657`） | `onlineUrl` state（`62`）→ `isOnlinePlaying`（`460`）→ `playableSource`（`462`）→ `lastVideoSrcRef`（`464`）→ `videoSrc`（`465`）→ `<video src={videoSrc \|\| undefined}>`（`1362`）；同时作为 `source` prop 传给 `VideoEnhancement`（`1418`）、弹幕层（`1419-1421`）、`PlayerControls`（`1422`） |
| `streamId` | 只挂在本次请求对象上（`654`） | 仅用于 `releaseOnlinePlay`（`130`、`647`、`744`）。**渲染层从不自己拼地址**，地址一律由主进程给出 |
| `streaming` | **未使用** | 全仓库仅 `main.js:2221` 定义，`src/` 零引用（grep `streaming` 只有 `Player.jsx:528` 的 `res.cached`，那是转码返回，不是 prepare 返回） |
| `size` | **未使用** | 界面上的缓存字节数来自 `onlineCacheStatus()`（`284-285`），与 prepare 的 `size` 无关 |
| `cached` | **未使用**（prepare 的） | 同上的 `online-cache-status`；`Player.jsx:528` 读的 `res.cached` 属于 `transcodeForPlayback` |
| `success` / `error` | 判定成功或走 `recoverOnlineFailure`（`650-652`） | 占位层的错误分支（`1426-1431`） |

`onlineVid` 由 `setOnlineVid(ep.vid)`（`634`）设置，用于 `isOnlinePlaying`（`460`）和分集小圆点（`1587`）。
`setMediaBuffering(true)`（`656`）在赋 url 之前就打开缓冲浮层，直到 `onCanPlay`（`1393`）/`onPlaying`（`594`）才关。

> 结论：**`streaming` / `size` / `cached` 是给主进程测试用的，不是给渲染层用的**。主进程侧的断言在 `scripts/check-streaming.cjs:165-166,307,317,358,366`、`scripts/check-app-media.cjs:53`。

---

### Q2 `online-play-progress` 在渲染层怎么用？有没有"下载完成后自动切换到另一个地址"？

**监听器（全文，`403-416`）：**

```js
405  return window.electronAPI.onOnlinePlayProgress((d) => {
406    const request = onlineRequestRef.current;
407    if (!request || request.prepared || d.requestId !== request.requestId) return;   // ← 关键
408    setOnlineProgress({ vid: d.vid, percent: d.percent || 0, phase: d.phase || 'downloading',
412      received: d.received, total: d.total });
415  });
```

- 它**只做一件事**：写 `onlineProgress` state。没有任何取源、切源、释放动作。[事实]
- `407` 的 `request.prepared` 意味着：**一旦开始播放，后续进度事件全部被丢弃**。[事实] 主进程在播放期唯一会发进度的地方是惰性 HLS 分支（`main.js:1939-1940`），因此那条进度在渲染层不可见（该分支的可达性见 §4「不确定」）。[推断]
- 事件载荷（`main.js:2189-2193`）：`{vid, seriesId, vidIndex, requestId, received, total, percent, phase}`——**按 `requestId` 匹配，不按 `streamId`**。

**"下载完成后自动切换到另一个地址"确实存在，但触发条件不是进度到 100%：**

| 通路 | 触发条件 | 切换前地址 | 切换后地址 | 位置保持 |
|---|---|---|---|---|
| (a) 在线 → 本地文件 | `waitingFor != null`（由 `recoverOnlineFailure:269` 或 `downloadEpisode:998` 设置）且 2 秒轮询发现该集在 `getSeriesEpisodes` 里变成 `completed + fileUrl` | `hongguo-stream://play/<id>` | `hongguo-local://f/<uuid>`（`ep.fileUrl`） | `resumeLocal(ep, seekTo)`（`440`）→ `pendingSeekRef`（`238`）→ `handleMetadata` 里 `v.currentTime = seekTo`（`801-805`）；`seekTo` 取 `recovery.seekTo` 或 `currentPosition()`（`439`）；暂停态由 `pendingAutoplayRef`（`149`,`808`）与 `recovery.autoplay` 保持 |
| (b) 在线 → 转码产物 | `handlePlaying` 判定 `videoWidth === 0 && !paused && currentTime > 0.3`（2.6 秒后，`598-606`）或 `onError` 给 `[3,4]`（`1402`） | 同上 | `compatMap[vidIndex]`（`525`，实为 `hongguo-local://…`） | `startCompatPlay` 先 `pendingSeekRef.current = currentPosition()`（`496`），并保留暂停态（`497`） |
| (c) 在线 → 新的在线地址 | `onError`：`unavailableOnline`（code 4 且 `videoSrc === onlineUrl`，`1400-1401`）或 code 2（`1403`）先试 `reconnectOnce()`；或用户点"重新连接片源"（`1429`,`1527`） | `hongguo-stream://play/<旧id>` | `hongguo-stream://play/<新id>`（同 scheme，新 `streamId`，字符串不同→`src` 变化） | `startOnlinePlay(vidIndex, currentPosition(), true, …)`（`674`） |
| (d) 转码生效后释放 | `handleMetadata` 里 `if (compatMap[currentIndex]) releaseOnline()`（`807`） | — | — | 不涉及换源 |

**明确结论：搜索全仓库，不存在任何以 `percent === 100`（或 `received === total`）为条件的换源/收尾逻辑。** 唯一读取 `percent` 的地方是展示（`1437`、`1440`）。想在"边下边写完成后切换终态文件"时复用现成钩子——**没有现成钩子**。

---

### Q3 `release-online-play` 在哪里调用？有哪些释放时机？

**渲染层 8 个调用点：**

| 位置 | 载荷 | 场景 |
|---|---|---|
| `Player.jsx:130`（`releaseOnline`） | `{requestId, streamId}` | 当前在线会话释放 |
| `Player.jsx:136`（`releasePrefetch`） | `{requestId}` | 预取会话释放 |
| `Player.jsx:160-161` | 上面两者的调用点 | 在 `resetPlayback` 内部（**收尾出口**） |
| `Player.jsx:187-188` | 同上 | 组件卸载 |
| `Player.jsx:354` | `releasePrefetch` | 用户关闭"缓存下一集" |
| `Player.jsx:647` | `{requestId, streamId: res?.streamId}` | `prepare` 迟到结果（已被新请求取代） |
| `Player.jsx:744` | 同上 | 预取迟到结果且已无人认领 |
| `Player.jsx:807` | `releaseOnline` | 转码生效、`handleMetadata` 之后 |
| `Player.jsx:977` | `releasePrefetch` | `clearCache` 清在线缓存 |

`resetPlayback` 的调用者（即"所有会导致释放的入口"）：
`resumeLocal:235`、`recoverOnlineFailure:250`、`startOnlinePlay:626`、`goToEpisode:691`（本地分支）、`stopPlayback:175`、`switchSeries:880`、`removeSeries:947`、`purgeEmpty:962`、`onError:1409`、`clearCache→stopPlayback:979`。

**时机结论：**

- **切集**：一定释放。切到可播本地集走 `goToEpisode:685-691`→`resetPlayback`；切到在线集走 `startOnlinePlay:626`→`resetPlayback`（先释放旧的，再准备新的）。[事实]
- **卸载**：`Player.jsx:181-191`。注意 `App.jsx:234` 用 `visited.map(... hidden)` 保留已访问页面，所以**普通切页不会卸载 Player**（`active=false` 只做 `persistPosition`，`790-792`）；**只有切到"热播推荐"`feed` 会卸载**（`App.jsx:71`、`102`：`setPlayerMounted(nextPage === 'player')`，`renderPage('player')` 在 `111-112` 返回 `null`）。[事实]
- **暂停**：**不释放**。`onPause`（`1390`）只 `persistPosition(true)`。[事实]
- **切页/切剧**：切页不释放（同上）；切剧释放（`switchSeries:880`）。
- **播完连播**：`handleEnded:772` → `goToEpisode` → 释放旧的（并在需要时发起新准备）。
- **主进程侧语义**：`main.js:2228-2234` 按 `streamId` 或 `requestId` 命中并 `releaseOnlineSession`（`113-124`），进而 `disposeOnlineDisk`（`134-137`，惰性删临时目录，有读者时不删），并在"最后一个持有该 job 的会话"释放时 `pending.controller.abort()`（`119-123`）。**所以"切集"确实会立刻中止还在进行中的取源/解密 job**。

---

### Q4 渲染层会不会对同一个地址重新赋值 `src`？有没有"抢回 src"的防护代码？

**`src` 的来历（`462-465`）：**

```js
462  const playableSource = compatUrl || (isOnlinePlaying ? onlineUrl : current?.fileUrl) || '';
463  // 原生全屏依附于 video 节点。准备下一集时保留结束帧，换源不换节点。
464  if (canPlay) lastVideoSrcRef.current = playableSource;
465  const videoSrc = compatProgress ? '' : lastVideoSrcRef.current;
```

`videoSrc` **不是** `onlineUrl` 的直接镜像，而是 `lastVideoSrcRef` 这枚"粘滞"引用：只有 `canPlay` 为真时才更新。所以准备下一集（`setOnlineUrl('')`，`163`）时 video 仍保留上一集的 `src` 与结束帧。这条契约有测试锁定：`scripts/check-player-resume.cjs:304-315`（"retaining the ended frame until the next source is ready"，断言 `props.src` 不变、`props.key` 不变）。[事实]

**显式重设 `src` 只有两处（+ 一处清空）：**

1. `Player.jsx:475-484`——"同地址显式重试"：

```js
481  // 相同地址的显式重试不会触发 src 变更，用原生 load 重置媒体即可。
482  if (previous?.source === videoSrc && previous.version !== playbackVersion) { v.src = videoSrc; v.load(); }
```

2. `Player.jsx:524`——转码成功后：

```js
523  // A fast same-URL result can be batched with the loading state; restore the DOM source explicitly.
524  if (videoRef.current) { videoRef.current.src = res.url; videoRef.current.load(); }
```

3. `Player.jsx:505-506`——转码前清空：`videoRef.current?.removeAttribute('src'); videoRef.current?.load();`（注释：Windows 必须释放被占用的缓存文件）。

**"抢回 src"类防护代码：未找到。** 搜索 `抢`、`回抢`、`守卫`、`重设 src` 等词，`src/` 下零命中；`Player.jsx` 中唯一带 `src` 的注释就是上面 `481` 那句。

真正起作用的是**"事件来源过滤"**（防止旧元素/旧源的事件污染新集状态），共 5 处：

```js
587  if (element.currentSrc && element.currentSrc !== videoSrc) return;       // handlePlaying
735  || media.element !== video || (video.currentSrc && video.currentSrc !== videoSrc)) return;  // prepareNextEpisode
797  if (v.currentSrc && v.currentSrc !== videoSrc) return;                   // handleMetadata
1386 if (v.currentSrc && v.currentSrc !== videoSrc) return;                   // onRateChange
1397 if (event.currentTarget.currentSrc && event.currentTarget.currentSrc !== videoSrc) return; // onError
```

再叠加"请求世代"校验：`onlineRequestRef.current !== request`（`638`、`646`、`661`）与 `mediaVersion/selectionVersion`（`155-156`、`184`、`586`）。这套组合有回归测试（`src/components/check-ui-state.cjs:64-84` "late old online prepare cannot replace latest episode"，**但该测试当前跑不起来，见 §3 R14**）。[事实]

> 直接回答：**进度更新不会导致重设 `src`**（进度只写 `onlineProgress`，而 `onlineProgress` 非空时 `canPlay` 为假、`playableSource` 根本不会被采纳）。会重设 `src` 的只有"版本号变化的重试"和"转码成功后"两条路径。

---

### Q5 `phase` 有哪些取值？渲染层是否按 `phase` 区分展示？

**取值全集（共 3 个）：**

| 值 | 产生者 | 位置 |
|---|---|---|
| `'preparing'` | **渲染层自己造**（prepare 尚未返回时） | `Player.jsx:633` `setOnlineProgress({ vid: ep.vid, percent: 0, phase: 'preparing' })` |
| `'downloading'` | 主进程默认值 / HLS 分支写死 | `main.js:2189-2193`（`phase: phase \|\| 'downloading'`）、`main.js:1939-1940` |
| `'decrypting'` | 主进程解密前的一帧 | `main.js:2131`（contentKey 路径）、`main.js:2151`（spadeA 路径）→ 经 `fetchDecryptedEpisodeOnce` 的 `onProgress(received, total, phase)` 传给 `2189` 的 `progress` |

渲染层还有一处兜底：`phase: d.phase || 'downloading'`（`411`）。

**渲染层确实按 `phase` 区分展示（3 处，全是文案/进度条）：**

```js
1435  <p>{onlineProgress.phase === 'preparing' ? '正在连接片源…' : onlineProgress.phase === 'decrypting' ? '正在准备播放…' : '正在缓冲在线播放…'}</p>
1436  {onlineProgress.phase !== 'preparing' && <div className="player-wait-bar">…宽度 = onlineProgress.percent%</div>}
1440  {onlineProgress.phase === 'preparing' ? '获取可播放地址' : `${onlineProgress.percent || 0}%`}
1441  {onlineProgress.total ? ` · ${MB(received)} / ${MB(total)} MB` : ''} … ' · 不写入下载目录'
```

**注意两个"空转"细节**（对新方案重要）：
- HLS 准备期的进度是 `progress(received, 0)`（`main.js:2197`）/ `percent: 0`（`1939-1940`）→ **`percent` 恒为 0、`total` 恒为 0**，于是进度条宽度恒 0，文案显示"0% · 不写入下载目录"。
- 加密路径的 `phase: 'decrypting'` 只在下载完成那一帧出现一次（`2131`/`2151`），随后就 return 了 → 用户实际看到的是"下载中（有百分比）→ 正在准备播放…（0% 停顿）→ 播放"。

---

### Q6 有"等待/缓冲中"的界面状态吗？由什么驱动？改流式后哪些状态不再出现？

**共有 5 个互斥/叠加的等待界面：**

| 界面 | 显示条件 | 驱动 |
|---|---|---|
| ① 未就绪占位层 | `!canPlay`（`1424`） | 优先级：`playbackError`(1426) > `onlineProgress`(1432) > `waitingFor`(1446) > `locked`(1461) > `current` 未下载(1463) > 未选集(1487) |
| ② 缓冲浮层"正在加载视频…" | `canPlay && mediaBuffering && !compatProgress`（`1496`） | 置真：`656`（拿到 url 时）、`1392` `onWaiting`；置假：`1393` `onCanPlay`、`594` `onPlaying`、`1412` `onError` |
| ③ 转码浮层 | `compatProgress && vidIndex === currentIndex`（`1504`） | `onTranscodeProgress`（`336-343`） |
| ④ 解码失败浮层 | `!compatProgress && decodeFailed && canPlay`（`1518`） | `handlePlaying` 的 2.6 秒定时器（`598-606`）+ `onError` |
| ⑤ `waitingFor`"第 N 集正在下载…" | `waitingFor != null`（`1446-1460`） | `recoverOnlineFailure:269`、`downloadEpisode:998`；由 2 秒轮询清除（`437`,`443`） |

**关键约束**：`canPlay` 要求 `!onlineProgress`（`461`）：

```js
460  const isOnlinePlaying = onlineVid && current && current.vid === onlineVid && onlineUrl;
461  const canPlay = !!(!playbackError && !onlineProgress && current && !current.locked && (compatUrl || usableLocal(...) || isOnlinePlaying));
```

也就是说**"在线准备期"视频节点不显示，占位层独占画面**（①），`mediaBuffering`（②）只在拿到 url 之后才可能出现。

另外：
- `PlayerControls` **完全没有 buffering 指示**：它监听的事件列表是 `play/pause/ended/timeupdate/loadedmetadata/durationchange/volumechange/emptied`（`179`），不含 `waiting`/`canplay`/`progress`；进度条与时间只依赖 `duration`（`175-176`、`247`、`250`）。
- `aria-busy={!canPlay || mediaBuffering}`（`1364`）。
- 弹幕层在 `waiting` 时 `stop()`：`CommentDanmaku.jsx:138`、`OfficialDanmaku.jsx:200`（`waiting: stop`）。

**改成"立即返回可播地址、边下边播"后：**

1. **`onlineProgress` 占位层（①的 `1432-1445` 分支）会基本不再出现**——因为 `setOnlineProgress(null)`（`658`）几乎立刻执行。于是"正在连接片源…/正在缓冲在线播放… + 百分比进度条"这一整套反馈**消失**，而它是当前唯一的进度反馈。
2. 空档期会落到占位层的"未下载"分支（`1463-1486`）：显示"第 N 集 尚未下载" + "在线播放（不下载）/ 下载本集"按钮——**这是明确的界面回归**（用户会以为没在准备，且按钮可点会重复发起）。
3. `mediaBuffering`（②）会成为主等待界面，但它只在 `canPlay` 为真后出现；且它由 `onWaiting` 驱动——如果服务端对未缓存区间直接报错而不是"等数据"，就不会出现 waiting，而是走 `onError`（见 §3 R3）。
4. `waitingFor`（⑤）不受影响（它来自"在线失败→下载兜底"，不是流式播放本身）。

---

### Q7 除了 `prepare-online-play`，渲染层还有别的途径播放在线视频吗？

**没有第二条在线通路。** 全仓库只有一个 `<video>` 元素（`grep '<video'` → 仅 `Player.jsx:1359`），它只有三种可能的地址形式：

| 地址形式 | 来源 | 代码位置 |
|---|---|---|
| `hongguo-stream://play/<streamId>` | `prepare-online-play` 返回（明文直连代理 / 加密内存缓冲 / HLS 落盘，三种内部形态，**渲染层不区分**） | `Player.jsx:657`；`main.js:66`、`2220-2221`；服务端 `1903-1988` |
| `hongguo-local://f/<uuid>` | 已下载的本地文件（`get-series-episodes` 的 `fileUrl`） | `main.js:1613`、`1629` → `localPlayUrl:1991-1994` → `media-access.js:9-13`；渲染层 `Player.jsx:462` |
| `hongguo-local://f/<uuid>` | 兼容模式转码产物（放进 `compatMap`，不是 `onlineUrl`） | `main.js:2565`；渲染层 `Player.jsx:524-525`、`459`、`462` |

澄清几点：

- **HLS 不是一个独立的渲染层通路**：它在主进程被整份下载分片 + ffmpeg remux 成 mp4（`hls-media.js:16-126`），再经 `hongguo-stream` 供给（`main.js:2197`、`main.js:1934-1951`）。渲染层没有 HLS.js/dash.js，也没有任何 `.m3u8` 处理。
- **自定义源 / 西饭 / 河马走同一条链路**：`main.js:2176` 对 `/^(xifan|hema|custom):/` 先做一次取源校验，然后仍是 `prepare-online-play` → `hongguo-stream://`。
- **`play-series`（`main.js:1694-1709`）不发地址**，只是 `sendToRenderer('navigate', {page:'player', payload})`；取地址仍发生在 `Player` 里。
- 没有 `webview`/内嵌网页播放（`grep webview src/` 零命中）。
- 下载/合并/弹幕/画质增强都不消费在线地址；`VideoEnhancement`（`VideoEnhancement.jsx:44-148`）只在 `source` 变化时重建 WebGPU 渲染器并从 video 元素取帧，**不碰 `src`**。

---

## 3. 改造风险点

按"会不会直接改坏"排序。**R3/R9/R8 是我认为必须先解决的三个。**

### Critical

**R3 · 起播早期的 `onError` 会被误判成"片源不可用"，把用户踢进整集下载兜底。**
现状：`Player.jsx:1394-1416` 里 `errorCode === 2 || 4` 会先 `reconnectOnce()`（强制重新取源，`668-676`），第二次才 `recoverOnlineFailure`（加入下载并进入等待界面）。流式 fMP4 在"分片还没写出来"时的媒体错误与"片源真不可用"**在当前判据下无法区分**（`1400`：`unavailableOnline = errorCode === 4 && videoSrc === onlineUrl`）。一旦误判，用户会看到"正在重新获取本集片源…"甚至"第 N 集正在下载"，而下载兜底会**再走一遍完整链路**。改造必须新增"仍在缓冲中"的判据（例如结合 `waiting`/`readyState`/已写盘字节），否则这是必然踩到的坑。
证据：`Player.jsx:1394-1416`、`668-676`、`247-280`；回归测试锁定这条链：`scripts/check-player-fallback.cjs:100-107`（"exhausted online media error 2/4 downloads once and retains paused position"）。

**R9 · 兼容模式把在线缓存当作 ffmpeg 输入，"改成流式写盘"后输入不再完整。**
`main.js:2452-2464` 明确从 `onlineCache` 取 `.filePath`（HLS 落盘）或 `.buffer`（内存解密结果）作为转码输入；`main.js:2572` 还按 `disk.readers` 引用计数决定何时删临时目录。渲染层侧的耦合是：`Player.jsx:516` 用 `onlineSourceRef.current === … ? null : ep.savePath` 让主进程走"在线缓存当输入"这条路，并在 `807` 转码生效后才 `releaseOnline()`（即**在线会话必须活到转码完成**）。若新方案只保留"正在增长的分片文件"，兼容模式会拿到半成品 mp4。
证据：`main.js:2452-2464`、`2565`、`2572`；`Player.jsx:505-524`、`807`；回归护栏 `scripts/check-streaming.cjs` 的 "concurrent compatibility requests share one encoder and result"。

### Major

**R1 · `streaming` 字段无人消费。**
如果新方案想用 `streaming: true` 表达"这是可边下边播的源"，渲染层的消费点**需要新增**——现状 `src/` 里零引用（`grep -rn "streaming" src/` 只命中无关字符串）。同时注意主进程测试把它当契约锁住（`check-streaming.cjs:307,317` 断言 `streaming === true`；`check-app-media.cjs:53` 断言加密源 `streaming === false`），改语义会直接打破这些断言。

**R2 · `size` 语义被主进程测试锁定。**
渲染层不用它，但 `check-streaming.cjs:166`（预取 `p.size === 10`）与 `:358,366`（加密路径 `result.size === 10`）断言的是**完整字节数**。若 `size` 从"总长度"变成"当前已落盘字节"，该断言与"`Content-Length` 由 `entry.size` 推导"的 `diskMediaResponse:1884` 一起会失真。

**R5 · "取源前"没有等待状态可展示（界面回归）。**
见 §2 Q6：`onlineProgress` 占位层消失后，空档期会落到"尚未下载 + 在线播放按钮"（`1463-1486`）。必须新增一个"正在准备（流式）"状态，否则用户看到的是"没在准备"。同时 `canPlay` 的判据（`461`）里 `!onlineProgress` 这一条会失去意义（progress 变瞬时），需要重新设计"何时显示视频节点"。

**R7 · "完成后才可拖动"现有判据不足。**
进度条只按 `duration` 判断可用：`PlayerControls.jsx:234`（`if (!available || !video || !media.duration) return;`）与 `247`（`disabled={!available || !media.duration}`）。而 `PlayerControls` 完全不看 `seekable`（`grep seekable` 零命中），所以"duration 已知但不许拖"没有现成表达。更糟的是快捷键快进/快退**绕过**这个门控，直接改 `currentTime`：`Player.jsx:843-846`。
另注：fMP4 无 moov 尾部时 Chromium 常给出 `duration = Infinity`；那么 `247` 的 `max={media.duration || 0}` 与 `235` 的 `Math.min(media.duration, …)` 行为都需实测（`PlayerControls.jsx:175-176` 已经会把非有限 duration 归一成 0 → 进度条 disabled、时间显示 0:00）。

**R8 · 断点续播可能失效。**
`handleMetadata` 只在 `loadedmetadata` 一次性应用 `pendingSeekRef`，且加了 `seekTo < v.duration - 3` 的条件：

```js
801  const seekTo = Math.max(0, Number(pendingSeekRef.current) || 0);
802  if (seekTo > 0 && (!Number.isFinite(v.duration) || seekTo < v.duration - 3)) { v.currentTime = seekTo; … }
806  pendingSeekRef.current = 0;                       // ← 一次性，用完即清零
```

`duration` 为 `Infinity` 时这一支是**成立的**（`!Number.isFinite` 为真），所以幸运地能跳；但如果首帧 metadata 时 `duration` 尚未确定且小于 `seekTo + 3`，跳转会被静默跳过并把 `pendingSeekRef` 清零 → **用户断点丢失且无法补救**（`pendingSeekRef` 已归零）。这需要新方案保证"起播时 duration 已可用"或改成"可重试的 seek"。

**R11 · release 即杀写入进程。**
渲染层在切集/卸载/清缓存时会立刻 `release-online-play`（`157-161`、`187-188`、`977`），主进程据此 `releaseOnlineSession` → abort job + `disposeOnlineDisk`（`main.js:113-124`、`134-137`）。若 ffmpeg 解密进程的生命周期挂在 session 上，**"切集"就等于"杀掉上一集的写盘"**——这在现状是正确回收，在新方案里要确认：(1) 半成品文件不会留在临时目录被误用；(2) 也不会留下孤儿进程。

**R12 · 半成品被登记进缓存 = 下次播放拿到残缺文件。**
现在靠 `prepared.complete` 把关（`main.js:2209-2210`），且 `diskMediaResponse`（`1883-1901`）只要 `entry.filePath` 存在就按 `entry.size` 直接供片。新方案若在"写完"之前把 entry 落进 `onlineCache`，或提前把 `entry.size` 设为最终长度，会出现"第二次播放拿到不完整文件"且**没有校验兜底**。渲染层侧的表现是"播到中间卡死/直接结束"。

**R14 · 唯一锁定"迟到 prepare 不覆盖新集"的渲染层测试当前是死的。**
`src/components/check-ui-state.cjs` 在 HEAD 上 **31 条测试里 30 条 FAIL（仅 1 条 PASS）**（实跑），根因是测试沙箱的 `require` 桩没跟上 `Player.jsx` 新增的导入（报错 `(0, import_VideoEnhancement.useVideoEnhancement) is not a function`）；它自己的 `mount` 只 stub 了 `react`/`./useDialogKeyboard`/`./episodeRange`（`check-ui-state.cjs:25-26`）。而 `scripts/check-player-fallback.cjs`（16/16 PASS）与 `scripts/check-player-resume.cjs`（全 PASS）用的是另一套更新过的沙箱（`scripts/check-player-resume.cjs:14-86`）。**改造前建议先修好这个沙箱**，否则"迟到结果不得覆盖新集"这条护栏在改造期间是失效的。

### Minor

**R4 · 依赖"进度到 100% 才切换/才可播"——不存在。**
这是好消息：改造不会撞到这条假设。反过来，如果新方案希望"写完分片后自动换成终态（可拖动、可缓存）地址"，**没有现成钩子**，需要新增一条切换通路，并复用 `pendingSeekRef` 才能保住播放位置（`439`/`496`/`674` 是现有三种切换保留位置的写法）。

**R6 · 进度百分比只有一处消费，且 total=0 时显示 0%。**
`Player.jsx:1436-1443`。新方案若拿不到 `total`（chunked 无 `Content-Length`），"已写 X MB"这类文案需要新分支；`percent` 会一直是 0。

**R10 · fMP4 的 error code 语义漂移。**
`Player.jsx:1400-1402` 把 error 4 当作 `SRC_NOT_SUPPORTED`（注释也承认"Chromium also reports an unavailable HTTP stream as unsupported source (4)"）。流式播放中 4 号错误可能来自"还没数据"，会先触发 `reconnectOnce`（`1401`）。

**R13 · `aria-busy`。**
`Player.jsx:1364` `aria-busy={!canPlay || mediaBuffering}`。流式后 `canPlay` 很快为真，`aria-busy` 只在 `waiting` 时短暂为真——可接受，但要留意屏幕阅读器提示会变少。

### Good（值得保留的设计）

- **G1 "换源不换节点"的粘滞 src**：`Player.jsx:463-465` 用 `lastVideoSrcRef` 保留结束帧，避免准备下一集时 video 节点卸载（原生全屏依附于该节点）。有测试锁定：`scripts/check-player-resume.cjs:304-315`（断言 next episode 准备期间 `props.key`/`props.src` 均不变）。改造流式播放时**必须继续保留**这个行为。
- **G2 单一收尾出口**：`resetPlayback`（`147-171`）集中清理 online/prefetch/compat/buffering/错误状态，所有换源路径（本地、在线、转码、下载兜底）都经它。这正好符合"多路径 fallback 必须共享一个 finalize 出口"的要求——新增流式路径也应走它，不要另开早返回。
- **G3 事件来源过滤**：`currentSrc === videoSrc` 的 5 处判断（`587/735/797/1386/1397`）配合 `media.element !== video`，有效阻止旧元素/旧源事件污染新集状态。
- **G4 请求世代校验**：`onlineRequestRef` + `requestId` 比对（`638/646/661`）保证迟到结果被丢弃并主动释放（`647`），不会出现"旧地址覆盖新地址"。
- **G5 缓存数字单一来源**：界面上的缓存条数/字节数统一来自 `online-cache-status`（`refreshCacheInfo:282-296`），而不是 prepare 返回值——避免了两套口径不一致。

---

## 4. 未找到 / 不确定

1. **未找到**任何"进度到 100% → 切换地址/终态化"的代码。
2. **未找到**"抢回 src"相关注释或防护逻辑（搜索词：抢、回抢、守卫、重设 src = 0 命中）。
3. **未找到**渲染层对 `streaming` / `size` / `cached` 的任何消费（`src/` 内 grep 零命中；`streaming` 全仓库只在 `main.js:2221`）。
4. **不确定（推断）**：`main.js:1934-1951` 的惰性 HLS 分支在什么条件下会被真实触发。`prepare-online-play` 对 `format === 'hls'` 已同步准备完（`2197`），因此只有"明文直连会话在播放期被 `withMediaRecovery` 换成 HLS 候选"时才可能走到；未找到覆盖它的既有测试。若真走到，其进度事件会被渲染层 `407` 丢弃。
5. **不确定**：Chromium 对本机 fMP4（无 moov 尾部、chunked 无 `Content-Length`）的 `duration` / `seekable` / `buffered` 具体行为。仓库内**没有**相关记录（`grep seekable` 零命中，代码里也没有注释）。这属于必须实机验证的部分。
6. **未找到**在线播放的"起播耗时"埋点/日志（`Player.jsx` 无相关计时），因此改造前后无法用现有代码量化比较。

---

## 5. 工作区状态（与本次调研的边界）

- 本次调研**未修改**任何既有文件；`git status --porcelain` 只显示两个**未跟踪**文件：`src/native/progressive-media.js`、`src/native/progressive-media.test.cjs`（mtime 2026-10-14 23:38，晚于基线提交 23:30，**不在基线内**，不是本次产出）。
- 这两个文件已经按"ffmpeg 边解密边写分片 MP4（`frag_keyframe+empty_moov+default_base_moof`）+ 把增长中的文件供给播放器"的思路实现，其注释直接写到"Chromium 会把 HTTP 200 + chunked + 无 `Content-Length` + 不支持 Range 判定为流式源（此时 duration 为 Infinity、不能拖动）"——这与本报告 R7/R8/R10 的担忧同源。若它们是要落到主进程的实现，请以本报告 §3 的 R3/R9/R8 逐条对照渲染层侧的既有假设。
- 基线可复现的验证命令（均离线，我已实跑）：

```bash
cd /workspace/红果/refs/hongguo-drama
node scripts/check-player-fallback.cjs   # 16/16 PASS —— 在线失败的下载兜底契约
node scripts/check-player-resume.cjs     # 全 PASS —— 换源不换节点、位置/暂停态保留
node scripts/check-streaming.cjs         # 全 PASS —— 主进程 prepare/release/Range 契约
node src/components/check-ui-state.cjs   # 30/31 FAIL —— 沙箱失修，见 R14
```
