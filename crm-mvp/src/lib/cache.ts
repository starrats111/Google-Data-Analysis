/**
 * 轻量级内存缓存 — 2核2G 服务器优化
 *
 * 用于缓存不常变化的数据（统计数据、配置、MCC 列表等），
 * 减少数据库查询次数。
 *
 * 内存限制：最多缓存 200 个条目，超过自动淘汰最旧的。
 * 生产环境建议替换为 Redis，但 2G 内存下 Redis 本身也要 50-100MB，
 * 所以小规模用内存缓存更划算。
 */

interface CacheEntry<T> {
  data: T;
  expireAt: number;
  createdAt: number;
}

const MAX_ENTRIES = 200;
const cache = new Map<string, CacheEntry<unknown>>();

/**
 * 获取缓存
 */
export function cacheGet<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

/**
 * 设置缓存
 * @param ttlMs 过期时间（毫秒），默认 30 秒
 */
export function cacheSet<T>(key: string, data: T, ttlMs = 30000): void {
  // 超过上限时淘汰最旧的条目
  if (cache.size >= MAX_ENTRIES) {
    let oldestKey = "";
    let oldestTime = Infinity;
    for (const [k, v] of cache) {
      if (v.createdAt < oldestTime) {
        oldestTime = v.createdAt;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }

  cache.set(key, {
    data,
    expireAt: Date.now() + ttlMs,
    createdAt: Date.now(),
  });
}

/**
 * 删除缓存（支持前缀匹配）
 */
export function cacheDelete(keyOrPrefix: string, prefix = false): void {
  if (prefix) {
    for (const key of cache.keys()) {
      if (key.startsWith(keyOrPrefix)) cache.delete(key);
    }
  } else {
    cache.delete(keyOrPrefix);
  }
}

/**
 * 带缓存的数据获取 — 最常用的模式
 *
 * @example
 * const stats = await cachedQuery("merchant-stats:123", () => prisma.merchants.count(...), 30000);
 */
export async function cachedQuery<T>(
  key: string,
  queryFn: () => Promise<T>,
  ttlMs = 30000
): Promise<T> {
  const cached = cacheGet<T>(key);
  if (cached !== null) return cached;

  const data = await queryFn();
  cacheSet(key, data, ttlMs);
  return data;
}

/**
 * 缓存统计（调试用）
 */
export function cacheStats() {
  let expired = 0;
  const now = Date.now();
  for (const entry of cache.values()) {
    if (now > entry.expireAt) expired++;
  }
  return { size: cache.size, expired, maxEntries: MAX_ENTRIES };
}
