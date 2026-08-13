/**
 * @fileoverview ad-create `extract_brand_keywords` 阶段的纯 DI 编排器
 * (spec §9 lines 580-731)。
 *
 * 把以下四块功能拼装成单一入口：
 *  1. 7 天 `(domain, country, prompt_hash)` 缓存 (cache-full / cache-half / miss)。
 *  2. DataForSEO Labs Ranked Keywords Live 拉取 Top 5。
 *  3. LLM 品牌词抽取（带 `brandTokenHint`）。
 *  4. 每日 `brand_assessment_cost_ledger` 预算门控与扣账。
 *
 * **纯 DI 模块**：不直接 import `prisma` / `fetch` / `node:crypto` / `dotenv` /
 * 任何 LLM 客户端；`computePromptHash` 也由调用方注入，便于测试时使用确定的
 * 短 hash。
 *
 * **唯一导出函数**：{@link runExtractBrandKeywordsStage}。内部 helper
 * `finalize` / `fallback` / `normalizeDomainBase` 刻意不导出，避免外部
 * 调用方误用造成形状漂移。
 *
 * 8 条返回路径详见 spec §11.1，全部由
 * `tests/ad-create/extract-brand-keywords.test.ts` 覆盖。
 */

import { normalizeDomain } from "@/lib/rival-intel/ad-create/competitor-source";
import type {
  BrandKeywordExtractionRecord,
  BrandKeywordExtractionSource,
} from "@/lib/rival-intel/ad-create/types";
import type { AiBrandExtraction } from "@/lib/rival-intel/ad-create/brand-keyword-ai";
import type {
  CachedExtraction,
  CachedTopKeyword,
  GetCachedExtractionArgs,
  SetCachedExtractionArgs,
} from "@/lib/rival-intel/ad-create/brand-keyword-cache";
import type {
  FetchRankedKeywordsArgs,
  FetchRankedKeywordsResult,
  RankedKeyword,
} from "@/lib/rival-intel/ad-create/dataforseo-client";
import type { countryCodeToDataForSeoParams } from "@/lib/rival-intel/ad-create/dataforseo-country-params";

export type { AiBrandExtraction } from "@/lib/rival-intel/ad-create/brand-keyword-ai";

/**
 * DataForSEO 单次调用的预估成本（USD），用于预算门控（spec §9 line 643）。
 * 当 `cfg.dailyBrandBudgetUsd != null` 时，若 `today_used + 0.08 > cap` 则
 * 立刻走 `budget_exceeded_fallback`，不发起 DataForSEO 请求、不扣 ledger。
 */
const ESTIMATED_COST_USD = 0.08;

/**
 * 编排器需要的运行时配置。生产环境由 `route.ts` 的 `loadConfig` 从
 * `ai_model_configs` 取值后注入；测试可直接构造。
 *
 * - `dataforseoLogin` / `dataforseoPassword` 为 `null` 时走凭证缺失 fallback。
 * - `dailyBrandBudgetUsd` 为 `null` 表示不开预算门控。
 */
export interface ExtractBrandKeywordsConfig {
  dataforseoLogin: string | null;
  dataforseoPassword: string | null;
  brandKeywordExtractPrompt: string;
  dailyBrandBudgetUsd: number | null;
}

/**
 * 编排器的依赖注入接口。生产装配在 `route.ts` 完成；单测全部用 fake。
 *
 * - `loadConfig`: 读 admin 配置（DataForSEO 凭证 / 预算上限 / LLM 参数 / Prompt 模板）。
 * - `getTodayTotalUsd`: 读今天该 team 的 DataForSEO 累计开销（不含今次）。
 * - `addCostLedger`: 写今次 DataForSEO 开销到 `brand_assessment_cost_ledger`。
 * - `getCache` / `setCache`: 7 天缓存读写。
 * - `fetchRankedKeywords`: DataForSEO Labs Ranked Keywords Live 调用。
 * - `extractByAi`: LLM 品牌词抽取。
 * - `countryToParams`: ISO-2 → `{ locationCode, languageCode }` 映射。
 * - `computePromptHash`: prompt 模板 → 64 字符 hex；测试常注入固定值以验证缓存 key。
 * - `now`: 当前时间；统一从 deps 取，便于测试时间相关分支。
 */
