import { useEffect, useRef, useState } from 'react';

export default function useStealthWindow() {
  const [stealthMode, setStealthMode] = useState(false);
  const [stealthError, setStealthError] = useState('');
  const resume = useRef(null);
  const concealed = useRef(false);
  const busy = useRef(false);
  const toggleStealth = async enabled => {
    if (busy.current) return;
    busy.current = true;
    setStealthError('');
    try {
      // 进小窗前必须退出全屏：DOM 全屏与原生窗口全屏都要处理，否则窗口会卡在全屏形态
      // （主进程也会拒绝在全屏时开启小窗，这里先退可避免用户看到一个失败提示）。
      if (enabled && document.fullscreenElement) await document.exitFullscreen();
      if (enabled && await window.electronAPI?.getWindowFullscreen?.()) await window.electronAPI.setWindowFullscreen(false);
      const result = await window.electronAPI.setStealthMode(enabled);
      if (!result?.success) throw new Error(result?.error || '小窗切换失败，请重试');
    } catch (error) { setStealthError(error.message); }
    finally { busy.current = false; }
  };
  useEffect(() => window.electronAPI.onStealthState(state => {
    setStealthMode(state.enabled);
    concealed.current = state.concealed;
    const video = document.querySelector('main[data-page="player"] video');
    if (state.concealed) {
      resume.current = video && !video.paused && !video.ended ? { video, source: video.currentSrc } : null;
      video?.pause();
    } else {
      const saved = resume.current;
      resume.current = null;
      if (saved && saved.video === video && saved.source === video.currentSrc && video.isConnected) {
        video.play().catch(() => setStealthError('已恢复窗口，请点击播放继续'));
      }
    }
  }), []);
  useEffect(() => {
    const guardPlayback = event => {
      const video = event.target;
      if (!concealed.current || !video.matches?.('main[data-page="player"] video')) return;
      resume.current = { video, source: video.currentSrc };
      video.pause();
    };
    document.addEventListener('play', guardPlayback, true);
    return () => document.removeEventListener('play', guardPlayback, true);
  }, []);
  useEffect(() => {
    if (!stealthMode) return;
    const escape = event => {
      if (event.key !== 'Escape') return;
      event.preventDefault(); event.stopImmediatePropagation();
      void toggleStealth(false);
    };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [stealthMode]);
  return { stealthMode, toggleStealth, stealthError };
}
