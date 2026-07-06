/**
 * Developer Token 池轮询（按团队隔离，组长配置）
 *
 * 背景：Google Ads API 的配额（QPS + 每日操作数）按 Developer Token 计，
 * 与请求里的 login-customer-id / OAuth 凭据无关——任何一个有效 token 都可以
 * 配任何 service account 去查任何有权限的账户。此前全员共用一个 token，
 * 配额被打爆导致全员 429。
 *
 * 池的构成（单次请求可轮换的 token 候选集）：
 * 1. 该 MCC 所属团队的组长在「团队设置 → Developer Token 池」配置的活跃 token
 *    （team_developer_tokens 表；按团队隔离，不与其他组混用配额）
 * 2. 环境变量 GOOGLE_ADS_TOKEN_POOL（逗号分隔，管理员全局补充，所有团队可用）
 * 3. 该 MCC 自己配置的 token（兜底；组长未配池时行为与旧版单 token 完全一致）
 *
 * 轮询策略：
 * - 请求级 round-robin，各 token 均摊流量
 * - 某 token 收到 429 → 冷却 3 分钟（或 Google 返回的 retryDelay，取大者），期间跳过
 *   （冷却状态全局共享：token 配额是全局的，不分团队）
 * - 某 token 报 DEVELOPER_TOKEN_NOT_APPROVED → 冷却 24 小时（基本等于禁用）
 * - 全部候选都在冷却时，返回冷却最早结束的那个（调用方自行决定等待）
 *
 * 状态存于模块内存：生产是 PM2 单进程 Next.js，天然全局；进程重启即清零，无碍。
 */
import prisma from "@/lib/prisma";

const POOL_CACHE_TTL_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 3 * 60_000;
const INVALID_COOLDOWN_MS = 24 * 3600_000;
// 真实 Developer Token 为 22 位；过滤占位假 token（如 "123456"）
const MIN_TOKEN_LENGTH = 15;

/** mcc_id（Google MCC 客户号）→ 团队池 token 列表缓存 */
const poolCacheByMcc = new Map<string, { tokens: string[]; loadedAt: number }>();
const cooldownUntil = new Map<string, number>();
let rr = 0;

/** 日志用：只露 token 末 6 位 */
export function maskToken(token: string): string {
  return token.length <= 6 ? token : `…${token.slice(-6)}`;
}

function envTokens(): string[] {
  const out: string[] = [];
  for (const raw of (process.env.GOOGLE_ADS_TOKEN_POOL || "").split(",")) {
    const t = raw.trim();
    if (t.length >= MIN_TOKEN_LENGTH) out.push(t);
  }
  return out;
}

/** 该 MCC 所属团队组长配置的活跃 token（60s 缓存） */
async function loadTeamTokens(mccId: string): Promise<string[]> {
  const key = mccId.replace(/-/g, "");
  const now = Date.now();
  const cached = poolCacheByMcc.get(key);
  if (cached && now - cached.loadedAt < POOL_CACHE_TTL_MS) return cached.tokens;

  const tokens = new Set<string>();
  try {
    // mcc_id → 持有该 MCC 的用户 → 团队（同一物理 MCC 可能挂在多个用户名下，取全部团队的并集）
    const owners = await prisma.google_mcc_accounts.findMany({
      where: { mcc_id: { in: [key, mccId] }, is_deleted: 0, is_active: 1 },
      select: { user_id: true },
    });
    const userIds = [...new Set(owners.map((o) => o.user_id))];
    if (userIds.length > 0) {
      const users = await prisma.users.findMany({
        where: { id: { in: userIds }, is_deleted: 0, team_id: { not: null } },
        select: { team_id: true },
      });
      const teamIds = [...new Set(users.map((u) => u.team_id!))];
      if (teamIds.length > 0) {
        const rows = await prisma.team_developer_tokens.findMany({
          where: { team_id: { in: teamIds }, is_deleted: 0, is_active: 1 },
          select: { token: true },
        });
        for (const r of rows) {
          const t = r.token.trim();
          if (t.length >= MIN_TOKEN_LENGTH) tokens.add(t);
        }
      }
    }
  } catch (e) {
    console.error("[TokenPool] 加载团队 token 池失败（退回 MCC 自带 token）:", e instanceof Error ? e.message : e);
  }

  const list = [...tokens];
  poolCacheByMcc.set(key, { tokens: list, loadedAt: now });
  return list;
}

