// D-158 / C-156: 过期部署（stale deploy）客户端自愈工具。
//
// 背景：新版本上线后会原子替换 .next，webpack chunk / Server Action 的 hash 全部变化。
// 老标签页仍持有旧 runtime，会出现：
//   ① ChunkLoadError —— chunk hash 变化，旧映射指向的文件在切换窗口期短暂 404；
//   ② "Failed to find Server Action" —— action ID 变化，旧标签页调用旧 action。
// 两者本质都是"客户端 bundle 过期"，唯一正解是刷新拉取最新 bundle。
//
// 此前 error.tsx 用 window.location.reload() + 10s 节流恢复，存在两个缺陷：
//   1) 普通 reload 可能命中 bfcache/磁盘缓存，仍跑旧 chunk 映射 → 反复失败；
//   2) 节流只刷一次后就把用户永久晾在静态错误页，"重试"按钮调 reset() 对 chunk 错误无效。
// 本工具改为"缓存穿透硬刷新 + 有限次重试"，并让重试按钮走真正的硬刷新。

const STALE_DEPLOY_RE =
  /Loading chunk [\w-]+ failed|ChunkLoadError|Failed to fetch dynamically imported module|error loading dynamically imported module|Failed to find Server Action|from an older or newer deployment/i;

export function isStaleDeployError(error?: { name?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.name === "ChunkLoadError") return true;
  return STALE_DEPLOY_RE.test(String(error.message || ""));
}

// 缓存穿透硬刷新：给当前 URL 追加一次性时间戳参数，强制浏览器/CDN 重新拉取最新 HTML 与
// webpack runtime。普通 location.reload() 可能命中 bfcache/磁盘缓存仍跑旧 chunk 映射。
export function hardReloadBustingCache(): void {
  if (typeof window === "undefined") return;
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("__r", String(Date.now()));
    window.location.replace(u.toString());
  } catch {
    window.location.reload();
  }
}

// 自动恢复：检测到过期部署错误时硬刷新。30s 窗口内最多刷 2 次，避免坏部署无限刷新；
// 距上次刷新超过 30s 视为已恢复并重置计数，使后续真正的新部署仍可自愈。
// 返回是否已触发刷新（false 表示已达上限、需要用户手动重试）。
export function tryAutoRecoverStaleDeploy(): boolean {
  if (typeof window === "undefined") return false;
  const COUNT_KEY = "__chunk_reload_count";
  const TIME_KEY = "__chunk_reloaded_at";
  const now = Date.now();
  const last = Number(sessionStorage.getItem(TIME_KEY) || 0);
  let count = Number(sessionStorage.getItem(COUNT_KEY) || 0);
  if (now - last > 30000) count = 0;
  if (count >= 2) return false;
  sessionStorage.setItem(TIME_KEY, String(now));
  sessionStorage.setItem(COUNT_KEY, String(count + 1));
  hardReloadBustingCache();
  return true;
}
