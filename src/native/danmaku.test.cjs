'use strict';

/**
 * 官方弹幕抓取层测试。全部离线：传输层是注入的假实现，不打网络。
 *
 * 这里最要紧的一组断言是"失败语义"：源不可用与"本集真的没有弹幕"是两件事，
 * 任何情况下都不能互相冒充 —— 包括缓存命中的路径。
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const danmaku = require('./danmaku.js');

const SERIES = '7503745441910017049';
const VID = '7503780574541122622';

const comment = (overrides = {}) => ({
  comment: {
    common: { group_id: VID, status: '1', content: { text: '好家伙' }, ...(overrides.common || {}) },
    expand: { offset_time: 1200, ...(overrides.expand || {}) },
    ...(overrides.comment || {}),
  },
});

const page = ({ rows = [], extra, info } = {}) => ({
  code: 0,
  data: {
    data_list: rows,
    ...(extra ? { extra } : {}),
    ...(info ? { common_list_info: info } : {}),
  },
});

/** 固定时钟与 nonce，让测试完全确定。 */
const fixedOptions = transport => ({
  transport,
  now: () => 1760000000000,
  random: () => Buffer.from('000102030405060708090a', 'hex'),
});

test.beforeEach(() => {
  danmaku.resetDanmakuCache();
  danmaku.setDeviceIdentity({ deviceId: '1000000000000000001', installId: '1000000000000000002' });
});

test('非红果编号直接拒绝，且不打网络', async () => {
  let calls = 0;
  const result = await danmaku.fetchDanmaku({ seriesId: 'hema:123', vid: '1', ...fixedOptions(async () => { calls++; }) });
  assert.equal(result.success, false);
  assert.equal(calls, 0);
  assert.match(result.error, /仅红果来源/);
});

test('把毫秒偏移换算成秒，并按时间升序返回', async () => {
  const transport = async () => ({
    data: JSON.stringify(page({ rows: [comment({ expand: { offset_time: 3000 } }), comment({ expand: { offset_time: 1000 } }), comment({ expand: { offset_time: 2000 } })] })),
  });
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.equal(result.success, true);
  assert.deepEqual(result.items.map(item => item.time), [1, 2, 3]);
  assert.equal(result.items[0].text, '好家伙');
  assert.equal(result.items[0].mode, 'scroll');
});

test('分页信号之一：extra.next_query_danmaku_list_time 推进游标', async () => {
  const calls = [];
  const transport = async (url, body) => {
    calls.push(JSON.parse(body).business_param.start_offset_time);
    return calls.length === 1
      ? { data: JSON.stringify(page({ rows: [comment({ expand: { offset_time: 1000 } })], extra: { next_query_danmaku_list_time: 5000 } })) }
      : { data: JSON.stringify(page({ rows: [comment({ expand: { offset_time: 6000 }, common: { content: { text: '第二页' } } })] })) };
  };
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.deepEqual(calls, [0, 5000]);
  assert.deepEqual(result.items.map(item => item.text), ['好家伙', '第二页']);
});

test('分页信号之二：common_list_info 的 has_more 与 cursor 同样能推进（extra 为空时唯一来源）', async () => {
  const calls = [];
  const transport = async (url, body) => {
    calls.push(JSON.parse(body).business_param.start_offset_time);
    return calls.length === 1
      ? { data: JSON.stringify(page({ rows: [comment()], info: { has_more: true, cursor: { end_offset_time: 9000 } } })) }
      : { data: JSON.stringify(page({ rows: [comment({ expand: { offset_time: 9000 }, common: { content: { text: '末页' } } })] })) };
  };
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.deepEqual(calls, [0, 9000]);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].text, '末页');
});

test('has_more=false 时即便带 cursor 也必须停止（避免把"没有了"翻成多页空转）', async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    return { data: JSON.stringify(page({ rows: [comment()], info: { has_more: false, cursor: { end_offset_time: 900000 } } })) };
  };
  await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.equal(calls, 1);
});

test('连续空页提前停止，不会把整集翻满', async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    // 一直声称"还有更多"，但一页都不给 —— 参考实现实测遇到过的上游行为
    return { data: JSON.stringify(page({ rows: [], extra: { next_query_danmaku_list_time: calls * 100000 } })) };
  };
  await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.ok(calls <= 4, `连续空页应尽快停止，实际请求 ${calls} 次`);
});

test('丢掉脏数据：非本视频、非正常状态、超长文本', async () => {
  const transport = async () => ({ data: JSON.stringify(page({ rows: [
    comment({ common: { group_id: '999' } }),
    comment({ common: { status: '2' } }),
    comment({ common: { content: { text: 'x'.repeat(300) } } }),
    comment({ common: { content: { text: '这条要留下' } } }),
  ] })) });
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.deepEqual(result.items.map(item => item.text), ['这条要留下']);
});

test('控制字符被清洗，且按（时间, 文本）去重', async () => {
  const transport = async () => ({ data: JSON.stringify(page({ rows: [
    comment({ common: { content: { text: '前\u0000后' } } }),
    comment({ common: { content: { text: '前 后' } } }),
  ] })) });
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].text, '前 后');
});

