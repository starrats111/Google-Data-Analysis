/**
 * 竞品情报引擎草稿生成的五个阶段实现。
 *
 * D-233：kyads 把这段逻辑写在 `GET /api/ad-create/drafts/:id` 路由文件里（前端每轮询
 * 一次就执行一个 case）。CRM 这边由 `draft-generation-runner` 在后台调用，所以整段
 * 搬成独立模块——路由层不该持有阶段调度。
 *
 * 阶段顺序见 `ad-create/types.ts` 的 DRAFT_STAGES：
 *   fetch_rival_ads → extract_brand_keywords → discover_sitelink_urls
 *   → ai_generate_assets → build_preview
 */
import type { AdEntry } from "../brand-assessment/types";
import { buildAdSamples } from "../ad-create/ad-samples";
import type { AdCopyPoolResult } from "../ad-create/ad-copy-pool";
import { defaultLlm, generateAdAssets } from "../ad-create/ai-asset-generator";
import {
  fetchCompetitorFromBrandAssessment,
  type CompetitorSourceResult,
} from "../ad-create/competitor-source";
import type { GapReport } from "../ad-create/gap-report";
import {
  extractDescriptionTexts,
  extractHeadlineTexts,
  normalizeSitelinks,
  type SitelinkItem,
} from "../ad-create/normalize-items";
import { buildPreviewPayload } from "../ad-create/preview-builder";
import { getDraftById, updateDraft } from "../ad-create/repository";
import type { DraftSitelink } from "../ad-create/sitelink-policy";
import type { DraftStage } from "../ad-create/types";
import type { AdGenerationMode } from "../deps/generation-mode";
import { readAdPrompt } from "../config";
import { runExtractBrandKeywordsStage } from "./extract-brand-keywords-stage";

export interface StageExecutionResult {
  skipped?: boolean;
}

type DraftRow = NonNullable<Awaited<ReturnType<typeof getDraftById>>>;

function resolveMode(raw: string | null): AdGenerationMode {
  return raw === "ai_generate" ? "ai_generate" : "filter";
}

export async function executeDraftStage(
  draftId: bigint,
  stage: DraftStage,
  draft: DraftRow,
): Promise<StageExecutionResult | void> {
  switch (stage) {
    case "fetch_rival_ads":
      return fetchRivalAds(draftId, draft);
    case "extract_brand_keywords":
      return extractBrandKeywords(draftId, draft);
    case "discover_sitelink_urls":
      // kyads 生产上这个阶段是关掉的：站内链接归因没验证清楚之前，自动挖出来的
      // sitelink 会把流量导到不结算的页面。移植时保持关闭，跳过而非删除，
      // 以便 completed_stages 的阶段序列在两个系统间可比。
      console.log(`[RivalIntel] draft=${draftId} discover_sitelink_urls 跳过（sitelink 归因未验证）`);
      return { skipped: true };
    case "ai_generate_assets":
      return aiGenerateAssets(draftId, draft);
    case "build_preview":
      return buildPreview(draftId);
  }
}

/**
 * 阶段一：取竞品在投广告。
 *
 * 数据来自「广告情报」里同域名同国家的品牌评估结果；评估没跑过时
 * competitor-source 会自己现场调 SerpApi 补一次并落库共享。
 */
async function fetchRivalAds(draftId: bigint, draft: DraftRow): Promise<void> {
  const source: CompetitorSourceResult = await fetchCompetitorFromBrandAssessment({
    domain: draft.domain,
    countryCode: draft.country_code,
    userId: draft.user_id,
    generationMode: resolveMode(draft.generation_mode),
  });

  await updateDraft(draftId, {
    source_payload: {
      keywords: source.keywords,
      adsOverview: source.adsOverview,
      copies: source.copies,
      creativeSamples: source.creativeSamples,
      dedupedTitles: source.dedupedTitles,
      dedupedDescriptions: source.dedupedDescriptions,
      brandToken: source.brandToken,
      adSitelinks: source.adSitelinks,
      collectionStats: source.collectionStats ?? null,
      // ai_generate_assets 阶段要按 is_brand_own 拆样本，所以原始分组也存下来
      brandOwnAds: source.brandOwnAds,
      nonBrandAds: source.nonBrandAds,
    },
    landing_page_url: draft.landing_page_url || `https://${source.domain}`,
  });
}

/**
 * 阶段二：抽品牌核心词（DataForSEO 排名词 + AI 判定品牌属性）。
 * 溯源记录合并进 source_payload，保留阶段一写入的全部字段。
 */
