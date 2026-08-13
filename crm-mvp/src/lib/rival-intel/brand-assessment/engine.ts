/**
 * Engine: 单个 (domain, country) 的一次完整评估。
 *
 * 编排顺序（spec §6.5）：
 *   1) 命中 7 天缓存 → 直接返回 cache_hit（不再调 SerpApi / LLM）
 *   2) 读引擎配置（SerpApi key 池 / 评估 prompt / 每日预算）
 *   3) 当日成本预检查（SerpApi 预估 + 当日 ledger）→ 溢出直接 cost_aborted
 *   4) SerpApi: serp + trends + transparency + autocomplete（失败降级）
 *   5) derive 四件套 + compact payload
 *   6) LLM 评估（失败降级：result 仍落库 status=partial 或 failed）
 *   7) 写 BrandAssessmentResult（含 engine_status / warnings / 成本）
 *   8) ledger 累加实际成本
 *
 * 所有外部依赖（SerpApi / LLM / DB）通过 DI 传入，便于单元测试。
 */

import { countryToParams } from "./country-params";
import { extractBrandName } from "./brand-extract";
import {
  compactForLlm,
  deriveBrandLevel,
  deriveCountrySnapshot,
} from "./derive";
import {
  evaluateWithLlm,
  type LlmCaller,
} from "./llm-evaluator";
import {
  fetchAutocomplete,
  fetchSerp,
  fetchTransparency,
  fetchTrends,
  SerpApiAuthError,
  type HttpGet,
} from "./serpapi-client";
import type {
  BrandAssessmentEngineInput,
  BrandAssessmentEngineOutput,
  EngineState,
  EngineStatus,
} from "./types";

// ---------------------------------------------------------------------------
// Deps (all injectable)
// ---------------------------------------------------------------------------

/**
 * D-233：kyads 这里读的是它自己 `ai_model_configs` 一行里的 6 个字段
 * （SerpApi key、评估 prompt、每日预算、AI baseUrl/key/model）。CRM 侧：
 *   - SerpApi key 走多 key 共享池
 *   - AI 凭据由 ai-service 按场景从管理台取，引擎不该碰
 *   - 预算存 system_configs
 * 所以配置契约收窄成三项，AI 凭据整组去掉。
 */
export interface EngineRepo {
  readEngineConfig: () => Promise<{
    serpapiKey: string | null;
    brandAssessmentPrompt: string | null;
    dailyBudgetUsd: number;
  } | null>;
  getCachedResult: (params: {
    domain: string;
    country: string;
    now: Date;
  }) => Promise<{ id: bigint; llm_output: unknown; engine_status: unknown; warnings: unknown; serpapi_cost_usd: unknown; llm_cost_usd: unknown } | null>;
  upsertResult: (input: Parameters<typeof import("./repository").upsertResult>[0]) => Promise<{ id: bigint }>;
  addCostLedger: (params: { ledgerDate: Date; amountUsd: number }) => Promise<unknown>;
  getTodayTotalUsd: (params: { now: Date }) => Promise<number>;
}

