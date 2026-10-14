import React, { useEffect, useRef, useState } from 'react';
import { Play, Pause, Settings as SettingsIcon } from './icons';
import './PlayerControls.css';
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, formatShortcut, ignoresPlaybackShortcut, shortcutKey } from '../shortcuts';
import { VideoEnhancementControls } from './VideoEnhancement';
import { DanmakuSettings } from './CommentDanmaku';

const formatTime = seconds => {
  const value = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
};
const Icon = ({ children }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;

// 音量/静音的持久化键。放在本模块是因为它只被播放器控制条读写。
const VOLUME_STORAGE_KEY = 'hongguo:player-volume:v1';

/** 读取上次保存的音量；无记录或数据不可用时返回 null（表示沿用浏览器默认）。 */
const readStoredVolume = () => {
  try {
    const value = JSON.parse(window.localStorage.getItem(VOLUME_STORAGE_KEY));
    if (!value || typeof value !== 'object') return null;
    const v = Number(value.v);
    if (!Number.isFinite(v) || v < 0 || v > 1) return null;
    return { v, muted: value.muted === true };
  } catch { return null; }
};

export default function PlayerControls({ danmaku, danmakuSource = 'comments', onDanmakuSourceChange, enhancement, shortcuts = DEFAULT_SHORTCUTS, onToggleFullscreen, videoRef, stageRef, source, available, continuing = false, autoContinue = false, rate, onRateChange, onError, pictureMode = 'fit', onPictureModeChange, portrait = false, windowFill = false, onWindowFill }) {
  const [media, setMedia] = useState({ paused: true, ended: false, time: 0, duration: 0, muted: false, volume: 1 });
  const [fullscreen, setFullscreen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [danmakuOpen, setDanmakuOpen] = useState(false);
  const danmakuPanelRef = useRef(null);
  const danmakuButtonRef = useRef(null);
  const [danmakuHeight, setDanmakuHeight] = useState(300);
  const [menuHeight, setMenuHeight] = useState(240);
  const [controlsHidden, setControlsHidden] = useState(false);
  const controlsRef = useRef(null);
  const menuRef = useRef(null);
  const menuButtonRef = useRef(null);
  const speedRef = useRef(null);
  const episodeKeysRef = useRef(new Set());
  const pointerRef = useRef(null);
  const expanded = fullscreen || windowFill;

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
  }, [menuOpen, fullscreen, windowFill, stageRef]);

  useEffect(() => {
    if (!windowFill) return;
    const escape = event => { if (event.key === 'Escape' && !event.defaultPrevented && !event.target.closest?.('.danmaku-settings')) onWindowFill(false); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [windowFill, onWindowFill]);

  useEffect(() => {
    const stage = stageRef.current;
    let timer;
    let pauseTimer;
    let dragging = false;
    const scheduleHide = () => {
      clearTimeout(timer);
      if (available && !media.paused && !menuOpen && !danmakuOpen && !dragging) {
        timer = setTimeout(() => {
          if (!controlsRef.current?.querySelector(':focus-visible')) setControlsHidden(true);
        }, 2000);
      }
    };
    const reveal = () => { clearTimeout(pauseTimer); setControlsHidden(false); scheduleHide(); };
    const onKey = event => {
      const physicalKey = event.code || event.key;
      // Keep the release paired across source/effect changes, even if Shift is released first.
      if (event.type === 'keyup' && episodeKeysRef.current.delete(physicalKey)) return;
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
      const key = shortcutKey(event);
      if (!menuOpen && !ignoresPlaybackShortcut(event.target) && key && [shortcuts.previous, shortcuts.next].includes(key)) {
        if (event.type === 'keydown') episodeKeysRef.current.add(physicalKey);
        return;
      }
      reveal();
    };
    const onPointerMove = event => {
      const previous = pointerRef.current;
      pointerRef.current = { x: event.screenX, y: event.screenY };
      // Native fullscreen/source changes can dispatch a move without moving the pointer.
      if (previous ? previous.x === event.screenX && previous.y === event.screenY : !event.movementX && !event.movementY) return;
      reveal();
    };
    const startDrag = event => { dragging = !!event.target.closest?.('input[type="range"]'); reveal(); };
    // 明确的用户操作（点击/滚轮）：直接唤出，不经屏幕坐标去重。
    const onActivity = () => reveal();
    const stopDrag = () => { if (dragging) { dragging = false; reveal(); } };
    const onFocus = event => {
      // Tab and pointerdown reveal immediately; media focus churn is not user activity.
      if (controlsRef.current?.contains(event.target)) reveal();
      else scheduleHide();
    };
    // 全屏时的指针移动来自主进程轮询，而不是 DOM 的 pointermove。
    //
    // 为什么必须有这一条：页面不是 active（窗口失焦）时，Blink 会抑制 hover/指针语义，
    // 渲染层收不到 pointermove —— 即使鼠标确实在本窗口上、WM_MOUSEMOVE 也确实送达了
    // （微软文档：消息发给光标下的窗口，不需要窗口是前台）。实测用户场景正是如此：
    // 副屏全屏 → 控制条隐藏 → 去别的屏点别的程序 → 回来只移动鼠标（不点击，窗口因此
    // 不会重新获得焦点）→ 控制条再也唤不出，只能按 Esc。
    // 轮询不读 DOM、不依赖焦点，所以这个场景能兜住。
    const offFullscreenPointer = window.electronAPI?.onFullscreenPointerMove?.(() => reveal());
    stage?.addEventListener('pointermove', onPointerMove);
    stage?.addEventListener('pointerdown', startDrag);
    stage?.addEventListener('focusin', onFocus);
    stage?.addEventListener('focusout', scheduleHide);
    // 与用户自己维护的项目（hongguo-monorepo/pc 的 attachAutoHideCtrls）对齐：
    // 指针活动除了绑在播放器元素上，也绑到 document，并且同时听 mousemove —— 不只
    // Pointer Events 的 pointermove。那边的实现（document + mousemove + wheel + mousedown）
    // 在同一台机器的双屏环境下能正常唤出控制条。
    //
    // 为什么值得多挂这几条：Blink 在页面非 active 时对 hover/指针语义有额外的 active 门禁
    // （mouse_event_manager.cc 要求 GetFocusController().IsActive()），而 mousemove 与
    // pointermove 的分发路径并不完全相同；多一条来源就多一分"鼠标移回来即出现"的把握。
    // mousemove 共用 onPointerMove（靠 screenX/screenY 去重）；点击与滚轮属于明确的用户
    // 操作，直接 reveal —— 它们不经过去重，否则"原地点击不动鼠标"会被误判为无活动。
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('wheel', onActivity, { passive: true });
    document.addEventListener('mousedown', onActivity);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    // 失焦：清掉按键状态、结束拖动（控制条仍按既有规则自动隐藏，不做特例）。
    const onBlur = () => { episodeKeysRef.current.clear(); stopDrag(); };
    window.addEventListener('blur', onBlur);
    // 重新获得焦点：把控制条显出来（用户切回来即可见，随后按闲置规则自动隐藏）。
    const onWindowFocus = () => reveal();
    window.addEventListener('focus', onWindowFocus);
    // Source changes and automatic handoffs are not user activity.
    if (menuOpen || danmakuOpen || (!continuing && !available)) reveal();
    else if (!continuing && media.paused && !(media.ended && autoContinue)) {
      // A native pause can precede ended; explicit key/click pauses already reveal immediately.
      if (autoContinue && controlsHidden) pauseTimer = setTimeout(() => {
        if (videoRef.current?.paused && !videoRef.current.ended) reveal();
      }, 120);
      else reveal();
    } else scheduleHide();
    return () => {
      clearTimeout(timer);
      clearTimeout(pauseTimer);
      stage?.removeEventListener('pointermove', onPointerMove);
      stage?.removeEventListener('pointerdown', startDrag);
      stage?.removeEventListener('focusin', onFocus);
      stage?.removeEventListener('focusout', scheduleHide);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onWindowFocus);
      document.removeEventListener('mousemove', onPointerMove);
      document.removeEventListener('wheel', onActivity);
      document.removeEventListener('mousedown', onActivity);
      offFullscreenPointer?.();
    };
  }, [portrait, expanded, available, media.paused, media.ended, continuing, autoContinue, menuOpen, danmakuOpen, source, stageRef, shortcuts]);

  useEffect(() => {
    setMenuOpen(false);
    setDanmakuOpen(false);
    const video = videoRef.current;
    if (!video) return;
    // 音量/静音持久化（用户反馈"重进立马最大声音"）。
    // 上游从未保存过音量，切换剧集或重开播放器都会回到默认的 1.0，听感上很突兀。
    // 做法与用户自己的项目一致（localStorage 存 { v, muted }）。
    //
    // 恢复放在 sync 内的持久化**之前**，而不是另注册一个 loadedmetadata 监听器：
    // 一是避免"先写默认值再读"的顺序陷阱（那会把用户偏好冲成 1.0）；二是测试夹具用 Map
    // 存监听器（同名只保留最后一个），两个监听器会互相挤掉，顺序不可控。
    // 顺带一句：必须在调整 volume 之前判定"这是不是一次新的加载"，否则每次 sync
    // 都会把正在播放时的音量改动覆盖回去。
    let appliedKey = null;
    const persistVolume = videoElement => {
      try { window.localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ v: videoElement.volume, muted: videoElement.muted })); } catch { /* 存储不可用时忽略 */ }
    };
    const applyStoredVolume = () => {
      // 每次新的媒体加载（currentSrc 变化）套用一次已保存音量；同一媒体内不再干预，
      // 否则用户拖动音量条后会被下一次 sync 复原。
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
    return () => {
      events.forEach(name => video.removeEventListener(name, sync));
    };
  }, [videoRef, source, available]);

  // 全屏状态来自主进程的原生窗口全屏，不再是 document.fullscreenElement。
  // 改用原生全屏的原因见 main.js 的 set-window-fullscreen 注释（多显示器下 DOM 全屏
  // 不参与焦点管理，鼠标事件会被别的窗口截走）。这里同时保留 DOM 全屏的监听：
  // 隐藏小窗等路径仍可能使用它，两处都同步才不会出现图标与实际不符。
  useEffect(() => {
    let cancelled = false;
    const syncDom = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener('fullscreenchange', syncDom);
    window.electronAPI?.getWindowFullscreen?.().then((value) => { if (!cancelled) setFullscreen(value === true); });
    const off = window.electronAPI?.onWindowFullscreenChanged?.((value) => setFullscreen(value === true));
    return () => {
      cancelled = true;
      document.removeEventListener('fullscreenchange', syncDom);
      off?.();
    };
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
  const seek = event => {
    const video = videoRef.current;
    if (!available || !video || !media.duration) return;
    try { video.currentTime = Math.max(0, Math.min(media.duration, Number(event.target.value))); }
    catch { onError?.('暂时无法跳转，请稍后重试'); }
  };
  const changeVolume = event => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Number(event.target.value);
    video.muted = video.volume === 0;
    // volumechange 会触发下面的持久化订阅，这里不必再写一次
  };

  return (
    <div ref={controlsRef} className={`player-controls ${controlsHidden ? 'controls-hidden' : ''}`} role="group" aria-label="视频播放控制">
      <input className="player-controls-seek" type="range" aria-label="播放进度" aria-valuetext={`${formatTime(media.time)} / ${formatTime(media.duration)}`} min="0" max={media.duration || 0} step="0.1" value={Math.min(media.time, media.duration)} disabled={!available || !media.duration} onChange={seek} />
      <div className="player-controls-row">
        <button type="button" data-player-control aria-label={media.paused ? '播放' : '暂停'} title={`播放/暂停（${formatShortcut(shortcuts.play)}）`} disabled={!available} onClick={togglePlay}>{media.paused ? <Play size={18} /> : <Pause size={18} />}</button>
        <span className="player-controls-time">{formatTime(media.time)} / {formatTime(media.duration)}</span>
        {danmaku && <div className="player-controls-danmaku">
          {/* 文案跟着当前弹幕源走：官方弹幕是按播放进度投放的，本集评论不是。
              把两者说成同一件事会误导用户。 */}
          <button type="button" data-player-menu className={`danmaku-icon-button ${danmaku.enabled ? 'danmaku-enabled' : ''}`} aria-label={danmaku.enabled ? `${danmakuSource === 'official' ? '关闭弹幕' : '关闭评论弹幕'}` : `${danmakuSource === 'official' ? '开启弹幕' : '开启评论弹幕'}`} aria-pressed={danmaku.enabled}
            title={danmaku.supported
              ? (danmakuSource === 'official' ? '将本集弹幕按播放进度显示在画面上' : '将当前集公开评论显示在画面上')
              : (danmakuSource === 'official' ? '仅红果来源的剧集支持弹幕' : '仅红果来源的当前集支持评论弹幕')} disabled={!danmaku.supported} onClick={danmaku.toggle}><span className="danmaku-symbol" aria-hidden="true">弹<span className="danmaku-state-mark" /></span></button>
          <button type="button" data-player-menu className="danmaku-icon-button" ref={danmakuButtonRef} aria-label="弹幕设置" title="弹幕设置" aria-haspopup="dialog" aria-expanded={danmakuOpen}
            onClick={() => { setMenuOpen(false); setDanmakuOpen(open => !open); }}>
            <span className="danmaku-symbol" aria-hidden="true">弹<span className="danmaku-settings-mark"><SettingsIcon size={10} /></span></span>
          </button>
          {danmakuOpen && <DanmakuSettings danmaku={danmaku} source={danmakuSource} onSourceChange={onDanmakuSourceChange} onClose={closeDanmaku} panelRef={danmakuPanelRef} maxHeight={danmakuHeight} />}
        </div>}
        <div className="player-controls-volume">
          <button type="button" data-player-control aria-label={media.muted ? '取消静音' : '静音'} onClick={() => { const video = videoRef.current; if (video) video.muted = !video.muted; }}>
            <Icon><path d="M11 5 6 9H3v6h3l5 4Z" />{media.muted ? <path d="m16 9 5 6m0-6-5 6" /> : <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />}</Icon>
          </button>
          <input type="range" aria-label="音量" aria-valuetext={`${Math.round((media.muted ? 0 : media.volume) * 100)}%`} min="0" max="1" step="0.05" value={media.muted ? 0 : media.volume} onChange={changeVolume} />
        </div>
        <button type="button" data-player-control aria-label={expanded ? '退出全屏' : '全屏'} title={`${expanded ? '退出全屏' : portrait ? '填满当前窗口' : '全屏'}（${formatShortcut(shortcuts.fullscreen)}）`} onClick={onToggleFullscreen}>
          <Icon><path d={expanded ? 'M9 3v6H3m12-6v6h6M9 21v-6H3m12 6v-6h6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m12-6v6h-6'} /></Icon>
        </button>
        <button type="button" data-player-control className="player-controls-rate" aria-label="增加播放速度" title={`播放速度 ${rate}×，点击增加 0.25 倍，4 倍后回到 1 倍`} onClick={() => onRateChange(rate >= 4 ? 1 : Math.min(4, rate + 0.25))}>{rate}×</button>
        <div className="player-controls-options" data-player-menu ref={menuRef}>
          <button type="button" ref={menuButtonRef} aria-label="更多播放选项" title="更多播放选项" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => { setDanmakuOpen(false); setMenuOpen(open => !open); }}>
            <Icon><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></Icon>
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