async function extractBrandKeywords(draftId: bigint, draft: DraftRow): Promise<void> {
  const result = await runExtractBrandKeywordsStage({
    domain: draft.domain,
    countryCode: draft.country_code,
    sourcePayload: draft.source_payload,
  });

  console.log(
    `[RivalIntel] draft=${draftId} extract_brand_keywords: ` +
      `source=${result.brandKeywordExtraction.source}, ` +
      `keywords(${result.coreBrandKeywords.length})=${JSON.stringify(result.coreBrandKeywords)}, ` +
      `cacheHit=${result.brandKeywordExtraction.cacheHit}, ` +
      `fallback=${result.brandKeywordExtraction.fallbackReason ?? "none"}`,
  );

  const existingPayload =
    draft.source_payload && typeof draft.source_payload === "object"
      ? (draft.source_payload as Record<string, unknown>)
      : {};

  await updateDraft(draftId, {
    core_brand_keywords: result.coreBrandKeywords,
    source_payload: {
      ...existingPayload,
      brandKeywordExtraction: result.brandKeywordExtraction,
    },
  });
}

/** 阶段四：调 AI 出标题/描述/否词。filter 模式只从竞品文案里挑，ai_generate 照打法重写。 */
async function aiGenerateAssets(draftId: bigint, draft: DraftRow): Promise<void> {
  const fresh = await getDraftById(draftId);
  const sourcePayload = (fresh?.source_payload ?? draft.source_payload) as
    | (AdCopyPoolResult & { brandOwnAds?: AdEntry[]; nonBrandAds?: AdEntry[] })
    | null;

  if (!sourcePayload) {
    throw new Error("竞品数据尚未获取，无法生成广告资产");
  }

  const mode = resolveMode(draft.generation_mode);
  const adSamples = buildAdSamples({
    mode,
    brandOwnAds: Array.isArray(sourcePayload.brandOwnAds) ? sourcePayload.brandOwnAds : [],
    nonBrandAds: Array.isArray(sourcePayload.nonBrandAds) ? sourcePayload.nonBrandAds : [],
  });

  const sitelinkPayload = (fresh?.sitelink_source_payload ?? draft.sitelink_source_payload) as
    | { candidates?: Array<{ finalUrl?: string; sourceTitle?: string }> }
    | null;
  const sitelinkCandidates = (
    Array.isArray(sitelinkPayload?.candidates) ? sitelinkPayload.candidates : []
  )
    .map((c) => ({
      url: typeof c?.finalUrl === "string" ? c.finalUrl : "",
      ...(typeof c?.sourceTitle === "string" ? { sourceTitle: c.sourceTitle } : {}),
    }))
    .filter((c) => c.url.length > 0);

  console.log(
    `[RivalIntel] draft=${draftId} ai_generate_assets: mode=${mode}, ` +
      `language=${draft.language_code ?? "auto"}, samples=${adSamples.length}, ` +
      `sitelinkCandidates=${sitelinkCandidates.length}`,
  );

  const result = await generateAdAssets(
    {
      mode,
      domain: draft.domain,
      countryCode: draft.country_code,
      languageCode: draft.language_code,
      adSamples,
      sitelinkCandidates,
      dedupedTitles: Array.isArray(sourcePayload.dedupedTitles) ? sourcePayload.dedupedTitles : [],
      dedupedDescriptions: Array.isArray(sourcePayload.dedupedDescriptions)
        ? sourcePayload.dedupedDescriptions
        : [],
    },
    { llm: defaultLlm, promptLoader: readAdPrompt },
  );

  console.log(
    `[RivalIntel] draft=${draftId} ai_generate_assets: headlines=${result.headlines.length}, ` +
      `descriptions=${result.descriptions.length}, sitelinks=${result.sitelinks.length}, ` +
      `negKw=${result.negativeKeywords.length}, breaksRsa=${result.gapReport?.breaksRsaMinimum ?? "n/a"}`,
  );

  await updateDraft(draftId, {
    headlines: result.headlines,
    descriptions: result.descriptions,
    sitelinks: result.sitelinks,
    negative_keywords: result.negativeKeywords,
    // 显式写 null 清列：ai_generate 模式没有 gap_report，重跑时不能留上一轮的
    gap_report: result.gapReport ?? null,
  });
}

/** 阶段五：拼预览体，前端第三步直接渲染这份 JSON。 */
async function buildPreview(draftId: bigint): Promise<void> {
  const draft = await getDraftById(draftId);
  if (!draft) return;

  const sitelinksForPreview: DraftSitelink[] = normalizeSitelinks(draft.sitelinks).map(
    (s: SitelinkItem) => ({
      linkText: s.linkText,
      finalUrl: s.finalUrl,
      ...(s.description1 ? { description1: s.description1 } : {}),
      ...(s.description2 ? { description2: s.description2 } : {}),
    }),
  );

  const preview = buildPreviewPayload({
    domain: draft.domain,
    landingPageUrl: draft.landing_page_url,
    headlines: extractHeadlineTexts(draft.headlines),
    descriptions: extractDescriptionTexts(draft.descriptions),
    brandKeywords: (draft.core_brand_keywords as string[]) || [],
    sitelinks: sitelinksForPreview,
    gapReport: (draft.gap_report as GapReport | null) ?? null,
    negativeKeywords: Array.isArray(draft.negative_keywords)
      ? (draft.negative_keywords as string[])
      : null,
  });

  await updateDraft(draftId, { preview_payload: preview });
}