export interface EngineDeps {
  httpGet: HttpGet;
  llmCaller: LlmCaller;
  repo: EngineRepo;
  now?: () => Date;
  ttlMs?: number; // default 7 days
  dailyBudgetOverrideUsd?: number; // for tests
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/**
 * 预估 SerpApi 单国开销：3 付费引擎（serp + trends + transparency）× 0.015 + autocomplete 0。
 */
export const SERPAPI_ESTIMATED_COST_PER_COUNTRY_USD = 0.045;

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export async function runBrandAssessmentJob(
  input: BrandAssessmentEngineInput,
  deps: EngineDeps,
): Promise<BrandAssessmentEngineOutput> {
  const now = deps.now ? deps.now() : new Date();
  const ttlMs = deps.ttlMs ?? 7 * 24 * 3600 * 1000;

  // (1) cache lookup
  // Only serve a cache hit when the prior run was fully successful
  // (serp=ok AND llm=ok). Partial/failed rows are kept for diagnostics but
  // must NOT short-circuit a re-run, otherwise a single transient LLM
  // timeout gets frozen as "ok cached result" for 7 days.
  if (!input.forceRefresh) {
    const cached = await deps.repo.getCachedResult({
      domain: input.domain,
      country: input.country,
      now,
    });
    const cachedEngineStatus = (cached?.engine_status ?? null) as
      | EngineStatus
      | null;
    const cachedWasFullySuccessful =
      cachedEngineStatus?.serp === "ok" && cachedEngineStatus?.llm === "ok";
    if (cached && cachedWasFullySuccessful) {
      return {
        status: "ok",
        source: "cache_hit",
        engineStatus: cachedEngineStatus ?? {
          serp: "skipped",
          trends: "skipped",
          transparency: "skipped",
          autocomplete: "skipped",
          llm: "skipped",
        },
        resultId: cached.id,
        llmOutput: (cached.llm_output as BrandAssessmentEngineOutput["llmOutput"]) ?? null,
        warnings: Array.isArray(cached.warnings)
          ? (cached.warnings as string[])
          : [],
        serpapiCostUsd: Number(cached.serpapi_cost_usd ?? 0),
        llmCostUsd: Number(cached.llm_cost_usd ?? 0),
      };
    }
  }

  // (2) config
  const cfg = await deps.repo.readEngineConfig();
  if (!cfg || !cfg.serpapiKey || !cfg.brandAssessmentPrompt) {
    return failedEarly("SerpApi key or brand assessment prompt not configured", now);
  }

  // (3) budget guard —— 全公司一本账
  const budget = deps.dailyBudgetOverrideUsd ?? cfg.dailyBudgetUsd;
  const usedToday = await deps.repo.getTodayTotalUsd({ now });
  if (
    Number.isFinite(budget) &&
    usedToday + SERPAPI_ESTIMATED_COST_PER_COUNTRY_USD > budget
  ) {
    return {
      status: "cost_aborted",
      source: "fresh",
      engineStatus: allSkipped(),
      resultId: null,
      llmOutput: null,
      warnings: [
        `daily budget would be exceeded: used=${usedToday} + est=${SERPAPI_ESTIMATED_COST_PER_COUNTRY_USD} > cap=${budget}`,
      ],
      serpapiCostUsd: 0,
      llmCostUsd: 0,
      errorMessage: "daily cost cap exceeded",
    };
  }

  // (4) SerpApi calls
  const cp = countryToParams(input.country);
  const brandToken = extractBrandName(input.domain);
  if (!brandToken) {
    return failedEarly(`unable to extract brand token from "${input.domain}"`, now);
  }
  const seeds = [brandToken, `${brandToken} `];
  const engineStatus: EngineStatus = {
    serp: "skipped",
    trends: "skipped",
    transparency: "skipped",
    autocomplete: "skipped",
    llm: "skipped",
  };
  const warnings: string[] = [];
  let serpCost = 0;

  let serpData: unknown = null;
  try {
    const res = await fetchSerp({
      q: brandToken,
      countryParams: cp,
      apiKey: cfg.serpapiKey,
      deps: { httpGet: deps.httpGet },
    });
    serpCost += res.costUsd;
    if (res.status === "ok") {
      engineStatus.serp = "ok";
      serpData = res.data;
    } else {
      engineStatus.serp = "failed";
      warnings.push(`serp failed: ${res.error}`);
    }
  } catch (e) {
    if (e instanceof SerpApiAuthError) {
      await creditLedger(deps, now, serpCost);
      return failedEarly("serpapi auth error: key invalid or expired", now, {
        ...engineStatus,
        serp: "failed",
      });
    }
    engineStatus.serp = "failed";
    warnings.push(`serp exception: ${(e as Error).message}`);
  }

  let trendsData: unknown = null;
  try {
    const res = await fetchTrends({
      brand: brandToken,
      countryParams: cp,
      apiKey: cfg.serpapiKey,
      deps: { httpGet: deps.httpGet },
    });
    serpCost += res.costUsd;
    if (res.status === "ok") {
      engineStatus.trends = "ok";
      trendsData = res.data;
    } else {
      engineStatus.trends = "failed";
      warnings.push(`trends failed: ${res.error}`);
    }
  } catch (e) {
    engineStatus.trends = "failed";
    warnings.push(`trends exception: ${(e as Error).message}`);
  }

  let transparencyData: unknown = null;
  try {
    const res = await fetchTransparency({
      domain: input.domain,
      apiKey: cfg.serpapiKey,
      deps: { httpGet: deps.httpGet },
    });
    serpCost += res.costUsd;
    if (res.status === "ok") {
      engineStatus.transparency = "ok";
      transparencyData = res.data;
    } else {
      engineStatus.transparency = "failed";
      warnings.push(`transparency failed: ${res.error}`);
    }
  } catch (e) {
    engineStatus.transparency = "failed";
    warnings.push(`transparency exception: ${(e as Error).message}`);
  }

  let autocomplete: Array<{ seed: string; suggestion: string }> = [];
  try {
    const res = await fetchAutocomplete({
      brand: brandToken,
      seeds,
      countryParams: cp,
      deps: { httpGet: deps.httpGet },
    });
    if (res.status === "ok") engineStatus.autocomplete = "ok";
    else if (res.status === "partial") {
      engineStatus.autocomplete = "insufficient";
      warnings.push("autocomplete partial");
    } else {
      engineStatus.autocomplete = "failed";
      warnings.push("autocomplete all seeds failed");
    }
    autocomplete = res.suggestions;
  } catch (e) {
    engineStatus.autocomplete = "failed";
    warnings.push(`autocomplete exception: ${(e as Error).message}`);
  }

  // (5) derive
  const { serp_snapshot, brand_own_ads, non_brand_ads } = deriveCountrySnapshot(
    serpData,
    input.domain,
  );
  const brandLevel = deriveBrandLevel(trendsData, transparencyData);

  // (5b) Refine engine_status based on derived signal completeness.
  //
  // Spec §特殊情况：SerpApi HTTP 200 + 空 body 不等于 ok：
  //   - Trends timeline_data 为空且无 region 数据 → "insufficient"
  //   - Transparency 0 creatives → "empty"（确认零投放，不是请求失败）
  //
  // 旧实现把 HTTP 200 直接当 ok，让 LLM 误以为有真实数据，给出过乐观评分
  // （observed: phase-eight.com + US，trends 全空仍判 country_fit=5）。
  if (engineStatus.trends === "ok") {
    const t = (brandLevel as { trends: { interest_score_0_100?: number; interest_by_region_top5?: unknown[] } | null }).trends;
    const score = t?.interest_score_0_100 ?? 0;
    const regionCount = Array.isArray(t?.interest_by_region_top5)
      ? t!.interest_by_region_top5!.length
      : 0;
    if (score === 0 && regionCount === 0) {
      engineStatus.trends = "insufficient";
      warnings.push("trends 200 but empty timeline and region");
    }
  }
  if (engineStatus.transparency === "ok") {
    const tp = (brandLevel as { transparency: { brand_ads_history_days?: number; platforms?: unknown[] } | null }).transparency;
    const historyDays = tp?.brand_ads_history_days ?? 0;
    const platformCount = Array.isArray(tp?.platforms) ? tp!.platforms!.length : 0;
    if (historyDays === 0 && platformCount === 0) {
      engineStatus.transparency = "empty";
      warnings.push("transparency 200 but no creatives");
    }
  }

  const userPayload = compactForLlm({
    domain: input.domain,
    country: input.country,
    brandToken,
    countrySnapshot: serp_snapshot,
    brandOwnAds: brand_own_ads,
    nonBrandAds: non_brand_ads,
    brandLevel,
    autocompleteVariants: autocomplete,
    engineStatus: engineStatus as unknown as Record<string, string>,
  });

  // (6) LLM: skip if no serp at all
  let llmOutput: BrandAssessmentEngineOutput["llmOutput"] = null;
  let llmCost = 0;
  let overallStatus: BrandAssessmentEngineOutput["status"] = "ok";

  if (engineStatus.serp !== "ok") {
    engineStatus.llm = "skipped";
    warnings.push("llm skipped: serp not ok");
    overallStatus = "partial";
  } else {
    const r = await evaluateWithLlm({
      systemPrompt: cfg.brandAssessmentPrompt,
      userPayload,
      caller: deps.llmCaller,
    });
    llmCost = r.costUsd;
    if (r.status === "ok") {
      engineStatus.llm = "ok";
      llmOutput = r.output;
      for (const w of r.warnings) warnings.push(`llm: ${w}`);
    } else {
      engineStatus.llm = "failed";
      warnings.push(`llm failed: ${r.errorMessage ?? "unknown"}`);
      // When the upstream returns a body but it fails validation/parse
      // (e.g. model emitted markdown instead of JSON, or wrapped JSON in
      // ```json fences), the cryptic JSON.parse position error alone isn't
      // enough to diagnose. Persist a short raw preview so diag-scripts
      // can point at the real root cause without re-running the job.
      if (r.raw && r.raw.length > 0) {
        const preview = r.raw.slice(0, 200).replace(/\s+/g, " ");
        warnings.push(
          `llm raw preview (len=${r.raw.length}): ${preview}${r.raw.length > 200 ? "…" : ""}`,
        );
      }
      overallStatus = "partial";
    }
  }

  // Mark partial if any engine failed
  if (
    (["serp", "trends", "transparency", "autocomplete", "llm"] as const).some(
      (k) => engineStatus[k] === "failed",
    ) &&
    overallStatus === "ok"
  ) {
    overallStatus = "partial";
  }

  // (7) persist result
  const ttlExpiresAt = new Date(now.getTime() + ttlMs);
  let resultId: bigint | null = null;
  try {
    const row = await deps.repo.upsertResult({
      userId: input.userId ?? null,
      jobId: input.jobId ?? BigInt(0),
      domain: input.domain,
      country: input.country,
      brandToken,
      countrySnapshot: serp_snapshot,
      brandLevel,
      brandOwnAds: brand_own_ads,
      nonBrandAds: non_brand_ads,
      trends: (brandLevel as { trends: unknown }).trends,
      transparency: (brandLevel as { transparency: unknown }).transparency,
      autocompleteVariants: autocomplete,
      engineStatus,
      llmOutput,
      warnings,
      source: "fresh",
      serpapiCostUsd: serpCost,
      llmCostUsd: llmCost,
      ttlExpiresAt,
    });
    resultId = row.id;
  } catch (e) {
    warnings.push(`db upsert failed: ${(e as Error).message}`);
    overallStatus = "failed";
  }

  // (8) ledger
  await creditLedger(deps, now, serpCost + llmCost);

  return {
    status: overallStatus,
    source: "fresh",
    engineStatus,
    resultId,
    llmOutput,
    warnings,
    serpapiCostUsd: serpCost,
    llmCostUsd: llmCost,
  };
}

async function creditLedger(deps: EngineDeps, now: Date, amountUsd: number) {
  if (amountUsd <= 0) return;
  try {
    await deps.repo.addCostLedger({
      ledgerDate: now,
      amountUsd,
    });
  } catch {
    // ledger 失败不影响主流程
  }
}

function allSkipped(): EngineStatus {
  const s: EngineState = "skipped";
  return { serp: s, trends: s, transparency: s, autocomplete: s, llm: s };
}

function failedEarly(
  message: string,
  _now: Date,
  status?: EngineStatus,
): BrandAssessmentEngineOutput {
  return {
    status: "failed",
    source: "fresh",
    engineStatus: status ?? allSkipped(),
    resultId: null,
    llmOutput: null,
    warnings: [message],
    serpapiCostUsd: 0,
    llmCostUsd: 0,
    errorMessage: message,
  };
}
