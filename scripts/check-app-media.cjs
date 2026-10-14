// Offline app-source regression. No credentials, network beyond a local fixture, or GUI.
//
// ⚠️ 契约变更（随「加密片源边解密边播」改造，2026-10）：
//   加密 App 片源不再"整集下载到临时文件 → 整集解密 remux(+faststart) → 整个读进内存"，而是
//   ffmpeg 直接读远端地址、边解密边写**分片 MP4**，够播的一小段落盘后立即把地址交给播放器；
//   写完后终态化成普通 MP4（可拖动/可缓存）。因此本文件里三条**实现细节**断言按新契约改写：
//     · `streaming`：false → true（它现在是可边下边播的流式源）
//     · 一次播放会看到两次 ffmpeg（带密钥的解密一次、写完后的终态化一次，后者不带密钥）
//     · 播放结束前临时目录里会有分片文件与终态文件（不再是"内存里，磁盘全空"）
//   **安全断言一条都没放宽**：密钥不得进日志/进错误信息、非法密钥不得启动原生进程、
//   取消要杀掉原生进程且不留残留文件；并补上"不得留孤儿进程""半成品不得被当成完整产物"。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const source = path.resolve(__dirname, '../main.js'), req = createRequire(source);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-app-media-'));
const contentKey = '01'.repeat(16); // Synthetic test key, never a captured credential.
const clearBytes = Buffer.from('decrypted-mp4-fixture');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (condition, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (condition()) return true; await sleep(10); }
  return false;
};
/** 一个 box：4 字节长度 + 4 字节类型（够用来表达"init segment 在前、分片在后"的形状）。 */
const box = (type, size) => { const b = Buffer.alloc(size); b.writeUInt32BE(size, 0); b.write(type, 4, 'latin1'); return b; };
/** 分片 MP4：empty_moov 把 moov 排在分片之前，因此写到哪就能播到哪。 */
const fragmentedFixture = () => Buffer.concat([
  box('ftyp', 24), box('moov', 512),           // init segment
  box('moof', 256), box('mdat', 300 * 1024),   // 第一批分片（故意超过起播阈值）
]);
const tailFixture = () => Buffer.concat([box('moof', 64), box('mdat', 8 * 1024)]);
function load(url, mode = 'ok', key = contentKey) {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const handlers = {}, protocols = {}, children = [], app = new EventEmitter();
  Object.assign(app, { getVersion: () => 'test', getPath: () => dir, commandLine: { appendSwitch() {} }, requestSingleInstanceLock: () => true, whenReady: () => ({ then() {} }) });
  const electron = { app, ipcMain: { handle: (n, f) => handlers[n] = f }, protocol: { registerSchemesAsPrivileged() {}, handle: (n, f) => protocols[n] = f } };
  const native = { fetchPlayUrlSingle: async () => ({ url, contentKey: key, source: 'app', codec: 'h264' }), UA: 'test', VIDEO_REFERER: 'https://example.com/', deriveKey: () => { throw new Error('contentKey must never go through spade'); } };
  const childProcess = { spawn: (file, args) => {
    assert.equal(file, '/bundled/ffmpeg');
    // 密钥只允许出现在"解密"那一次调用里，且必须是调用方给的那把
    const keyed = args.includes('-decryption_key');
    if (keyed) {
      assert.equal(args[args.indexOf('-decryption_key') + 1], contentKey);
      assert.ok(args.includes('copy'), 'remux without lossy transcode');
    } else {
      assert.ok(args.includes('+faststart'), '终态化：只读本地已解密文件，转成可拖动/可缓存的 MP4');
    }
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.args = args; child.keyed = keyed; child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null, 'SIGTERM')); return true; };
    children.push(child);
    const output = args.at(-1);
    if (mode === 'wait') { fs.writeFileSync(output, 'partial'); return child; }   // 生产者永不结束
    if (mode === 'grow' && /\.part\.mp4$/.test(output)) {
      // 边解密边写的**流式**那一次：先落盘超过起播阈值的分片，随后由测试驱动追加并正常结束。
      // 其余调用（整集解密/终态化 remux）读的都是本地或有限输入，按普通分支立刻写完退出。
      fs.writeFileSync(output, fragmentedFixture());
      child.finish = () => { fs.appendFileSync(output, tailFixture()); child.emit('close', 0); };
      return child;
    }
    setImmediate(() => {
      fs.writeFileSync(output, mode === 'fail' ? 'partial' : (/\.part\.mp4$/.test(output) ? fragmentedFixture() : clearBytes));
      if (mode === 'fail') child.stderr.emit('data', Buffer.from('bad media ' + contentKey));
      child.emit('close', mode === 'fail' ? 1 : 0);
    });
    return child;
  } };
  const context = vm.createContext({ require: n => n === 'electron' ? electron : n === './src/native/hongguo' ? native : n === 'child_process' || n === 'node:child_process' ? childProcess : n === './src/store' ? { saveTasks() {}, getSettings: () => ({ root: dir }) } : req(n), __dirname: path.dirname(source), console: { log() {}, warn() {}, error() {} }, process, Buffer, URL, Response, Request, Headers, AbortController, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  // These transport/decryption fixtures are synthetic; real media validity is checked separately.
  context.probeVideoInfo = async () => ({ w: 1080, h: 1920, duration: 12, codec: 'h264' });
  context.probeDuration = async () => 12;
  context.pickH264Encoder = async () => 'libx264';
  context.resolveFfmpeg = () => '/bundled/ffmpeg'; context.registerStreamProtocol();
  context.registerLocalProtocol();
  return { dir, handlers, protocols, children, context, run: s => vm.runInContext(s, context) };
}
(async () => {
  const server = http.createServer((r, s) => s.end('encrypted-fixture'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/media`;
  let failures = 0;
  async function check(name, fn) { try { await fn(); console.log('PASS ' + name); } catch (e) { failures++; console.error('FAIL ' + name + ': ' + e.message.replaceAll(contentKey, '[test-key]')); } }

  await check('app prepare 边解密边播：不等整集，写到哪送到哪', async () => {
    const h = load(url, 'grow');
    const started = Date.now();
    const p = await h.handlers['prepare-online-play']({}, { vid: 'app', requestId: 'stream' });
    assert.equal(p.success, true, p.error);
    assert.equal(p.streaming, true, 'contentKey 现在是可边下边播的流式源');
    assert.ok(Date.now() - started < 5000, 'prepare 不得等整集写完');
    const decrypt = h.children.filter(c => c.keyed);
    assert.equal(decrypt.length, 1, '应恰好启动一次带密钥的解密 ffmpeg');
    assert.equal(decrypt[0].killed, false, '生产者仍在写，不得提前杀掉');
    // 半成品绝不进在线缓存（否则会被回收逻辑删掉，或被当成完整产物复用）
    assert.equal(h.run('onlineCache.size'), 0, '流式进行中的条目不得进 onlineCache');
    assert.equal(h.run('onlineStreaming.size'), 1, '应登记一份在途流');
    const partPath = h.run(`onlineStreaming.get('app').partPath`);
    assert.ok(fs.existsSync(partPath), '分片文件应写在磁盘临时目录里');
    const response = await h.protocols['hongguo-stream'](new Request(p.url));
    // 流式源的关键：200 + 无 Content-Length / Accept-Ranges（带上就不再是流式源）
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('content-length'), null, '流式源不得带 Content-Length');
    assert.equal(response.headers.get('accept-ranges'), null, '流式源不得带 Accept-Ranges');
    const reader = response.body.getReader();
    const first = await reader.read();
    const head = Buffer.from(first.value);
    assert.ok(head.length >= h.run('PROGRESSIVE_FIRST_BYTES'), '首个响应必须已经带上完整 init segment，播放器不会拿到空流');
    assert.equal(head.subarray(4, 8).toString(), 'ftyp', '分片 MP4 的最前面必须是 init segment');
    assert.ok(head.includes('moov'), 'init segment 必须在最前面（empty_moov），否则又要等整集');
    // 生产者继续写：后续分片必须继续送达，直到生产者结束才收尾
    decrypt[0].finish();
    const rest = [];
    for (;;) { const { value, done } = await reader.read(); if (done) break; if (value) rest.push(Buffer.from(value)); }
    const whole = Buffer.concat([head, ...rest]);
    assert.equal(whole.length, fragmentedFixture().length + tailFixture().length, '增长过程中的全部字节都要送达');
    assert.deepEqual(whole.subarray(-tailFixture().length), tailFixture(), '迟到追加的分片也必须送到');
    h.context.clearOnlineCache();
  });

  await check('app 流式条目终态化：可 Range 拖动、入缓存复用、不留分片与孤儿进程', async () => {
    const h = load(url, 'grow');
    const p = await h.handlers['prepare-online-play']({}, { vid: 'app', requestId: 'finalize' });
    const response = await h.protocols['hongguo-stream'](new Request(p.url));
    const reader = response.body.getReader();
    await reader.read();
    h.children.find(c => c.keyed).finish();                       // 生产者结束 → 终态化
    assert.ok(await until(() => h.run('onlineCache.size') === 1), '写完并入缓存后才能算“已完成”');
    // 本次流式响应还没读完：同一 URL 的新请求必须继续走流式。
    // 分片 MP4 与 faststart 普通 MP4 字节布局不同，读到一半换表示会让解复用器解析错乱。
    const midStream = await h.protocols['hongguo-stream'](new Request(p.url));
    assert.equal(midStream.status, 200);
    assert.equal(midStream.headers.get('accept-ranges'), null, '流式响应未结束时不得切成另一种媒体表示');
    assert.equal((await midStream.arrayBuffer()).byteLength, fragmentedFixture().length + tailFixture().length);
    for (;;) { const { done } = await reader.read(); if (done) break; }
    assert.equal(h.run('onlineCache.get(\'app\').complete'), true);
    assert.equal(h.run(`onlineStreaming.size`), 0, '终态化后不再是在途条目');
    const remux = h.children.filter(c => !c.keyed);
    assert.equal(remux.length, 1, '终态化恰好一次，且不带密钥');
    assert.equal(h.children.filter(c => c.keyed).length, 1, '不得重复起解密进程');
    const partPath = h.run(`onlineCache.get('app').disk.directory`);
    assert.deepEqual(fs.readdirSync(partPath), ['video.mp4'], '分片文件在终态化后应删掉，只留终态文件');
    // 同一 URL 的新请求改走磁盘供给：恢复 Range（时长与拖动）
    const ranged = await h.protocols['hongguo-stream'](new Request(p.url, { headers: { range: 'bytes=0-3' } }));
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('accept-ranges'), 'bytes');
    assert.match(ranged.headers.get('content-range'), /^bytes 0-3\//);
    assert.equal(await ranged.text(), clearBytes.subarray(0, 4).toString());
    // 再次准备同一集：命中终态化后的缓存，不再起新进程
    const again = await h.handlers['prepare-online-play']({}, { vid: 'app', requestId: 'again' });
    assert.equal(again.success, true, again.error); assert.equal(again.cached, true);
    assert.equal(h.children.length, 2, '缓存命中不得再起 ffmpeg');
    h.context.clearOnlineCache();
    assert.equal(await until(() => fs.readdirSync(h.dir).length === 0), true, '释放后不得留下临时目录或文件');
    assert.ok(h.children.every(c => !c.killed || c.keyed), '不得留下孤儿进程');
  });

  await check('同一集在途解密只起一个 ffmpeg，写入进程跟随“最后一个持有者”', async () => {
    const h = load(url, 'grow');
    const first = await h.handlers['prepare-online-play']({}, { vid: 'app', requestId: 'one' });
    const second = await h.handlers['prepare-online-play']({}, { vid: 'app', requestId: 'two' });
    assert.equal(first.success, true, first.error); assert.equal(second.success, true, second.error);
    assert.equal(h.children.filter(c => c.keyed).length, 1, '同一片源不得起第二个解密进程');
    assert.notEqual(first.streamId, second.streamId, '两次准备仍是两个可独立释放的会话');
    await h.handlers['release-online-play']({}, { streamId: first.streamId });
    assert.equal(h.children[0].killed, false, '还有会话在读：释放另一个会话不得杀掉写盘进程');
    assert.equal(h.run('onlineStreaming.size'), 1, '在途流必须留给仍在读的会话');
    await h.handlers['release-online-play']({}, { streamId: second.streamId });
    assert.equal(await until(() => h.children[0].killed), true, '最后一个持有者释放后必须停掉写盘进程');
    assert.equal(h.run('onlineStreaming.size'), 0, '不得留下无人持有的在途流');
    assert.equal(await until(() => fs.readdirSync(h.dir).length === 0), true, '不得留下临时目录或半成品');
  });

  await check('app download publishes decrypted bytes and removes intermediate files', async () => {
    const h = load(url), task = { id: 'download', type: 'hongguo', filename: 'final.mp4', customDir: h.dir, hongguoInfo: { vid: 'app' } };
    await h.context.executeHongguoDownload(task);
    assert.equal(task.status, 'completed'); assert.deepEqual(fs.readFileSync(task.savePath), clearBytes);
    assert.deepEqual(fs.readdirSync(h.dir), ['final.mp4']);
  });

  await check('取消要杀掉原生进程，且不留临时目录', async () => {
    const h = load(url, 'wait'); const pending = h.handlers['prepare-online-play']({}, { vid: 'cancel', requestId: 'cancel' });
    for (let i=0; i<30 && !h.children.length; i++) await sleep(5);
    assert.equal(h.children.length, 1, '加密准备必须启动 ffmpeg');
    await h.handlers['release-online-play']({}, { requestId: 'cancel' });
    assert.equal((await pending).success, false); assert.equal(h.children[0].killed, true);
    assert.equal(await until(() => fs.readdirSync(h.dir).length === 0), true, '取消后不得留下临时目录或半成品');
    assert.equal(h.run('onlineStreaming.size'), 0);
  });

  await check('native failure does not expose keys or retain partial output', async () => {
    const h = load(url, 'fail'); const p = await h.handlers['prepare-online-play']({}, { vid: 'fail' });
    assert.equal(p.success, false); assert.ok(!p.error.includes(contentKey)); assert.deepEqual(fs.readdirSync(h.dir), []);
  });

  await check('invalid content key is rejected before launching native code', async () => {
    const h = load(url, 'ok', 'invalid'); const p = await h.handlers['prepare-online-play']({}, { vid: 'invalid' });
    assert.equal(p.success, false); assert.equal(h.children.length, 0); assert.deepEqual(fs.readdirSync(h.dir), []);
  });

  await check('兼容模式：在途分片不得当转码输入，且终态化后重试可恢复', async () => {
    const h = load(url, 'grow');
    const p = await h.handlers['prepare-online-play']({}, { vid: 'app', requestId: 'compat' });
    assert.equal(p.success, true, p.error);
    const half = path.join(h.dir, 'half-written.mp4');
    fs.writeFileSync(half, 'half');
    // 直接构造"半成品被塞进缓存"的情形：complete 未置位 ⇒ 必须被拒绝
    h.run(`onlineCache.set('app', {filePath: ${JSON.stringify(half)}, size: 4, complete: false, seriesId: 'S', vidIndex: 1, lastUsed: Date.now()})`);
    const denied = await h.handlers['transcode-for-playback']({}, { seriesId: 'S', vidIndex: 1, vid: 'app', requestId: 'c1' });
    assert.ok(!h.children.some(c => (c.args || []).includes(half)), '半成品文件被当成了转码输入');
    assert.equal(denied.success, true, '拒绝之后必须能走既有恢复路径（整集取源并解密），而不是死路一条');
    assert.ok(h.children.filter(c => c.keyed).length >= 1, '恢复路径应重新解密出完整输入');
    h.context.clearOnlineCache();
  });

  server.closeAllConnections(); await new Promise(r => server.close(r));
  assert.equal(failures, 0, `${failures} app-media regressions`);
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => fs.rmSync(root, { recursive: true, force: true }));
