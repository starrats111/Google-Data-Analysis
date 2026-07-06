/**
 * Developer Token 池轮询
 *
 * 背景：Google Ads API 的配额（QPS + 每日操作数）按 Developer Token 计，
 * 与请求里的 login-customer-id / OAuth 凭据无关——任何一个有效 token 都可以
 * 配任何 service account 去查任何有权限的账户。此前全员 9 个 MCC 共用一个
 * token，配额被打爆导致全员 429；把所有 MCC 配置的 token 汇成池做轮询，
 * 配额即扩大为 N 个 token 之和。
 *
 * 池来源（自动，无需额外配置）：
 * - 所有活跃 MCC（google_mcc_accounts.is_active=1）的去重 developer_token
 * - 环境变量 GOOGLE_ADS_TOKEN_POOL（逗号分隔，可补充未挂在任何 MCC 上的 token）
 * - 环境变量 GOOGLE_ADS_DEVELOPER_TOKEN（兜底默认 token）
 *
 * 轮询策略：
 * - 请求级 round-robin，各 token 均摊流量
 * - 某 token 收到 429 → 冷却 3 分钟（或 Google 返回的 retryDelay，取大者），期间跳过
 * - 某 token 报 DEVELOPER_TOKEN_NOT_APPROVED / PROHIBITED → 冷却 24 小时（基本等于禁用）
 * - 全池都在冷却时，返回冷却最早结束的那个（调用方自行决定等待）
 *
 * 状态存于模块内存：生产是 PM2 单进程 Next.js，天然全局；进程重启即清零，无碍。
 */
import prisma from "@/lib/prisma";

const POOL_CACHE_TTL_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 3 * 60_000;
const INVALID_COOLDOWN_MS = 24 * 3600_000;

let poolCache: { tokens: string[]; loadedAt: number } | null = null;
const cooldownUntil = new Map<string, number>();
let rr = 0;

/** 日志用：只露 token 末 6 位 */
export function maskToken(token: string): string {
  return token.length <= 6 ? token : `…${token.slice(-6)}`;
}

async function loadPool(): Promise<string[]> {
  const now = Date.now();
  if (poolCache && now - poolCache.loadedAt < POOL_CACHE_TTL_MS) return poolCache.tokens;

  const tokens = new Set<string>();
  try {
    const rows = await prisma.google_mcc_accounts.findMany({
      where: { is_deleted: 0, is_active: 1, developer_token: { not: null } },
      select: { developer_token: true },
    });
    for (const r of rows) {
      const t = (r.developer_token || "").trim();
      if (t) tokens.add(t);
    }
  } catch (e) {
    console.error("[TokenPool] 加载 MCC token 失败（将退回调用方自带 token）:", e instanceof Error ? e.message : e);
  }
  for (const raw of (process.env.GOOGLE_ADS_TOKEN_POOL || "").split(",")) {
    const t = raw.trim();
    if (t) tokens.add(t);
  }
  const envDefault = (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim();
  if (envDefault) tokens.add(envDefault);

  poolCache = { tokens: [...tokens], loadedAt: now };
  return poolCache.tokens;
}

/**
 * 轮询取一个可用 token。
 * @param preferred 调用方自带 token（该 MCC 配置的），池为空时兜底返回它
 * @param exclude 本次请求已试过（刚 429/失效）的 token
 */
export async function pickDeveloperToken(preferred: string, exclude?: Set<string>): Promise<string> {
  const pool = await loadPool();
  if (pool.length === 0) return preferred;

  const now = Date.now();
  const available = pool.filter((t) => (cooldownUntil.get(t) ?? 0) <= now && !exclude?.has(t));
  if (available.length > 0) {
    return available[rr++ % available.length];
  }

  // 全在冷却/已排除：取冷却最早结束的（未被排除者优先），让调用方自行等待
  const base = pool.filter((t) => !exclude?.has(t));
  const candidates = base.length > 0 ? base : pool;
  let best = candidates[0];
  for (const t of candidates) {
    if ((cooldownUntil.get(t) ?? 0) < (cooldownUntil.get(best) ?? 0)) best = t;
  }
  return best;
}

/** 是否还有未冷却、未被排除的备用 token（决定 429 后是立即换 token 还是等待） */
export async function hasAlternativeToken(exclude: Set<string>): Promise<boolean> {
  const pool = await loadPool();
  const now = Date.now();
  return pool.some((t) => !exclude.has(t) && (cooldownUntil.get(t) ?? 0) <= now);
}

/** 上报某 token 触发 429：冷却 3 分钟或 Google 建议的 retryDelay（取大者） */
export function reportTokenRateLimited(token: string, retryDelaySec?: number): void {
  const ms = Math.max(RATE_LIMIT_COOLDOWN_MS, (retryDelaySec ?? 0) * 1000);
  cooldownUntil.set(token, Date.now() + ms);
  console.warn(`[TokenPool] token ${maskToken(token)} 触发限流，冷却 ${Math.round(ms / 1000)}s`);
}

/** 上报某 token 不可用（未获批/被禁）：冷却 24 小时 */
export function reportTokenInvalid(token: string): void {
  cooldownUntil.set(token, Date.now() + INVALID_COOLDOWN_MS);
  console.warn(`[TokenPool] token ${maskToken(token)} 不可用（未获批/被禁），24h 内不再使用`);
}

/** 池运行状态（供诊断/管理端查看） */
export async function getTokenPoolStatus(): Promise<{ total: number; available: number; cooling: { token: string; until: string }[] }> {
  const pool = await loadPool();
  const now = Date.now();
  const cooling = pool
    .filter((t) => (cooldownUntil.get(t) ?? 0) > now)
    .map((t) => ({ token: maskToken(t), until: new Date(cooldownUntil.get(t)!).toISOString() }));
  return { total: pool.length, available: pool.length - cooling.length, cooling };
}
