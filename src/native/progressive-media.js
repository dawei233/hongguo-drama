'use strict';

/**
 * 加密片源的「边解密边播」支持。
 *
 * ## 为什么需要
 *
 * 改之前，加密的 App 片源要跑**三遍整集数据**才可能播放：
 *   1. 整集下载到临时文件（`encrypted.mp4`）
 *   2. ffmpeg 整集解密并 remux（`-movflags +faststart`，必须写完整个文件才能前置 moov）
 *   3. 把解密结果整个读进内存，再供给播放器
 * 因此起播要干等整集下载 + 解密完成，用户感受就是"缓冲慢"。
 *
 * 用户自有项目（dawei233/hongguo-monorepo 的 pc 版）在同一类片源上起播很快，
 * 其做法经实测确认（见该项目 hongguo_core.py 的注释）：
 *
 *   ffmpeg [-decryption_key K] -i URL -c copy \
 *     -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 out.part.mp4
 *
 *   · 分片 MP4（fragmented MP4）不把 moov 留到结尾，因此**写到哪就能播到哪**；
 *   · 产出的分片 MP4 不含任何 CENC 信令 box，解码 0 错误；
 *   · 实测写到约 21MB（约 2 秒）时 ffprobe 已能解析 → 浏览器可起播；
 *   · Chromium 会把「HTTP 200 + chunked + 无 Content-Length + 不支持 Range」
 *     判定为流式源，边到边播（代价：此时 duration 为 Infinity、不能拖动）。
 *
 * 本模块提供两件事：
 *   `createDecryptStream` —— 启动上面这条 ffmpeg（直接读远端 URL，不再单独下载一遍）
 *   `createGrowingFileStream` —— 把"正在增长的文件"供给播放器：读到文件尾就等生产者
 *                                继续写，生产者结束后正常收尾；`onClose` 是唯一收尾出口
 *
 * 终态化（写完后转 faststart + 净化以换取可拖动与持久缓存）由调用方负责，
 * 不属于本模块。
 */

const fs = require('fs');

/** 分片 MP4 的 movflags：与用户项目实测可用的取值一致，不要随意改动。 */
const FRAGMENTED_MOVFLAGS = 'frag_keyframe+empty_moov+default_base_moof';

/**
 * 启动"解密 + 写分片 MP4"的 ffmpeg 进程。
 *
 * 与旧实现的关键差别：**不再先把整集下载到临时文件**，直接让 ffmpeg 读远端 URL，
 * 一边解密一边把分片 MP4 写进 outputPath。少一遍整集 IO，也少一份临时文件。
 *
 * @returns {{ done: Promise<void>, stop: () => void, get running(): boolean, outputPath: string }}
 */
function createDecryptStream({ ffmpegPath, inputUrl, contentKey, outputPath, signal, spawn, extraArgs = [] }) {
  if (!ffmpegPath) throw new Error('未找到可用的 FFmpeg');
  if (!inputUrl) throw new Error('缺少播放地址');
  if (contentKey && !/^[a-f\d]{32}$/i.test(contentKey)) throw new Error('片源解密密钥格式无效');
  if (typeof spawn !== 'function') throw new Error('缺少 spawn 实现');

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  // 密钥只经参数传递，绝不写日志（否则会把私密材料落到日志里）
  if (contentKey) args.push('-decryption_key', contentKey);
  args.push('-i', inputUrl, '-map', '0:v:0', '-map', '0:a?', '-c', 'copy',
    '-movflags', FRAGMENTED_MOVFLAGS, '-f', 'mp4', ...extraArgs, outputPath);

  const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });

  let settled = false;
  let stopped = false;
  let failure = null;
  const stderrTail = [];

  // 丢弃原生诊断到日志尾部：可能包含私密路径或密钥材料，仅在需要时用于错误信息
  child.stderr?.on('data', chunk => {
    stderrTail.push(String(chunk));
    if (stderrTail.length > 8) stderrTail.shift();
  });

  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { child.kill('SIGTERM'); } catch { /* 进程可能已退出 */ }
    const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 2000);
    killTimer.unref?.();
  };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();

  const done = new Promise((resolve, reject) => {
    const finish = fn => { if (!settled) { settled = true; fn(); } };
    child.once('error', error => finish(() => reject(new Error(`无法启动 FFmpeg：${error.message}`))));
    child.once('close', code => {
      signal?.removeEventListener('abort', stop);
      if (stopped || signal?.aborted) return finish(() => reject(new Error('已取消媒体解密')));
      if (code !== 0) {
        failure = new Error(`媒体解密失败（FFmpeg 退出码 ${code}）`);
        return finish(() => reject(failure));
      }
      finish(resolve);
    });
  });
  // 调用方可能只关心"是否结束"，没人 await 时不要让未处理拒绝冒泡
  done.catch(() => {});

  return {
    done,
    stop,
    outputPath,
    get running() { return !settled; },
    get failed() { return failure; },
  };
}

