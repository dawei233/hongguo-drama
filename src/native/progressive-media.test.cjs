'use strict';

/**
 * 边解密边播的两个核心件测试。
 *
 * 背景与设计依据见 src/native/progressive-media.js 的模块注释。
 * 这里只测**能在本地确定性验证**的部分：
 *   · ffmpeg 参数是否正确（分片 MP4 的 movflags 是"能边写边播"的关键，错了就退化成旧行为）
 *   · "增长中的文件"能否被正确供给：读到 EOF 时生产者还在写 → 等待；生产者结束 → 收尾
 * 真实解码/播放行为需要真机与真片源，不在本测试范围。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createDecryptStream, createGrowingFileStream, FRAGMENTED_MOVFLAGS } = require('./progressive-media.js');

const tmpDir = () => fsp.mkdtemp(path.join(os.tmpdir(), 'hg-prog-'));

/** 造一个假的 ffmpeg 子进程：可手动触发 close/error。 */
function fakeChild() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

function spawnRecorder() {
  const calls = [];
  const child = fakeChild();
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return child; };
  return { calls, child, spawn };
}

/** 按顺序收集流里的字节。 */
async function collect(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

test('ffmpeg 参数：必须用分片 MP4 的 movflags，否则退化成"写完才能播"', { timeout: 10000 }, async () => {
  const { calls, child, spawn } = spawnRecorder();
  const stream = createDecryptStream({
    ffmpegPath: 'ffmpeg.exe', inputUrl: 'https://cdn.example/video.mp4',
    contentKey: 'a'.repeat(32), outputPath: 'C:/tmp/out.part.mp4', spawn,
  });
  const args = calls[0].args;
  assert.ok(args.includes('-movflags'), '必须显式指定 movflags');
  assert.equal(args[args.indexOf('-movflags') + 1], FRAGMENTED_MOVFLAGS);
  assert.ok(FRAGMENTED_MOVFLAGS.includes('empty_moov'), 'empty_moov 是"moov 前置、可边写边播"的关键');
  assert.ok(FRAGMENTED_MOVFLAGS.includes('frag_keyframe'), 'frag_keyframe 才能分片追加');
  assert.deepEqual(args.slice(args.indexOf('-decryption_key'), args.indexOf('-decryption_key') + 2), ['-decryption_key', 'a'.repeat(32)]);
  assert.ok(args.includes('-c') && args[args.indexOf('-c') + 1] === 'copy', '应直接 copy，不做重编码');
  assert.equal(args[args.length - 1], 'C:/tmp/out.part.mp4', '输出路径必须是最后一个参数');
  assert.ok(!args.includes('+faststart'), '带上 +faststart 就回到"必须整集写完"的旧行为');

  child.emit('close', 0);
  await stream.done;
});

test('解密流：非零退出码要如实报错，并保留 exited 状态供调用方判断', { timeout: 10000 }, async () => {
  const { child, spawn } = spawnRecorder();
  const stream = createDecryptStream({ ffmpegPath: 'ffmpeg', inputUrl: 'u', contentKey: 'b'.repeat(32), outputPath: 'o', spawn });
  assert.equal(stream.running, true);
  child.emit('close', 1);
  await assert.rejects(() => stream.done, /媒体解密失败/);
  assert.equal(stream.running, false, '结束后 running 应为 false（供给端据此判断是否继续等待）');
});

test('解密流：密钥格式非法要提前拒绝，不启动进程', { timeout: 10000 }, async () => {
  const { calls, spawn } = spawnRecorder();
  assert.throws(() => createDecryptStream({ ffmpegPath: 'ffmpeg', inputUrl: 'u', contentKey: 'not-a-key', outputPath: 'o', spawn }), /密钥格式无效/);
  assert.equal(calls.length, 0, '参数校验失败不应启动子进程');
});

test('解密流：abort 会结束进程，且 done 以"已取消"拒绝', { timeout: 10000 }, async () => {
  const { child, spawn } = spawnRecorder();
  const controller = new AbortController();
  const stream = createDecryptStream({ ffmpegPath: 'ffmpeg', inputUrl: 'u', contentKey: 'c'.repeat(32), outputPath: 'o', spawn, signal: controller.signal });
  controller.abort();
  assert.equal(child.killed, true, 'abort 应终止 ffmpeg');
  child.emit('close', null);
  await assert.rejects(() => stream.done, /已取消/);
});

test('供给端：先给出已有字节，随后追加的字节也要继续送达', { timeout: 10000 }, async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'a.part.mp4');
  await fsp.writeFile(file, 'AAAA');
  let running = true;
  const stream = createGrowingFileStream({ filePath: file, isRunning: () => running, pollMs: 5 });
  const collected = collect(stream);

  // 生产者继续追加，模拟 ffmpeg 边解密边写
  await new Promise(r => setTimeout(r, 30));
  await fsp.appendFile(file, 'BBBB');
  await new Promise(r => setTimeout(r, 30));
  await fsp.appendFile(file, 'CCCC');
  await new Promise(r => setTimeout(r, 30));
  running = false;   // 生产者结束

  const bytes = await collected;
  assert.equal(bytes.toString(), 'AAAABBBBCCCC', '增长过程中的全部字节都必须被送达');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('供给端：生产者结束即收尾（EOF 必须发出，否则连接不关、浏览器一直等）', { timeout: 10000 }, async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'b.part.mp4');
  await fsp.writeFile(file, 'done');
  const stream = createGrowingFileStream({ filePath: file, isRunning: () => false, pollMs: 5 });
  const bytes = await collect(stream);
  assert.equal(bytes.toString(), 'done');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('供给端：文件尚未创建时不能报错，要等生产者写出来', { timeout: 10000 }, async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'late.part.mp4');   // 故意先不创建：ffmpeg 启动有延迟
  let running = true;
  const stream = createGrowingFileStream({ filePath: file, isRunning: () => running, pollMs: 5 });
  const collected = collect(stream);
  await new Promise(r => setTimeout(r, 30));
  await fsp.writeFile(file, 'late-bytes');
  await new Promise(r => setTimeout(r, 30));
  running = false;
  const bytes = await collected;
  assert.equal(bytes.toString(), 'late-bytes', '应等到文件出现后把内容送出，而不是立刻失败');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('供给端：取消后停止读取并关闭文件句柄', { timeout: 10000 }, async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'c.part.mp4');
  await fsp.writeFile(file, 'x'.repeat(1024));
  const stream = createGrowingFileStream({ filePath: file, isRunning: () => true, pollMs: 5, readSize: 16 });
  const reader = stream.getReader();
  const first = await reader.read();
  assert.ok(first.value?.length > 0, '应先读到已有内容');
  await reader.cancel();
  // 取消后不应再读到内容
  const after = await reader.read();
  assert.equal(after.done, true);
  await fsp.rm(dir, { recursive: true, force: true });
});

