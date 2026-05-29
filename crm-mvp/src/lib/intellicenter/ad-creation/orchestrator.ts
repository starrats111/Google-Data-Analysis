/**
 * C-112 / D-046.C — 8 步 AI 广告创建智能闭环（核心编排器）
 *
 * 设计目标：完全替换 generate-extensions/route.ts 现有 generateCore 逻辑。
 * 员工无感知，调用入口同一个 POST /api/user/ad-creation/generate-extensions，
 * 但背后流程从"6 路并行调 AI"升级为"8 步串行智能链路"。
 *
 * 执行流程：
 *   Step 1 reachability       — finalUrl 可达性闸门（X3=B 警告但允许）
 *   Step 2 crawler-bridge     — 实时爬商家（缓存 7 天复用）
 *   Step 3 profile-generator  — gpt-5-nano 生成 12 字段画像（X2 / X7）
 *   Step 4 policy-preflight   — 政策避障闸门（X8 同类型 ≥3 次阻断）
 *   Step 5 keyword-intel      — 5 源融合 + 三因子 match type（X4=C）
 *   Step 6 evidence-prompt    — RAG 证据约束 prompt + AI 文案生成
 *   Step 7 similarity-scorer  — cosine ≥ 0.7 阈值（X5=B），低分返工最多 2 轮
 *   Step 8 compliance-linter  — D-039 H3 兜底，剔除 critical 违规
 *
 * 整体失败策略：任何一步异常都会被捕获并降级到下一步，绝不抛错阻断员工流程。
 * 仅 Step 4 政策阻断会硬阻断（07 X4=阻断 + X3 仅警告）。
 */

import { callAiWithFallback } from "@/lib/ai-service";
import { extractJsonFromAi, smartTruncate } from "@/lib/crawl-pipeline";
import type { CrawlCache } from "@/lib/crawl-pipeline";
import type { IndustryProfile } from "@/lib/industry-profile";
import type { MerchantIntelligenceProfile } from "@/lib/intellicenter/merchant-profile/types";

import { checkReachability, type ReachabilityResult } from "./reachability";
import { ensureCrawlCache } from "./crawler-bridge";
import {
  generateMerchantProfile,
  type ProfileGenerationResult,
} from "./profile-generator";
import { policyPreflight, type PreflightResult } from "./policy-preflight";
import {
  runKeywordIntelligence,
  type KeywordCandidate,
  type KeywordWithMatchType,
} from "./keyword-intelligence";
import { buildEvidencePrompt, type EvidenceContext } from "./evidence-prompt";
import {
  buildRetryHintForLowSimilarity,
  scoreBatch,
  type BatchSimilarityResult,
} from "./similarity-scorer";
import { lintRewriteAndBackfill, type LinterReport } from "./compliance-linter";

const AI_SCENE = "ad_creation_intelligent";

export type OrchestratorTaskKind =
  | "headlines"
  | "descriptions"
  | "sitelinks"
  | "callouts"
  | "snippets"
  | "promotion";

export interface OrchestratorTask {
  kind: OrchestratorTaskKind;
  count: number;
  maxLen: number;
  minLen?: number;
}

export interface OrchestratorContext {
  merchantId: bigint;
  campaignId: bigint;
  merchantName: string;
  merchantUrl: string;
  finalUrl: string;
  targetCountry: string;
  languageName: string;
  /** 已有的 ad_creatives.crawl_cache，Step 2 缓存判断会用到 */
  existingCrawlCache?: CrawlCache | null;
  /** Step 5 候选关键词原始多源输入 */
  candidateKeywords: KeywordCandidate[];
  /** campaigns.daily_budget USD（已归一化） */
  dailyBudgetUsd: number;
  /** campaigns.max_cpc USD（已归一化） */
  maxCpcUsd: number;
  /** 要生成的任务清单 */
  tasks: OrchestratorTask[];
  /** SSE 事件回调（前端实时进度） */
  emitSSE?: (type: string, payload: unknown) => void;
  /** 行业资料（compliance-linter 用） */
  industryProfile?: IndustryProfile | null;
  /** 是否强制重生画像（员工点"重新生成"传 true） */
  forceProfileRefresh?: boolean;
  /** 强制 puppeteer 爬虫（promotion 需求） */
  forcePuppeteerCrawl?: boolean;
}

