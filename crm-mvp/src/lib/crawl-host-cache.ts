/**
 * 站级反爬指纹缓存（D-030 抽出，D-031 共享）
 *
 * 用途：记录某个 host 在 30 分钟窗口内是否触发过 CF/Datadome 强反爬。
 * 命中后，crawler.fetchUrlMeta / image-proxy 等模块应跳过 L0 HTTP 路径，
 * 直接走 Puppeteer 真人指纹兜底。
 *
 * 进程内 LRU（max 500 host，超量回收过期项），无持久化 —— PM2 restart
 * 后重新探测，避免站点反爬策略变动后旧标记长期生效。
 */

const CHALLENGED_HOST_TTL_MS = 30 * 60 * 1000;
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
