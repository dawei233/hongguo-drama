/**
 * 官方弹幕（带视频时间轴）的纯逻辑模型。
 *
 * ## 为什么单开一个文件
 *
 * `danmakuModel.mjs` 是上游的「本集评论滚动条」模型，它的单测用
 * `deepEqual` 锁死了设置对象的字段集合，夹具测试又断言了 `feed.animation`
 * 的内部结构。往里面加字段会同时打破两类测试，也会让以后
 * `git merge upstream/main` 每次都冲突。
 *
 * 所以这里**新增**而不是修改：评论滚动条那条路完全不动，官方弹幕这条路自成
 * 一套模型。两者共享的只有视觉设置（字号/透明度/速度/区域/密度/屏蔽词），
 * 由 `danmakuModel.mjs` 的 `normalizeDanmakuSettings` 提供。
 *
 * ## 与评论滚动条的本质区别
 *
 * 评论滚动条是"有一条发一条"的先进先出队列，与视频时间无关。
 * 弹幕必须**按视频时间投放**：`time` 到点了才出现，用户拖动进度条后要跟着
 * 重新对齐。这就是 `advanceTimedDanmaku` 存在的原因。
 */

import { commentIsBlocked } from './danmakuModel.mjs';

export const DANMAKU_SOURCES = Object.freeze(['official', 'comments']);

/** 默认走真弹幕；存储里出现任何其它值都回落到默认。 */
export const DEFAULT_DANMAKU_SOURCE = 'official';

export function normalizeDanmakuSource(value) {
  return DANMAKU_SOURCES.includes(value) ? value : DEFAULT_DANMAKU_SOURCE;
}

export const SOURCE_LABELS = Object.freeze({
  official: '官方弹幕',
  comments: '本集评论',
});

// 一道弹幕占满整屏所需的时间由宽度和速度决定；这里只约束"同一道里前后两条
// 至少要留出的水平间距"，避免后发的弹幕追尾前面那条。
const LANE_HEAD_GAP = 24;

// 单帧最多消费多少条待发弹幕，防止一次性涌入（例如长时间卡顿后恢复）把画面糊住。
const MAX_EMIT_PER_FRAME = 4;

// 两次投放之间的最小间隔（秒），按密度分档。
//
// 注意这个值**不能照抄**评论滚动条那套（那边是 3 / 1.8 / 0.9）。评论滚动条没有
// 时间轴，靠这个间隔给队列定速；弹幕有时间轴，时间轴本身就在定速，间隔只用来
// 防同刻堆叠。照抄那套 1.8 秒会把吞吐压到 0.55 条/秒，而实测一部剧的弹幕密度
// 约 0.5 条/秒且带突发，结果就是突发段落整批变成"迟到"而被丢弃。
// 通道数（稀疏 1 / 适中 3 / 密集 6）才是密度的主要控制手段。
const EMIT_INTERVAL = Object.freeze({ sparse: 1.5, normal: 0.6, dense: 0.25 });

/** 严重迟到的弹幕直接丢弃：它们在时间轴上已经过去了，补发只会突兀。 */
const STALE_SECONDS = 5;

/**
 * 减少动态效果模式下每条弹幕的展示时长。
 *
 * 这个模式一次只轮播一条，所以吞吐量天生比滚动模式低一个量级。迟到阈值必须跟着
 * 放宽到同一个量级 —— 否则排队中的弹幕会在还没轮到时就全部被判"迟到"丢掉，
 * 结果是开了减少动态效果几乎看不到弹幕。
 */
const REDUCED_MOTION_READ_SECONDS = 6;

/**
 * 认定"用户跳转了进度"的条件。
 *
 * 正常播放时 `currentTime` 的增量约等于本帧的媒体时间增量；一旦出现负数增量
 * 或远超增量的正跳变，就只能是 seek。这个判断决定了要不要重建光标与清屏，
 * 判错会导致快进后把中间整段弹幕一次性倒到屏幕上。
 */
