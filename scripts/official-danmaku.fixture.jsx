import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import OfficialDanmaku from '../src/components/OfficialDanmaku.jsx';
import { createOfficialFeed } from '../src/components/danmakuOfficial.mjs';
import { DEFAULT_DANMAKU_SETTINGS } from '../src/components/danmakuModel.mjs';

/**
 * 官方弹幕叠层的渲染层夹具。
 *
 * 这里验证的是模型单测覆盖不到的部分：组件是否真的按 `video.currentTime`
 * 把弹幕挂上/撤下 DOM，跳转时是否清了屏，改设置时会不会把已经投出去的弹幕
 * 全部重来。
 */

window.IS_REACT_ACT_ENVIRONMENT = true;
window.testResult = (async () => {
  const assert = (value, message) => { if (!value) throw Error(message); };
  const root = createRoot(document.getElementById('root'));
  const video = Object.assign(new EventTarget(), {
    paused: false, ended: false, seeking: false, readyState: 4, playbackRate: 1, currentTime: 0,
  });
  const videoRef = { current: video };
  const feed = createOfficialFeed('7503745441910017049', '7503780574541122622');
  // 时间轴取真实量级：实测最早的一条在 0.7 秒附近，没有正好落在 0 点的弹幕。
  // 播放起点对齐时不会补发"当前播放位置之前"的弹幕，用 0 点会让夹具测到假失败。
  feed.danmaku = [
    { time: 0.2, text: '开场', color: '#FFFFFF', mode: 'scroll' },
    { time: 5, text: '第五秒', color: '#FF0000', mode: 'scroll' },
    { time: 10, text: '屏蔽我', color: '#FFFFFF', mode: 'scroll' },
    { time: 12, text: '第十二秒', color: '#FFFFFF', mode: 'scroll' },
  ];
  feed.loaded = true;

  // 夹具不加载应用 CSS（esbuild 把 .css 置空），必须自己补上叠层的几何。
  // 否则 .comment-danmaku 只是普通块级元素、高度为 0，投放逻辑会因"容器过小"
  // 直接返回，表现为一条弹幕都不出现。
  const style = document.createElement('style');
  style.textContent = '.comment-danmaku{position:absolute;inset:0}.comment-danmaku-item{position:absolute;white-space:nowrap;line-height:1.25}';
  document.head.append(style);

  let settings = { ...DEFAULT_DANMAKU_SETTINGS, density: 'dense' };  let now = 0, serial = 0;
  const frames = new Map();
  window.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
  window.cancelAnimationFrame = id => { frames.delete(id); };

  const render = () => act(async () => root.render(
    <div style={{ position: 'relative', width: 800, height: 600 }}>
      <OfficialDanmaku videoRef={videoRef} source="fixture" available danmaku={{ running: true, settings, feed, status: '', error: '', loading: false }} />
    </div>,
  ));

  /** 推进 count 帧，每帧 100ms，同时把播放位置推进同样的时长。 */
  const advance = async (count, seconds = 0.1) => {
    for (let i = 0; i < count; i += 1) {
      await act(async () => {
        now += 100;
        video.currentTime += seconds;
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach(callback => callback(now));
      });
    }
  };

  const onScreen = () => [...document.querySelectorAll('.comment-danmaku-item')].map(node => node.textContent);

  try {
    await render();
    // 第一帧只做对齐，第二帧起才按时间投放
    await advance(2);
    assert(onScreen().includes('开场'), `时间到点后应出现弹幕，实际 ${JSON.stringify(onScreen())}`);
    assert(!onScreen().includes('第五秒'), `未到时间的弹幕不得提前出现，实际 ${JSON.stringify(onScreen())}`);

    // 推进到 5.5 秒：第五条弹幕应出现，且颜色沿用到 DOM 上
    await advance(53, 0.1);
    assert(onScreen().includes('第五秒'), `5 秒的弹幕应在 5.5 秒时在屏，实际 ${JSON.stringify(onScreen())}`);
    const colored = [...document.querySelectorAll('.comment-danmaku-item')].find(node => node.textContent === '第五秒');
    assert(colored.style.color === 'rgb(255, 0, 0)', `弹幕颜色应生效，实际 ${colored.style.color}`);

    // 后退跳转：清屏并重新对齐，不能把跳转前的弹幕留在屏幕上。
    // 跳转那一帧要把 seconds 传 0：夹具的 advance 默认会推进播放位置，
    // 若跳转后又立刻前进 0.1 秒，就正好越过目标弹幕，测出来的是假失败。
    video.currentTime = 5;
    video.dispatchEvent(new Event('seeking'));
    await advance(1, 0);
    const afterRewind = onScreen();
    assert(!afterRewind.includes('开场'), `后退跳转后不应残留跳转前的弹幕，实际 ${JSON.stringify(afterRewind)}`);
    assert(afterRewind.includes('第五秒'), `后退到 5 秒后应重新投放该时刻的弹幕，实际 ${JSON.stringify(afterRewind)}`);

    // 前进跳转：不得把中间整段弹幕一次性倒出来
    video.currentTime = 12;
    video.dispatchEvent(new Event('seeking'));
    await advance(1, 0);
    const afterForward = onScreen();
    assert(!afterForward.includes('开场'), '快进后不应补发早就过去的弹幕');
    assert(afterForward.length <= 4, `快进后单帧投放应受限，实际 ${afterForward.length}`);
    const beforeSettings = [...document.querySelectorAll('.comment-danmaku-item')];
    assert(beforeSettings.length > 0, '改设置前应有在屏弹幕');

    // 改设置：在屏弹幕必须原地保留，不能集体重来
    const firstText = beforeSettings[0].textContent;
    settings = { ...settings, fontSize: 32 };
    await render();
    const afterSettings = [...document.querySelectorAll('.comment-danmaku-item')];
    assert(afterSettings.length === beforeSettings.length, `改设置不应改变在屏条数：${beforeSettings.length} → ${afterSettings.length}`);
    assert(afterSettings.some(node => node.textContent === firstText), '改设置不应丢掉原本在屏的弹幕');
    assert(afterSettings[0] === beforeSettings[0], '改设置不应重建 DOM 节点');

    // 屏蔽词：命中后当场撤下
    video.currentTime = 10;
    video.dispatchEvent(new Event('seeking'));
    await advance(2, 0);
    const target = [...document.querySelectorAll('.comment-danmaku-item')].find(node => node.textContent === '屏蔽我');
    assert(target, '未设置屏蔽词时应能看到该弹幕');
    settings = { ...settings, blockedWords: '屏蔽我' };
    await render();
    assert(![...document.querySelectorAll('.comment-danmaku-item')].some(node => node.textContent === '屏蔽我'),
      '屏蔽词命中后应立刻撤下该弹幕');
    assert(!onScreen().includes('屏蔽我'), '屏蔽词命中后不应再次出现');

    return {
      passed: true,
      checks: ['按播放时间投放', '未到点不提前出现', '颜色生效', '后退跳转清屏并对齐', '快进不补发', '改设置保留在屏弹幕与 DOM 身份', '屏蔽词当场生效'],
    };
  } catch (error) {
    return { passed: false, error: error.message };
  } finally {
    await act(async () => root.unmount());
  }
})();