export interface RunExtractBrandKeywordsStageDeps {
  loadConfig: () => Promise<ExtractBrandKeywordsConfig>;
  getTodayTotalUsd: (params: { now: Date }) => Promise<number>;
  addCostLedger: (params: { ledgerDate: Date; amountUsd: number }) => Promise<void>;
  getCache: (args: GetCachedExtractionArgs) => Promise<CachedExtraction | null>;
  setCache: (args: SetCachedExtractionArgs) => Promise<void>;
  fetchRankedKeywords: (
    args: FetchRankedKeywordsArgs,
  ) => Promise<FetchRankedKeywordsResult>;
  extractByAi: (args: {
    domain: string;
    country: string;
    topKeywords: RankedKeyword[];
    brandTokenHint: string | null;
    prompt: string;
  }) => Promise<AiBrandExtraction>;
  countryToParams: typeof countryCodeToDataForSeoParams;
  computePromptHash: (prompt: string) => string;
  now: () => Date;
}

/**
 * 编排器入参。`draft` 只取本阶段需要的三个字段，`source_payload` 类型为
 * `unknown`（实际由 Phase A 写入 {@link BrandKeywordExtractionRecord} 或更宽
 * 的结构），编排器只读取其中的 `brandToken`。
 */
export interface RunExtractBrandKeywordsStageInput {
  draft: {
    domain: string;
    country_code: string | null;
    source_payload: unknown;
  };
}

/**
 * 编排器返回值。
 *
 * - `coreBrandKeywords`: 落到 draft `core_brand_keywords` 列的数组；
 *   happy path 来自 `aiResult.brandKeywords`，fallback 来自
 *   `brandToken ?? normalizeDomainBase(domain)` 单元素数组。
 * - `brandKeywordExtraction`: 完整溯源记录，落到 draft `source_payload`
 *   的 `brand_keyword_extraction` 字段。
 */
export interface ExtractBrandKeywordsResult {
  coreBrandKeywords: string[];
  brandKeywordExtraction: BrandKeywordExtractionRecord;
}

/**
 * 把 domain 缩成「裸品牌词」用作最终 fallback（spec §9 line 730）。
 *
 * 实现：按 `.` 切分取首段，trim + 转小写。例如：
 *  - `nvidia.com` → `nvidia`
 *  - `acme.co.uk` → `acme`
 *  - `WWW.example.com`（理论不会传入，因为编排器先走 `normalizeDomain`）→ `example`
 *
 * **空值守卫**：若 domain 为空 / 仅 `.` / 仅空白，首段会清洗成空串；此时
 * 返回硬编码占位符 `"brand"` 而**不是** `""`。`coreBrandKeywords` 是下游
 * Google Ads keyword 序列化的输入，空字符串会破坏序列化（被忽略或抛错），
 * 因此 fallback 链宁可输出 `["brand"]` 这种无害占位也不能输出 `[""]`。
 */
function normalizeDomainBase(domain: string): string {
  const base = domain.split(".")[0]?.toLowerCase().trim() ?? "";
  return base || "brand";
}

/**
 * 由 source 推断 fallback 链最终落到的 coreBrandKeywords。
 *
 * - `dataforseo+ai`: 永远不走这里（由 finalize 用 aiResult.brandKeywords）。
 * - 其它所有 source: `brandToken ? [brandToken] : [normalizeDomainBase(domain)]`。
 */
function fallbackBrandKeywords(
  brandToken: string | null,
  domain: string,
): string[] {
  if (brandToken && brandToken.trim()) {
    return [brandToken];
  }
  return [normalizeDomainBase(domain)];
}

interface FinalizeArgs {
  source: BrandKeywordExtractionSource;
  topKeywords: CachedTopKeyword[];
  aiResult: AiBrandExtraction;
  cacheHit: boolean;
  fetchedAt: Date;
}

/**
 * happy path（含 cache full-hit）的结果构造器。
 *
 * `coreBrandKeywords` 直接取 `aiResult.brandKeywords`；`source` 只在
 * `dataforseo+ai` 时才会经过这里。`fallbackReason` 固定 null。
 */
function finalize(args: FinalizeArgs): ExtractBrandKeywordsResult {
  return {
    coreBrandKeywords: args.aiResult.brandKeywords,
    brandKeywordExtraction: {
      source: args.source,
      topKeywords: args.topKeywords,
      aiResult: args.aiResult,
      fallbackReason: null,
      fetchedAt: args.fetchedAt.toISOString(),
      cacheHit: args.cacheHit,
    },
  };
}

