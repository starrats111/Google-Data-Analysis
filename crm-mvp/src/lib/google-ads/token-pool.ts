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
 * - 剩余额度优先：每次挑「今日剩余额度（实测额度 detected_quota 优先，否则组长
 *   预设 daily_quota，再减去今日已用）最高」的 token；剩余相同的做 round-robin
 *   分摊 QPS。额度高的 token 天然多吃流量，各 token 大致同时耗尽，池总额度用满。
 * - 某 token 收到 429 → 冷却 3 分钟（或 Google 返回的 retryDelay，取大者），期间跳过
 * - 某 token 报 DEVELOPER_TOKEN_NOT_APPROVED → 冷却 24 小时
 * - 全部候选都在冷却时，返回冷却最早结束的那个（调用方自行决定等待）
 *
 * 用量统计：每次实际发出的 API 请求调用 recordTokenUse()，内存缓冲后批量
 * 落到 token_usage_daily（token + 日期唯一），供组长查看「今日已用/使用人数」。
 *
 * 冷却/轮询状态存于模块内存：生产是 PM2 单进程 Next.js，天然全局。
 *
 * 自动体检（系统自行判断谁能用、额度多少，无需人工标记）：
 * - 每次真实请求的结果都会回流：成功 → health_status=ok + mcc_access[mcc]=ok；
 *   token 失效 → health_status=invalid（踢出轮询，待每日探测复活）；
 *   对某 MCC 无权限 → mcc_access[mcc]=denied（该 MCC 的请求跳过此凭证）；
 *   每日额度触顶 → 用当天实际请求数反推 detected_quota，写回并冷却到太平洋时区次日。
 * - 探测额度：detected_quota（实测）优先于组长手填的 daily_quota；
 *   当日用量 ≥ 实测额度的 token 直接跳过，不再撞墙。
 */
import prisma from "@/lib/prisma";
import {
  isDailyQuotaExhausted,
  isTokenUsableForMcc,
  remainingQuotaOf,
  type TokenQuotaMeta,
} from "@/lib/google-ads/token-pool-logic";

const POOL_CACHE_TTL_MS = 60_000;
const RATE_LIMIT_COOLDOWN_MS = 3 * 60_000;
const INVALID_COOLDOWN_MS = 24 * 3600_000;
// 真实 Developer Token 为 22 位；过滤占位假 token（如 "123456"）
const MIN_TOKEN_LENGTH = 15;
// 成功标记落库的节流间隔（避免每个请求都写库）
const OK_PERSIST_INTERVAL_MS = 5 * 60_000;

export interface TokenCredential {
  token: string;
  /** 与 token 配对的 Service Account JSON；null 表示使用调用方 MCC 自己的 JSON */
  saJson: string | null;
}

/** 池内 token 的自动体检元数据（随凭证列表一起 60s 缓存）；结构见 token-pool-logic */
type TokenMeta = TokenQuotaMeta;

/** mcc_id（Google MCC 客户号）→ 团队凭证对列表缓存 */
const poolCacheByMcc = new Map<string, { creds: TokenCredential[]; loadedAt: number }>();
/** token → 体检元数据（loadTeamCredentials 时一并刷新） */
const tokenMetaCache = new Map<string, TokenMeta>();
const cooldownUntil = new Map<string, number>();
/** 实时学到的「token|mcc 无权限」对（DB 缓存有 60s 延迟，这里立即生效） */
const deniedPairs = new Set<string>();
/** token → 上次成功标记落库时间（节流） */
const lastOkPersist = new Map<string, number>();
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

