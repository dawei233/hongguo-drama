# ADR-0001：弹幕功能的数据来源与投放模型

- 状态：已采纳
- 日期：2026-10-13
- 基线：上游 `jackotom/hongguo-drama` @ `21cda5f`（v1.6.0），本 fork 无独有提交，本次为快进合并
- 后续：同日又合并了上游 v1.7（`4e30a03`，5 个提交）。v1.7 未改动弹幕相关实现（`CommentDanmaku.jsx`、`danmakuModel.mjs`、`episode-comments.js` 均未变），合并只与 `Settings.jsx` 的一行 import 冲突。本 ADR 的结论不受影响。
- 相关文件：`src/native/danmaku.js`、`src/native/danmaku-sign.js`、`src/components/danmakuOfficial.mjs`、`src/components/OfficialDanmaku.jsx`

## 1. 问题

需求是「弹幕功能」。上游 v1.6 已经有一个叫弹幕的东西（`CommentDanmaku.jsx`），但它在实现层面是**本集评论的滚动条**，不是弹幕：

- **CODE FACT** `src/components/CommentDanmaku.jsx:165` 自己的设置面板写着：`本集公开评论依次展示，与视频时间无对应。`
- **CODE FACT** 它的数据源是 `src/native/episode-comments.js`，只从官网匿名页面抠 `episodeSocialInfo.reviews`，且 `:27` 硬编码 `has_more: false, source_limited: true`。
- **DOC CLAIM** `docs/EPISODE_COMMENTS.md:8`：样本首集平台总数 15536，公开网页只给 15 条；`:12` 结论是"未找到可用的匿名评论分页请求"。

也就是说，上游这条路**拿不到时间轴，也拿不到量**。而"弹幕"这个词在用户心智里恰恰就是"按播放时间点飘过屏幕的字"，两者不是一回事。

同时，本项目先前的工作已经证明真弹幕可取：`nas-backend/danmaku.py` 是一份纯 Python 实现，走官方客户端使用的分时评论接口（`POST /novel/commentapi/comment/list/{vid}/v1/`），每条带 `offset_time`。

**本次实测：该接口在 2026-10-13 仍可用**，同一集返回 98~104 条带时间轴弹幕（0.15s ~ 211s）。

## 2. 决策

**做可插拔的弹幕源，默认真弹幕；把上游那套评论滚动条保留为可选备用源。**

- 源偏好独立存放（`hongguo:danmaku-source:v1`），默认 `official`。
- 视觉设置（字号/透明度/速度/区域/密度/屏蔽词）两源共用，换源不清空用户调参。
- 两个源各自独立组件，只让**被选中的那个**真正去请求上游。

## 3. 被否决的方案

### 3.1 只合并上游，直接用它的「弹幕」

否决。它没有时间轴，用户要的功能等于没实现。但它并非没有价值 —— 它抓的是**公开网页的公开评论**，不依赖任何签名，因此被保留为降级来源。

### 3.2 用 Python 进程做侧车，复用已验证的 `danmaku.py`

否决。理由：需要在 Windows/macOS 各自打包 Python 运行时与依赖，安装包体积和故障面都显著变大；而签名算法本身只有约 350 行纯算术，移植成本远低于多带一个运行时。移植后仍与 Python 实现对**逐字节比对**（见 §5），并没有因为改写而失去可信度。

### 3.3 把签名算法以 Go 共享库形式 FFI 调用（复用 `guoapp-fork` 的 Go 实现）

否决。理由：要按平台交叉编译并随包分发 `.so`/`.dll`/`.dylib`，崩溃与架构不匹配的风险都落在主进程；而 Electron 侧已有的 `app-source.js` 证明纯 JS 完全能承载同类签名。

### 3.4 改造 `danmakuModel.mjs` 以同时支持两种投放方式

否决。上游该文件的单测用 `deepEqual` 锁死了设置对象的字段集合（`comment-danmaku.test.mjs:7-9`），夹具测试又断言了 `feed.animation` 的内部结构（`danmaku-live.fixture.jsx`）。往里加字段会同时打破两类测试，并且让以后每次 `git merge upstream/main` 都产生冲突。改为**新增** `danmakuOfficial.mjs`，上游那条路一行不动。