/**
 * 把一个"仍在增长的文件"供给为可读流。
 *
 * 语义（与用户项目 `_stream_partial` 的关键点一致，那边踩过坑）：
 *  · 读到当前 EOF 时，若生产者仍在运行 → 等待后重试，**不要**直接结束；
 *  · 生产者结束 → 把剩余字节读完再正常收尾（EOF 必须发出，否则连接不关、
 *    浏览器一直等）；
 *  · 生产失败 → 结束流（调用方已发出 200，无法再改成错误码）。
 *
 * ⚠️ 等待必须发生在**同一个 pull 调用内部**（下面的 for 循环）。
 * 早期实现是"await 等待后 return（不入队）"，那条路径会永久停住：
 * ReadableStream 只在「入队 / 新的 read() 请求 / 上一次 pull 尚未完成」时才回调 pull，
 * 而等待期间消费者正阻塞在 read() 上、不会产生新请求，于是 pull 再也不会被调用，
 * 流既不结束也不给数据（测试实测：读到 EOF 后永久挂住）。让 pull 的 promise
 * 一直挂到"有数据"或"生产者结束"，就不依赖流的回调时机。
 *
 * `onClose` 是**唯一的收尾出口**：读到 EOF、出错、被 cancel、被 abort 都会恰好调用一次，
 * 调用方据此释放"每个响应的读者计数"（不要自己包装这个流去做收尾）。
 *
 * 由调用方保证响应是「200 + chunked，不带 Content-Length / Accept-Ranges」——
 * Chromium 才会按流式源处理、边到边播。
 */
function createGrowingFileStream({ filePath, isRunning, signal, pollMs = 100, readSize = 256 * 1024, openFn = fs.promises.open, onClose }) {
  if (typeof isRunning !== 'function') throw new Error('缺少生产者状态判断');
  let handle = null;
  let position = 0;
  let closed = false;
  let cancelled = false;
  let wake = null;

  const finish = () => {
    if (closed) return;
    closed = true;
    wake?.();
    try { onClose?.(); } catch { /* 收尾回调自身出错不应影响流的关闭 */ }
  };

  const closeHandle = async () => {
    const closing = handle;
    handle = null;
    try { await closing?.close(); } catch { /* 已关闭 */ }
  };

  const safeClose = controller => { try { controller.close(); } catch { /* 已被取消 */ } };

  const sleep = ms => new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); wake = null; resolve(); };
    const timer = setTimeout(done, ms);
    wake = done;
    // 取消时尽快醒来，不必等满一个轮询周期
    signal?.addEventListener('abort', done, { once: true });
  });

  return new ReadableStream({
    async pull(controller) {
      if (cancelled) return;
      try {
        for (;;) {
          if (cancelled || signal?.aborted) { await closeHandle(); finish(); safeClose(controller); return; }
          // 文件可能还没被创建（ffmpeg 启动有几百毫秒延迟），此时不能报错
          if (!handle) {
            try { handle = await openFn(filePath, 'r'); }
            catch (error) {
              if (error?.code === 'ENOENT' && isRunning()) { await sleep(pollMs); continue; }
              throw error;
            }
          }
          const buffer = Buffer.allocUnsafe(readSize);
          const { bytesRead } = await handle.read(buffer, 0, readSize, position);
          if (bytesRead > 0) {
            position += bytesRead;
            controller.enqueue(new Uint8Array(buffer.subarray(0, bytesRead)));
            return;
          }
          // 读到 EOF：生产者还在写就继续等（仍在本次 pull 内），否则收尾
          if (isRunning()) { await sleep(pollMs); continue; }
          await closeHandle();
          finish();
          safeClose(controller);
          return;
        }
      } catch (error) {
        await closeHandle();
        finish();
        // 已经发出 200，只能用结束流来表达"没有更多数据"
        safeClose(controller);
        void error;
      }
    },
    async cancel() {
      cancelled = true;
      wake?.();
      await closeHandle();
      finish();
    },
  });
}

module.exports = { createDecryptStream, createGrowingFileStream, FRAGMENTED_MOVFLAGS };