interface FallbackArgs {
  source: BrandKeywordExtractionSource;
  reason: string;
  domain: string;
  brandToken: string | null;
  fetchedAt: Date;
  /**
   * 仅在 spec §9 line 707 的「DataForSEO 成功 + AI has_brand=false」分支
   * 透出已经成功拿到的 topKeywords / aiResult，便于审计；其它 fallback 分支
   * 留空（默认 `[]` / `null`）。
   */
  topKeywords?: CachedTopKeyword[];
  aiResult?: AiBrandExtraction | null;
}

/**
 * 所有 fallback / 错误路径的统一结果构造器。
 *
 * `coreBrandKeywords` 走 `brandToken ?? normalizeDomainBase(domain)` 链；
 * `cacheHit` 固定 false（fallback 不走完整缓存命中分支）。
 *
 * **Spec §3.1 / §9 line 731 — source 自动降级**：
 *  - 调用方对「DFS empty / DFS throw / AI throw / AI hasBrand=false」四条
 *    一般 fallback 路径统一传 `"brand_token_fallback"` 作为意图；
 *  - 当 `brandToken` 为 null / 空字符串 / 仅空白时，本 helper 自动把 source
 *    降级为 `"domain_fallback"`，与 §11.4 监控口径一致——能区分
 *    「有品牌词回落」与「连品牌词都没有，只能用 domain 兜底」两种风险等级。
 *  - 特殊「失败原因」型 source（`credentials_missing_fallback` /
 *    `budget_exceeded_fallback`）**不参与降级**，原样透出：它们表征的是
 *    上游凭证 / 预算问题，与 brandToken 是否存在无关，监控/告警必须能
 *    单独识别。
 */
function fallback(args: FallbackArgs): ExtractBrandKeywordsResult {
  const hasUsableBrandToken = Boolean(
    args.brandToken && args.brandToken.trim(),
  );
  const effectiveSource: BrandKeywordExtractionSource =
    args.source === "brand_token_fallback" && !hasUsableBrandToken
      ? "domain_fallback"
      : args.source;
  return {
    coreBrandKeywords: fallbackBrandKeywords(args.brandToken, args.domain),
    brandKeywordExtraction: {
      source: effectiveSource,
      topKeywords: args.topKeywords ?? [],
      aiResult: args.aiResult ?? null,
      fallbackReason: args.reason,
      fetchedAt: args.fetchedAt.toISOString(),
      cacheHit: false,
    },
  };
}

/**
 * 执行 `extract_brand_keywords` 阶段（spec §9）。
 *
 * 决策树（每一步在自身分支内 short-circuit）：
 *  1. 7 天缓存完全命中（含 `aiExtraction`）→ {@link finalize} `dataforseo+ai` + `cacheHit=true`。
 *  2. DataForSEO 凭证缺失 → {@link fallback} `credentials_missing_fallback`。
 *  3. 预算门控不通过 → {@link fallback} `budget_exceeded_fallback`（无 ledger 写入）。
 *  4. 半命中（topKeywords 有但 ai=null）跳过 DataForSEO；否则调一次 DFS，
 *     `items` 为空时 ledger 仍要扣 DFS 成本，然后 fallback `brand_token_fallback`；
 *     DFS 抛错时 fallback `brand_token_fallback`（不写缓存、不扣 ledger）。
 *  5. AI 抛错 → 写半命中缓存（`aiExtraction: null`），`dfsCost > 0` 时扣 ledger，
 *     然后 fallback `brand_token_fallback`。
 *  6. AI 成功 → 写完整缓存，`dfsCost > 0` 时扣 ledger。
 *  7. `hasBrand=false || brandKeywords=[]` → fallback `brand_token_fallback`
 *     （透传 topKeywords / aiResult 便于审计）；否则 finalize `dataforseo+ai`。
 *
 * 注：上述步骤 4 / 5 / 7 的 `brand_token_fallback` 在 `brandToken` 为
 * null / 空 / 仅空白时会由 {@link fallback} 自动降级为 `domain_fallback`
 * （spec §3.1 / §9 line 731）；`credentials_missing_fallback` /
 * `budget_exceeded_fallback` 不参与降级。
 *
 * 行为约束：
 *  - 不直接 I/O；所有副作用通过 `deps` 触发。
 *  - 不打 console 日志（由 `route.ts` 在调用前后记录）。
 *  - `fetchedAt` 始终是 ISO 8601 字符串。
 *
 * @param input draft（仅取 domain / country_code / source_payload）。
 * @param deps 见 {@link RunExtractBrandKeywordsStageDeps}。
 * @returns {@link ExtractBrandKeywordsResult}：核心品牌词 + 完整溯源记录。
 */