### 3.5 把时间轴弹幕也做成"先进先出队列"（照抄上游的投放节拍）

否决。上游的投放置是"有一条发一条"，节拍常量 3 / 1.8 / 0.9 秒，那是给**没有时间轴**的队列定速用的。弹幕有时间轴，时间轴本身就在定速，照抄会把吞吐压到 0.55 条/秒，而实测每集密度约 0.5 条/秒且带突发 —— 突发段落会整批变成"迟到"而被丢弃。改为：时间轴驱动投放，密度主要靠**同屏通道数**（1/3/6）控制，投放间隔只用于防同刻堆叠（1.5/0.6/0.25 秒）。

## 4. 架构

```
渲染进程  OfficialDanmaku.jsx ── useOfficialDanmaku ─┐
          （按 video.currentTime 投放）               │
                                                     ▼
                                        danmakuOfficial.mjs（纯逻辑）
                                        ├ createOfficialFeed / appendOfficialPage
                                        ├ advanceTimedDanmaku   ← 时间轴投放与跳转重建
                                        └ resolveDanmakuStatus  ← 唯一的结束状态出口
                                                     │
preload.js  getEpisodeDanmaku ─────────────────────► │
main.js     ipcMain 'get-episode-danmaku' ──────────► │
                                        src/native/danmaku.js
                                        ├ 单集缓存 + 在途去重
                                        ├ 分页（双信号）+ 清洗 + 去重 + 排序
                                        └ danmaku-sign.js（X-Gorgon / X-Ladon / X-Argus）
```

三条工程约束是刻意落进去的：

1. **多路降级共用一个收尾出口。** 官方弹幕有超时、HTTP 错误、部分成功、缓存命中失败结果等多条路径，全部经 `resolveDanmakuStatus` 计算状态，不允许任何一条分支自己拼文案 —— 否则就会出现"接口挂了却显示本集暂无弹幕"。缓存里存的是完整结果而非裁剪后的结果，命中缓存时也不会把失败洗成正常（`src/native/danmaku.js` 的 `present`）。
2. **失败优先于一切。** 状态判定顺序是 `error` → 加载中 → 空集。宁可说"没取到"，也不能说成"没有弹幕"。
3. **与上游保持可合并。** 上游文件只做加法式小改（`Player.jsx` 选组件、`PlayerControls.jsx` 文案、`DanmakuSettings` 增加可选属性、`Settings.jsx` 增加一个下拉、`main.js`/`preload.js` 各加一行 IPC）。新增逻辑都在新文件里，`git merge upstream/main` 不需要解冲突。

## 5. 验证

签名算法没有公开文档，"改写了还能不能用"只能靠对齐证据回答：

| 验证 | 手段 | 结果 |
|---|---|---|
| 签名与参考实现一致 | 由 `danmaku.py` 生成黄金向量（固定设备指纹/nonce/时间戳），JS 侧逐字节断言 | 11/11 通过；X-Gorgon / X-Ladon / X-Argus 三项均逐字节相同 |
| SM3 实现正确 | SM3 标准向量（含 10000 字节跨块长输入）+ 与系统 Node 的 native 实现比对 11 种长度 | 通过 |
| 抓取层 | 17 项离线测试（分页双信号、去重、脏数据、缓存、在途去重、失败语义） | 17/17 通过 |
| 时间轴投放 | 18 项模型测试（到点才发、跳转重建、快进不倒灌、同道不追尾、真实密度不丢量、静态轮换） | 18/18 通过 |
| 渲染层 | 真实 Chromium 内挂载组件（新增夹具 7 项检查），并回归上游评论夹具 | 2/2 通过 |
| 端到端 | 真实应用内经 preload → IPC → 主进程取弹幕 | 成功，98 条，0.72s ~ 201s |
| 上游回归 | `check-app-source.cjs`、`check-store.cjs`、`check-streaming.cjs`、`check-native-performance.cjs`、全部单测 | 全部通过 |