function isSeek(lastTime, currentTime, elapsed) {
  if (lastTime === undefined) return true;
  const jump = currentTime - lastTime;
  if (jump < 0) return true;
  return jump > elapsed * 3 + 1;
}

/** 找到第一条 time >= currentTime 的下标（列表按 time 升序）。 */
export function lowerBoundTime(list, currentTime) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid].time < currentTime) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function createOfficialFeed(seriesId, vid) {
  return {
    source: 'official',
    seriesId: String(seriesId ?? ''),
    vid: String(vid ?? ''),
    danmaku: [],
    loaded: false,
    loading: false,
    error: '',
    notice: '',
    truncated: false,
    partial: false,
    // 动画状态与评论滚动条同名（items/nextId/cooldown），便于渲染层复用同一套
    // 绘制与设置变更处理。
    animation: { items: [], nextId: 0, cursor: 0, cooldown: 0, lastTime: undefined },
  };
}

/**
 * 写入一页官方弹幕结果。
 *
 * 上游接口每次返回的是当次抓到的子集（实测同一集在几十秒内会给出 71~104 条
 * 不同结果），因此这里只做合并与排序，**不把 `hasMore` 之类当作"已全部加载"**；
 * 状态文案统一由 `resolveDanmakuStatus` 决定。
 */
