/**
 * 品牌评估的 DB 访问层。
 *
 * D-233 移植改动：
 *   - 表名 kyads 的 camelCase model（brandAssessmentJob…）→ CRM 的 snake_case
 *     （brand_assessment_jobs…）；CRM 的 Prisma schema 一律用表名当 model 名。
 *   - 隔离维度 team_id → user_id。**但结果表不带 user_id**：品牌评估要付 SerpApi 的钱，
 *     同一 (域名, 国家) 全公司共享一份，别人买过就直接用，只留
 *     first_requested_by_user_id 做审计。
 *   - 成本账本 team_id+日 → 日+provider 全公司一本账（brand_intel_cost_ledger），
 *     SerpApi / DataForSEO / LLM 共用，每日上限读 system_configs。
 *   - Boolean 字段（force_refresh）→ MariaDB TinyInt，写入用 0/1。
 *
 * 所有函数仍接受可选的 client 参数，允许测试传 mock。
 */

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { prisma as defaultPrisma } from "@/lib/prisma";
import { getSystemConfig } from "@/lib/system-config";

// ---------------------------------------------------------------------------
// PrismaLike: 只用到的几张表 / 操作
// ---------------------------------------------------------------------------

export type PrismaLike = Pick<
  PrismaClient,
  | "brand_assessment_jobs"
  | "brand_assessment_results"
  | "brand_intel_cost_ledger"
  | "$executeRawUnsafe"
>;

function p(client?: PrismaLike): PrismaLike {
  return client ?? (defaultPrisma as unknown as PrismaLike);
}

// ---------------------------------------------------------------------------
// 预算配置
// ---------------------------------------------------------------------------

/** 品牌评估 + DataForSEO 的每日花费上限（USD）。未配置视作不设限。 */
export const BRAND_INTEL_DAILY_BUDGET_KEY = "brand_intel_daily_budget_usd";

/** 评估 prompt 的管理台覆盖键。未配置时用代码里的 v3 默认 prompt。 */
export const BRAND_ASSESSMENT_PROMPT_KEY = "brand_assessment_prompt";