### 5.1 端到端验证抓出的真实缺陷（本次最重要的收获）

离线单测全绿的情况下，应用里弹幕接口**全部失败**，错误为 `Digest method not supported`。

- **CODE FACT** 系统 Node 用 OpenSSL 3，有 SM3；Electron 44 内置 BoringSSL（`process.versions.openssl === '0.0.0'`），**没有 SM3**。
- 离线测试跑在系统 Node 上，因此这个差异在测试层面完全不可见 —— 只有真正把应用跑起来调一次接口才会暴露。
- **CODE FACT** 上游早已为同一原因写了纯 JS 的 `src/native/sm3.js`（`app-source.js` 在用）。本次直接复用它（`src/native/danmaku-sign.js:52`），而不是再维护一份。
- 已加回归护栏：断言 `danmaku-sign.js` 不得出现 `createHash('sm3')`，且必须复用 `./sm3`。

结论：**这类"目标运行时的能力集与测试运行时不同"的假设，必须由端到端验证兜底，不能只靠单测。**

## 6. 风险与未决事项

### 6.1 依赖不可控的第三方签名接口（Critical）

这是本功能的根本风险：接口不是公开接口，靠伪造官方客户端头部访问，上游随时可能改算法、改参数或封禁。缓解措施：

- 任何失败都转成 `success: false` 加一句人话说明，绝不抛异常、绝不伪装成"本集没有弹幕"；
- 失败文案写明"已尝试官方签名请求"并指向备用源，用户可一键切到「本集评论」；
- 失败结果只缓存 15 秒，且界面上的「继续加载」会绕过缓存（否则用户点了重试只会拿到同一条缓存失败）；
- 提供联网健康检查 `node scripts/check-danmaku-official-source.cjs`，一眼判断上游是否还认这个签名。

### 6.2 上游返回量随请求频率浮动（Major）

实测同一集在不同时段拿到 71 / 98 / 102 / 104 条；同一周期内两次连续请求结果完全一致，跨周期变化。判断与上游反爬节流有关。因此：

- 界面文案**不声称"已全部加载"**，只报"已载入 N 条弹幕"；
- 不实现"翻页到底"的假象（该接口本来也没有公开的翻页语义）。

### 6.3 合规与内容过滤（需产品决策，非技术问题）

- 该实现伪造官方客户端身份访问接口，与上游"只读公开网页"的既有姿态相比更进一步。发布前应由项目所有者确认可接受。
- 沿用了上游内置的涉政/辱骂词屏蔽表（`danmakuModel.mjs` 的 `BUILTIN_BLOCKED_WORDS`，含具体政治敏感词），且默认开启。这是内容审查行为，属于产品决策，本次未改动其内容，也未扩大其作用范围。

### 6.4 未覆盖

- 未在真实 Windows/macOS 安装包上验证（本次仅验证到应用内端到端；`--no-sandbox`/`--disable-dev-shm-usage` 是容器环境专用开关，不影响正常桌面运行）。
- 未实现弹幕发送、点赞等写操作，只做只读展示。
- 弹幕只覆盖红果来源；西饭、河马来源无对应接口，界面按"仅红果来源的剧集支持弹幕"如实提示。

## 7. 维护提示

- 改签名相关代码后，先跑 `node src/native/danmaku-sign.test.cjs`（离线、秒级）。它一旦失败，说明与参考实现不再一致，**不要**直接联网碰运气。
- 怀疑上游变了，先跑 `node scripts/check-danmaku-official-source.cjs`；若它也失败，再用 `nas-backend/danmaku.py` 跑同一集，即可区分"算法变了"与"网络/环境问题"。
- 重新生成黄金向量：`python3 scripts/gen-danmaku-sign-vectors.py <含 danmaku.py 的目录> > scripts/fixtures/danmaku-sign-vectors.json`。
- 渲染层检查需要 Electron 二进制与显示环境：`DISPLAY=:99 node scripts/check-official-danmaku.cjs`。