// ===== 回归：旧实现的死锁（必须"失败"，绝不能"挂住"）=====
// 旧实现在"读到 EOF 但生产者仍在写"这条路径上 `await wait(pollMs); return;`（不入队）。
// 消费者此时正阻塞在 read() 上，不会产生新的读取请求 → ReadableStream 再也不会回调 pull
// → 流既不结束也不给数据，测试挂住、CI 卡死。这里用看门狗把"挂住"变成"失败"，
// 并断言迟到追加的字节确实被送达：旧实现必然失败，新实现必然通过。
test('回归：EOF 处等待生产者时必须继续送出迟到字节（不得死锁）', { timeout: 10000 }, async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'walk.part.mp4');
  await fsp.writeFile(file, 'AAAA');
  let running = true;
  const stream = createGrowingFileStream({ filePath: file, isRunning: () => running, pollMs: 20 });
  const reader = stream.getReader();
  const first = await reader.read();
  assert.equal(Buffer.from(first.value).toString(), 'AAAA', '应先送出已有字节');
  const stalled = reader.read();       // 这次读到 EOF → pull 必须在同一个调用里等生产者
  const watchdog = new Promise(resolve => setTimeout(() => resolve('watchdog'), 3000));
  await new Promise(r => setTimeout(r, 60));   // 确保 pull 已经进到等待里
  await fsp.appendFile(file, 'BBBB');          // 迟到的追加
  const result = await Promise.race([stalled, watchdog]);
  assert.notEqual(result, 'watchdog',
    '疑似 pull 在等待后未继续入队导致死锁：迟到字节永远送不出（旧实现即如此）');
  assert.equal(Buffer.from(result.value).toString(), 'BBBB', '等待期间追加的字节必须被送达');
  running = false;
  const tail = await reader.read();
  assert.equal(tail.done, true, '生产者结束后必须发出 EOF');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('供给端：唯一收尾出口 onClose 读到 EOF 时恰好调用一次', { timeout: 10000 }, async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'd.part.mp4');
  await fsp.writeFile(file, 'xy');
  let closes = 0;
  const stream = createGrowingFileStream({ filePath: file, isRunning: () => false, pollMs: 5, onClose: () => { closes++; } });
  const bytes = await collect(stream);
  assert.equal(bytes.toString(), 'xy');
  assert.equal(closes, 1, '读到 EOF 收尾时必须恰好调用一次 onClose');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('供给端：取消要唤醒正在等待的 pull，并走同一个收尾出口', { timeout: 10000 }, async () => {
  const dir = await tmpDir();
  const file = path.join(dir, 'e.part.mp4');
  await fsp.writeFile(file, 'x');      // 已到 EOF，生产者仍在写 → pull 进入等待
  let closes = 0;
  const stream = createGrowingFileStream({ filePath: file, isRunning: () => true, pollMs: 5000, onClose: () => { closes++; } });
  const reader = stream.getReader();
  await reader.read();
  const pending = reader.read();
  await new Promise(r => setTimeout(r, 30));   // 让 pull 真的进到等待里
  const started = Date.now();
  await reader.cancel();                       // pollMs=5000：必须被唤醒，不能等满一个轮询周期
  assert.ok(Date.now() - started < 1000, '取消必须唤醒等待中的 pull');
  await pending.catch(() => {});
  assert.equal(closes, 1, '取消也必须走同一个收尾出口');
  await fsp.rm(dir, { recursive: true, force: true });
});
