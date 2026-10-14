import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Settings as SettingsIcon } from './icons';
import './NativePlayer.css';
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, formatShortcut } from '../shortcuts';
import { VideoEnhancementControls } from './VideoEnhancement';
import { DanmakuSettings } from './CommentDanmaku';

/**
 * PlayerControls —— 前台播放器控制条
 *
 * ══ 来源 ═══════════════════════════════════════════════════════════════════
 * 逐字移植自用户自有项目 hongguo-monorepo/pc/backend/static/index.html：
 *   · DOM：第 629–653 行（.ctrl-bar / .ctrl-seek / .ctrl-btns / .time / .vol /
 *          .qwrap / .qlist / .ep-pos / .spacer）
 *   · CSS：NativePlayer.css（源自第 245–266 行）
 *   · JS ：toggleFullscreen()（第 2150–2170 行）、attachAutoHideCtrls() /
 *          detachAutoHideCtrls()（第 2181–2216 行）—— 见本文件末尾的**逐字**实现
 *
 * ══ 显隐机制（本次替换的核心，别改回去）═══════════════════════════════════
 * 源的机制是纯 DOM + CSS，不看 React 状态：
 *   · `.ctrl-bar` 默认 opacity:0 / pointer-events:none；
 *   · 窗口化靠 CSS `:hover` 显示（源码 `.player-wrap:hover .ctrl-bar`）；
 *   · 全屏时 CSS 主动把 `:hover` 也压成 0，只有 JS 加的 `.fs-show` 能显示，
 *     且 `opacity/pointer-events: ... !important`；
 *   · 四个活动事件绑在 **document** 上（mousemove/keydown/wheel/mousedown），
 *     3 秒无操作才移除 `.fs-show`；
 *   · `body.fs-mode` 由原生全屏切换驱动（Player.jsx）。
 * 本仓库原来的 `controlsHidden` state → `.controls-hidden` → `opacity:0` 那套已经
 * 整段删除：它正是"全屏下移动鼠标唤不出控制条"的原因。
 *
 * ══ 与目标仓库的接口对接（不改播放链）═════════════════════════════════════
 *   播放/暂停、进度、时长  ← videoRef（同一个 <video>）
 *   上一集/下一集/集数     ← onPreviousEpisode / onNextEpisode / position / episodeCount
 *   音量（含静音）         ← 保留本仓库既有持久化（hongguo:player-volume:v1）
 *   倍速                   ← rate / onRateChange（本仓库的 0.25 档模型，见移植报告）
 *   弹幕开关               ← danmaku.toggle / danmaku.enabled / danmaku.supported
 *   自动连播               ← autoNext / onToggleAutoNext
 *   全屏                   ← onToggleFullscreen（Player.jsx，走原生窗口全屏 + body.fs-mode）
 *   画质                   ← **占位**：qualities / quality / onSelectQuality 已就位，
 *                             但本仓库 prepareOnlinePlay 没有清晰度参数，故列表恒为空、
 *                             按钮 disabled 并显示源的空态文案"画质 ▾"。
 *   仍未对接的源功能        ← 见移植报告（触屏手势、源自己的直链失败回退等）
 */

const formatTime = seconds => {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};

// 音量/静音的持久化键。放在本模块是因为它只被播放器控制条读写。
const VOLUME_STORAGE_KEY = 'hongguo:player-volume:v1';

/** 读取上次保存的音量；无记录或数据不可用时返回 null（表示沿用默认）。 */
const readStoredVolume = () => {
  try {
    const value = JSON.parse(window.localStorage.getItem(VOLUME_STORAGE_KEY));
    if (!value || typeof value !== 'object') return null;
    const v = Number(value.v);
    if (!Number.isFinite(v) || v < 0 || v > 1) return null;
    return { v, muted: value.muted === true };
  } catch { return null; }
};