export async function runExtractBrandKeywordsStage(
  input: RunExtractBrandKeywordsStageInput,
  deps: RunExtractBrandKeywordsStageDeps,
): Promise<ExtractBrandKeywordsResult> {
  const domain = normalizeDomain(input.draft.domain);
  const country = (input.draft.country_code || "US").toUpperCase();
  const brandToken =
    (input.draft.source_payload as { brandToken?: unknown } | null | undefined)
      ?.brandToken;
  const brandTokenStr = typeof brandToken === "string" ? brandToken : null;

  const cfg = await deps.loadConfig();
  const promptHash = deps.computePromptHash(cfg.brandKeywordExtractPrompt);
  const now = deps.now();

  const cached = await deps.getCache({ domain, country, promptHash, now });
  if (cached && cached.aiExtraction) {
    return finalize({
      source: "dataforseo+ai",
      topKeywords: cached.topKeywords,
      aiResult: cached.aiExtraction,
      cacheHit: true,
      fetchedAt: now,
    });
  }

  if (!cfg.dataforseoLogin || !cfg.dataforseoPassword) {
    return fallback({
      source: "credentials_missing_fallback",
      reason: "credentials_missing",
      domain,
      brandToken: brandTokenStr,
      fetchedAt: now,
    });
  }

  if (cfg.dailyBrandBudgetUsd != null) {
    const used = await deps.getTodayTotalUsd({ now });
    if (used + ESTIMATED_COST_USD > cfg.dailyBrandBudgetUsd) {
      return fallback({
        source: "budget_exceeded_fallback",
        reason: `budget_exceeded: today=$${used} + est=$${ESTIMATED_COST_USD} > cap=$${cfg.dailyBrandBudgetUsd}`,
        domain,
        brandToken: brandTokenStr,
        fetchedAt: now,
      });
    }
  }

  let topKeywords: CachedTopKeyword[] | null = cached?.topKeywords ?? null;
  let dfsCost = 0;
  if (!topKeywords) {
    try {
      const { locationCode, languageCode } = deps.countryToParams(country);
      const res = await deps.fetchRankedKeywords({
        target: domain,
        locationCode,
        languageCode,
        limit: 5,
        credentials: {
          login: cfg.dataforseoLogin,
          password: cfg.dataforseoPassword,
        },
      });
      topKeywords = res.items;
      dfsCost = res.costUsd;
      if (topKeywords.length === 0) {
        await deps.addCostLedger({
          ledgerDate: now,
          amountUsd: dfsCost,
        });
        return fallback({
          source: "brand_token_fallback",
          reason: "dataforseo: empty result",
          domain,
          brandToken: brandTokenStr,
          fetchedAt: now,
        });
      }
    } catch (e) {
      return fallback({
        source: "brand_token_fallback",
        reason: `dataforseo: ${e instanceof Error ? e.message : String(e)}`,
        domain,
        brandToken: brandTokenStr,
        fetchedAt: now,
      });
    }
  }

  let aiResult: AiBrandExtraction;
  try {
    aiResult = await deps.extractByAi({
      domain,
      country,
      topKeywords,
      brandTokenHint: brandTokenStr,
      prompt: cfg.brandKeywordExtractPrompt,
    });
  } catch (e) {
    await deps.setCache({
      domain,
      country,
      promptHash,
      topKeywords,
      aiExtraction: null,
      costUsd: dfsCost,
      now,
    });
    if (dfsCost > 0) {
      await deps.addCostLedger({
        ledgerDate: now,
        amountUsd: dfsCost,
      });
    }
    return fallback({
      source: "brand_token_fallback",
      reason: `ai: ${e instanceof Error ? e.message : String(e)}`,
      domain,
      brandToken: brandTokenStr,
      fetchedAt: now,
    });
  }

  await deps.setCache({
    domain,
    country,
    promptHash,
    topKeywords,
    aiExtraction: aiResult,
    costUsd: dfsCost,
    now,
  });
  if (dfsCost > 0) {
    await deps.addCostLedger({
      ledgerDate: now,
      amountUsd: dfsCost,
    });
  }

  if (!aiResult.hasBrand || aiResult.brandKeywords.length === 0) {
    return fallback({
      source: "brand_token_fallback",
      reason: "ai: has_brand=false",
      domain,
      brandToken: brandTokenStr,
      fetchedAt: now,
      topKeywords,
      aiResult,
    });
  }

  return finalize({
    source: "dataforseo+ai",
    topKeywords,
    aiResult,
    cacheHit: false,
    fetchedAt: now,
  });
}
