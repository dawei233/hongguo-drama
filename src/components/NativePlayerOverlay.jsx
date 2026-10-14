import React, { useEffect, useRef, useState } from 'react';

/**
 * NativePlayerOverlay —— 播放器的「准备 / 下载 / 缓冲」覆盖层
 *
 * 逐字移植自用户自有项目 hongguo-monorepo/pc/backend/static/index.html：
 *   · DOM：第 615–628 行（#overlay 一族 + #dl-bar 一族）
 *   · CSS：NativePlayer.css（.player-overlay / .spinner / .dl-pct / .dl-progress /
 *          .dl-bar / .dl-fill / .dl-text，源自第 223–244 行）
 *   · 文案与状态机：源 pollProgress()（第 1986–2024 行，"下载中"分支）、
 *     startPlay().updateDl()（第 2041–2091 行，"边下边播"分支）、
 *     bindPlayer() 的 waiting/playing（第 2260–2265 行）、showErr()（第 2094–2103 行）。
 *
 * ── 与目标仓库的对接（都是接口对接，没有改播放链） ──────────────────────────
 * 1) 进度来源：**自己独立订阅** window.electronAPI.onOnlinePlayProgress。
 *    不能复用 Player.jsx:403-416 那个监听器：它在 request.prepared 之后会把后续
 *    进度事件全部丢弃（`if (!request || request.prepared || ...) return`），
 *    而"边下边播 N%"恰恰只在开始播放之后才有意义。这里按 seriesId + vidIndex 过滤，
 *    不读 onlineRequestRef，也不写 Player.jsx 的 onlineProgress —— 因此**不会**
 *    影响 canPlay（Player.jsx:461 要求 !onlineProgress）。
 * 2) 缓冲：直接听 video 的 waiting / playing（源的 bindPlayer 做法）。
 *    只注册这两个事件名：Player.jsx 的 onWaiting/onPlaying 是 React 属性、
 *    PlayerControls 的 sync 监听数组里没有这两个名字，不会互相顶掉。
 * 3) 重试：按钮文案与结构照源搬，但**不搬**源 video error 里那套
 *    "直链失败 → 回退整集下载" 的逻辑（源第 2267–2280 行）。原因见移植报告：
 *    那正是 docs/research/renderer-playback-consumption.md §3 R3 明令要避免的
 *    "起播早期 media error 2/4 被误判成片源不可用"。这里只提供按钮，
 *    由 Player.jsx 决定是否显示、以及点了以后走它自己的重试路径。
 * 4) 显示范围：本组件只在 available(=canPlay) 为真时才可能出现。
 *    准备期(!canPlay)由本仓库既有的 .player-placeholder 占位层独占画面，
 *    两层都是 inset:0，同时出现会叠在一起。源里这两层本来就是分时的
 *    （下载完成前 overlay、完成后才开始边下边播），分工与源码一致。
 */

// 源 peekProgress 用的换算：字节 → MB
const toMB = bytes => (bytes ? bytes / 1048576 : 0);

