// Execute main.js startup with an Electron boundary double; no windows, network or user files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const source = path.resolve(__dirname, '../main.js');
const req = createRequire(source);

function load(ownsLock, preview = false) {
  const events = [], ready = [], app = new EventEmitter();
  let userData = '/tmp/hongguo-single-instance-test';
  Object.assign(app, {
    getVersion: () => 'test', getPath: name => name === 'userData' ? userData : '/tmp',
    setName() {}, setPath: (name, value) => { if (name === 'userData') userData = value; },
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => { events.push(['lock', userData]); return ownsLock; },
    quit: () => events.push(['quit']),
    whenReady: () => { events.push(['ready']); return { then: callback => ready.push(callback) }; },
  });
  const store = { setErrorHandler() {}, init: file => events.push(['store', file]) };
  const electron = { app, ipcMain: { handle() {} }, protocol: { registerSchemesAsPrivileged() {} } };
  const context = vm.createContext({
    require: name => name === 'electron' ? electron : name === './src/store' ? store
      : name === './package.json' ? { name: preview ? 'hongguo-experience-preview' : 'hongguo-downloader' } : req(name),
    __dirname: path.dirname(source), process: { ...process, platform: 'linux', env: {} },
    console: { log() {}, warn() {}, error() {} }, Buffer, URL, Response, Request, Headers, AbortController,
    setTimeout: () => ({ unref() {} }), setInterval: () => ({ unref() {} }), clearTimeout, clearInterval,
  });
  vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
  for (const name of ['loadDownloadTasks', 'loadSeriesRegistry', 'rebuildSeriesRegistryFromTasks', 'rescanDownloadsFromDisk', 'loadMergeTasks', 'registerStreamProtocol', 'registerLocalProtocol', 'applyProxySettings']) context[name] = () => {};
  context.getCurrentSettings = () => ({});
  context.enqueuePendingTasks = () => { events.push(['queue']); return 0; };
  const window = {
    isDestroyed: () => false, isMinimized: () => true,
    restore: () => events.push(['restore']), show: () => events.push(['show']), focus: () => events.push(['focus']),
  };
  context.fixtureWindow = window;
  context.createWindow = () => { events.push(['window']); vm.runInContext('mainWindow = fixtureWindow', context); };
  return { app, events, ready, context };
}

test('second process quits before readiness, data load, queued jobs or a window', async () => {
  const h = load(false);
  for (const callback of h.ready) await callback();
  assert.deepEqual(h.events.map(event => event[0]), ['lock', 'quit']);
});

test('lock owner starts once; repeated launches restore its existing window', async () => {
  for (const preview of [false, true]) {
    const h = load(true, preview);
    for (const callback of h.ready) await callback();
    const expectedDirectory = preview ? '/tmp/hongguo-experience-preview' : '/tmp/hongguo-single-instance-test';
    assert.deepEqual(h.events[0], ['lock', expectedDirectory], 'take lock after preview userData isolation');
    assert.equal(h.events.filter(event => event[0] === 'store').length, 1);
    assert.equal(h.events.find(event => event[0] === 'store')[1], path.join(expectedDirectory, 'data.json'));
    h.events.length = 0;
    h.app.emit('second-instance');
    assert.deepEqual(h.events.map(event => event[0]), ['restore', 'show', 'focus']);
    vm.runInContext('mainWindow = null', h.context);
    h.events.length = 0;
    h.app.emit('second-instance');
    assert.deepEqual(h.events.map(event => event[0]), ['window', 'restore', 'show', 'focus']);
  }
});