/** 单次请求的全部候选 token：团队池 + 环境变量全局池 + MCC 自带 token */
async function getCandidates(preferred: string, mccId: string): Promise<string[]> {
  const set = new Set<string>([...(await loadTeamTokens(mccId)), ...envTokens()]);
  if (preferred && preferred.length >= MIN_TOKEN_LENGTH) set.add(preferred);
  const list = [...set];
  return list.length > 0 ? list : (preferred ? [preferred] : []);
}

/**
 * 轮询取一个可用 token。
 * @param preferred 该 MCC 自己配置的 token（池为空时兜底）
 * @param mccId 该请求的 login-customer-id（用于定位团队池）
 * @param exclude 本次请求已试过（刚 429/失效）的 token
 */
export async function pickDeveloperToken(preferred: string, mccId: string, exclude?: Set<string>): Promise<string> {
  const candidates = await getCandidates(preferred, mccId);
  if (candidates.length === 0) return preferred;

  const now = Date.now();
  const available = candidates.filter((t) => (cooldownUntil.get(t) ?? 0) <= now && !exclude?.has(t));
  if (available.length > 0) {
    return available[rr++ % available.length];
  }

  // 全在冷却/已排除：取冷却最早结束的（未被排除者优先），让调用方自行等待
  const base = candidates.filter((t) => !exclude?.has(t));
  const pool = base.length > 0 ? base : candidates;
  let best = pool[0];
  for (const t of pool) {
    if ((cooldownUntil.get(t) ?? 0) < (cooldownUntil.get(best) ?? 0)) best = t;
  }
  return best;
}

/** 是否还有未冷却、未被排除的备用 token（决定 429 后是立即换 token 还是等待） */
export async function hasAlternativeToken(preferred: string, mccId: string, exclude: Set<string>): Promise<boolean> {
  const candidates = await getCandidates(preferred, mccId);
  const now = Date.now();
  return candidates.some((t) => !exclude.has(t) && (cooldownUntil.get(t) ?? 0) <= now);
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

/** 某 token 当前冷却截止时间（未冷却返回 null）；供管理/组长界面展示 */
export function getTokenCooldown(token: string): Date | null {
  const until = cooldownUntil.get(token) ?? 0;
  return until > Date.now() ? new Date(until) : null;
}

/** 池运行状态（供管理端诊断）：按团队列出配置数量 + 全局冷却清单 */
export async function getTokenPoolStatus(): Promise<{
  teams: { team_id: string; team_name: string; tokens: number; active: number }[];
  env_tokens: number;
  cooling: { token: string; until: string }[];
}> {
  const rows = await prisma.team_developer_tokens.findMany({
    where: { is_deleted: 0 },
    select: { team_id: true, token: true, is_active: true },
  });
  const teams = await prisma.teams.findMany({
    where: { is_deleted: 0 },
    select: { id: true, team_name: true },
  });
  const teamName = new Map(teams.map((t) => [t.id.toString(), t.team_name]));

  const byTeam = new Map<string, { tokens: number; active: number }>();
  const allTokens = new Set<string>(envTokens());
  for (const r of rows) {
    const k = r.team_id.toString();
    const slot = byTeam.get(k) || { tokens: 0, active: 0 };
    slot.tokens++;
    if (r.is_active === 1) {
      slot.active++;
      allTokens.add(r.token);
    }
    byTeam.set(k, slot);
  }

  const now = Date.now();
  const cooling = [...allTokens]
    .filter((t) => (cooldownUntil.get(t) ?? 0) > now)
    .map((t) => ({ token: maskToken(t), until: new Date(cooldownUntil.get(t)!).toISOString() }));

  return {
    teams: [...byTeam.entries()].map(([team_id, v]) => ({
      team_id,
      team_name: teamName.get(team_id) || team_id,
      tokens: v.tokens,
      active: v.active,
    })),
    env_tokens: envTokens().length,
    cooling,
  };
}
