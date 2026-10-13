import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DANMAKU_SOURCE, normalizeDanmakuSource, createOfficialFeed, appendOfficialPage,
  advanceTimedDanmaku, lowerBoundTime, resolveDanmakuStatus,
} from '../danmakuOfficial.mjs';
import { DEFAULT_DANMAKU_SETTINGS } from '../danmakuModel.mjs';

const SERIES = '7503745441910017049';
const VID = '7503780574541122622';

const makeFeed = () => createOfficialFeed(SERIES, VID);
const at = (time, text) => ({ time, text, color: '#FFFFFF', mode: 'scroll' });
const options = (settings = DEFAULT_DANMAKU_SETTINGS, extra = {}) => ({ width: 800, height: 600, settings, reducedMotion: false, ...extra });

/** 按 60fps 推进到指定时间，模拟真实播放。 */
function playTo(state, list, from, to, optionsFor) {
  const step = 1 / 60;
  for (let time = from; time <= to + 1e-9; time += step) {
    advanceTimedDanmaku(state, list, Math.min(time, to), step, optionsFor);
  }
}

test('弹幕源只接受已知取值，其余一律回落官方弹幕', () => {
  assert.equal(normalizeDanmakuSource('comments'), 'comments');
  assert.equal(normalizeDanmakuSource('official'), 'official');
  assert.equal(normalizeDanmakuSource('随便什么'), DEFAULT_DANMAKU_SOURCE);
  assert.equal(normalizeDanmakuSource(undefined), 'official');
  assert.equal(DEFAULT_DANMAKU_SOURCE, 'official');
});

test('lowerBoundTime 定位到第一条不早于给定时间的弹幕', () => {
  const list = [at(1, 'a'), at(3, 'b'), at(3.5, 'c'), at(9, 'd')];
  assert.equal(lowerBoundTime(list, 0), 0);
  assert.equal(lowerBoundTime(list, 3), 1);
  assert.equal(lowerBoundTime(list, 3.2), 2);
  assert.equal(lowerBoundTime(list, 10), 4);
});

test('appendOfficialPage 合并、去重、按时间排序，并保留失败说明', () => {
  const feed = makeFeed();
  appendOfficialPage(feed, {
    success: true, series_id: SERIES, episode_id: VID, truncated: false,
    items: [at(5, '后'), at(1, '前'), at(1, '前')],
  });
  assert.deepEqual(feed.danmaku.map(item => item.text), ['前', '后']);
  assert.equal(feed.loaded, true);
  assert.equal(feed.error, '');

  // 分页结果二次写入不应产生重复
  appendOfficialPage(feed, { success: true, series_id: SERIES, episode_id: VID, items: [at(1, '前'), at(7, '新')] });
  assert.deepEqual(feed.danmaku.map(item => item.text), ['前', '后', '新']);

  const failed = makeFeed();
  appendOfficialPage(failed, { success: false, series_id: SERIES, episode_id: VID, items: [], error: '弹幕接口不可用（HTTP 502）' });
  assert.equal(failed.error, '弹幕接口不可用（HTTP 502）');
});

test('appendOfficialPage 拒绝身份不匹配的响应（防止串集）', () => {
  const feed = makeFeed();
  assert.throws(() => appendOfficialPage(feed, { success: true, series_id: SERIES, episode_id: '999', items: [] }));
  assert.equal(feed.danmaku.length, 0);
});

test('弹幕只在时间到点时投放，不会提前出现', () => {
  const state = makeFeed().animation;
  const list = [at(10, '十秒')];
  playTo(state, list, 0, 5, options());
  assert.equal(state.items.length, 0, '5 秒时不该出现 10 秒的弹幕');
  playTo(state, list, 5, 10.05, options());
  assert.equal(state.items.length, 1);
  assert.equal(state.items[0].text, '十秒');
});

test('倒退跳转：重建光标并清掉属于旧位置的弹幕', () => {
  const state = makeFeed().animation;
  const list = [at(1, 'a'), at(2, 'b'), at(30, 'c')];
  playTo(state, list, 0, 3, options());
  assert.equal(state.items.length, 2);
  const cursorBefore = state.cursor;
  assert.equal(cursorBefore, 2);

  // 跳回 1.5 秒：1.5 秒之后、含 2 秒的弹幕应重新可发
  advanceTimedDanmaku(state, list, 1.5, 0, options());
  assert.equal(state.items.length, 0, '跳转必须清掉旧位置的在屏弹幕');
  assert.equal(state.cursor, 1, '光标应回到 1.5 秒对应的位置');
});

