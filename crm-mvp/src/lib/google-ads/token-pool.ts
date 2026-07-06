/**
 * Developer Token 池轮询（按团队隔离，组长配置，token 与 Service Account JSON 配对）
 *
 * 背景：Google Ads API 的配额（QPS + 每日操作数）按 Developer Token 计。
 * 组长在「团队设置 → Token 池」维护本组的凭证对（Developer Token + 配对的
 * Service Account JSON），所有 API 请求在池内轮询，配额互相分摊；
 * 员工 MCC 里的 token/JSON 降级为兜底，不再要求员工配置。
 *
 * 单次请求的候选凭证对：
 * 1. 该 MCC 所属团队的池内活跃凭证对（team_developer_tokens，按团队隔离）
 * 2. 环境变量 GOOGLE_ADS_TOKEN_POOL（逗号分隔，管理员全局补充；无配对 JSON，
 *    使用时回落到该 MCC 自己的 service_account_json）
 * 3. 该 MCC 自己配置的 token + JSON（兜底；组长未配池时行为与旧版完全一致）
 *
 * 轮询策略：
 * - 请求级 round-robin，各 token 均摊流量
 * - 某 token 收到 429 → 冷却 3 分钟（或 Google 返回的 retryDelay，取大者），期间跳过
 * - 某 token 报 DEVELOPER_TOKEN_NOT_APPROVED → 冷却 24 小时
 * - 全部候选都在冷却时，返回冷却最早结束的那个（调用方自行决定等待）
 *
 * 用量统计：每次实际发出的 API 请求调用 recordTokenUse()，内存缓冲后批量
 * 落到 token_usage_daily（token + 日期唯一），供组长查看「今日已用/使用人数」。
 *
 * 冷却/轮询状态存于模块内存：生产是 PM2 单进程 Next.js，天然全局。
 */
import prisma from "@/lib/prisma";

const POOL_CACHE_TTL_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 3 * 60_000;
const INVALID_COOLDOWN_MS = 24 * 3600_000;
// 真实 Developer Token 为 22 位；过滤占位假 token（如 "123456"）
const MIN_TOKEN_LENGTH = 15;

export interface TokenCredential {
  token: string;
  /** 与 token 配对的 Service Account JSON；null 表示使用调用方 MCC 自己的 JSON */
  saJson: string | null;
}

/** mcc_id（Google MCC 客户号）→ 团队凭证对列表缓存 */
const poolCacheByMcc = new Map<string, { creds: TokenCredential[]; loadedAt: number }>();
const cooldownUntil = new Map<string, number>();
let rr = 0;

/** 日志用：只露 token 末 6 位 */
export function maskToken(token: string): string {
  return token.length <= 6 ? token : `…${token.slice(-6)}`;
}

function envCredentials(): TokenCredential[] {
  const out: TokenCredential[] = [];
  for (const raw of (process.env.GOOGLE_ADS_TOKEN_POOL || "").split(",")) {
    const t = raw.trim();
    if (t.length >= MIN_TOKEN_LENGTH) out.push({ token: t, saJson: null });
  }
  return out;
}

/** 该 MCC 所属团队组长配置的活跃凭证对（60s 缓存） */
async function loadTeamCredentials(mccId: string): Promise<TokenCredential[]> {
  const key = mccId.replace(/-/g, "");
  const now = Date.now();
  const cached = poolCacheByMcc.get(key);
  if (cached && now - cached.loadedAt < POOL_CACHE_TTL_MS) return cached.creds;

  const creds: TokenCredential[] = [];
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
          select: { token: true, service_account_json: true },
        });
        const seen = new Set<string>();
        for (const r of rows) {
          const t = r.token.trim();
          if (t.length < MIN_TOKEN_LENGTH || seen.has(t)) continue;
          seen.add(t);
          creds.push({ token: t, saJson: r.service_account_json?.trim() || null });
        }
      }
    }
  } catch (e) {
    console.error("[TokenPool] 加载团队 token 池失败（退回 MCC 自带凭证）:", e instanceof Error ? e.message : e);
  }

  poolCacheByMcc.set(key, { creds, loadedAt: now });
  return creds;
}

/** 单次请求的全部候选凭证对：团队池 + 环境变量全局池 + MCC 自带凭证 */
async function getCandidates(preferred: TokenCredential | null, mccId: string): Promise<TokenCredential[]> {
  const list: TokenCredential[] = [];
  const seen = new Set<string>();
  for (const c of [...(await loadTeamCredentials(mccId)), ...envCredentials()]) {
    if (!seen.has(c.token)) { seen.add(c.token); list.push(c); }
  }
  if (preferred && preferred.token.length >= MIN_TOKEN_LENGTH && !seen.has(preferred.token)) {
    list.push(preferred);
  }
  return list;
}