/** 该 MCC 所属团队组长配置的活跃凭证对（60s 缓存），并同步刷新体检元数据 */
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
          select: {
            token: true, service_account_json: true,
            health_status: true, mcc_access: true, detected_quota: true, daily_quota: true,
            cooldown_until: true,
          },
        });
        // 今日已用（用于「实测额度已耗尽」的预判跳过）
        const usage = rows.length > 0 ? await prisma.token_usage_daily.findMany({
          where: { token: { in: rows.map((r) => r.token.trim()) }, date: cstToday() },
          select: { token: true, requests: true },
        }) : [];
        const usageByToken = new Map(usage.map((u) => [u.token, u.requests]));

        const seen = new Set<string>();
        for (const r of rows) {
          const t = r.token.trim();
          if (t.length < MIN_TOKEN_LENGTH || seen.has(t)) continue;
          seen.add(t);
          creds.push({ token: t, saJson: r.service_account_json?.trim() || null });
          let mccAccess: Record<string, string> = {};
          try { mccAccess = JSON.parse(r.mcc_access || "{}"); } catch {}
          tokenMetaCache.set(t, {
            healthStatus: r.health_status || "unknown",
            mccAccess,
            detectedQuota: r.detected_quota ?? null,
            dailyQuota: r.daily_quota,
            todayRequests: usageByToken.get(t) ?? 0,
          });
          // 冷却回灌：进程重启后内存冷却表清零，从 DB 恢复仍在冷却期的 token，
          // 避免重启后立刻对已限流/额度耗尽的 token 撞墙。内存里已有更晚的截止时间则不覆盖。
          const dbCooldown = r.cooldown_until ? new Date(r.cooldown_until).getTime() : 0;
          if (dbCooldown > now && dbCooldown > (cooldownUntil.get(t) ?? 0)) {
            cooldownUntil.set(t, dbCooldown);
          }
        }
      }
    }
  } catch (e) {
    console.error("[TokenPool] 加载团队 token 池失败（退回 MCC 自带凭证）:", e instanceof Error ? e.message : e);
  }

  poolCacheByMcc.set(key, { creds, loadedAt: now });
  return creds;
}

/**
 * 今日剩余额度：实测额度（触顶反推）优先，否则组长预设，减去今日已用。
 * 非池内凭证（环境变量/员工 MCC 自带）无额度信息，返回 -1 表示最后兜底。
 */
function remainingQuota(token: string): number {
  return remainingQuotaOf(tokenMetaCache.get(token));
}