export async function readDailyBudgetUsd(): Promise<number> {
  const raw = await getSystemConfig(BRAND_INTEL_DAILY_BUDGET_KEY).catch(() => null);
  const parsed = Number((raw ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * kyads 把评估 prompt 存在库里（管理台可编辑），代码里另有一份 v3 默认值。
 * CRM 沿用这个两层结构：system_configs 有值就用它，没有就用默认——这样上线不需要
 * 先去后台粘 prompt，07 想调措辞时也不用改代码重新部署。
 */
export async function readBrandAssessmentPrompt(): Promise<string> {
  const override = await getSystemConfig(BRAND_ASSESSMENT_PROMPT_KEY).catch(() => null);
  if (override && override.trim().length > 0) return override;
  const { DEFAULT_BRAND_ASSESSMENT_PROMPT } = await import("./default-prompt");
  return DEFAULT_BRAND_ASSESSMENT_PROMPT;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export interface CreateJobInput {
  userId: bigint | number;
  domain: string;
  countries: string[];
  forceRefresh: boolean;
  estimatedCostUsd: number;
}

export async function createJob(input: CreateJobInput, client?: PrismaLike) {
  return p(client).brand_assessment_jobs.create({
    data: {
      user_id: typeof input.userId === "bigint" ? input.userId : BigInt(input.userId),
      domain: input.domain,
      countries: input.countries as unknown as Prisma.InputJsonValue,
      force_refresh: input.forceRefresh ? 1 : 0,
      estimated_cost_usd: input.estimatedCostUsd,
      actual_cost_usd: 0,
      status: "pending",
    },
  });
}

export async function getJobById(id: bigint, client?: PrismaLike) {
  return p(client).brand_assessment_jobs.findFirst({
    where: { id, is_deleted: 0 },
  });
}

/**
 * 评估历史全公司可见（立项 Q10：付费资源共享）。不按 user_id 过滤，
 * 列表展示所有员工发起过的评估。
 */
export async function listRecentJobs(limit: number, client?: PrismaLike) {
  return p(client).brand_assessment_jobs.findMany({
    where: { is_deleted: 0 },
    orderBy: { created_at: "desc" },
    take: Math.max(1, Math.min(100, limit)),
  });
}

/**
 * 用 findFirst 选候选 + 原子 `UPDATE ... WHERE id=? AND status='pending'` 抢占 pending job。
 *
 * 相比 Prisma `updateMany`，这里直接走 `$executeRawUnsafe` 拿 affectedRows，
 * 避免 Prisma 内部可能的二次查询/缓存把并发语义搞糊。MariaDB InnoDB 的 row lock
 * 保证两个并发 UPDATE 只有一个 affectedRows=1。
 */
export async function claimPendingJob(
  now: Date,
  client?: PrismaLike,
): Promise<{ id: bigint } | null> {
  const db = p(client);
  const candidate = await db.brand_assessment_jobs.findFirst({
    where: { status: "pending", is_deleted: 0 },
    orderBy: { created_at: "asc" },
    select: { id: true },
  });
  if (!candidate) return null;
  const startedAtSql = now.toISOString().slice(0, 19).replace("T", " ");
  const affected = await db.$executeRawUnsafe(
    `UPDATE brand_assessment_jobs
       SET status = 'running', started_at = ?
     WHERE id = ? AND status = 'pending'`,
    startedAtSql,
    candidate.id,
  );
  return affected === 1 ? { id: candidate.id } : null;
}

export async function markJobFinished(
  jobId: bigint,
  patch: {
    status: "ok" | "partial" | "failed" | "cost_aborted";
    errorMessage?: string | null;
    actualCostUsd?: number;
    finishedAt?: Date;
  },
  client?: PrismaLike,
) {
  return p(client).brand_assessment_jobs.update({
    where: { id: jobId },
    data: {
      status: patch.status,
      error_message: patch.errorMessage ?? null,
      actual_cost_usd: patch.actualCostUsd,
      finished_at: patch.finishedAt ?? new Date(),
    },
  });
}

// ---------------------------------------------------------------------------
// Results（TTL + (域名, 国家) 唯一，全公司共享）
// ---------------------------------------------------------------------------

export interface UpsertResultInput {
  /** 首次请求该 (域名, 国家) 的员工，仅审计用；已有行不覆盖 */
  userId?: bigint | null;
  jobId: bigint;
  domain: string;
  country: string;
  brandToken: string | null;
  countrySnapshot: unknown;
  brandLevel: unknown;
  brandOwnAds: unknown;
  nonBrandAds: unknown;
  trends: unknown;
  transparency: unknown;
  autocompleteVariants: unknown;
  engineStatus: unknown;
  llmOutput: unknown;
  warnings: unknown;
  source: "fresh" | "cache_hit";
  serpapiCostUsd: number;
  llmCostUsd: number;
  ttlExpiresAt: Date;
}

export async function upsertResult(input: UpsertResultInput, client?: PrismaLike) {
  const shared = {
    job_id: input.jobId,
    domain: input.domain,
    country: input.country,
    brand_token: input.brandToken,
    country_snapshot: input.countrySnapshot as Prisma.InputJsonValue,
    brand_level: input.brandLevel as Prisma.InputJsonValue,
    brand_own_ads: input.brandOwnAds as Prisma.InputJsonValue,
    non_brand_ads: input.nonBrandAds as Prisma.InputJsonValue,
    trends: input.trends as Prisma.InputJsonValue,
    transparency: input.transparency as Prisma.InputJsonValue,
    autocomplete_variants: input.autocompleteVariants as Prisma.InputJsonValue,
    engine_status: input.engineStatus as Prisma.InputJsonValue,
    llm_output: input.llmOutput as Prisma.InputJsonValue,
    warnings: input.warnings as Prisma.InputJsonValue,
    source: input.source,
    serpapi_cost_usd: input.serpapiCostUsd,
    llm_cost_usd: input.llmCostUsd,
    ttl_expires_at: input.ttlExpiresAt,
    is_deleted: 0,
  };
  return p(client).brand_assessment_results.upsert({
    where: {
      domain_country: {
        domain: input.domain,
        country: input.country,
      },
    },
    // first_requested_by_user_id 只在建行时写，刷新不动——它记的是「谁最早花钱买了这份数据」
    create: { ...shared, first_requested_by_user_id: input.userId ?? null },
    update: shared,
  });
}

/**
 * 命中策略：`(域名, 国家)` 全公司共享。任一员工评估过的域名都算命中，TTL 内直接复用。
 */
/**
 * 某次评估任务产出的各国结果。任务是「一个域名 × 多个国家」，结果按国家一行。
 * 命中缓存的国家也会记一行（source='cache_hit'），所以这里拿到的就是任务的完整视图。
 */
export async function listResultsByJob(jobId: bigint, client?: PrismaLike) {
  return p(client).brand_assessment_results.findMany({
    where: { job_id: jobId, is_deleted: 0 },
    orderBy: { country: "asc" },
  });
}

export async function getCachedResult(
  params: { domain: string; country: string; now: Date },
  client?: PrismaLike,
) {
  return p(client).brand_assessment_results.findFirst({
    where: {
      domain: params.domain,
      country: params.country,
      is_deleted: 0,
      ttl_expires_at: { gt: params.now },
    },
  });
}

// ---------------------------------------------------------------------------
// Cost ledger（全公司一本账，按天 × provider）
// ---------------------------------------------------------------------------

export type CostProvider = "serpapi" | "dataforseo" | "llm" | "all";

export async function addCostLedger(
  params: { ledgerDate: Date; amountUsd: number; provider?: CostProvider },
  client?: PrismaLike,
) {
  const date = startOfUtcDay(params.ledgerDate);
  const provider = params.provider ?? "all";
  return p(client).brand_intel_cost_ledger.upsert({
    where: {
      ledger_date_provider: { ledger_date: date, provider },
    },
    create: {
      ledger_date: date,
      provider,
      total_cost_usd: params.amountUsd,
      call_count: 1,
    },
    update: {
      total_cost_usd: { increment: params.amountUsd },
      call_count: { increment: 1 },
    },
  });
}

/** 当天全部 provider 的累计花费，用于每日预算门控 */
export async function getTodayTotalUsd(
  params: { now: Date },
  client?: PrismaLike,
): Promise<number> {
  const date = startOfUtcDay(params.now);
  const rows = await p(client).brand_intel_cost_ledger.findMany({
    where: { ledger_date: date },
    select: { total_cost_usd: true },
  });
  return rows.reduce((sum, row) => sum + Number(row.total_cost_usd), 0);
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