/**
 * 轮询取一个可用凭证对。
 * @param preferred 该 MCC 自己配置的 token+JSON（池为空时兜底）
 * @param mccId 该请求的 login-customer-id（用于定位团队池）
 * @param exclude 本次请求已试过（刚 429/失效）的 token
 */
export async function pickCredential(
  preferred: TokenCredential | null,
  mccId: string,
  exclude?: Set<string>,
): Promise<TokenCredential | null> {
  const candidates = await getCandidates(preferred, mccId);
  if (candidates.length === 0) return preferred;

  const now = Date.now();
  const available = candidates.filter((c) => (cooldownUntil.get(c.token) ?? 0) <= now && !exclude?.has(c.token));
  if (available.length > 0) {
    return available[rr++ % available.length];
  }

  // 全在冷却/已排除：取冷却最早结束的（未被排除者优先），让调用方自行决定等待
  const base = candidates.filter((c) => !exclude?.has(c.token));
  const pool = base.length > 0 ? base : candidates;
  let best = pool[0];
  for (const c of pool) {
    if ((cooldownUntil.get(c.token) ?? 0) < (cooldownUntil.get(best.token) ?? 0)) best = c;
  }
  return best;
}

/** 是否还有未冷却、未被排除的备用凭证（决定 429 后是立即换 token 还是等待） */
export async function hasAlternativeToken(
  preferred: TokenCredential | null,
  mccId: string,
  exclude: Set<string>,
): Promise<boolean> {
  const candidates = await getCandidates(preferred, mccId);
  const now = Date.now();
  return candidates.some((c) => !exclude.has(c.token) && (cooldownUntil.get(c.token) ?? 0) <= now);
}

/** 团队池中是否存在带配对 JSON 的可用凭证（用于放宽「MCC 未配置服务账号」的硬拦截） */
export async function poolHasCredentialFor(mccId: string): Promise<boolean> {
  const creds = await loadTeamCredentials(mccId);
  return creds.some((c) => !!c.saJson);
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

// ─────────────────────── 用量统计（内存缓冲 → token_usage_daily） ───────────────────────

const usageBuffer = new Map<string, { count: number; mccs: Set<string> }>();
let lastFlushAt = Date.now();
let flushing = false;
const FLUSH_INTERVAL_MS = 15_000;
const FLUSH_COUNT_THRESHOLD = 50;

/** 当日日期（东八区口径，与业务统计一致） */
function cstToday(): Date {
  const cst = new Date(Date.now() + 8 * 3600_000);
  return new Date(`${cst.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

/** 记录一次经某 token 发出的 API 请求（缓冲，异步落库，绝不阻塞主流程） */
export function recordTokenUse(token: string, mccId: string): void {
  const slot = usageBuffer.get(token) || { count: 0, mccs: new Set<string>() };
  slot.count++;
  slot.mccs.add(mccId.replace(/-/g, ""));
  usageBuffer.set(token, slot);

  const total = [...usageBuffer.values()].reduce((s, v) => s + v.count, 0);
  if (total >= FLUSH_COUNT_THRESHOLD || Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS) {
    void flushUsage();
  }
}

async function flushUsage(): Promise<void> {
  if (flushing || usageBuffer.size === 0) return;
  flushing = true;
  const snapshot = new Map(usageBuffer);
  usageBuffer.clear();
  lastFlushAt = Date.now();

  try {
    const date = cstToday();
    for (const [token, { count, mccs }] of snapshot) {
      const existing = await prisma.token_usage_daily.findUnique({
        where: { token_date: { token, date } },
        select: { id: true, mcc_ids: true },
      });
      if (existing) {
        let merged: string[] = [];
        try { merged = JSON.parse(existing.mcc_ids || "[]"); } catch {}
        const set = new Set([...merged, ...mccs]);
        await prisma.token_usage_daily.update({
          where: { id: existing.id },
          data: { requests: { increment: count }, mcc_ids: JSON.stringify([...set]) },
        });
      } else {
        await prisma.token_usage_daily.create({
          data: { token, date, requests: count, mcc_ids: JSON.stringify([...mccs]) },
        });
      }
    }
  } catch (e) {
    console.error("[TokenPool] 用量落库失败（丢弃本批计数不影响业务）:", e instanceof Error ? e.message : e);
  } finally {
    flushing = false;
  }
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
  const allTokens = new Set<string>(envCredentials().map((c) => c.token));
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
    env_tokens: envCredentials().length,
    cooling,
  };
}