/** 该凭证对此 MCC 是否可用（自动标记学习结果；unknown 视为可用，让真实流量去探明） */
function isUsableFor(token: string, mccKey: string): boolean {
  return isTokenUsableForMcc(
    tokenMetaCache.get(token),
    deniedPairs.has(`${token}|${mccKey}`),
    mccKey,
  );
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
  const mccKey = mccId.replace(/-/g, "");
  const available = candidates.filter((c) =>
    (cooldownUntil.get(c.token) ?? 0) <= now
    && !exclude?.has(c.token)
    && isUsableFor(c.token, mccKey),
  );
  if (available.length > 0) {
    // 剩余额度最高者优先；剩余相同的（如每天开局）round-robin 分摊 QPS
    const maxRemaining = Math.max(...available.map((c) => remainingQuota(c.token)));
    const top = available.filter((c) => remainingQuota(c.token) === maxRemaining);
    return top[rr++ % top.length];
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
  const mccKey = mccId.replace(/-/g, "");
  return candidates.some((c) =>
    !exclude.has(c.token) && (cooldownUntil.get(c.token) ?? 0) <= now && isUsableFor(c.token, mccKey),
  );
}

/** 团队池中是否存在带配对 JSON 的可用凭证（用于放宽「MCC 未配置服务账号」的硬拦截） */
export async function poolHasCredentialFor(mccId: string): Promise<boolean> {
  const creds = await loadTeamCredentials(mccId);
  return creds.some((c) => !!c.saJson);
}

// ─────────────────────── 自动标记（真实流量回流 → 持久化） ───────────────────────

/** 把标记写回 team_developer_tokens（同一 token 可能被多个组配置，全部更新）；失败仅打日志 */
function persistMark(token: string, data: Record<string, unknown>): void {
  void prisma.team_developer_tokens.updateMany({
    where: { token, is_deleted: 0 },
    data,
  }).catch((e) => console.error("[TokenPool] 标记落库失败:", e instanceof Error ? e.message : e));
}

/** 合并写 mcc_access JSON（读-改-写；并发丢失个别标记可接受，下次流量会再学到） */
async function persistMccAccess(token: string, mccKey: string, status: "ok" | "denied"): Promise<void> {
  try {
    const rows = await prisma.team_developer_tokens.findMany({
      where: { token, is_deleted: 0 },
      select: { id: true, mcc_access: true },
    });
    for (const r of rows) {
      let acc: Record<string, string> = {};
      try { acc = JSON.parse(r.mcc_access || "{}"); } catch {}
      if (acc[mccKey] === status) continue;
      acc[mccKey] = status;
      await prisma.team_developer_tokens.update({
        where: { id: r.id },
        data: { mcc_access: JSON.stringify(acc) },
      });
    }
  } catch (e) {
    console.error("[TokenPool] mcc_access 落库失败:", e instanceof Error ? e.message : e);
  }
}

/** 距太平洋时区（Google 配额重置口径）下一个午夜的毫秒数 */
function msUntilPacificMidnight(): number {
  const now = new Date();
  const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const secsToday = pacific.getHours() * 3600 + pacific.getMinutes() * 60 + pacific.getSeconds();
  return Math.max(60_000, (24 * 3600 - secsToday) * 1000);
}

/** 上报某 token 请求成功：更新 ok 标记 + 该 MCC 可用（5 分钟节流落库） */
export function reportTokenOk(token: string, mccId: string): void {
  const mccKey = mccId.replace(/-/g, "");
  deniedPairs.delete(`${token}|${mccKey}`);
  const meta = tokenMetaCache.get(token);
  if (!meta) return; // 非池内 token（环境变量/MCC 自带）无落库对象
  const now = Date.now();
  const needMccMark = meta.mccAccess[mccKey] !== "ok";
  const throttled = now - (lastOkPersist.get(token) ?? 0) < OK_PERSIST_INTERVAL_MS;
  if (!needMccMark && throttled) return;
  lastOkPersist.set(token, now);
  meta.mccAccess[mccKey] = "ok";
  meta.healthStatus = "ok";
  persistMark(token, { health_status: "ok", health_note: null, last_ok_at: new Date() });
  if (needMccMark) void persistMccAccess(token, mccKey, "ok");
}

/**
 * 上报某 token 触发 429。
 * - QPS 类（RESOURCE_TEMPORARILY_EXHAUSTED / retryDelay 短）：冷却几分钟
 * - 每日额度耗尽（RESOURCE_EXHAUSTED 长冷却）：用当天实际请求数反推真实额度写回
 *   detected_quota，并冷却到太平洋时区次日（Google 配额重置点）
 */
export function reportTokenRateLimited(token: string, retryDelaySec?: number, errBody?: string): void {
  if (isDailyQuotaExhausted(retryDelaySec, errBody)) {
    const ms = msUntilPacificMidnight();
    const until = new Date(Date.now() + ms);
    cooldownUntil.set(token, until.getTime());
    const meta = tokenMetaCache.get(token);
    if (meta) {
      // 今日实际打出的请求数 ≈ 该 token 的真实每日额度（取历史探测值的较大者，防止低估）
      const observed = Math.max(meta.todayRequests, meta.detectedQuota ?? 0);
      meta.detectedQuota = observed > 0 ? observed : meta.detectedQuota;
      meta.healthStatus = "limited";
      persistMark(token, {
        health_status: "limited",
        health_note: `每日额度耗尽（实测约 ${observed.toLocaleString()} 次/天），太平洋时区次日自动恢复`,
        last_error_at: new Date(),
        cooldown_until: until,
        ...(observed > 0 ? { detected_quota: observed, quota_detected_at: new Date() } : {}),
      });
      console.warn(`[TokenPool] token ${maskToken(token)} 每日额度耗尽，实测额度≈${observed}，冷却至太平洋次日（${Math.round(ms / 60000)} 分钟后）`);
      return;
    }
    persistMark(token, { cooldown_until: until });
    console.warn(`[TokenPool] token ${maskToken(token)} 每日额度耗尽，冷却至太平洋次日`);
    return;
  }

  const ms = Math.max(RATE_LIMIT_COOLDOWN_MS, (retryDelaySec ?? 0) * 1000);
  const until = new Date(Date.now() + ms);
  cooldownUntil.set(token, until.getTime());
  // 短冷却也落库：429 频率低，写库开销可忽略；重启后回灌避免立刻撞墙
  persistMark(token, { cooldown_until: until });
  console.warn(`[TokenPool] token ${maskToken(token)} 触发限流，冷却 ${Math.round(ms / 1000)}s`);
}

/** 上报某 token 不可用（未获批/被禁）：冷却 24 小时 + 持久化失效标记（每日探测自动复检） */
export function reportTokenInvalid(token: string, note?: string): void {
  const until = new Date(Date.now() + INVALID_COOLDOWN_MS);
  cooldownUntil.set(token, until.getTime());
  const meta = tokenMetaCache.get(token);
  if (meta) meta.healthStatus = "invalid";
  persistMark(token, {
    health_status: "invalid",
    health_note: note || "Developer Token 未获批准或已被禁用",
    last_error_at: new Date(),
    cooldown_until: until,
  });
  console.warn(`[TokenPool] token ${maskToken(token)} 不可用（未获批/被禁），已标记 invalid，24h 内不再使用`);
}

/** 上报某凭证对指定 MCC 无权限（SA 未被加入该 MCC 等）：该 MCC 的后续请求跳过此凭证 */
export function reportTokenDeniedForMcc(token: string, mccId: string): void {
  const mccKey = mccId.replace(/-/g, "");
  deniedPairs.add(`${token}|${mccKey}`);
  const meta = tokenMetaCache.get(token);
  if (meta) meta.mccAccess[mccKey] = "denied";
  void persistMccAccess(token, mccKey, "denied");
  console.warn(`[TokenPool] 凭证 ${maskToken(token)} 对 MCC ${mccKey} 无权限，已标记跳过`);
}

/** 某 token 当前冷却截止时间（未冷却返回 null）；供管理/组长界面展示 */
export function getTokenCooldown(token: string): Date | null {
  const until = cooldownUntil.get(token) ?? 0;
  return until > Date.now() ? new Date(until) : null;
}

/** 探测确认 token 恢复可用后，清掉内存冷却、体检缓存与实时 denied 标记（下次加载重读 DB 最新标记） */
export function clearTokenCooldown(token: string): void {
  cooldownUntil.delete(token);
  tokenMetaCache.delete(token);
  for (const pair of deniedPairs) {
    if (pair.startsWith(`${token}|`)) deniedPairs.delete(pair);
  }
  poolCacheByMcc.clear();
  // 同步清掉 DB 冷却标记，避免下次加载又被回灌
  persistMark(token, { cooldown_until: null });
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

/** 配额审计维度（批次5）：日+token+MCC+CID+kind 聚合到 google_ads_api_usage */
type AuditKind = "query" | "mutate";
/** key = token|mcc|cid|kind */
const auditBuffer = new Map<string, { requests: number; rateLimited: number }>();

function bumpAudit(token: string, mccId: string, customerId: string | undefined, kind: AuditKind, field: "requests" | "rateLimited"): void {
  const key = `${token}|${mccId.replace(/-/g, "")}|${(customerId ?? "").replace(/-/g, "")}|${kind}`;
  const slot = auditBuffer.get(key) || { requests: 0, rateLimited: 0 };
  slot[field]++;
  auditBuffer.set(key, slot);
}

/**
 * 记录一次经某 token 发出的 API 请求（缓冲，异步落库，绝不阻塞主流程）。
 * customerId/kind 供配额审计账本定位「配额被谁烧掉的」（批次5）。
 */
export function recordTokenUse(token: string, mccId: string, customerId?: string, kind: AuditKind = "query"): void {
  const slot = usageBuffer.get(token) || { count: 0, mccs: new Set<string>() };
  slot.count++;
  slot.mccs.add(mccId.replace(/-/g, ""));
  usageBuffer.set(token, slot);
  bumpAudit(token, mccId, customerId, kind, "requests");

  // 同步累加体检缓存中的今日用量，让「实测额度触顶预判」在缓存窗口内也准确
  const meta = tokenMetaCache.get(token);
  if (meta) meta.todayRequests++;

  const total = [...usageBuffer.values()].reduce((s, v) => s + v.count, 0);
  if (total >= FLUSH_COUNT_THRESHOLD || Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS) {
    void flushUsage();
  }
}

/** 记录一次 429（随下次 flushUsage 一起落库；用于审计「谁打爆的配额」） */
export function recordTokenRateLimitHit(token: string, mccId: string, customerId?: string, kind: AuditKind = "query"): void {
  bumpAudit(token, mccId, customerId, kind, "rateLimited");
}

async function flushUsage(): Promise<void> {
  if (flushing || (usageBuffer.size === 0 && auditBuffer.size === 0)) return;
  flushing = true;
  const snapshot = new Map(usageBuffer);
  usageBuffer.clear();
  const auditSnapshot = new Map(auditBuffer);
  auditBuffer.clear();
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
    // 配额审计账本（批次5）：按 日+token+MCC+CID+kind upsert 累加
    for (const [key, { requests, rateLimited }] of auditSnapshot) {
      const [token, mcc_id, customer_id, kind] = key.split("|");
      await prisma.google_ads_api_usage.upsert({
        where: { date_token_mcc_id_customer_id_kind: { date, token, mcc_id, customer_id, kind } },
        update: { requests: { increment: requests }, rate_limited: { increment: rateLimited } },
        create: { date, token, mcc_id, customer_id, kind, requests, rate_limited: rateLimited },
      });
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