test('快进跳转：不把中间整段弹幕一次性倒到屏幕上', () => {
  const state = makeFeed().animation;
  const list = Array.from({ length: 200 }, (_, index) => at(index + 1, `弹幕${index + 1}`));
  playTo(state, list, 0, 2, options());
  const resumeAt = lowerBoundTime(list, 150);
  advanceTimedDanmaku(state, list, 150, 0.016, options());
  // 单帧最多投放 MAX_EMIT_PER_FRAME 条，绝不能因为快进而把 1~150 秒的弹幕全倒出来
  assert.ok(state.items.length <= 4, `快进后单帧投放应受限，实际 ${state.items.length}`);
  assert.ok(state.cursor >= resumeAt, '光标应至少推进到快进后的位置');
  assert.ok(state.cursor <= resumeAt + 4, '光标不应越过快进位置批量消费');
});

test('严重迟到的弹幕被丢弃，不补发', () => {
  const state = makeFeed().animation;
  const list = [at(0, '早就过去了'), at(20, '正常')];
  advanceTimedDanmaku(state, list, 20, 0.016, options());
  assert.deepEqual(state.items.map(item => item.text), ['正常']);
});

test('屏蔽词命中的弹幕被跳过，且不占用通道', () => {
  const settings = { ...DEFAULT_DANMAKU_SETTINGS, blockedWords: '屏蔽我' };
  const state = makeFeed().animation;
  const list = [at(0, '屏蔽我'), at(0, '正常')];
  advanceTimedDanmaku(state, list, 0, 0.016, options(settings));
  assert.deepEqual(state.items.map(item => item.text), ['正常']);
});

test('同一道内允许续发：前一条走出足够距离后可以再发', () => {
  const settings = { ...DEFAULT_DANMAKU_SETTINGS, density: 'sparse' }; // 只 1 条道
  const state = makeFeed().animation;
  const list = [at(0, '第一条'), at(2, '第二条')];
  advanceTimedDanmaku(state, list, 0, 0.016, options(settings));
  assert.equal(state.items.length, 1);
  // 只推进 0.1 秒：第一条还占着道口，第二条必须等待
  playTo(state, list, 0, 0.1, options(settings));
  assert.equal(state.items.length, 1);
  // 推进到 3.5 秒：第二条已到点、第一条也走远，两条应同时在屏
  playTo(state, list, 0.1, 3.5, options(settings));
  assert.equal(state.items.length, 2);
  assert.deepEqual(state.items.map(item => item.text), ['第一条', '第二条']);
  assert.equal(state.cursor, 2, '两条都应被消费');
});

test('真实密度下不丢弹幕：0.5 条/秒的 100 条应全部投放', () => {
  const state = makeFeed().animation;
  // 时间轴 0~198 秒，每 2 秒一条，接近实测的每集弹幕密度
  const list = Array.from({ length: 100 }, (_, index) => at(index * 2, `弹幕${index}`));
  playTo(state, list, 0, 200, options());
  assert.equal(state.cursor, 100, '全部弹幕都应被消费');
  assert.equal(state.nextId, 100, '不该有弹幕因为迟到而被丢弃');
});

test('突发弹幕不会互相追尾：同道内前后两条始终保持间距', () => {
  const settings = { ...DEFAULT_DANMAKU_SETTINGS, density: 'normal' }; // 3 条道
  const state = makeFeed().animation;
  const list = Array.from({ length: 40 }, (_, index) => at(10, `突发${index}`));
  const step = 1 / 60;
  let peak = 0;
  let checked = 0;
  for (let time = 0; time <= 25; time += step) {
    advanceTimedDanmaku(state, list, time, step, options(settings));
    peak = Math.max(peak, state.items.length);
    // 同道内按 x 降序，新的那条必须整条落在旧的那条右侧留出间距之内
    for (const lane of new Set(state.items.map(item => item.lane))) {
      const inLane = state.items.filter(item => item.lane === lane).sort((a, b) => b.x - a.x);
      for (let i = 1; i < inLane.length; i++) {
        const newer = inLane[i - 1];
        const older = inLane[i];
        assert.ok(newer.x >= older.x + older.width + 24 - 1e-6,
          `同道追尾：${newer.text} 追上 ${older.text}（x=${newer.x.toFixed(1)} vs ${(older.x + older.width).toFixed(1)}）`);
        checked++;
      }
    }
  }
  assert.ok(peak > 3, `通道应被复用，实际峰值只有 ${peak}`);
  assert.ok(peak <= 12, `同屏弹幕不应无限增长，实际峰值 ${peak}`);
  assert.ok(checked > 0, '应至少检查到一对同道弹幕');
});

