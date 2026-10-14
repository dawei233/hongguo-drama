# PC 版取源链路：403 与画质问题的根因记录

核对时间：2026-10-14。所有结论均为**实测**（可复现的命令见文末），不是读代码的推断。

## 一、问题

用户反馈两件事，看起来无关，实际同源：

1. 播放**老是 403**。而用户自己维护的 NAS 后端（`hongguo-monorepo/nas-backend`）从不 403。
2. 最高 1080p 的剧，PC 版只拉到 **640×360**。

## 二、403 的根因：App 片源不该带 Referer

对 App 片源（`qznovelvod.com` / `fqnovelvod.com` 系 CDN）实测，同一 URL、同一时刻：

| 请求头组合 | 结果 |
|---|---|
| `Referer: https://novelquickapp.com/`（PC 版改动前就是这样） | **403** |
| 不带 Referer | **200**，数据正常流出 |
| 带 Referer + `Range: bytes=0-1023` | **403** |
| 不带 Referer、换成浏览器 UA | **200** |
| 带 Referer、去掉 `Accept-Encoding` | **403** |

换两条不同的 CDN 主机（`v5-se2-bjtc-reading-video-a.qznovelvod.com`、
`v26-reading-videocdn302.qznovelvod.com`）结果一致，说明不是单台节点的偶发行为。

**为什么 NAS 后端从不 403**：它的 `USER_AGENT` 与 PC 版的 `VIDEO_UA` **逐字相同**
（都是 `com.phoenix.read/71332 … Android 16 … 25053RT47C …`），所以 UA 不是原因；
差异在于 NAS 取媒体时**不发 Referer**。这个假设是被实测排除/证实的，不是猜的。

改动前 `main.js` 的 403 重试还会**补上**这个 Referer，等于重试必然再失败一次 ——
把偶发失败变成了必然失败。

## 三、低画质的根因：取源顺序

官网页自己声明的元数据里：

```json
"width": 360, "height": 640
```

**官网直链只是低清预览**（竖屏短剧的 360×640）。而 App 接口同一集给的清晰度梯度是
`1080p / 720p / 540p / 480p / 360p`。

但原代码的顺序是**官网优先**：

- 官网成功 → 画质被压到 360×640（用户看到的 640x360）
- 官网失败 → 回退 App → 因上面那个 Referer **必然 403**

所以「低画质」和「403」是同一个病根的两面，必须一起改。

## 四、改动

| 文件 | 改动 |
|---|---|
| `src/native/app-source.js` | App 片源候选不再携带 `referer` |
| `src/native/hongguo.js` | legacy api 路径同样去掉 referer；`fetchPlayUrlFresh` 改为 **App 优先、web 兜底** |
| `main.js` | 403 重试由「补上 Referer」改为「**去掉** Referer」 |

## 五、关于「补签名」

目标里提到「按需补上签名」。查证结论：**403 不是签名问题**。

- App 取址路径（`multi_video_model/v1/`）的签名是好的 —— 正是它成功取到了 1080p 地址；
  它输出的头包括 `x-gorgon` / `x-argus` / `x-ladon` / `x-helios` / `x-medusa` / `x-tt-dt`。
- 真正**未签名**的是详情/分集接口 `multi_video_detail/preload/v1`（`apiCall` 只发
  UA/Accept/Host）。但实测该端点**无论用什么身份都返回 HTTP 200 + 0 字节**：

  | 身份 | 结果 |
  |---|---|
  | 陈旧（Android 9 / SM-N9860 / 7.1.5.32，即 PC 版现状） | HTTP 200，**0 字节** |
  | 现代（Android 16 / 25053RT47C / 7.3.5.32） | HTTP 200，**0 字节** |

  所以它**本身就是死的**，改设备指纹救不了 —— 这是 PC 版 UI 里那句
  「网页源提供前 N 集，后续集数自动尝试 App 片源」的来源。要救只能补签名，
  而那属于取源路径改造，应单独评估。

- 另外：用户 NAS 的分集列表**也是从官网网页取的**（`extract_vid_list`），唯一签名调用
  就是视频地址（`multi_video_model/v1/`）。所以「只有前 N 集」的限制两边都有，
  只是本 fork 改成 App 优先后，播放不再依赖官网那条低清链路。

## 六、设备指纹的现状（一处内部不一致，未改）

PC 版两条路径各用一套身份：

| | 详情/分集（`apiCall`） | 签名取址（`app-source.js`） |
|---|---|---|
| UA | `com.phoenix.read/71532 … Android 9 … SM-N9860 … tt-ok/3.12` | `com.phoenix.read/71332 … Android 16 … 25053RT47C … Cronet/TTNet` |
| 机型 | SM-N9860 / Samsung | 25053RT47C / Redmi |
| 版本 | 7.1.5.32 | 7.1.3.32 |

因为详情接口本身已死（见上），统一身份**目前没有可观测收益**，故未改动 —— 避免为了
「看起来整齐」而改动已验证可用的取址路径。

## 七、已知代价与风险

1. **启动慢几秒**：App 片源是 CENC 加密的 HEVC，播放前要先下载 + 解密 + 重封装
   （ffmpeg `-decryption_key`，且是 `-c copy` 不重编码），不像官网直连那样即点即播。
2. **HEVC 依赖**：实测该集只有 HEVC 档、没有 H.264。Windows 常缺 HEVC 解码支持，
   **有播不出来的可能，必须实机验证**。若确实播不了，下一步应加「优先 H.264 档、
   没有再退回 HEVC」的策略。
3. 上游原测试有两条把本 bug 当成正确行为锁住了（夹具写成「没有 Referer 就 403」、
   断言 App 候选必须带 `novelquickapp.com`），已按实测修正，并新增回归护栏。

## 八、可复现命令

```bash
cd /workspace/红果/refs/hongguo-drama

# 取源结果与是否携带 Referer
node -e "const h=require('./src/native/hongguo.js');h.fetchPlayUrlSingle('7503780574541122622','7503745441910017049').then(r=>console.log(r.source,r.codec,!!r.contentKey,r.referer))"

# 403 对照实验（带/不带 Referer）
node -e "
const axios=require('axios');const app=require('./src/native/app-source');
(async()=>{const i=await app.fetchAppPlayUrl('7503780574541122622');
for(const [t,h] of [['带Referer',{'Accept-Encoding':'identity','User-Agent':i.userAgent,Referer:'https://novelquickapp.com/'}],['不带',{'Accept-Encoding':'identity','User-Agent':i.userAgent}]]){
const r=await axios.get(i.url,{headers:h,timeout:25000,responseType:'arraybuffer',maxContentLength:60000,validateStatus:()=>true}).catch(e=>e.response);
console.log(t,r&&r.status);}})();"

# 官网直链声明的分辨率（会输出 360x640）
curl -s -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0 Safari/537.36" \
  "https://hongguoduanju.com/player/7503745441910017049/7503780574541122622" \
  | grep -oE '"(width|height)": ?[0-9]{2,4}'
```

回归护栏：`node scripts/check-app-source.cjs`（其中一条专门断言 App 候选不得带 Referer）。