export interface OrchestratorResult {
  approved: boolean;
  blockingReasons: string[];
  warnings: string[];

  /** Step 1 */
  reachability: ReachabilityResult;
  /** Step 2 */
  crawlSummary: {
    cacheHit: boolean;
    elapsedMs: number;
    qualityScore: number;
    pageTextLength: number;
  };
  /** Step 3 */
  profile: MerchantIntelligenceProfile;
  profileGeneration: Omit<ProfileGenerationResult, "profile">;
  /** Step 4 */
  preflight: PreflightResult;
  /** Step 5 */
  keywords: KeywordWithMatchType[];
  keywordNotes: string[];

  /** Step 6+7+8 输出 */
  headlines: string[];
  descriptions: string[];
  sitelinks: Array<{ title: string; desc1?: string; desc2?: string; url_path?: string | null }>;
  callouts: string[];
  snippets: Array<{ header: string; values: string[] }>;
  promotion: {
    item: string;
    promotion_details: string;
    type: string;
    value: number;
    currency: string;
  } | null;

  /** Step 7 各任务最终相似度（诊断用） */
  similarity: {
    headlines?: BatchSimilarityResult;
    descriptions?: BatchSimilarityResult;
  };
  /** Step 8 lint 报告 */
  linter: LinterReport | null;

  /** 单步耗时（毫秒） */
  timings: Record<string, number>;
  /** 单步 AI 调用次数 */
  aiCalls: Record<string, number>;
}

