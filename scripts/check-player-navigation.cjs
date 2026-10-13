const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { transformSync } = require('esbuild');
const slots = [];
let cursor = 0;
const react = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
  useState(initial) {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
  },
  useRef: value => ({ current: value }), useCallback: fn => fn, useEffect() {}, useLayoutEffect() {},
};
const context = { module: { exports: {} }, navigator: { platform: 'Mac' }, require: name => {
  if (name === 'react') return react;
  if (name.endsWith('useStealthWindow')) return () => ({ stealthMode: false, toggleStealth() {} });
  return name;
} };
context.exports = context.module.exports;
vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname, '../src/App.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs' }).code, context);
let tree;
const render = () => { cursor = 0; tree = context.module.exports.default(); };
const nodes = () => {
  const out = [];
  const visit = node => { if (!node || typeof node !== 'object') return; out.push(node); node.children?.forEach(visit); };
  visit(tree); return out;
};
const navigate = id => {
  const button = nodes().find(node => node.type === 'button' && node.props.key === id);
  assert(button, id); button.props.onClick(); render();
};
const players = () => nodes().filter(node => node.type === './components/Player');
render();
navigate('player'); assert.equal(players().length, 1);
navigate('feed'); assert.equal(players().length, 0);
navigate('settings'); assert.equal(players().length, 0, 'leaving feed must not remount a hidden player');
navigate('player'); assert.equal(players().length, 1, 'returning to library explicitly mounts its player');
navigate('settings'); assert.equal(players().length, 1, 'ordinary navigation preserves the existing retained-player behavior');
assert.equal(players()[0].props.active, false);
console.log('PASS navigation: feed/library exclusivity without hidden playback remount');