export default function NativePlayerOverlay({
  videoRef,
  available = false,
  seriesId = '',
  vidIndex = null,
  retryVisible = false,
  onRetry,
}) {
  // 与源 #overlay 的三个可变部分一一对应（源是直接写 textContent / className）
  const [overlay, setOverlay] = useState({ hidden: true, spinner: true, msg: '正在解析视频…', sub: '' });
  // 与源 #dl-pct / #dl-progress 对应：null = 两者都 display:none
  const [percent, setPercent] = useState(null);
  // 与源 #dl-bar / #dl-fill / #dl-text 对应
  const [bar, setBar] = useState({ visible: false, fill: 0, text: '下载中 0%' });
  const barRef = useRef(bar);
  barRef.current = bar;

  /** 源里"终态文件就绪"的做法是切到终态地址后时长恢复有限值（见源第 2060–2073 行注释）。
   *  这里就在收到进度/playing 时顺手看一眼 duration，不额外注册媒体事件。 */
  const settled = () => {
    const duration = videoRef.current?.duration;
    return Number.isFinite(duration) && duration > 0;
  };

  // ══ 源 bindPlayer() 的 waiting / playing（第 2260–2265 行） ═══════════════
  useEffect(() => {
    const video = videoRef.current;
    if (!video?.addEventListener) return undefined;
    const onWaiting = () => {
      // 源：if (!video.paused) { ov-msg='缓冲中…'; ov-sub=''; overlay 显示 }
      if (!video.paused) setOverlay(current => ({ ...current, hidden: false, msg: '缓冲中…', sub: '' }));
    };
    const onPlaying = () => {
      // 源：overlay 隐藏
      setOverlay(current => ({ ...current, hidden: true }));
      // 终态文件被换上后（源会 reload）会再发一次 playing —— 此时收掉边下边播进度条
      if (settled() && barRef.current.visible) setBar(current => ({ ...current, visible: false }));
    };
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    return () => {
      video.removeEventListener?.('waiting', onWaiting);
      video.removeEventListener?.('playing', onPlaying);
    };
    // seriesId/vidIndex 变化意味着换了媒体元素内容，重新挂一次（与源"换集重绑"一致）
  }, [videoRef, seriesId, vidIndex]);

  // ══ 独立订阅在线播放进度 ═══════════════════════════════════════════════════
  useEffect(() => {
    const subscribe = window.electronAPI?.onOnlinePlayProgress;
    if (typeof subscribe !== 'function') return undefined;
    return subscribe((data) => {
      if (!data || String(data.seriesId ?? '') !== String(seriesId ?? '')) return;
      if (data.vidIndex != null && vidIndex != null && data.vidIndex !== vidIndex) return;
      const pct = Math.max(0, Number(data.percent) || 0);
      const received = Number(data.received) || 0;
      const total = Number(data.total) || 0;
      const phase = data.phase || 'downloading';
      // 收尾：写满了 100%，或终态文件已就绪（有限时长）
      if (pct >= 100 || (total > 0 && received >= total) || settled()) {
        setPercent(null);
        setBar(current => ({ ...current, visible: false }));
        return;
      }
      if (phase === 'preparing') {
        // 源 playEpisode() 开头的状态（第 1934–1937 行）
        setOverlay(current => ({ ...current, hidden: false, spinner: true, msg: '正在解析视频…', sub: '请求官方接口解析播放地址' }));
        setPercent(null);
        setBar(current => ({ ...current, visible: false }));
        return;
      }
      if (available) {
        // 源 startPlay().updateDl() 的 downloading 分支（第 2081–2087 行）
        setBar({
          visible: true,
          fill: pct ? Math.min(pct, 100) : 8,
          text: pct ? `边下边播 ${pct}%` : (received ? `边下边播 ${toMB(received).toFixed(0)}MB` : '边下边播中…'),
        });
        setOverlay(current => ({ ...current, hidden: true }));
        setPercent(null);
        return;
      }
      // 源 pollProgress() 的 downloading 分支（第 2001–2020 行）
      const totalText = total ? toMB(total).toFixed(1) : '?';
      setOverlay(current => ({
        ...current,
        hidden: false,
        spinner: false,
        msg: pct ? `正在缓冲 ${pct}%` : '正在下载解密…',
        sub: pct ? `已下载 ${toMB(received).toFixed(0)}MB / ${totalText}MB · 完成即自动播放` : `已下载 ${toMB(received).toFixed(0)}MB，请稍候`,
      }));
      setPercent(pct || 0);
      setBar({ visible: true, fill: pct ? pct : 8, text: pct ? `缓冲 ${pct}%` : '缓冲中…' });
    });
  }, [seriesId, vidIndex, available]);

  // 换集/换源：清掉上一集的进度条，避免它挂在新一集画面上
  useEffect(() => {
    setPercent(null);
    setBar(current => ({ ...current, visible: false }));
    setOverlay(current => ({ ...current, hidden: true, sub: '' }));
  }, [seriesId, vidIndex]);

  const overlayClass = 'player-overlay' + (overlay.hidden ? ' hidden' : '');
  return (
    <>
      <div className={overlayClass} id="overlay" role="status" aria-live="polite">
        {overlay.spinner && <div className="spinner" id="spinner" />}
        <div className="msg" id="ov-msg">{overlay.msg}</div>
        {percent !== null && <div className="dl-pct" id="dl-pct">{percent ? `${percent}%` : '…'}</div>}
        {percent !== null && (
          <div className="dl-progress" id="dl-progress">
            <div className="dl-progress-fill" id="dl-progress-fill" style={{ width: `${percent ? percent : 4}%` }} />
          </div>
        )}
        <div className="sub" id="ov-sub">{overlay.sub}</div>
        {retryVisible && <button className="retry" id="ov-retry" onClick={() => onRetry?.()}>重试</button>}
      </div>
      {/* 源 #dl-bar 初始 style="display:none" */}
      {bar.visible && (
        <div className="dl-bar" id="dl-bar">
          <div className="dl-fill" id="dl-fill" style={{ width: `${bar.fill}%` }} />
          <div className="dl-text" id="dl-text">{bar.text}</div>
        </div>
      )}
    </>
  );
}
