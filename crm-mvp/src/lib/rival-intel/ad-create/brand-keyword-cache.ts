/**
 * @fileoverview 品牌核心词缓存层（spec §7）。
 *
 * 持久化 DataForSEO + AI 抽取结果，按 `(domain, country, prompt_hash)` 唯一索引
 * 查询命中（索引由 Task 1 的迁移建立）。TTL 在应用层（7 天）通过 `expires_at`
 * 判断；DB 不做自动过期。每次 `setCachedExtraction` 都会刷新 `expires_at`。
 *
 * 当 `aiExtraction === null` 时为「半命中」——表示 DataForSEO 成功而 AI 抽取
 * 失败，orchestrator 仍可拿到 `topKeywords` 走 brand-token-fallback，不必再扣
 * DataForSEO 预算。`computePromptHash` 使用模板字符串（非渲染后）的 sha256，
 * 因此 prompt 模板任何修改都会自动让旧缓存失效。
 */

import { createHash } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

const CACHE_TTL_MS = 7 * 86400 * 1000;

/**
 * 把 Prisma `Decimal`（或字符串 / 数字）安全转为 JS `number`。
 *
 * MariaDB adapter 把 `Decimal` 列读出来时可能是 `Decimal` 对象、字符串或数字，
 * 这里统一收口：对象走 `toString()` 再 `Number`，null/undefined 兜底为 0。
 *
 * 内部 helper，不导出。
 */
function decimalToNumber(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "object") {
    return Number((raw as { toString(): string }).toString());
  }
  return Number(raw);
}

/**
 * 缓存中的单条 DataForSEO Top 关键词。
 */
export type CachedTopKeyword = {
  keyword: string;
  etv: number;
  searchVolume: number;
  rank: number;
};

/**
 * 缓存中的 AI 品牌词抽取结果（与 `brand-keyword-ai` 的归一化输出形状对齐）。
 */
export type CachedAiExtraction = {
  brandKeywords: string[];
  hasBrand: boolean;
  reasoning: string;
};

/**
 * `getCachedExtraction` 的返回结构。
 *
 * - `aiExtraction === null` 表示该次缓存是「半命中」：DataForSEO 成功但 AI 失败。
 * - `costUsd` 已转换为普通 number（DB 列为 Decimal）。
 */
export interface CachedExtraction {
  topKeywords: CachedTopKeyword[];
  aiExtraction: CachedAiExtraction | null;
  costUsd: number;
  /** Orchestrator can use this to log "缓存命中，N 分钟前抓取" or expose freshness in UI. */
  fetchedAt: Date;
}

/**
 * `getCachedExtraction` 入参。
 *
 * - `now` 由调用方注入，便于在测试中模拟时间。
 */
export interface GetCachedExtractionArgs {
  domain: string;
  country: string;
  promptHash: string;
  now: Date;
}

/**
 * `setCachedExtraction` 入参。
 *
 * - `aiExtraction === null` 表示半命中写入。
 * - `now` 由调用方注入；`expires_at` 计算为 `now + 7d`。
 */
export interface SetCachedExtractionArgs {
  domain: string;
  country: string;
  promptHash: string;
  topKeywords: CachedTopKeyword[];
  aiExtraction: CachedAiExtraction | null;
  costUsd: number;
  now: Date;
}

/**
 * 计算 prompt 模板字符串的 sha256 hex（小写、64 字符）。
 *
 * 用于缓存的 `prompt_hash` 字段；hash 的是模板本身（含占位符），不是渲染后的
 * 字符串，这样同一模板对不同 domain 的请求可以复用缓存，模板一旦修改则所有
 * 旧缓存自动失效。
 *
 * @param prompt - prompt 模板字符串。
 * @returns sha256 hex（小写，固定 64 字符）。
 */
export function computePromptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

/**
 * 按 `(domain, country, prompt_hash)` 唯一键读取未过期缓存。
 *
 * `expires_at > now` 的过滤条件由 app 层负责；命中后把 Prisma 的 `JsonValue`
 * 视为已写入的 `CachedTopKeyword[]` / `CachedAiExtraction` 形状返回，
 * `cost_usd`（Decimal）走 `decimalToNumber` 转为普通 number。
 *
 * Trust boundary: the returned topKeywords / aiExtraction shape is trusted to
 * match the writer's contract. We do NOT zod-validate the Json columns on read.
 * If a row was hand-edited via SQL, malformed shape will silently propagate to
 * orchestrator. Caller should defensively handle malformed data downstream.
 *
 * @returns 未命中或已过期时返回 `null`。
 */
export async function getCachedExtraction(
  args: GetCachedExtractionArgs,
): Promise<CachedExtraction | null> {
  const { domain, country, promptHash, now } = args;
  const row = await prisma.dataforseo_brand_keyword_cache.findFirst({
    where: {
      domain,
      country,
      prompt_hash: promptHash,
      expires_at: { gt: now },
    },
  });
  if (!row) return null;
  return {
    topKeywords: row.top_keywords as unknown as CachedTopKeyword[],
    aiExtraction: row.ai_extraction as unknown as CachedAiExtraction | null,
    costUsd: decimalToNumber(row.cost_usd),
    fetchedAt: row.fetched_at,
  };
}

/**
 * Upsert cache row by (domain, country, prompt_hash) composite unique key.
 * Refreshes expires_at on every set. Atomic on MariaDB adapter — Prisma compiles
 * to INSERT … ON DUPLICATE KEY UPDATE single statement, so concurrent calls on
 * the same key are race-safe; if you ever switch to a non-native-upsert backend,
 * re-evaluate this assumption.
 *
 * - 不存在则插入，存在则覆盖；任一路径都会把 `expires_at` 刷新为 `now + 7d`。
 * - `aiExtraction === null` 表示半命中写入（DataForSEO OK / AI 失败），用
 *   `Prisma.DbNull` 写入 SQL NULL（而非 JSON 字面量 `'null'`），与 schema
 *   `Json?` 的可空语义一致，`ai_extraction IS NULL` 的 SQL 抽查也能命中。
 */
export async function setCachedExtraction(
  args: SetCachedExtractionArgs,
): Promise<void> {
  const { domain, country, promptHash, topKeywords, aiExtraction, costUsd, now } = args;
  const expiresAt = new Date(now.getTime() + CACHE_TTL_MS);
  const aiExtractionInput =
    aiExtraction === null
      ? Prisma.DbNull
      : (aiExtraction as unknown as Prisma.InputJsonValue);
  const topKeywordsInput = topKeywords as unknown as Prisma.InputJsonValue;
  await prisma.dataforseo_brand_keyword_cache.upsert({
    where: {
      domain_country_prompt_hash: { domain, country, prompt_hash: promptHash },
    },
    create: {
      domain,
      country,
      prompt_hash: promptHash,
      top_keywords: topKeywordsInput,
      ai_extraction: aiExtractionInput,
      cost_usd: costUsd,
      fetched_at: now,
      expires_at: expiresAt,
    },
    update: {
      top_keywords: topKeywordsInput,
      ai_extraction: aiExtractionInput,
      cost_usd: costUsd,
      fetched_at: now,
      expires_at: expiresAt,
    },
  });
}
