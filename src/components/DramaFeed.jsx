import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Film, Play, RefreshCw } from './icons';
import RandomDrama, { DramaPoster } from './RandomDrama';
import { playRecommendedDrama, waitForRequest } from './randomDramaModel.mjs';
import './DramaFeed.css';

const RANKINGS = [
  ['hot-drama', '热播总榜'], ['hot-real-drama', '真人短剧'],
  ['hot-comic-drama', '漫剧'], ['hot-ai-drama', 'AI 短剧'],
];

function DramaFeed({ active = true, onNavigate }) {
  const [category, setCategory] = useState('hot-drama');
  const [items, setItems] = useState([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState('');
  const [playError, setPlayError] = useState('');
  const [randomRefresh, setRandomRefresh] = useState(0);
  const listController = useRef(null);
  const playController = useRef(null);
  const selected = items[index];
  const random = category === 'random';

  const loadList = useCallback(async (forceRefresh = false) => {
    listController.current?.abort(); playController.current?.abort();
    const controller = new AbortController();
    listController.current = controller;
    setResolving(false); setPlayError(''); setItems([]); setIndex(0); setError(''); setLoading(true);
    try {
      const result = await waitForRequest(window.electronAPI.browseList({
        source: 'hongguo', category, page: 1, forceRefresh,
      }), { signal: controller.signal, message: '热播榜加载超时，请重试' });
      if (controller.signal.aborted) return;
      if (!result?.success) throw new Error(result?.error || '热播榜暂时不可用');
      const seen = new Set();
      setItems((Array.isArray(result.results) ? result.results : []).filter(item => {
        const id = String(item?.series_id || '');
        if (!/^\d{6,30}$/.test(id) || typeof item.series_title !== 'string' || !item.series_title.trim() || seen.has(id)) return false;
        seen.add(id); return true;
      }));
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause.message || '热播榜加载失败，请重试');
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [category]);

  useEffect(() => {
    if (active && !random) loadList();
    return () => { listController.current?.abort(); playController.current?.abort(); };
  }, [active, random, loadList]);

  const startItem = async () => {
    if (!active || !selected || resolving) return;
    playController.current?.abort();
    const controller = new AbortController();
    playController.current = controller;
    setPlayError(''); setResolving(true);
    try { await playRecommendedDrama(window.electronAPI, selected, { signal: controller.signal }); }
    catch (cause) { if (!controller.signal.aborted) setPlayError(cause.message || '加载失败，请重试本剧'); }
    finally { if (!controller.signal.aborted) setResolving(false); }
  };

  const selectItem = next => {
    if (loading || resolving || next < 0 || next >= items.length) return;
    setPlayError(''); setIndex(next);
  };

  const introduction = selected?.intro || selected?.series_intro;
  const upcoming = items.slice(index + 1, index + 5);
  return <section className="drama-feed" aria-label="热播推荐">
    <header className="drama-feed-header">
      <div><h2>热播推荐</h2><p className="page-description">顺着热播榜，遇见下一部故事。</p></div>
      <button className="btn btn-outline" disabled={!random && loading} onClick={() => random ? setRandomRefresh(value => value + 1) : loadList(true)}><RefreshCw size={15} />刷新片单</button>
    </header>
    <div className="drama-feed-categories" role="group" aria-label="选择推荐方式">
      {RANKINGS.map(([value, label]) => <button key={value} className={`browse-cat ${category === value ? 'active' : ''}`}
        aria-pressed={category === value} onClick={() => setCategory(value)}>{label}</button>)}
      <button className={`browse-cat drama-random-tab ${random ? 'active' : ''}`} aria-pressed={random} onClick={() => setCategory('random')}>摇一摇</button>
    </div>
    {random ? <RandomDrama active={active} refreshKey={randomRefresh} onNavigate={onNavigate} /> : <>
      <div className="drama-feed-list-meta"><p>红果公开热播榜{items.length > 0 ? ` · 本次 ${items.length} 部` : ''}</p><span>按来源榜单顺序</span></div>
      {loading && <div className="drama-feed-state" role="status"><RefreshCw size={24} className="spin" /><p>正在加载真实热播片单…</p>
        <button className="btn btn-outline" onClick={() => { listController.current?.abort(); setLoading(false); setError('已取消加载，可以重试或切换榜单。'); }}>取消加载</button>
      </div>}
      {!loading && (error || !selected) && <div className="drama-feed-state" role={error ? 'alert' : 'status'}>
        <Film size={32} /><h3>{error ? '暂时没能加载热播榜' : '这个榜单暂未返回剧集'}</h3>
        {error && <p>{error}</p>}
        <div className="drama-feed-actions"><button className="btn btn-primary" onClick={() => loadList(true)}>重新加载</button>
          {onNavigate && <button className="btn btn-outline" onClick={() => onNavigate('download')}>按剧名搜索</button>}</div>
      </div>}
      {!loading && selected && <>
        <div className="drama-feed-feature">
          <DramaPoster item={selected} />
          <div className="drama-feed-copy">
            <p className="drama-feed-rank">{selected.rank > 0 ? `榜单第 ${selected.rank} 名` : `本次片单第 ${index + 1} 部`}{selected.heat ? ` · ${selected.heat}` : ''}</p>
            <h3>{selected.series_title}</h3>
            <p className="drama-feed-tags">{[selected.episode_count > 0 && `${selected.episode_count} 集`, ...(selected.tags || [])].filter(Boolean).join(' · ') || '来自红果公开片单'}</p>
            {typeof introduction === 'string' && introduction.trim() && <p className="drama-feed-intro">{introduction}</p>}
            <p className="drama-feed-play-note">在「我的剧库」选集、播放，接着上次继续看。</p>
            <div className="drama-feed-actions"><button className="btn btn-primary" disabled={resolving} onClick={startItem}><Play size={16} />{resolving ? '正在打开剧库…' : '在剧库播放'}</button>
              {resolving && <button className="btn btn-outline" onClick={() => { playController.current?.abort(); setResolving(false); setPlayError('已取消加载，可重试本剧。'); }}>取消加载</button>}</div>
            {playError && <p className="drama-inline-error" role="alert">{playError}</p>}
          </div>
        </div>
        <div className="drama-feed-navigation">
          <span aria-live="polite">第 <strong>{index + 1}</strong> / {items.length} 部</span>
          <div className="drama-feed-actions" role="group" aria-label="切换推荐短剧">
            <button className="btn btn-outline" disabled={index === 0 || resolving} onClick={() => selectItem(index - 1)}>上一部</button>
            <button className="btn btn-outline" disabled={index === items.length - 1 || resolving} onClick={() => selectItem(index + 1)}>下一部</button>
          </div>
        </div>
        {upcoming.length > 0 ? <div className="drama-feed-upcoming"><h4>接下来看看</h4><div className="drama-feed-upcoming-list">
          {upcoming.map((item, offset) => <button key={item.series_id} className="drama-feed-next" disabled={resolving} onClick={() => selectItem(index + offset + 1)}>
            <DramaPoster item={item} /><span><strong>{item.series_title}</strong><small>{item.rank > 0 ? `榜单第 ${item.rank} 名` : `片单第 ${index + offset + 2} 部`}</small></span>
          </button>)}
        </div></div> : <p className="drama-feed-hint">已到本次片单末尾，换个榜单，或摇一摇发现新故事。</p>}
        <p className="drama-feed-source">榜单来自红果公开页面，不是账号个性化推荐。</p>
      </>}
    </>}
  </section>;
}

export default DramaFeed;
