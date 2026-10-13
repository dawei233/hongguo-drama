import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_DANMAKU_SETTINGS, normalizeDanmakuSettings, commentIsBlocked } from './danmakuModel.mjs';
import { createOfficialFeed, appendOfficialPage, advanceTimedDanmaku, resolveDanmakuStatus } from './danmakuOfficial.mjs';
import './CommentDanmaku.css';

/**
 * 官方弹幕叠层：按视频时间投放。
 *
 * 与 `CommentDanmaku.jsx`（本集评论滚动条）是两个独立组件，不是同一个组件的
 * 分支。这样上游那套评论逻辑与其夹具测试完全不受影响，将来合并上游也不用解冲突。
 *
 * 视觉设置沿用同一个存储键，换源不会清掉用户调好的字号与屏蔽词。
 */

const STORAGE_KEY = 'hongguo:comment-danmaku:v1';

const readPreferences = () => {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
    return { enabled: value?.enabled === true, ...normalizeDanmakuSettings(value) };
  } catch {
    return { enabled: false, ...DEFAULT_DANMAKU_SETTINGS };
  }
};

export function useOfficialDanmaku({ seriesId, vid, active }) {
  const [preferences, setPreferences] = useState(readPreferences);
  const [saveError, setSaveError] = useState('');
  const [visible, setVisible] = useState(() => !document.hidden);
  const [, refresh] = useState(0);
  const feed = useMemo(() => createOfficialFeed(seriesId, vid), [seriesId, vid]);
  const currentFeed = useRef(feed);
  currentFeed.current = feed;

  const supported = /^\d{6,30}$/.test(String(seriesId || '')) && /^\d{6,30}$/.test(String(vid || ''));
  const enabled = preferences.enabled && supported;
  const running = enabled && active && visible;

  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  // 一集只抓一次。主进程侧另有 5 分钟缓存与在途去重，切集回来不会重复打上游。
  useEffect(() => {
    if (!running || feed.loaded || feed.loading) return undefined;
    let cancelled = false;
    feed.loading = true;
    refresh(value => value + 1);
    const finish = () => {
      feed.loading = false;
      feed.fresh = false;
      if (currentFeed.current === feed) refresh(value => value + 1);
    };
    (async () => {
      try {
        const data = await window.electronAPI?.getEpisodeDanmaku?.({
          seriesId: feed.seriesId,
          vid: feed.vid,
          fresh: feed.fresh === true,
        });
        if (cancelled || currentFeed.current !== feed) return;
        if (!data || typeof data !== 'object') {
          feed.loaded = true;
          feed.error = '弹幕接口不可用，可稍后重试';
          return;
        }
        appendOfficialPage(feed, data);
      } catch {
        if (!cancelled && currentFeed.current === feed) {
          feed.loaded = true;
          feed.error = '弹幕加载失败，可稍后重试';
        }
      } finally {
        if (currentFeed.current === feed) finish();
      }
    })();
    return () => { cancelled = true; };
  }, [running, feed]);

  const update = patch => {
    const next = { enabled: preferences.enabled, ...preferences, ...patch };
    const validated = { enabled: next.enabled === true, ...normalizeDanmakuSettings(next) };
    setPreferences(validated);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(validated));
      setSaveError('');
    } catch {
      setSaveError('设置已生效，但本机保存失败');
    }
  };

  const settings = useMemo(() => normalizeDanmakuSettings(preferences), [preferences]);

  // 状态文案只有这一个出口：失败、部分成功、加载中、空集都必须经由它，
  // 否则某条路径会把"源坏了"显示成"本集没有弹幕"。
  const status = resolveDanmakuStatus({
    source: 'official',
    supported,
    enabled,
    active,
    visible,
    error: feed.error,
    loading: running && feed.loading,
    notice: feed.notice,
    loaded: feed.loaded,
    count: feed.danmaku.length,
  });

  return {
    sourceKind: 'official',
    enabled,
    supported,
    running,
    settings,
    feed,
    comments: feed.danmaku,
    status,
    saveError,
    error: feed.error,
    loading: running && feed.loading,
    toggle: () => update({ enabled: !preferences.enabled }),
    update,
    reset: () => update(DEFAULT_DANMAKU_SETTINGS),
    retry: () => {
      feed.error = '';
      feed.notice = '';
      feed.loaded = false;
      feed.fresh = true; // 绕过主进程的失败缓存，否则重试只会拿到同一条失败
      refresh(value => value + 1);
    },
  };
}

