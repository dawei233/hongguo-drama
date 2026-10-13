'use strict';

/**
 * 官方弹幕源健康检查（**联网**，不属于离线测试）。
 *
 * 这条接口不是公开接口，靠伪造官方客户端签名（X-Gorgon / X-Argus / X-Ladon）访问，
 * 上游随时可能改算法、改参数或封禁。所以维护时需要有个一眼能看出"它还活着吗"的
 * 手段：离线单测只能证明"算法和参考实现一致"，证明不了"上游还认这个签名"。
 *
 * 用法：
 *     node scripts/check-danmaku-official-source.cjs [剧集ID] [分集ID]
 *
 * 退出码：0 = 能取到带时间轴的弹幕；1 = 取不到（附原因）。
 * 失败时错误文案会直接说明是签名被拒、超时还是网络不通 —— 排查时先看这一句。
 */

const { fetchDanmaku } = require('../src/native/danmaku');

// 默认样例：一个长期存在的红果短剧分集，便于对比历史结果。
const DEFAULT_SERIES = '7503745441910017049';
const DEFAULT_VID = '7503780574541122622';

(async () => {
  const seriesId = process.argv[2] || DEFAULT_SERIES;
  const vid = process.argv[3] || DEFAULT_VID;

  console.log(`检查官方弹幕源：剧集 ${seriesId} / 分集 ${vid}`);
  const started = Date.now();
  const result = await fetchDanmaku({ seriesId, vid, fresh: true });
  const elapsed = Date.now() - started;

  if (!result.success || !result.items.length) {
    console.error(`✖ 取不到弹幕（耗时 ${elapsed}ms）`);
    console.error(`  原因：${result.error || result.notice || '未知'}`);
    console.error('  排查顺序：1) 换一集再试，排除单集无弹幕；2) 看是否为签名被拒（业务 code 非 0）；');
    console.error('            3) 用参考实现 nas-backend/danmaku.py 跑同一集，判断是算法变了还是网络问题。');
    process.exitCode = 1;
    return;
  }

  const times = result.items.map(item => item.time);
  const earliest = Math.min(...times);
  const latest = Math.max(...times);
  const ascending = times.every((time, index) => index === 0 || time >= times[index - 1]);

  console.log(`✔ 取到 ${result.items.length} 条弹幕（耗时 ${elapsed}ms）`);
  console.log(`  时间范围：${earliest}s ~ ${latest}s${ascending ? '（已按时间升序）' : '（**顺序异常**）'}`);
  console.log(`  样例：${JSON.stringify(result.items.slice(0, 3))}`);
  if (result.notice) console.log(`  说明：${result.notice}`);

  // 时间轴是"真弹幕"与"评论滚动条"的分界，取到内容但时间轴不对等于没做。
  if (!ascending || latest <= earliest) {
    console.error('✖ 时间轴异常：拿到的数据不能按播放进度投放');
    process.exitCode = 1;
  }
})();
