/**
 * 站级反爬指纹缓存（D-030 抽出，D-031 共享，D-038b/方案 G 调整 TTL）
 *
 * 用途：记录某个 host 在 5 分钟窗口内是否触发过 CF/Datadome 强反爬。
 * 命中后，crawler.fetchUrlMeta / image-proxy 等模块应跳过 L0 HTTP 路径，
 * 直接走 Puppeteer 真人指纹兜底。
 *
 * D-038b（2026-05-28）：TTL 30 分钟 → 5 分钟。
 *   背景：D-028 v5 引入"L0 全灭立即 markHostChallenged"激进规则后，
 *   30 分钟 TTL 把"临时代理抖动/单次探活失败"也长期标记为 challenged，
 *   导致整站后续 30 分钟内全部走错误的短路路径。
 *   调整为 5 分钟后，让临时抖动 host 在 5 分钟内自动恢复，
 *   只有真正持续反爬的 host 才会被重复标记延长。
 *
 * 进程内 LRU（max 500 host，超量回收过期项），无持久化 —— PM2 restart
 * 后重新探测，避免站点反爬策略变动后旧标记长期生效。
 */

const CHALLENGED_HOST_TTL_MS = 5 * 60 * 1000;
const challengedHosts = new Map<string, number>();

export function getHostKey(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isHostChallenged(host: string): boolean {
  const exp = challengedHosts.get(host);
  if (!exp) return false;
  if (Date.now() > exp) {
    challengedHosts.delete(host);
    return false;
  }
  return true;
}

export function markHostChallenged(host: string): void {
  challengedHosts.set(host, Date.now() + CHALLENGED_HOST_TTL_MS);
  if (challengedHosts.size > 500) {
    const now = Date.now();
    for (const [h, e] of challengedHosts) {
      if (now > e) challengedHosts.delete(h);
    }
  }
}

export function challengedHostsCount(): number {
  return challengedHosts.size;
}
