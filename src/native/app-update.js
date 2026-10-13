/**
 * 本 fork 的发布仓库。
 *
 * 上游这里是 `jackotom/hongguo-drama`。不改的话，应用会拿上游的发行版做版本
 * 比较 —— 实测上游把 1.7 / 1.71 / 1.72 当作小版本号发 tag，于是本 fork 的
 * 1.7.0 会一直被提示"有新版本 1.72"，点开还跳到上游的下载页。
 *
 * 改这里就够了：更新检查（`LATEST_RELEASE_API`）与"打开发行页"（`RELEASES_URL`）
 * 都从它派生，不需要在两处各改一遍。
 *
 * 注意：**不要让 package.json 的 version 带上 `-fork` 之类的后缀**。
 * `versionParts()` 只认 `X.Y` / `X.Y.Z`，一旦带上后缀就解析失败，更新检查会
 * 永远静默失效（比提示上游还糟，因为完全没有报错）。
 */
const RELEASE_REPO = 'dawei233/hongguo-drama';
const RELEASES_URL = `https://github.com/${RELEASE_REPO}/releases`;
const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(value || ''));
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function availableRelease(data, currentVersion) {
  if (!data || data.draft || data.prerelease) return null;
  const next = versionParts(data.tag_name), current = versionParts(currentVersion);
  if (!next || !current) return null;
  const difference = next.findIndex((part, i) => part !== current[i]);
  if (difference < 0 || next[difference] < current[difference]) return null;
  return {
    version: data.tag_name.replace(/^v/, '').replace(/^(\d+\.\d+)\.0$/, '$1'),
    // Never open a remote-provided URL; only this project's release page.
    url: `${RELEASES_URL}/tag/${encodeURIComponent(data.tag_name)}`,
  };
}

module.exports = { availableRelease, RELEASE_REPO, RELEASES_URL, LATEST_RELEASE_API };