test('多道模式下同屏弹幕不重叠', () => {
  const settings = { ...DEFAULT_DANMAKU_SETTINGS, density: 'dense', area: 'full' };
  const state = makeFeed().animation;
  const list = Array.from({ length: 60 }, (_, index) => at(index * 0.05, `第${index}条`));
  playTo(state, list, 0, 20, options(settings));
  const items = state.items;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      assert.ok(Math.abs(items[i].y - items[j].y) >= settings.fontSize + 12, '同屏弹幕不得压行');
    }
  }
});

test('减少动态效果时改为静态轮换：只留一条、停在左侧、读完替换', () => {
  const state = makeFeed().animation;
  const list = [at(0, '一'), at(0.1, '二')];
  const runtime = options(DEFAULT_DANMAKU_SETTINGS, { reducedMotion: true });
  advanceTimedDanmaku(state, list, 0, 0.016, runtime);
  assert.equal(state.items.length, 1);
  const firstId = state.items[0].id;
  assert.equal(state.items[0].x, 12);
  playTo(state, list, 0, 8, runtime);
  assert.equal(state.items.length, 1);
  assert.notEqual(state.items[0].id, firstId);
  assert.equal(state.items[0].x, 12);
});

test('暂停时不推进：位置与时间都不变', () => {
  const state = makeFeed().animation;
  const list = [at(0, '停住')];
  advanceTimedDanmaku(state, list, 0, 0.016, options());
  playTo(state, list, 0, 1, options());
  const x = state.items[0].x;
  // elapsed=0 表示这一帧媒体时间没有前进（暂停）
  advanceTimedDanmaku(state, list, 1, 0, options());
  assert.equal(state.items[0].x, x);
});

test('容器过小或列表为空时不抛异常，也不谎报变化', () => {
  const state = makeFeed().animation;
  assert.equal(advanceTimedDanmaku(state, [], 1, 0.016, options()), false);
  assert.equal(advanceTimedDanmaku(state, [at(0, 'x')], 1, 0.016, options(DEFAULT_DANMAKU_SETTINGS, { width: 10, height: 10 })), false);
  assert.equal(advanceTimedDanmaku(state, [at(0, 'x')], 1, 0.016, options(DEFAULT_DANMAKU_SETTINGS, { width: 800, height: 20 })), false);
});

test('长弹幕被截断到 80 字，并保留原文供设置变更时重新计算', () => {
  const state = makeFeed().animation;
  const long = '字'.repeat(120);
  advanceTimedDanmaku(state, [at(0, long)], 0, 0.016, options());
  assert.equal(Array.from(state.items[0].text).length, 80);
  assert.equal(state.items[0].content, long);
});

test('状态出口：失败绝不说成"暂无弹幕"', () => {
  const base = { source: 'official', supported: true, enabled: true, active: true, visible: true, loading: false, notice: '', loaded: true, count: 0 };
  // 有 error 时必须原样透出
  assert.equal(resolveDanmakuStatus({ ...base, error: '弹幕接口不可用（HTTP 502）' }), '弹幕接口不可用（HTTP 502）');
  // 没 error 且没有内容，才是真的没有弹幕
  assert.equal(resolveDanmakuStatus({ ...base, error: '' }), '本集暂无弹幕');
  // 有内容时给出条数，并带上来源限制说明
  assert.match(resolveDanmakuStatus({ ...base, count: 12, notice: '上游仅返回部分结果' }), /已载入 12 条弹幕/);
  assert.match(resolveDanmakuStatus({ ...base, count: 12, notice: '上游仅返回部分结果' }), /上游仅返回部分结果/);
  // 未启用 / 不支持 / 未播放 各有明确说法
  assert.match(resolveDanmakuStatus({ ...base, enabled: false }), /开启后/);
  assert.match(resolveDanmakuStatus({ ...base, supported: false }), /仅红果来源/);
  assert.match(resolveDanmakuStatus({ ...base, active: false }), /播放本集后/);
  assert.equal(resolveDanmakuStatus({ ...base, visible: false }), '');
  assert.match(resolveDanmakuStatus({ ...base, error: '', loaded: false }), /正在加载/);
});
