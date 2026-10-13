'use strict';

/**
 * 渲染层检查：官方弹幕叠层，外加对上游「本集评论」夹具的回归。
 *
 * 与 `check-danmaku-live.cjs` 同一套 esbuild + electron 夹具手法，区别只在于：
 *  1. 同时跑两个夹具（新的官方弹幕 + 上游的评论弹幕），确认新组件没有把老路径
 *     带坏；
 *  2. 容器里以 root 运行时补上 `--no-sandbox` 与 `--disable-dev-shm-usage` ——
 *     上游脚本在这类环境里会因为 /dev/shm 不可写而静默失败，看不到任何结论。
 *
 * 用法：node scripts/check-official-danmaku.cjs [node_modules 目录]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIXTURES = [
  { name: '官方弹幕（新增）', fixture: 'official-danmaku.fixture.jsx' },
  { name: '本集评论（上游回归）', fixture: 'danmaku-live.fixture.jsx' },
];

// 以 root 跑 Chromium 需要显式关沙箱；容器里 /dev/shm 常常不可写。
// 探测必须是**真的试写一次**：`fs.accessSync(W_OK)` 对 root 恒为真（root 绕过权限
// 位），但沙箱仍会拒绝实际写入，用它判断会漏掉 --disable-dev-shm-usage，
// 于是 Chromium 静默建不出共享内存，测试全部无输出。
const containerFlags = () => {
  const flags = [];
  if (typeof process.getuid === 'function' && process.getuid() === 0) flags.push('--no-sandbox', '--disable-gpu');
  let writable = false;
  try {
    const probe = path.join('/dev/shm', `.hongguo-probe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    writable = true;
  } catch {
    writable = false;
  }
  if (!writable) flags.push('--disable-dev-shm-usage');
  return flags;
};

// 用标志名定位，不要硬编码 process.argv[2]：容器开关要放在脚本路径之前才能被
// Chromium 稳定接收，那样下标就不再固定了。
const rendererFlag = process.argv.indexOf('--renderer-test');

if (rendererFlag !== -1) {
  const { app, BrowserWindow } = require('electron');
  const workDir = process.argv[rendererFlag + 1];
  app.setPath('userData', path.join(workDir, 'profile'));
  app.whenReady().then(async () => {
    // 不要开 offscreen：离屏渲染会和夹具里被接管的 requestAnimationFrame 互相等，
    // 表现为整个检查挂到超时、拿不到任何结论。
    const window = new BrowserWindow({ show: false, width: 1000, height: 800 });
    try {
      await window.loadFile(path.join(workDir, 'index.html'));
      const result = await window.webContents.executeJavaScript('window.testResult');
      console.log(JSON.stringify(result));
      app.exit(result.passed ? 0 : 1);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
} else {
  const modules = path.resolve(process.argv[2] || path.join(__dirname, '../node_modules'));
  const flags = containerFlags();
  let failed = 0;

  for (const { name, fixture } of FIXTURES) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-danmaku-render-'));
    try {
      require(path.join(modules, 'esbuild')).buildSync({
        entryPoints: [path.join(__dirname, fixture)],
        bundle: true,
        outfile: path.join(temp, 'test.js'),
        nodePaths: [modules],
        loader: { '.css': 'empty' },
        define: { 'process.env.NODE_ENV': '"development"' },
      });
      fs.writeFileSync(path.join(temp, 'index.html'), '<div id="root"></div><script src="test.js"></script>');
      const run = require('node:child_process').spawnSync(
        require(path.join(modules, 'electron')),
        [...flags, __filename, '--renderer-test', temp],
        { encoding: 'utf8', timeout: 60000 },
      );
      const lines = (run.stdout || '').trim().split('\n');
      const payload = lines[lines.length - 1];
      let parsed = null;
      try {
        parsed = JSON.parse(payload);
      } catch {
        parsed = null;
      }
      if (run.status === 0 && parsed?.passed) {
        console.log(`✔ ${name}：${parsed.checks ? parsed.checks.join(' / ') : 'passed'}`);
      } else {
        failed += 1;
        console.log(`✖ ${name}：${parsed?.error || run.error?.message || (run.stderr || '').trim().split('\n').slice(-3).join(' | ') || '无输出'}`);
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  if (failed) {
    console.error(`渲染层检查未通过：${failed}/${FIXTURES.length}`);
    process.exitCode = 1;
  } else {
    console.log(`渲染层检查通过：${FIXTURES.length}/${FIXTURES.length}`);
  }
}