test('颜色归一：数字、0x 前缀与非法值', () => {
  assert.equal(danmaku.normalizeColor(16711680), '#FF0000');
  assert.equal(danmaku.normalizeColor('0xFF0000'), '#FF0000');
  assert.equal(danmaku.normalizeColor('#00ff00'), '#00FF00');
  assert.equal(danmaku.normalizeColor('乱七八糟'), '#FFFFFF');
  assert.equal(danmaku.normalizeColor(-1), '#FFFFFF');
  assert.equal(danmaku.normalizeColor(undefined), '#FFFFFF');
});

test('越界时间被丢弃（负数或超过 7 天）', () => {
  assert.equal(danmaku.toSeconds(-1), null);
  assert.equal(danmaku.toSeconds(999999999999), null);
  assert.equal(danmaku.toSeconds(1500), 1.5);
  assert.equal(danmaku.toSeconds(true), null);
});

test('成功结果进缓存：第二次调用不打网络', async () => {
  let calls = 0;
  const transport = async () => { calls++; return { data: JSON.stringify(page({ rows: [comment()] })) }; };
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions(transport) };
  await danmaku.fetchDanmaku(options);
  await danmaku.fetchDanmaku(options);
  assert.equal(calls, 1);
});

test('并发调用合并在途请求（只打一次上游）', async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 20));
    return { data: JSON.stringify(page({ rows: [comment()] })) };
  };
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions(transport) };
  const [first, second] = await Promise.all([danmaku.fetchDanmaku(options), danmaku.fetchDanmaku(options)]);
  assert.equal(calls, 1);
  assert.equal(first.items.length, 1);
  assert.deepEqual(second.items, first.items);
});

test('源不可用时给出人话说明，绝不改口成"本集暂无弹幕"', async () => {
  const transport = async () => { const error = new Error('boom'); error.response = { status: 502 }; throw error; };
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.equal(result.success, false);
  assert.equal(result.items.length, 0);
  assert.match(result.notice, /HTTP 502/);
  assert.match(result.notice, /已尝试官方签名请求/);
  assert.doesNotMatch(result.notice, /暂无弹幕/);
});

test('失败结果命中缓存时，仍然如实报告失败（回归：曾被洗成"本集暂无弹幕"）', async () => {
  let calls = 0;
  const transport = async () => { calls++; const error = new Error('boom'); error.response = { status: 502 }; throw error; };
  const options = { seriesId: SERIES, vid: VID, ...fixedOptions(transport) };
  const first = await danmaku.fetchDanmaku(options);
  const second = await danmaku.fetchDanmaku(options);
  assert.equal(calls, 1, '失败结果应命中短 TTL 缓存');
  assert.equal(second.success, false);
  assert.equal(second.notice, first.notice);
  assert.doesNotMatch(second.notice, /暂无弹幕/);
});

test('部分成功后中断：保留已获取的弹幕，并注明中断', async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    if (calls === 1) return { data: JSON.stringify(page({ rows: [comment()], extra: { next_query_danmaku_list_time: 5000 } })) };
    const error = new Error('net');
    throw error;
  };
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.equal(result.items.length, 1);
  assert.equal(result.partial, true);
  assert.match(result.notice, /后续弹幕加载中断/);
});

test('limit 只裁剪条数，不改变失败说明', async () => {
  let calls = 0;
  const transport = async () => {
    calls++;
    if (calls === 1) {
      return { data: JSON.stringify(page({ rows: [1, 2, 3].map(index => comment({ expand: { offset_time: index * 1000 }, common: { content: { text: `第${index}条` } } })), extra: { next_query_danmaku_list_time: 9000 } })) };
    }
    throw new Error('net');
  };
  const result = await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, limit: 2, ...fixedOptions(transport) });
  assert.equal(result.items.length, 2);
  assert.equal(result.truncated, true);
  assert.match(result.notice, /后续弹幕加载中断/);
});

test('请求体与签名头符合接口契约', async () => {
  let captured;
  const transport = async (url, body, config) => {
    captured = { url, body: JSON.parse(body), headers: config.headers };
    return { data: JSON.stringify(page({ rows: [] })) };
  };
  await danmaku.fetchDanmaku({ seriesId: SERIES, vid: VID, ...fixedOptions(transport) });
  assert.match(captured.url, /^https:\/\/api5-normal-sinfonlineb\.fqnovel\.com\/novel\/commentapi\/comment\/list\/\d+\/v1\/\?/);
  assert.equal(captured.body.group_id, VID);
  assert.equal(captured.body.business_param.book_id, SERIES);
  assert.equal(captured.body.comment_source, 601);
  assert.equal(captured.body.group_type, 30);
  assert.equal(captured.body.comment_type, 20);
  assert.ok(captured.headers['X-Gorgon'] && captured.headers['X-Argus'] && captured.headers['X-Ladon']);
  assert.equal(captured.headers['X-SS-STUB'], '');
  assert.equal(captured.headers['Comment-Source'], '601');
});