export default function OfficialDanmaku({ videoRef, source, available, danmaku }) {
  const layerRef = useRef(null);
  const nodes = useRef(new Map());
  const [items, setItems] = useState([]);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const { running, settings, feed, status, error, loading } = danmaku;
  const list = feed.danmaku;

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReducedMotion(media.matches);
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  // 设置变化时保持"已经投出去的弹幕"不重来：只按新字号重算宽度、压回不重叠的
  // 位置，并把命中屏蔽词的当场撤掉。与评论滚动条的处理保持一致。
  useEffect(() => {
    const state = feed.animation;
    state.items = state.items.filter(item => !commentIsBlocked(item.content, settings));
    let nextY = 12;
    for (const item of [...state.items].sort((a, b) => a.y - b.y)) {
      item.width = (Array.from(item.text).length + 1) * settings.fontSize;
      item.y = Math.max(item.y, nextY);
      nextY = item.y + settings.fontSize + 12;
    }
    setItems([...state.items]);
    const layer = layerRef.current;
    const video = videoRef.current;
    if (!running || !available || !layer || !video) return undefined;
    let frame = 0;
    let previous = 0;
    let width = layer.clientWidth;
    let height = layer.clientHeight;
    const controls = layer.parentElement?.querySelector('.player-controls');
    const options = () => ({ width, height, settings, reducedMotion, bottomInset: Math.max(76, (controls?.clientHeight || 0) + 8) });
    const paint = () => state.items.forEach(item => {
      const node = nodes.current.get(item.id);
      if (node) node.style.transform = `translate(${item.x}px, ${item.y}px)`;
    });
    const canAdvance = () => !video.paused && !video.ended && !video.seeking && video.readyState >= 2 && !document.hidden;
    const tick = now => {
      frame = 0;
      if (!canAdvance()) { previous = 0; return; }
      const delta = previous ? Math.min((now - previous) / 1000, 0.1) * video.playbackRate : 0.001;
      previous = now;
      if (advanceTimedDanmaku(state, list, video.currentTime, delta, options())) setItems([...state.items]);
      paint();
      frame = requestAnimationFrame(tick);
    };
    const start = () => { if (!frame && canAdvance()) { previous = 0; frame = requestAnimationFrame(tick); } };
    const stop = () => { cancelAnimationFrame(frame); frame = 0; previous = 0; };
    // 让下一帧重新对齐：跳转后必须重建光标，否则会把中间整段弹幕一次性倒出来
    const seek = () => { state.lastTime = undefined; };
    const resize = () => {
      const nextWidth = layer.clientWidth;
      const nextHeight = layer.clientHeight;
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth; height = nextHeight;
      stop(); start();
    };
    start();
    const observer = new ResizeObserver(resize);
    observer.observe(layer);
    const events = { playing: start, play: start, seeked: start, canplay: start, pause: stop, ended: stop, waiting: stop, seeking: seek, emptied: seek };
    Object.entries(events).forEach(([name, handler]) => video.addEventListener(name, handler));
    return () => { stop(); observer.disconnect(); Object.entries(events).forEach(([name, handler]) => video.removeEventListener(name, handler)); };
  }, [running, available, list, settings, reducedMotion, source, videoRef, feed]);

  if (!running || !available) return null;
  return <div ref={layerRef} className={`comment-danmaku ${reducedMotion ? 'comment-danmaku-static' : ''}`}>
    <div aria-hidden="true" style={{ opacity: settings.opacity / 100, fontSize: settings.fontSize }}>
      {((list.length ? items : [])).map(item => <span className="comment-danmaku-item" key={item.id} ref={node => { if (node) nodes.current.set(item.id, node); else nodes.current.delete(item.id); }}
        style={{ transform: `translate(${item.x}px, ${item.y}px)`, color: item.color || '#FFFFFF' }}>{item.text}</span>)}
    </div>
    {((loading && !items.length) || error || !list.length) && <span className="comment-danmaku-status" role="status">{status}</span>}
  </div>;
}