// ══════════════════════════════════════════════════════════════════════════════
// 以下两个函数**逐字**来自源 index.html 第 2181–2216 行。
// 唯一改动：`document.addEventListener` / `document.body` / `document.querySelector`
// 后加可选链 —— Node 测试夹具（scripts/check-player-resume.cjs:20）里的 document
// 只有 `{ activeElement, querySelector }`，没有 body / addEventListener。
// 语义完全不变：真实浏览器里这些调用永远存在。
// ══════════════════════════════════════════════════════════════════════════════

let _autoHideTimer = null;
let _autoHideHandler = null;
// "保持显示"计数。控制条里嵌着若干弹出面板（更多播放选项 / 弹幕设置 / 画质列表），
// 源实现没有这个例外：面板打开后若 3 秒不动鼠标，整条控制条连同**打开的面板**一起被隐藏，
// 用户会看到菜单自己消失。那是缺陷而不是有意的行为差异，所以这里加一个最小例外。
// 用计数而非布尔，避免多处持有/释放互相踩。
let _autoHideHold = 0;

/** 面板打开期间压住自动隐藏（可嵌套调用，必须成对 release）。 */
export function holdAutoHideCtrls() {
  _autoHideHold += 1;
  if (_autoHideTimer) { clearTimeout(_autoHideTimer); _autoHideTimer = null; }
  document.querySelector?.('.ctrl-bar')?.classList.add('fs-show');
  document.querySelector?.('.dl-text')?.classList.add('fs-show');
}

/** 释放一次压住；全部释放后重新开始 3 秒计时。 */
export function releaseAutoHideCtrls() {
  if (_autoHideHold > 0) _autoHideHold -= 1;
  if (_autoHideHold === 0) _autoHideHandler?.();
}

/**
 * 全屏下自动隐藏播放器控件：鼠标活动显示，3s 无操作隐藏
 * （topbar 全屏时直接 display:none，不参与这里的显隐）
 */
export function attachAutoHideCtrls() {
  detachAutoHideCtrls();
  document.body?.classList?.add('pv-active'); // 标记播放器页全屏，CSS 据此隐藏 topbar
  const show = () => {
    document.querySelector?.('.ctrl-bar')?.classList.add('fs-show');
    document.querySelector?.('.dl-text')?.classList.add('fs-show');
    if (_autoHideTimer) clearTimeout(_autoHideTimer);
    // 面板打开期间不排隐藏定时器（见 _autoHideHold 的说明）
    if (_autoHideHold > 0) { _autoHideTimer = null; return; }
    _autoHideTimer = setTimeout(() => {
      document.querySelector?.('.ctrl-bar')?.classList.remove('fs-show');
      document.querySelector?.('.dl-text')?.classList.remove('fs-show');
    }, 3000);
  };
  _autoHideHandler = show;
  show();
  document.addEventListener?.('mousemove', show);
  document.addEventListener?.('keydown', show);
  document.addEventListener?.('wheel', show);
  document.addEventListener?.('mousedown', show);
}

export function detachAutoHideCtrls() {
  if (_autoHideTimer) { clearTimeout(_autoHideTimer); _autoHideTimer = null; }
  // 摘除时把"保持显示"计数一并归零：否则退出全屏后计数会残留，
  // 下次进入全屏时控制条就再也不自动隐藏了。
  _autoHideHold = 0;
  if (_autoHideHandler) {
    document.removeEventListener?.('mousemove', _autoHideHandler);
    document.removeEventListener?.('keydown', _autoHideHandler);
    document.removeEventListener?.('wheel', _autoHideHandler);
    document.removeEventListener?.('mousedown', _autoHideHandler);
    _autoHideHandler = null;
  }
  document.body?.classList?.remove('pv-active');
  document.querySelector?.('.ctrl-bar')?.classList.remove('fs-show');
  document.querySelector?.('.dl-text')?.classList.remove('fs-show');
}