export async function runIntelligentAdCreation(
  ctx: OrchestratorContext,
): Promise<OrchestratorResult> {
  const emit = ctx.emitSSE ?? (() => undefined);
  const timings: Record<string, number> = {};
  const aiCalls: Record<string, number> = {};

  // ───── Step 1: URL 可达性 ─────
  const t1 = Date.now();
  const reachability = await checkReachability(ctx.finalUrl);
  timings.step1_reachability = Date.now() - t1;
  if (!reachability.reachable) {
    emit("url_unreachable_warning", {
      finalUrl: ctx.finalUrl,
      statusCode: reachability.statusCode,
      reason: reachability.failureReason,
      hops: reachability.redirectHops,
    });
  }

  // ───── Step 2: 商家爬虫（复用现有 buildCrawlCache + 7 天缓存） ─────
  const t2 = Date.now();
  const crawlResult = await ensureCrawlCache({
    merchantUrl: reachability.finalUrl || ctx.finalUrl,
    merchantName: ctx.merchantName,
    targetCountry: ctx.targetCountry,
    existingCache: ctx.existingCrawlCache ?? null,
    forcePuppeteer: ctx.forcePuppeteerCrawl,
  });
  timings.step2_crawl = Date.now() - t2;
  const crawlCache = crawlResult.cache;
  const crawlSummary = {
    cacheHit: crawlResult.cacheHit,
    elapsedMs: crawlResult.elapsedMs,
    qualityScore: typeof crawlCache.crawlQualityScore === "number" ? crawlCache.crawlQualityScore : 0,
    pageTextLength: (crawlCache.pageText ?? "").length,
  };
  emit("crawl_status", { ...crawlSummary, crawl_failed: !!crawlCache.crawlFailed });

  // ───── Step 3: AI 画像生成（gpt-5-nano） ─────
  const t3 = Date.now();
  const profileGen = await generateMerchantProfile({
    merchantId: ctx.merchantId,
    merchantName: ctx.merchantName,
    merchantUrl: ctx.merchantUrl,
    targetCountry: ctx.targetCountry,
    forceRefresh: ctx.forceProfileRefresh,
    crawl: {
      pageText: crawlCache.pageText,
      features: crawlCache.features,
      crawledProducts: (crawlCache as unknown as { crawledProducts?: Array<{ name: string; price?: number; currency?: string }> }).crawledProducts,
      semrushTitles: crawlCache.semrushTitles,
      detectedLanguageCode: crawlCache.detectedLanguageCode,
    },
  });
  timings.step3_profile = Date.now() - t3;
  aiCalls.step3_profile = profileGen.aiCalls;
  emit("profile_ready", {
    cacheHit: profileGen.cacheHit,
    industry: profileGen.profile.industry_category,
    risk: profileGen.profile.compliance_risk_level,
    trademark: profileGen.profile.trademark_authorization_status,
  });

  // ───── Step 4: 政策 Pre-flight 闸门 ─────
  const t4 = Date.now();
  const preflight = await policyPreflight({
    merchantId: ctx.merchantId,
    merchantName: ctx.merchantName,
    finalUrl: reachability.finalUrl || ctx.finalUrl,
    targetCountry: ctx.targetCountry,
    adType: "rsa",
    profile: profileGen.profile,
  });
  timings.step4_preflight = Date.now() - t4;

  for (const w of preflight.warnings) emit("preflight_warning", { message: w });

  if (!preflight.approved) {
    emit("policy_blocked", {
      reasons: preflight.blocking_reasons,
      recentRejectionCount: preflight.recentRejectionCount,
    });
    return {
      approved: false,
      blockingReasons: preflight.blocking_reasons,
      warnings: [
        ...preflight.warnings,
        ...(reachability.reachable ? [] : [`URL ${ctx.finalUrl} 不可达 (${reachability.failureReason})`]),
      ],
      reachability,
      crawlSummary,
      profile: profileGen.profile,
      profileGeneration: stripProfile(profileGen),
      preflight,
      keywords: [],
      keywordNotes: [],
      headlines: [],
      descriptions: [],
      sitelinks: [],
      callouts: [],
      snippets: [],
      promotion: null,
      similarity: {},
      linter: null,
      timings,
      aiCalls,
    };
  }

  // ───── Step 5: 关键词智能（5 源融合 + 三因子 match type） ─────
  const t5 = Date.now();
  const keywordResult = runKeywordIntelligence({
    merchantName: ctx.merchantName,
    finalUrl: reachability.finalUrl || ctx.finalUrl,
    targetCountry: ctx.targetCountry,
    profile: profileGen.profile,
    candidates: ctx.candidateKeywords,
    dailyBudgetUsd: ctx.dailyBudgetUsd,
    maxCpcUsd: ctx.maxCpcUsd,
    blockedKeywords: preflight.blockedKeywords,
  });
  timings.step5_keywords = Date.now() - t5;
  emit("keywords_ready", {
    count: keywordResult.keywords.length,
    matchTypeMix: keywordResult.matchTypeMix,
    notes: keywordResult.notes,
  });

  const evidence: EvidenceContext = {
    pageText: crawlCache.pageText,
    features: crawlCache.features,
    crawledProducts: (crawlCache as unknown as { crawledProducts?: Array<{ name: string; price?: number; currency?: string }> }).crawledProducts,
    semrushTitles: crawlCache.semrushTitles,
    promotion: (crawlCache as unknown as { promoRegex?: { discount_percent?: number; discount_amount?: number; currency?: string } | null }).promoRegex,
  };

  // ───── Step 6 + 7 + 8: 文案生成 / 相似度评分 / 合规兜底 ─────
  // 每个任务独立跑，互不影响。任何一个任务失败都返回该任务空数组，整体不阻断。
  let headlines: string[] = [];
  let descriptions: string[] = [];
  let sitelinks: OrchestratorResult["sitelinks"] = [];
  let callouts: string[] = [];
  let snippets: OrchestratorResult["snippets"] = [];
  let promotion: OrchestratorResult["promotion"] = null;
  const similarity: OrchestratorResult["similarity"] = {};

  for (const task of ctx.tasks) {
    try {
      if (task.kind === "headlines") {
        const r = await generateAndScoreBatch({
          task: "headline",
          count: task.count,
          maxLen: task.maxLen,
          minLen: task.minLen,
          fieldName: "headlines",
          ctx,
          profile: profileGen.profile,
          preflight,
          keywords: keywordResult.keywords,
          evidence,
          emit,
        });
        headlines = r.items;
        similarity.headlines = r.lastSimilarity;
        aiCalls.step6_headlines = r.aiCalls;
      } else if (task.kind === "descriptions") {
        const r = await generateAndScoreBatch({
          task: "description",
          count: task.count,
          maxLen: task.maxLen,
          minLen: task.minLen ?? 40,
          fieldName: "descriptions",
          ctx,
          profile: profileGen.profile,
          preflight,
          keywords: keywordResult.keywords,
          evidence,
          emit,
        });
        descriptions = r.items;
        similarity.descriptions = r.lastSimilarity;
        aiCalls.step6_descriptions = r.aiCalls;
      } else if (task.kind === "sitelinks") {
        const r = await generateSimpleTask<OrchestratorResult["sitelinks"]>({
          task: "sitelink",
          count: task.count,
          maxLen: task.maxLen,
          fieldName: "sitelinks",
          ctx,
          profile: profileGen.profile,
          preflight,
          keywords: keywordResult.keywords,
          evidence,
        });
        sitelinks = r.items ?? [];
        aiCalls.step6_sitelinks = r.aiCalls;
      } else if (task.kind === "callouts") {
        const r = await generateSimpleTask<string[]>({
          task: "callout",
          count: task.count,
          maxLen: task.maxLen,
          fieldName: "callouts",
          ctx,
          profile: profileGen.profile,
          preflight,
          keywords: keywordResult.keywords,
          evidence,
        });
        callouts = r.items ?? [];
        aiCalls.step6_callouts = r.aiCalls;
      } else if (task.kind === "snippets") {
        const r = await generateSimpleTask<OrchestratorResult["snippets"]>({
          task: "snippet",
          count: task.count,
          maxLen: task.maxLen,
          fieldName: "snippets",
          ctx,
          profile: profileGen.profile,
          preflight,
          keywords: keywordResult.keywords,
          evidence,
        });
        snippets = r.items ?? [];
        aiCalls.step6_snippets = r.aiCalls;
      } else if (task.kind === "promotion") {
        const r = await generateSimpleTask<OrchestratorResult["promotion"]>({
          task: "promotion",
          count: 1,
          maxLen: task.maxLen,
          fieldName: "promotion",
          ctx,
          profile: profileGen.profile,
          preflight,
          keywords: keywordResult.keywords,
          evidence,
        });
        promotion = r.items as OrchestratorResult["promotion"];
        aiCalls.step6_promotion = r.aiCalls;
      }
    } catch (err) {
      console.warn(
        `[Orchestrator] task=${task.kind} failed: ${err instanceof Error ? err.message : err}`,
      );
      emit("task_failed", { task: task.kind, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // ───── Step 8: Compliance Linter（C-118 重写闭环 + 数量补足）─────
  const t8 = Date.now();
  // 目标数量（删除违规后补足回这些数，07 铁律：标题 15 / 描述 4）
  let targetHeadlines = 0;
  let targetDescriptions = 0;
  for (const t of ctx.tasks) {
    if (t.kind === "headlines") targetHeadlines = t.count;
    else if (t.kind === "descriptions") targetDescriptions = t.count;
  }
  // 注入给 linter 的「证据感知重写」AI 调用闭包
  const rewriteCallAi = async (prompt: string): Promise<string> =>
    callAiWithFallback(
      AI_SCENE,
      [
        { role: "system", content: "You are a senior Google Ads copywriter. Return ONLY valid JSON, no markdown." },
        { role: "user", content: prompt },
      ],
      1024,
    );
  const linter = await lintRewriteAndBackfill(
    { headlines, descriptions, callouts },
    {
      merchantName: ctx.merchantName,
      industryProfile: ctx.industryProfile ?? null,
      industryLabel: ctx.industryProfile?.label ?? null,
      targetHeadlines,
      targetDescriptions,
    },
    rewriteCallAi,
  );
  timings.step8_lint = Date.now() - t8;
  if (!linter.passed || linter.rewroteCount > 0 || linter.backfilledCount > 0) {
    emit("compliance_lint_warning", {
      droppedCount: linter.droppedCount,
      criticalCount: linter.criticalViolations.length,
      minorCount: linter.minorViolations.length,
      rewroteCount: linter.rewroteCount,
      backfilledCount: linter.backfilledCount,
    });
  }
  console.log(
    `[Orchestrator] Step8 lint: dropped=${linter.droppedCount} rewrote=${linter.rewroteCount} backfilled=${linter.backfilledCount} → headlines=${linter.cleanedHeadlines.length}/${targetHeadlines} descriptions=${linter.cleanedDescriptions.length}/${targetDescriptions}`,
  );

  return {
    approved: true,
    blockingReasons: [],
    warnings: [
      ...preflight.warnings,
      ...(reachability.reachable ? [] : [`URL ${ctx.finalUrl} 不可达 (${reachability.failureReason})`]),
    ],
    reachability,
    crawlSummary,
    profile: profileGen.profile,
    profileGeneration: stripProfile(profileGen),
    preflight,
    keywords: keywordResult.keywords,
    keywordNotes: keywordResult.notes,
    headlines: linter.cleanedHeadlines,
    descriptions: linter.cleanedDescriptions,
    sitelinks,
    callouts: linter.cleanedCallouts,
    snippets,
    promotion,
    similarity,
    linter,
    timings,
    aiCalls,
  };
}

// ──────────── 内部工具 ────────────

function stripProfile(g: ProfileGenerationResult): Omit<ProfileGenerationResult, "profile"> {
  const { profile: _omit, ...rest } = g;
  void _omit;
  return rest;
}

interface GenerationCommon {
  ctx: OrchestratorContext;
  profile: MerchantIntelligenceProfile;
  preflight: PreflightResult;
  keywords: KeywordWithMatchType[];
  evidence: EvidenceContext;
}

/**
 * 用于 headline / description：带 cosine 评分 + 返工最多 2 轮。
 */
async function generateAndScoreBatch(
  opts: GenerationCommon & {
    task: "headline" | "description";
    count: number;
    maxLen: number;
    minLen?: number;
    fieldName: "headlines" | "descriptions";
    emit: (type: string, payload: unknown) => void;
  },
): Promise<{
  items: string[];
  lastSimilarity?: BatchSimilarityResult;
  aiCalls: number;
}> {
  let aiCalls = 0;
  let bestSimilarity: BatchSimilarityResult | undefined;
  let retryHint = "";

  // C-117: 跨轮「累积去重」凑够数量 —— 07 铁律：标题必须满 15、描述必须满 4。
  //   旧逻辑每轮独立、只取 similarity 最高的一轮，AI 单轮产不够就只剩 3-5 条。
  //   现在每轮达标项合并去重进 accumulated，够数即返回；并多要 buffer 条提高单轮产出。
  const accumulated: string[] = [];
  const seen = new Set<string>();
  const addItems = (items: string[]) => {
    for (const it of items) {
      const key = it.toLowerCase().trim();
      if (key && !seen.has(key)) {
        seen.add(key);
        accumulated.push(it);
      }
    }
  };
  // 多要 buffer：让 AI 一次多产几条，截断/去重后仍够数（描述更难达标，buffer 更大）
  const askCount = opts.count + (opts.task === "description" ? 4 : 5);

  for (let attempt = 0; attempt < 3; attempt++) {
    // 最多 3 轮：1 次首轮 + 2 次返工/补量
    const prompt = buildEvidencePrompt({
      merchantName: opts.ctx.merchantName,
      finalUrl: opts.ctx.finalUrl,
      targetCountry: opts.ctx.targetCountry,
      languageName: opts.ctx.languageName,
      profile: opts.profile,
      preflight: opts.preflight,
      keywords: opts.keywords,
      evidence: opts.evidence,
      task: opts.task,
      count: askCount,
      maxLen: opts.maxLen,
      minLen: opts.minLen,
    });
    // 已累积的项告诉 AI 不要重复 + 还差几条
    const needMore = opts.count - accumulated.length;
    const dedupHint = accumulated.length > 0
      ? `\n\n# Already have these (do NOT repeat, generate ${needMore}+ NEW different ones):\n${accumulated.map((s) => `- ${s}`).join("\n")}`
      : "";
    const fullPrompt = (retryHint ? `${prompt}\n\n# Retry feedback\n${retryHint}` : prompt) + dedupHint;

    aiCalls += 1;
    let parsed: string[] = [];
    try {
      const raw = await callAiWithFallback(
        AI_SCENE,
        [
          { role: "system", content: "You are a senior Google Ads copywriter. Return ONLY valid JSON." },
          { role: "user", content: fullPrompt },
        ],
        Math.max(1024, askCount * 90),
      );
      const json = JSON.parse(extractJsonFromAi(raw)) as Record<string, unknown>;
      const arr = json[opts.fieldName];
      if (Array.isArray(arr)) {
        // C-116: 超长项「截断」而非「丢弃」—— smartTruncate 在词边界截到 maxLen，保住数量；
        //   过短（< minLen，描述需 ≥40）/ 空项仍剔除（无法靠截断补长，交给下一轮补量）。
        parsed = arr
          .map((x) => (typeof x === "string" ? x.trim().replace(/^["']|["']$/g, "") : ""))
          .map((s) => (s.length > opts.maxLen ? smartTruncate(s, opts.maxLen).slice(0, opts.maxLen) : s))
          .filter((s) => s.length > 0 && (opts.minLen ? s.length >= opts.minLen : true));
      }
    } catch (err) {
      console.warn(
        `[Orchestrator] ${opts.task} attempt ${attempt + 1} parse/AI failed: ${err instanceof Error ? err.message : err}`,
      );
    }

    if (parsed.length > 0) {
      const sim = scoreBatch(parsed, opts.keywords);
      if (sim.avgSimilarity > (bestSimilarity?.avgSimilarity ?? -1)) {
        bestSimilarity = sim;
      }
      addItems(parsed);

      // 数量已够 → 立即返回（取前 count 条）
      if (accumulated.length >= opts.count) {
        return { items: accumulated.slice(0, opts.count), lastSimilarity: bestSimilarity, aiCalls };
      }

      // 触发返工（带相似度反馈 + 补量提示）
      retryHint = buildRetryHintForLowSimilarity(sim, opts.keywords);
      opts.emit("similarity_retry", {
        task: opts.task,
        attempt: attempt + 1,
        avgSimilarity: sim.avgSimilarity,
        lowScoringCount: sim.lowScoringItems.length,
      });
    }
  }

  console.warn(
    `[Orchestrator] ${opts.task} 3 轮累积仅 ${accumulated.length}/${opts.count} 条（AI 产出不足，已尽力）`,
  );
  return { items: accumulated.slice(0, opts.count), lastSimilarity: bestSimilarity, aiCalls };
}

/**
 * 用于 sitelink / callout / snippet / promotion：单次 AI 调用，无返工评分。
 * 这些任务的 keyword-fit 没那么关键（sitelink 关心标题，callout 关心 USP）。
 */
async function generateSimpleTask<T>(
  opts: GenerationCommon & {
    task: "sitelink" | "callout" | "snippet" | "promotion";
    count: number;
    maxLen: number;
    fieldName: "sitelinks" | "callouts" | "snippets" | "promotion";
  },
): Promise<{ items: T | null; aiCalls: number }> {
  const prompt = buildEvidencePrompt({
    merchantName: opts.ctx.merchantName,
    finalUrl: opts.ctx.finalUrl,
    targetCountry: opts.ctx.targetCountry,
    languageName: opts.ctx.languageName,
    profile: opts.profile,
    preflight: opts.preflight,
    keywords: opts.keywords,
    evidence: opts.evidence,
    task: opts.task,
    count: opts.count,
    maxLen: opts.maxLen,
  });
  try {
    const raw = await callAiWithFallback(
      AI_SCENE,
      [
        { role: "system", content: "You are a senior Google Ads copywriter. Return ONLY valid JSON." },
        { role: "user", content: prompt },
      ],
      Math.max(1024, opts.count * 120),
    );
    const json = JSON.parse(extractJsonFromAi(raw)) as Record<string, unknown>;
    return { items: (json[opts.fieldName] as unknown as T) ?? null, aiCalls: 1 };
  } catch (err) {
    console.warn(
      `[Orchestrator] ${opts.task} simple-task failed: ${err instanceof Error ? err.message : err}`,
    );
    return { items: null, aiCalls: 1 };
  }
}
