import React, { useState, useRef, useEffect } from 'react';
import './HongguoDownload.css';
import { Search, Film, RefreshCw, ExternalLink } from './icons';
import { isSubmitKey } from './episodeRange';
import { readSearchHistory, saveSearchTerm, clearSearchHistory, rememberCatalogTitles, getSearchSuggestions } from '../searchHistory';

import useMediaSources from './useMediaSources';
import { mediaSourceLabel } from './mediaSourcesModel.mjs';

/**
 * SearchPanel —— 按所选来源搜索短剧
 * 拿到 series_id 后交给父组件走既有的「拉全集 + 选集下载」流程。
 */
function SearchPanel({ onSelectSeries, onSwitchToInput, active = true }) {
  const [source, setSource] = useState('all');
  const { sources: mediaSources, revision: sourceRevision, loading: sourcesLoading, error: sourcesError } = useMediaSources();
  const requestVersion = useRef(0);
  const pendingSearch = useRef(null);
  useEffect(() => () => { requestVersion.current++; }, []);
  const [keyword, setKeyword] = useState('');
  const [history, setHistory] = useState(readSearchHistory);
  const [historyError, setHistoryError] = useState('');
  const inputRef = useRef(null);
  const suggestions = getSearchSuggestions(keyword, history);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null); // null=未搜索, []=无结果
  const [error, setError] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [pickingId, setPickingId] = useState('');

  useEffect(() => {
    if (!active) {
      requestVersion.current++;
      pendingSearch.current = null;
      setPickingId('');
      setLoading(false);
    }
  }, [active]);

  useEffect(() => {
    requestVersion.current++; pendingSearch.current = null;
    setLoading(false); setPickingId(''); setResults(null); setError(''); setPageTitle('');
    if (source !== 'all' && !mediaSources.some(item => item.id === source)) setSource('all');
  }, [sourceRevision, mediaSources]);

  const switchSource = (next) => {
    if (next === source) return;
    requestVersion.current++;
    pendingSearch.current = null;
    setSource(next);
    setLoading(false);
    setPickingId('');
    setResults(null);
    setError('');
    setPageTitle('');
  };

  const changeKeyword = (value) => {
    requestVersion.current++;
    pendingSearch.current = null;
    setKeyword(value);
    setLoading(false);
    setPickingId('');
    setResults(null);
    setError('');
  };

  const clearHistory = () => {
    try {
      clearSearchHistory();
      setHistory([]);
      setHistoryError('');
    } catch {
      setHistoryError('搜索历史清除失败，请重试。');
    }
  };

  const doSearch = async () => {
    if (sourcesLoading) return;
    const kw = keyword.trim();
    if (!kw) {
      setError('请输入剧名关键词');
      return;
    }
    const key = JSON.stringify([source, kw]);
    if (pendingSearch.current?.key === key) return;
    const request = ++requestVersion.current;
    pendingSearch.current = { key, request };
    setPickingId('');
    setLoading(true);
    setError('');
    setResults(null);
    setPageTitle('');
    try {
      const sources = source === 'all' ? mediaSources.map(item => item.id) : [source];
      const responses = await Promise.allSettled(sources.map(async (searchSource) => {
        const res = await window.electronAPI.searchSeries(kw, { source: searchSource });
        if (!res?.success) throw new Error(res?.error || '搜索失败，请重试');
        return res;
      }));
      if (request !== requestVersion.current) return;
      const merged = [], failures = [];
      responses.forEach((response, index) => {
        const searchSource = sources[index];
        if (response.status === 'fulfilled') {
          merged.push(...(response.value.results || []).map(item => ({ ...item, source: searchSource })));
          if (sources.length === 1) setPageTitle(response.value.pageTitle || '');
        } else {
          failures.push(`${mediaSourceLabel(searchSource, mediaSources)}：${response.reason?.message || '搜索失败'}`);
        }
      });
      rememberCatalogTitles(merged);
      if (responses.some((response) => response.status === 'fulfilled')) {
        try {
          setHistory(saveSearchTerm(kw));
          setHistoryError('');
        } catch {
          setHistoryError('搜索结果已显示，但本机搜索历史保存失败。');
        }
      }
      setResults(merged);
      if (failures.length) setError(`${failures.join('；')}。${merged.length ? '已显示其他来源的结果。' : ''}请重试或切换来源。`);
    } catch (e) {
      if (request !== requestVersion.current) return;
      setError('搜索异常: ' + e.message);
      setResults([]);
    } finally {
      if (pendingSearch.current?.request === request) pendingSearch.current = null;
      if (request === requestVersion.current) setLoading(false);
    }
  };

  // 选中某部剧 -> 拉取完整分集 -> 交给下载页
  const pick = async (item) => {
    const request = ++requestVersion.current;
    setPickingId(item.series_id);
    setError('');
    try {
      const res = await window.electronAPI.searchResolve(item.series_id);
      if (request !== requestVersion.current) return;
      if (res && res.success && res.data) {
        onSelectSeries(res.data);
      } else {
        setError((res && res.error) || '拉取分集失败');
      }
    } catch (e) {
      if (request === requestVersion.current) setError('拉取分集异常: ' + e.message);
    } finally {
      if (request === requestVersion.current) setPickingId('');
    }
  };

  const showBrowser = async () => {
    try {
      const res = await window.electronAPI.searchWindowShow(true);
      if (res?.success === false) throw new Error(res.error || '来源页面打开失败');
    } catch (e) { setError(e.message || '来源页面打开失败，请重试'); }
  };

  return (
    <div className="hongguo-card">
      <div className="card-header-title">
        <Search size={18} />
        <span>搜索短剧</span>
        <label className="source-control">来源<select className="input-field" aria-label="短剧来源" value={source} onChange={(e) => switchSource(e.target.value)}><option value="all">全部来源</option>{mediaSources.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}</select></label>
      </div>

      {sourcesError && <p className="settings-hint" role="status">来源列表更新失败，暂用上次列表；可在设置重新保存来源后重试。</p>}
      <div className="input-group">
        <input
          type="text"
          className="input-field"
          aria-label="搜索短剧名称"
          aria-describedby="search-suggestions-hint"
          ref={inputRef}
          list="local-search-suggestions"
          autoComplete="off"
          placeholder="输入剧名，例如：一村人养一个神"
          value={keyword}
          onChange={(e) => changeKeyword(e.target.value)}
          onKeyDown={(e) => isSubmitKey(e) && doSearch()}
        />
        <button className="btn btn-primary" onClick={doSearch} disabled={loading || sourcesLoading}>
          {loading ? (
            <>
              <RefreshCw size={16} className="spin" />
              <span>搜索中...</span>
            </>
          ) : (
            <>
              <Search size={16} />
              <span>搜索</span>
            </>
          )}
        </button>
      </div>
      <datalist id="local-search-suggestions">
        {suggestions.map(({ term, source: origin }) => <option key={term} value={term} label={origin} />)}
      </datalist>
      <p className="settings-hint search-suggestions-hint" id="search-suggestions-hint">本机联想：匹配搜索历史和本次浏览过的真实剧名。</p>
      {history.length > 0 && <div className="search-history">
        <div className="search-history-heading"><span>本机搜索历史</span><button type="button" className="btn-chip" onClick={clearHistory}>清除历史</button></div>
        <div className="search-history-terms">{history.map((term) => <button type="button" className="btn-chip" key={term} title={term} onClick={() => { changeKeyword(term); inputRef.current?.focus(); }}>{term}</button>)}</div>
      </div>}
      {historyError && <p className="search-history-error" role="alert">{historyError}</p>}
      <p className="settings-hint" style={{ marginTop: 8 }}>
        {source === 'all' ? '同时搜索所有已启用来源，结果标明来源；选择一部即可查看全部剧集。' : '按剧名查找，选择一部即可查看全部剧集。'}
      </p>

      {results === null && !loading && !error && (
        <div className="search-welcome"><Search size={36} /><h3>好故事，从一个名字开始</h3><p>输入完整剧名或关键词，发现你想看的短剧。</p></div>
      )}
      {error && <div className="alert alert-error" role="alert">{error}</div>}

      {loading && (
        <div className="search-loading">
          <RefreshCw size={18} className="spin" />
          <span>正在寻找相关短剧，首次加载可能需要几秒…</span>
        </div>
      )}

      {results && results.length === 0 && !loading && !error && (
        <div className="search-empty">
          <p>没有找到相关短剧{pageTitle ? `（页面标题：${pageTitle}）` : ''}</p>
          <div className="search-empty-actions">
            {source === 'hongguo' && <button className="btn btn-outline" onClick={showBrowser}>
              <ExternalLink size={15} />
              打开来源页面
            </button>}
            {source === 'hongguo' && onSwitchToInput && (
              <button className="btn btn-outline" onClick={onSwitchToInput}>
                改用链接 / ID 下载
              </button>
            )}
          </div>
        </div>
      )}

      {results && results.length > 0 && (
        <>
          <div className="search-count">找到 {results.length} 部相关短剧</div>
          <div className="search-grid">
            {results.map((item) => (
              <button
                type="button"
                disabled={pickingId !== ''}
                key={`${item.source}:${item.series_id}`}
                className={`search-card ${pickingId === item.series_id ? 'picking' : ''}`}
                onClick={() => pickingId === '' && pick(item)}
                title={`点击查看并下载：${item.series_title}`}
              >
                <div className="search-cover">
                  {item.cover ? (
                    <img src={item.cover} alt={item.series_title} loading="lazy" />
                  ) : (
                    <div className="cover-placeholder">
                      <Film size={22} />
                    </div>
                  )}
                </div>
                <div className="search-card-body">
                  <div className="search-card-title">{item.series_title}</div>
                  <div className="search-card-sub">
                    {pickingId === item.series_id ? (
                      <>
                        <RefreshCw size={13} className="spin" /> 正在拉取分集…
                      </>
                    ) : (
                      <><span className="badge">{mediaSourceLabel(item.source, mediaSources)}</span>查看剧集</>
                    )}
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default SearchPanel;