export function appendOfficialPage(feed, data) {
  if (!data || typeof data !== 'object') throw new Error('Invalid official danmaku page');
  if (String(data.series_id) !== feed.seriesId || String(data.episode_id) !== feed.vid) {
    throw new Error('Invalid official danmaku page');
  }
  const incoming = Array.isArray(data.items) ? data.items : [];
  const seen = new Set(feed.danmaku.map(item => `${item.time.toFixed(3)}|${item.text}`));
  for (const item of incoming) {
    if (!item || typeof item.text !== 'string' || !Number.isFinite(item.time)) continue;
    const key = `${item.time.toFixed(3)}|${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    feed.danmaku.push(item);
  }
  feed.danmaku.sort((a, b) => a.time - b.time);
  feed.loaded = true;
  feed.truncated = data.truncated === true;
  feed.partial = data.partial === true;
  feed.notice = typeof data.notice === 'string' ? data.notice : '';
  feed.error = data.success === false ? (typeof data.error === 'string' && data.error ? data.error : '弹幕加载失败') : '';
  return feed;
}

/**
 * 按视频时间投放弹幕，并推进已在屏上的弹幕。
 *
 * @param {object} state    `feed.animation`
 * @param {Array}  danmaku  按 time 升序的弹幕列表
 * @param {number} currentTime 视频当前播放位置（秒）
 * @param {number} elapsed  本帧推进的**媒体**时间（秒，已乘倍速）
 * @param {object} options  `{ width, height, settings, reducedMotion, bottomInset }`
 * @returns {boolean} 是否需要重绘
 */
export function advanceTimedDanmaku(state, danmaku, currentTime, elapsed, options) {
  const { width, height, settings, reducedMotion, bottomInset = 76 } = options;
  if (!(width >= 40) || !(height >= 60)) return false;
  const list = Array.isArray(danmaku) ? danmaku : [];
  const delta = Math.min(Math.max(elapsed, 0), 0.25);
  let changed = false;

  if (isSeek(state.lastTime, currentTime, elapsed)) {
    // 跳转后必须重建：光标对齐到新位置，在屏弹幕全部作废（它们属于跳转前的时间点）。
    // 这里**不能**提前 return —— 否则跳转那一帧不投放任何弹幕，跳过去要等下一帧
    // 才出画面，观感上像卡了一下。
    state.cursor = lowerBoundTime(list, currentTime);
    if (state.items.length) changed = true; // 只有真的清了屏才算需要重绘
    state.items = [];
    state.cooldown = 0;
  }
  state.lastTime = currentTime;

  const before = state.items.length;
  for (const item of state.items) {
    item.age += delta;
    if (!reducedMotion) item.x -= 85 * settings.speed * delta;
  }
  state.items = state.items.filter(item => (reducedMotion ? item.age < REDUCED_MOTION_READ_SECONDS : item.x + item.width > 0));
  if (state.items.length !== before) changed = true;
  state.cooldown = Math.max(0, state.cooldown - delta);

  const lineHeight = settings.fontSize + 12;
  const top = 12;
  const bottom = Math.min(height - bottomInset, height * ({ quarter: 0.25, half: 0.5, full: 1 }[settings.area] ?? 0.5));
  const lanes = reducedMotion
    ? 1
    : Math.max(1, Math.min({ sparse: 1, normal: 3, dense: 6 }[settings.density] ?? 3, Math.floor((bottom - top) / lineHeight)));
  const laneGap = lanes > 1 ? Math.max(lineHeight, (bottom - top - lineHeight) / (lanes - 1)) : 0;

  const laneFree = index => {
    const occupants = state.items.filter(item => item.lane === index);
    if (!occupants.length) return true;
    // 允许同一道里多发：只要最后一条已经走出足够距离，新的一条就不会追尾。
    // 上游评论滚动条用的是"这道有人就占着"，对真弹幕（一集上百条）会严重丢量。
    const newest = occupants.reduce((a, b) => (a.x > b.x ? a : b));
    return newest.x + newest.width + LANE_HEAD_GAP <= width;
  };

  let emitted = 0;
  const staleAfter = reducedMotion ? REDUCED_MOTION_READ_SECONDS : STALE_SECONDS;
  while (state.cursor < list.length && emitted < MAX_EMIT_PER_FRAME) {
    const entry = list[state.cursor];
    if (!(entry.time <= currentTime)) break;

    const stale = currentTime - entry.time > staleAfter;
    const blocked = commentIsBlocked(entry.text, settings);
    if (blocked || stale) {
      state.cursor++;
      continue;
    }
    if (state.cooldown > 0) break;

    const lane = Array.from({ length: lanes }, (_, index) => index).find(laneFree);
    if (lane === undefined) break; // 保留 cursor，下一帧再试

    const chars = Array.from(entry.text);
    const text = chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : entry.text;
    const textWidth = (Array.from(text).length + 1) * settings.fontSize;
    state.items.push({
      id: state.nextId++,
      text,
      content: entry.text,
      color: entry.color,
      mode: entry.mode,
      lane,
      x: reducedMotion ? 12 : width,
      y: top + lane * laneGap,
      width: textWidth,
      age: 0,
    });
    state.cooldown = reducedMotion ? REDUCED_MOTION_READ_SECONDS : (EMIT_INTERVAL[settings.density] ?? EMIT_INTERVAL.normal);
    state.cursor++;
    emitted++;
    changed = true;
  }

  return changed;
}

/**
 * 唯一的结束状态出口。
 *
 * 官方弹幕有好几条失败路径（超时、HTTP 错误、部分成功、缓存命中失败结果）。
 * 只要有一条路径自己拼状态文案，就会出现"源坏了却显示本集没有弹幕"这类事故。
 * 因此所有路径都必须调用这里，不在别处拼字符串。
 */
export function resolveDanmakuStatus({ source, supported, enabled, active, visible, error, loading, notice, loaded, count }) {
  if (!supported) return source === 'official' ? '仅红果来源的剧集支持弹幕' : '仅红果来源的当前集支持评论弹幕';
  if (!enabled) return source === 'official' ? '开启后展示官方弹幕' : '开启后展示本集公开评论';
  if (!active) return source === 'official' ? '播放本集后显示弹幕' : '播放本集后显示评论弹幕';
  if (!visible) return '';
  // 失败优先于一切：宁可说"没取到"，也不能说成"没有弹幕"
  if (error) return error;
  if (loading) return '正在加载弹幕…';
  if (notice && !count) return notice;
  if (!loaded) return '正在加载弹幕…';
  if (!count) return notice || '本集暂无弹幕';
  return `已载入 ${count} 条弹幕${notice ? `（${notice}）` : ''}`;
}
