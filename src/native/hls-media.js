const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const axios = require('axios');
const { webMediaRequestOptions } = require('./web-media-guard');

async function requestHls(url, { signal, headers }) {
  return axios({ url, method:'GET', responseType:'stream', timeout:30000,
    ...webMediaRequestOptions(url), signal, headers });
}

// The bundled FFmpeg has no HTTP transport: stage guarded HLS resources on disk and allow local protocols only.
async function remuxHls({ url, output, ffmpeg, signal, cancelToken, request = requestHls, checkAccess = () => {}, headers = {}, onProgress }) {
  if (!ffmpeg) throw new Error('未找到 FFmpeg，无法准备 HLS 视频');
  webMediaRequestOptions(url);
  const controller = new AbortController(), files = new Map();
  let temporary, child, failure, killed, killTimer, received = 0, lastProgress = 0;
  const stopChild = () => {
    if (!child || killed) return;
    killed = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  };
  const fail = error => { failure ||= error; controller.abort(); stopChild(); };
  const abort = () => fail(new Error('已取消 HLS 准备'));
  const check = () => {
    if (signal?.aborted || cancelToken?.reason) abort();
    if (failure) throw failure;
    checkAccess();
  };
  signal?.addEventListener('abort', abort, { once:true }); cancelToken?.subscribe(abort);
  const deadline = setTimeout(() => fail(new Error('HLS 准备超时，请重试')), 10 * 60 * 1000);
  const stage = async (remote, playlist = false, ancestors = new Set()) => {
    check(); webMediaRequestOptions(remote);
    if (ancestors.has(remote)) throw new Error('HLS 清单循环引用');
    if (files.has(remote)) return files.get(remote);
    if (files.size >= 10000) throw new Error('HLS 清单过大');
    const extension = playlist ? 'm3u8' : /\.(ts|m4s|mp4|aac|m4a|vtt)$/i.exec(new URL(remote).pathname)?.[1] || 'ts';
    const local = path.join(temporary, `${files.size}.${extension}`);
    files.set(remote,local);
    let upstream;
    try {
      upstream = await request(remote, { signal:controller.signal, headers:{...headers,'Accept-Encoding':'identity'} });
      check();
      if (upstream.status !== 200) throw new Error('HLS 媒体请求失败或内容不完整');
      const type = String(upstream.headers['content-type'] || '');
      if (playlist || /mpegurl/i.test(type)) {
        let text = '', bytes = 0;
        for await (const chunk of upstream.data) {
          check(); bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) throw new Error('HLS 清单过大');
          text += chunk.toString('utf8');
        }
        if (Number(upstream.headers['content-length']) && bytes !== Number(upstream.headers['content-length'])) throw new Error('HLS 清单下载不完整');
        if (!text.trimStart().startsWith('#EXTM3U')) throw new Error('无效 HLS 清单');
        if (/#EXTINF:/.test(text) && !/#EXT-X-ENDLIST/.test(text)) throw new Error('暂不支持未结束的直播清单');
        const base = upstream.request?.res?.responseUrl || upstream.url || remote;
        webMediaRequestOptions(base);
        const chain = new Set([...ancestors,remote]);
        let lines = text.split(/\r?\n/);
        // Keep one highest-bandwidth rendition; final media verification enforces the requested resolution.
        const variants = lines.map((line,index) => ({index,bandwidth:Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(line.slice(line.indexOf(':')+1))?.[1]) || 0})).filter(item => lines[item.index].startsWith('#EXT-X-STREAM-INF:'));
        if (variants.length > 1) {
          const chosen = variants.reduce((a,b) => b.bandwidth > a.bandwidth ? b : a);
          const removed = new Set(variants.filter(item => item !== chosen).flatMap(item => [item.index,item.index+1]));
          lines = lines.filter((line,index) => !removed.has(index));
        }
        const rewritten = []; let variant = false;
        for (const line of lines) {
          check(); const value = line.trim();
          if (!value) { rewritten.push(line); continue; }
          if (!value.startsWith('#')) {
            rewritten.push(await stage(new URL(value,base).href,variant,chain)); variant = false; continue;
          }
          variant = value.startsWith('#EXT-X-STREAM-INF:');
          if (value.startsWith('#EXT-X-DEFINE:')) throw new Error('不支持含动态地址变量的 HLS 清单');
          if (/^#EXT-X-(?:SESSION-)?KEY:/.test(value) && !/METHOD=(?:AES-128|NONE)(?:,|$)/.test(value)) throw new Error('不支持该 HLS 加密方式');
          let result = line, matches = [...line.matchAll(/\bURI="([^"]*)"/g)];
          if ((line.match(/\bURI\s*=/g) || []).length !== matches.length) throw new Error('HLS 地址格式无效');
          for (const match of matches) {
            const file = await stage(new URL(match[1],base).href,/^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):/.test(value),chain);
            if (/^#EXT-X-(?:SESSION-)?KEY:/.test(value) && fs.statSync(file).size !== 16) throw new Error('HLS 密钥长度无效');
            result = result.replace(match[0],`URI="${file}"`);
          }
          rewritten.push(result);
        }
        await fsp.writeFile(local,rewritten.join('\n'),{mode:0o600});
      } else {
        if (/text\/html|application\/json/i.test(type)) throw new Error('HLS 分片返回了错误页面');
        let bytes = 0;
        upstream.data.on('data',chunk => {
          bytes += chunk.length; received += chunk.length;
          if (Date.now()-lastProgress >= 150) { onProgress?.(received); lastProgress = Date.now(); }
        });
        await pipeline(upstream.data,fs.createWriteStream(local,{mode:0o600}),{signal:controller.signal});
        if (!bytes || (Number(upstream.headers['content-length']) && bytes !== Number(upstream.headers['content-length']))) throw new Error('HLS 分片下载不完整');
        onProgress?.(received);
      }
      check(); return local;
    } finally { upstream?.data?.destroy(); }
  };
  try {
    check(); temporary = await fsp.mkdtemp(path.join(os.tmpdir(),'hongguo-hls-'));
    const input = await stage(url,true);
    check();
    await new Promise((resolve,reject) => {
      child = spawn(ffmpeg,['-v','error','-nostdin','-y','-protocol_whitelist','file,crypto','-allowed_extensions','ALL',
        '-i',input,'-map','0:v:0','-map','0:a?','-c','copy','-movflags','+faststart','-f','mp4',output],
      {windowsHide:true,stdio:['ignore','ignore','pipe']});
      child.stderr.on('data',() => {});
      child.once('error',() => reject(new Error('无法启动 FFmpeg')));
      child.once('close',code => { clearTimeout(killTimer); failure ? reject(failure) : code === 0 ? resolve() : reject(new Error('HLS 媒体转换失败')); });
      if (controller.signal.aborted) stopChild();
    });
    check();
    if (!fs.existsSync(output) || !fs.statSync(output).size) throw new Error('HLS 没有生成有效视频');
  } catch (error) {
    try { fs.unlinkSync(output); } catch (_) {}
    throw failure || error;
  } finally {
    clearTimeout(deadline); clearTimeout(killTimer);
    signal?.removeEventListener('abort',abort); cancelToken?.unsubscribe(abort); controller.abort();
    if (temporary) await fsp.rm(temporary,{recursive:true,force:true});
  }
}
module.exports = { remuxHls };