export default function PlayerControls({
  danmaku, danmakuSource = 'comments', onDanmakuSourceChange, enhancement,
  shortcuts = DEFAULT_SHORTCUTS, onToggleFullscreen, videoRef, stageRef, source,
  available, continuing = false, autoContinue = false, rate, onRateChange, onError,
  pictureMode = 'fit', onPictureModeChange, portrait = false, nativeFullscreen = false,
  // 本次新增的对接入参
  autoNext = false, onToggleAutoNext, position = 0, episodeCount = 0,
  onPreviousEpisode, onNextEpisode, canPrevious = false, canNext = false,
  qualities = [], quality = '', onSelectQuality,
}) {
  const [media, setMedia] = useState({ paused: true, ended: false, time: 0, duration: 0, muted: false, volume: 1 });
  const [fullscreen, setFullscreen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [danmakuOpen, setDanmakuOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const danmakuPanelRef = useRef(null);
  const danmakuButtonRef = useRef(null);
  const [danmakuHeight, setDanmakuHeight] = useState(300);
  const [menuHeight, setMenuHeight] = useState(240);
  const controlsRef = useRef(null);
  const menuRef = useRef(null);
  const menuButtonRef = useRef(null);
  const qualityRef = useRef(null);
  const speedRef = useRef(null);
  // 源的全屏判定是 window.hgFs 的返回值；本仓库由 App 同步进 nativeFullscreen，
  // DOM 全屏（无 electronAPI 时的回退）另外记一份。
  const expanded = fullscreen || nativeFullscreen;

  // 控制条内的弹出面板（更多播放选项 / 弹幕设置 / 画质列表）打开期间压住自动隐藏。
  // 不加这条的话，面板打开后 3 秒不动鼠标，整条控制条连同打开的面板会一起消失 ——
  // 源实现没有这个例外，但那是缺陷而非有意的行为差异（详见 _autoHideHold 的说明）。
  const panelOpen = menuOpen || danmakuOpen || qualityOpen;
  useEffect(() => {
    if (!panelOpen) return undefined;
    holdAutoHideCtrls();
    return () => releaseAutoHideCtrls();
  }, [panelOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const measure = () => {
      const stage = stageRef.current?.getBoundingClientRect?.();
      const button = menuButtonRef.current?.getBoundingClientRect?.();
      if (stage && button) setMenuHeight(Math.max(96, button.top - Math.max(8, stage.top) - 16));
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (stageRef.current) observer?.observe(stageRef.current);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [menuOpen, fullscreen, nativeFullscreen, stageRef]);

  // 原生窗口全屏不像 DOM 全屏那样自带 Esc 退出，必须自己接。
  // 挂在 window 的冒泡阶段，优先级低于菜单那套（菜单在 document 上处理并
  // stopPropagation），所以"菜单打开时 Esc 先关菜单、不退出全屏"成立。
  useEffect(() => {
    if (!nativeFullscreen) return;
    const escape = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target?.closest?.('.danmaku-settings')) return;
      window.electronAPI?.setWindowFullscreen?.(false);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [nativeFullscreen]);

  // ── 媒体状态同步 + 音量/静音持久化 ─────────────────────────────────────────
  // 规则来自本仓库既有实现（用户反馈"重进立马最大声音"）：
  // 恢复必须在持久化**之前**，否则 sync 会先把媒体默认的 1.0 写进存储、
  // 把用户偏好冲掉；且只在新媒体加载（currentSrc 变化）时恢复一次，
  // 否则每次 sync 都会把用户正在调整的音量复回去。
  useEffect(() => {
    setMenuOpen(false);
    setDanmakuOpen(false);
    setQualityOpen(false);
    const video = videoRef.current;
    if (!video) return undefined;
    let appliedKey = null;
    const persistVolume = element => {
      try { window.localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ v: element.volume, muted: element.muted })); } catch { /* 存储不可用时忽略 */ }
    };
    const applyStoredVolume = () => {
      const key = video.currentSrc || '';
      if (key === appliedKey) return;
      appliedKey = key;
      const saved = readStoredVolume();
      if (!saved) return;
      if (video.volume !== saved.v) video.volume = saved.v;
      if (video.muted !== saved.muted) video.muted = saved.muted;
    };
    const sync = () => {
      applyStoredVolume();
      setMedia({ paused: video.paused, ended: video.ended, time: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0, muted: video.muted, volume: video.volume });
      persistVolume(video);
    };
    const events = ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'durationchange', 'volumechange', 'emptied'];
    events.forEach(name => video.addEventListener(name, sync));
    sync();
    return () => events.forEach(name => video.removeEventListener(name, sync));
  }, [videoRef, source, available]);

  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', sync);
    sync();
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [stageRef]);

  useEffect(() => {
    if (!menuOpen) return;
    speedRef.current?.focus();
    const outside = event => { if (!menuRef.current?.contains(event.target)) setMenuOpen(false); };
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopPropagation();
      setMenuOpen(false); menuButtonRef.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [menuOpen]);

  useEffect(() => {
    if (!qualityOpen) return;
    const outside = event => { if (!qualityRef.current?.contains(event.target)) setQualityOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [qualityOpen]);

  useEffect(() => {
    if (!danmakuOpen) return;
    const measure = () => {
      const stage = stageRef.current?.getBoundingClientRect();
      const controls = controlsRef.current?.getBoundingClientRect();
      if (stage && controls) setDanmakuHeight(Math.max(60, controls.top - stage.top - 12));
    };
    const outside = event => {
      if (!danmakuPanelRef.current?.contains(event.target) && !danmakuButtonRef.current?.contains(event.target)) setDanmakuOpen(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (stageRef.current) observer.observe(stageRef.current);
    if (controlsRef.current) observer.observe(controlsRef.current);
    document.addEventListener('pointerdown', outside);
    return () => { observer.disconnect(); document.removeEventListener('pointerdown', outside); };
  }, [danmakuOpen, stageRef]);

  const closeDanmaku = () => { setDanmakuOpen(false); danmakuButtonRef.current?.focus(); };

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!available || !video) return;
    try { if (video.paused) await video.play(); else video.pause(); }
    catch { onError?.('暂时无法播放，请重试本集'); }
  };
  // ── 进度条：源的取值模型（0–1000 归一化，见源 #seek 第 631 行）─────────────
  // 源在 bindPlayer 里用 input 事件做拖动预览、change 事件提交跳转；
  // 这里用 React 的受控 onChange 单事件等价实现（每次移动即提交，行为与
  // 本仓库原实现一致），归一化取值与源的 DOM 属性照搬。
  const seekValue = media.duration ? Math.round((Math.min(media.time, media.duration) / media.duration) * 1000) : 0;
  const seek = event => {
    const video = videoRef.current;
    if (!available || !video || !media.duration) return;
    try { video.currentTime = Math.max(0, Math.min(media.duration, media.duration * Number(event.target.value) / 1000)); }
    catch { onError?.('暂时无法跳转，请稍后重试'); }
  };
  const changeVolume = event => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Number(event.target.value);
    video.muted = video.volume === 0;
  };
  // 源的 volIcon()（第 2362–2364 行）
  const volIcon = (v, muted) => ((muted || v <= 0) ? '🔇' : v < 0.5 ? '🔉' : '🔊');
  // 源的 updateQualityBtn()（第 2136–2142 行）：无档位时显示"画质 ▾"
  const activeQuality = useMemo(
    () => qualities.find(q => q.label === quality || q.key === quality) || qualities[0] || null,
    [qualities, quality]
  );

  return (
    <div ref={controlsRef} className="ctrl-bar player-controls" id="ctrl-bar" role="group" aria-label="视频播放控制">
      <div className="ctrl-seek">
        <input type="range" id="seek" aria-label="播放进度" aria-valuetext={`${formatTime(media.time)} / ${formatTime(media.duration)}`} min="0" max="1000" step="1" value={seekValue} disabled={!available || !media.duration} onChange={seek} />
        <span className="time" id="time-info">{formatTime(media.time)} / {formatTime(media.duration)}</span>
      </div>
      <div className="ctrl-btns player-controls-row">
        <button type="button" id="btn-prev" aria-label="上一集" title="上一集" disabled={!canPrevious} onClick={() => onPreviousEpisode?.()}>⏮ 上一集</button>
        <button type="button" id="btn-play" aria-label={media.paused ? '播放' : '暂停'} title={`播放/暂停（${formatShortcut(shortcuts.play)}）`} disabled={!available} onClick={togglePlay}>{media.paused ? '▶' : '⏸'}</button>
        <button type="button" id="btn-next" aria-label="下一集" title="下一集" disabled={!canNext} onClick={() => onNextEpisode?.()}>下一集 ⏭</button>
        <span className="ep-pos" id="ep-pos">{episodeCount ? `${position} / ${episodeCount}` : ''}</span>
        <span className="spacer" />
        <div className="vol player-controls-volume">
          <button type="button" id="btn-vol" aria-label={media.muted ? '取消静音' : '静音'} title="静音" onClick={() => { const video = videoRef.current; if (video) video.muted = !video.muted; }}>
            {volIcon(media.volume, media.muted)}
          </button>
          <input type="range" id="vol" aria-label="音量" aria-valuetext={`${Math.round((media.muted ? 0 : media.volume) * 100)}%`} min="0" max="1" step="0.05" value={media.muted ? 0 : media.volume} onChange={changeVolume} />
        </div>
        {/* 倍速：源的按钮外观 + 本仓库既有的 0.25 档模型（onRateChange 由播放链/快捷键共用） */}
        <button type="button" id="btn-speed" aria-label="增加播放速度" title={`播放速度 ${rate}×，点击增加 0.25 倍，4 倍后回到 1 倍`} onClick={() => onRateChange(rate >= 4 ? 1 : Math.min(4, rate + 0.25))}>{rate}×</button>
        {/* ── 画质：占位 ──────────────────────────────────────────────────────
            源的 .qwrap/.qlist 结构照搬，但本仓库 prepareOnlinePlay({vid,seriesId,vidIndex,
            requestId,prefetch}) 没有清晰度参数，也没有任何清晰度数据源，因此
            qualities 恒为空 → 按钮 disabled 并显示源的空态文案"画质 ▾"。
            一旦有了数据源，把 qualities/quality/onSelectQuality 接上即可，无需改结构。 */}
        <div className="qwrap" ref={qualityRef}>
          <button type="button" id="btn-quality" title="画质（本版本不可选：播放地址由片源决定，没有清晰度参数）" aria-label="画质" aria-expanded={qualityOpen} disabled={qualities.length === 0} onClick={event => { event.stopPropagation(); setQualityOpen(open => !open); }}>
            {activeQuality ? `画质 ${activeQuality.label} ▾` : '画质 ▾'}
          </button>
          {qualityOpen && (
            <div className="qlist" id="qlist">
              {qualities.map(q => (
                <div key={q.key || q.label} className={'qitem' + ((activeQuality && (q.label === activeQuality.label)) ? ' active' : '')} role="button" tabIndex={0} onClick={() => { setQualityOpen(false); onSelectQuality?.(q); }}>
                  <span>{q.label}</span><span>{q.size ? `${(q.size / 1048576).toFixed(0)}M` : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {/* 弹幕开关：源的 #btn-danmaku（文本"弹" + .active） */}
        <button type="button" id="btn-danmaku" className={danmaku?.enabled ? 'active' : ''} aria-pressed={!!danmaku?.enabled} disabled={!danmaku?.supported}
          aria-label={danmaku?.enabled ? (danmakuSource === 'official' ? '关闭弹幕' : '关闭评论弹幕') : (danmakuSource === 'official' ? '开启弹幕' : '开启评论弹幕')}
          title={danmaku?.supported
            ? (danmakuSource === 'official' ? '将本集弹幕按播放进度显示在画面上' : '将当前集公开评论显示在画面上')
            : (danmakuSource === 'official' ? '仅红果来源的剧集支持弹幕' : '仅红果来源的当前集支持评论弹幕')}
          onClick={() => danmaku?.toggle?.()}>弹</button>
        {/* 自动连播：源的 #btn-auto（文本"连播" + .active） */}
        <button type="button" id="btn-auto" className={autoNext ? 'active' : ''} aria-pressed={autoNext} title={`自动连播（${formatShortcut(shortcuts.autoNext)}）`} onClick={() => onToggleAutoNext?.(!autoNext)}>连播</button>
        {/* 全屏：源的 #btn-fs；aria-label 保持本仓库的两个取值（隐身旁路依赖它隐藏按钮） */}
        <button type="button" id="btn-fs" aria-label={expanded ? '退出全屏' : '全屏'} title={`${expanded ? '退出全屏' : '全屏'}（${formatShortcut(shortcuts.fullscreen)}）`} onClick={onToggleFullscreen}>⛶</button>

        {/* ── 以下为本仓库独有（源没有这些功能），沿用既有标记与样式 ────────── */}
        {danmaku && <div className="player-controls-danmaku">
          <button type="button" data-player-menu className="danmaku-icon-button" ref={danmakuButtonRef} aria-label="弹幕设置" title="弹幕设置" aria-haspopup="dialog" aria-expanded={danmakuOpen}
            onClick={() => { setMenuOpen(false); setQualityOpen(false); setDanmakuOpen(open => !open); }}>
            <span className="danmaku-symbol" aria-hidden="true">弹<span className="danmaku-settings-mark"><SettingsIcon size={10} /></span></span>
          </button>
          {danmakuOpen && <DanmakuSettings danmaku={danmaku} source={danmakuSource} onSourceChange={onDanmakuSourceChange} onClose={closeDanmaku} panelRef={danmakuPanelRef} maxHeight={danmakuHeight} />}
        </div>}
        <div className="player-controls-options" data-player-menu ref={menuRef}>
          <button type="button" ref={menuButtonRef} aria-label="更多播放选项" title="更多播放选项" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => { setDanmakuOpen(false); setQualityOpen(false); setMenuOpen(open => !open); }}>
            <span aria-hidden="true">⋯</span>
          </button>
          {menuOpen && <div className="player-controls-menu" style={{ maxHeight: menuHeight }} role="dialog" aria-label="播放选项">
            <label>播放速度<select ref={speedRef} aria-label="播放速度" value={rate} onChange={event => onRateChange(Number(event.target.value))}>
              {Array.from({ length: 16 }, (_, index) => (index + 1) / 4).map(value => <option key={value} value={value}>{value}×</option>)}
            </select></label>
            <label className="player-picture-mode">画面模式<select aria-label="画面模式" aria-describedby="picture-mode-hint" value={pictureMode} onChange={event => onPictureModeChange(event.target.value)}>
              <option value="fit">适应窗口</option>
              <option value="width">保持宽度</option>
            </select></label>
            <span id="picture-mode-hint">{pictureMode === 'width' ? '按宽度显示，上下可能裁剪。按剧单独记忆。' : '完整显示，随窗口缩放。按剧单独记忆。'}</span>
            {enhancement && <VideoEnhancementControls enhancement={enhancement} available={available} />}
            {SHORTCUT_ACTIONS.map(action => <span key={action.id}>{formatShortcut(shortcuts[action.id])}：{action.label}</span>)}
          </div>}
        </div>
      </div>
    </div>
  );
}
