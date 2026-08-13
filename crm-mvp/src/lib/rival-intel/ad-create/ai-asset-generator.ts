import { requestLlmCompletion } from "@/lib/rival-intel/deps/llm";
import { buildAssetSystemPrompt } from "./prompts/output-schema";
import {
  normalizeHeadlines,
  normalizeDescriptions,
  normalizeSitelinks,
  type HeadlineItem,
  type DescriptionItem,
  type SitelinkItem,
} from "./normalize-items";
import { googleAdsLength, truncateToGoogleAdsLength } from "./text-length";
import { sanitizeGoogleAdsRsaText } from "./google-ads-editorial-policy";
import { finalizeGapReport, type GapReport, type RawGapReport } from "./gap-report";
import { completeDraftCopy } from "./copy-completion";
import { enforceSitelinkUrlPool } from "./sitelink-policy";
import type { AdGenerationMode } from "@/lib/rival-intel/deps/generation-mode";
import {
  buildLocalizationPromptInstruction,
  LOCALIZATION_EXAMPLES,
  localizeEnglishAdTermsInText,
  resolveTargetLanguage,
} from "./rsa-localization-quality";
import { classifyAngle } from "./copy-policy";

/**
 * Token 预算（估算）：
 * - filter 模式：system ~3000 + user（样本 50 条 × 200 字符）~3000 ≈ 6000 input tokens，output ~2000
 * - ai_generate 模式：system ~3000 + user ~1500 ≈ 4500 input tokens，output ~2000
 */

export const MAX_HEADLINE_LEN = 30;
export const MAX_DESCRIPTION_LEN = 90;
export const MAX_SITELINK_LINKTEXT_LEN = 25;
export const MAX_SITELINK_DESC_LEN = 35;
export const TARGET_HEADLINES = 15;
export const TARGET_DESCRIPTIONS = 4;
export const MAX_SITELINKS = 6;
export const LLM_TIMEOUT_MS = 90_000;

type HeadlineBucket = "value_prop" | "feature" | "social_proof" | "cta" | "trust";

/**
 * 把 `LOCALIZATION_EXAMPLES` 里的英语→本地化对照拆到三类语义桶里，
 * 用于非英语市场的多样性挑选启发式。
 */
const LOCALIZED_TERM_BUCKETS: Record<string, "cta" | "trust" | "value"> = {
  "Shop Now": "cta",
  Today: "cta",
  "Limited Time Offer": "cta",
  "Visit The Official Site": "trust",
  "Official Store": "trust",
  "Official Site": "trust",
  "Online Store": "trust",
  "Store Online": "trust",
  Official: "trust",
  Site: "trust",
  Save: "value",
  Sale: "value",
  Discount: "value",
  Discounts: "value",
  Deals: "value",
  Offer: "value",
  Offers: "value",
  "Free Shipping": "value",
  Off: "value",
};

interface LocalizedAdTermLexicon {
  ctaTerms: string[];
  trustTerms: string[];
  valueTerms: string[];
}

/**
 * 返回当前国家对应的本地化 CTA / 信任 / 价值类词汇集合。
 * 英语市场或无配置语言时返回空集合，由英文正则兜底。
 */
function buildLocalizedAdTermLexicon(
  countryCode: string,
  languageCode?: string | null,
): LocalizedAdTermLexicon {
  const language = resolveTargetLanguage({ countryCode, languageCode });
  const empty: LocalizedAdTermLexicon = { ctaTerms: [], trustTerms: [], valueTerms: [] };
  if (!language || language.code === "en") return empty;

  const lexicon: LocalizedAdTermLexicon = { ctaTerms: [], trustTerms: [], valueTerms: [] };
  for (const { english, local } of LOCALIZATION_EXAMPLES[language.code] ?? []) {
    const bucket = LOCALIZED_TERM_BUCKETS[english];
    const normalizedLocal = (local ?? "").trim().toLowerCase();
    if (!bucket || !normalizedLocal) continue;
    if (bucket === "cta") lexicon.ctaTerms.push(normalizedLocal);
    else if (bucket === "trust") lexicon.trustTerms.push(normalizedLocal);
    else lexicon.valueTerms.push(normalizedLocal);
  }
  return lexicon;
}

interface DiversityTextMatchers {
  isCta: (text: string) => boolean;
  isTrust: (text: string) => boolean;
  isValue: (text: string) => boolean;
}

const ENGLISH_CTA_REGEX = /\b(get|start|shop|book|try|learn|compare|discover|buy|reserve)\b/i;
const ENGLISH_TRUST_REGEX = /\b(official|trusted|verified|rated|customers?|reviews?|proven|since \d{4})\b/i;
const ENGLISH_VALUE_REGEX = /\b(save|sale|deal|deals|offer|offers|discount|free shipping|off)\b/i;

function containsLocalizedTerm(text: string, terms: string[]): boolean {
  if (terms.length === 0) return false;
  const lower = text.toLowerCase();
  return terms.some((term) => term.length > 0 && lower.includes(term));
}

function buildDiversityMatchers(
  countryCode: string,
  languageCode?: string | null,
): DiversityTextMatchers {
  const lexicon = buildLocalizedAdTermLexicon(countryCode, languageCode);
  return {
    isCta: (text) => ENGLISH_CTA_REGEX.test(text) || containsLocalizedTerm(text, lexicon.ctaTerms),
    isTrust: (text) =>
      ENGLISH_TRUST_REGEX.test(text) || containsLocalizedTerm(text, lexicon.trustTerms),
    isValue: (text) =>
      ENGLISH_VALUE_REGEX.test(text) || containsLocalizedTerm(text, lexicon.valueTerms),
  };
}

export interface AdSample {
  title: string;
  description: string;
  source: "ad" | "sitelink";
  is_brand_own: boolean;
  displayed_url?: string;
}

export interface AdAssetsInput {
  mode: AdGenerationMode;
  domain: string;
  countryCode: string;
  /**
   * 用户在生成页显式指定的文案语言（如阿联酋投英文）。
   * 留空表示跟随国家推导，保持历史行为。
   */
  languageCode?: string | null;
  adSamples: AdSample[];
  sitelinkCandidates: { url: string; sourceTitle?: string }[];
  /**
   * 站内链接默认关闭；只有站内链接归因验证完成后，调用方才应显式开启。
   */
  allowSitelinks?: boolean;
  /**
   * fetch_rival_ads 阶段产出的去重后的真实标题/描述池。
   * ai_generate 模式下用于 copy-completion 兜底；filter 模式忽略。
   */
  dedupedTitles?: string[];
  dedupedDescriptions?: string[];
}

export interface AdAssetsResult {
  brandKeyword: string | null;
  targetLanguage: string | null;
  industry: string | null;
  headlines: HeadlineItem[];
  descriptions: DescriptionItem[];
  sitelinks: SitelinkItem[];
  negativeKeywords: string[];
  gapReport: GapReport | null;
  rationale: string | null;
}

/**
 * D-233：原 deps 里还有 `llmConfig`（kyads 自己那套 baseUrl/apiKey/model），
 * CRM 的模型由 `ai-service` 按场景挑，已删除。`temperature` 也只是留在签名里
 * 表达「filter 要低温、generate 要高温」的意图，实际温度取管理台配置。
 */
export interface AdAssetsDeps {
  llm: (args: {
    systemPrompt: string;
    userPrompt: string;
    responseFormat: "json_object";
    temperature: number;
    timeoutMs: number;
  }) => Promise<string>;
  promptLoader: (mode: AdGenerationMode) => Promise<string>;
}

function buildUserPrompt(input: AdAssetsInput): string {
  const targetLanguage = resolveTargetLanguage({
    countryCode: input.countryCode,
    languageCode: input.languageCode,
  });
  const parts: string[] = [`域名: ${input.domain}`, `国家: ${input.countryCode}`];
  if (targetLanguage) {
    parts.push(`目标语言: ${targetLanguage.label}`);
  }
  if (input.mode === "filter") {
    parts.push(`SerpApi 广告样本（JSON 数组）:`);
    parts.push(JSON.stringify(input.adSamples, null, 2));
  } else {
    if (input.adSamples.length > 0) {
      parts.push(`SERP 广告样本（可选参考）:`);
      parts.push(JSON.stringify(input.adSamples, null, 2));
    }
    if (input.allowSitelinks) {
      parts.push(`候选 sitelink URL 列表（来自首页抓取）:`);
      parts.push(JSON.stringify(input.sitelinkCandidates, null, 2));
    } else {
      parts.push("站内链接当前默认禁用：请返回 sitelinks: []，不要生成任何站内链接。");
    }
  }
  return parts.join("\n");
}

export function parseAssetResponse(raw: string): AdAssetsResult {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*"headlines"[\s\S]*\}/);
    if (!match) throw new Error("AI 返回内容不是有效 JSON");
    parsed = JSON.parse(match[0]);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI 返回根结构不是对象");
  }
  const obj = parsed as Record<string, unknown>;
  return {
    brandKeyword: typeof obj.brandKeyword === "string" ? obj.brandKeyword : null,
    targetLanguage: typeof obj.targetLanguage === "string" ? obj.targetLanguage : null,
    industry: typeof obj.industry === "string" ? obj.industry : null,
    headlines: normalizeHeadlines(obj.headlines),
    descriptions: normalizeDescriptions(obj.descriptions),
    sitelinks: normalizeSitelinks(obj.sitelinks).slice(0, MAX_SITELINKS),
    negativeKeywords: Array.isArray(obj.negativeKeywords)
      ? obj.negativeKeywords.map((x) => String(x)).filter(Boolean)
      : [],
    gapReport:
      obj.gapReport && typeof obj.gapReport === "object"
        ? (obj.gapReport as unknown as GapReport)
        : null,
    rationale: typeof obj.rationale === "string" ? obj.rationale : null,
  };
}

const GENERIC_DOMAIN_TOKENS = new Set([
  "www",
  "com",
  "net",
  "org",
  "co",
  "us",
  "uk",
  "store",
  "shop",
  "official",
]);

function domainBrandToken(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    ?.split(".")[0] ?? "";
  return normalized.replace(/[^a-z0-9]/g, "");
}

function displayedUrlBrandToken(value: string): string | null {
  const token = domainBrandToken(value);
  if (token.length < 3 || GENERIC_DOMAIN_TOKENS.has(token)) return null;
  return token;
}

function buildThirdPartyBrandTokens(input: AdAssetsInput): Set<string> {
  const ownToken = domainBrandToken(input.domain);
  const tokens = new Set<string>();
  for (const sample of input.adSamples) {
    if (sample.is_brand_own || !sample.displayed_url) continue;
    const token = displayedUrlBrandToken(sample.displayed_url);
    if (!token || token === ownToken) continue;
    tokens.add(token);
  }
  return tokens;
}

function containsThirdPartyBrand(text: string, tokens: Set<string>): boolean {
  if (!text || tokens.size === 0) return false;
  const lower = text.toLowerCase();
  for (const token of tokens) {
    const pattern = new RegExp(`(^|[^a-z0-9])${token}(?:[™®©]|[^a-z0-9]|$)`, "i");
    if (pattern.test(lower)) return true;
  }
  return false;
}

function localizeTextField(
  text: string,
  countryCode: string,
  languageCode: string | null | undefined,
  maxLen: number,
): string {
  const editorial = sanitizeGoogleAdsRsaText(text);
  const localized = localizeEnglishAdTermsInText(editorial, countryCode, languageCode);
  if (googleAdsLength(localized) <= maxLen) return localized;
  return truncateToGoogleAdsLength(localized, maxLen, true);
}

function applyLocalizationSanitize(result: AdAssetsResult, input: AdAssetsInput): AdAssetsResult {
  const { countryCode, languageCode } = input;
  const headlines = result.headlines.map((item) => {
    const text = localizeTextField(item.text, countryCode, languageCode, MAX_HEADLINE_LEN);
    return { ...item, text, charLen: googleAdsLength(text) };
  });
  const descriptions = result.descriptions.map((item) => {
    const text = localizeTextField(item.text, countryCode, languageCode, MAX_DESCRIPTION_LEN);
    return { ...item, text, charLen: googleAdsLength(text) };
  });
  const sitelinks = result.sitelinks.map((item) => ({
    ...item,
    linkText: localizeTextField(item.linkText, countryCode, languageCode, MAX_SITELINK_LINKTEXT_LEN),
    description1: item.description1
      ? localizeTextField(item.description1, countryCode, languageCode, MAX_SITELINK_DESC_LEN)
      : undefined,
    description2: item.description2
      ? localizeTextField(item.description2, countryCode, languageCode, MAX_SITELINK_DESC_LEN)
      : undefined,
  }));
  return { ...result, headlines, descriptions, sitelinks };
}

function applyFilterSanitize(result: AdAssetsResult, input: AdAssetsInput): AdAssetsResult {
  let rLen = 0;
  let r5 = 0;
  const thirdPartyBrandTokens = buildThirdPartyBrandTokens(input);
  const headlines = result.headlines
    .filter((h) => {
      if (containsThirdPartyBrand(h.text, thirdPartyBrandTokens)) {
        r5++;
        return false;
      }
      if (googleAdsLength(h.text) > MAX_HEADLINE_LEN) {
        rLen++;
        return false;
      }
      return true;
    })
    .slice(0, TARGET_HEADLINES);
  const descriptions = result.descriptions
    .filter((d) => {
      if (containsThirdPartyBrand(d.text, thirdPartyBrandTokens)) {
        r5++;
        return false;
      }
      if (googleAdsLength(d.text) > MAX_DESCRIPTION_LEN) {
        rLen++;
        return false;
      }
      return true;
    })
    .slice(0, TARGET_DESCRIPTIONS);
  const sitelinks = result.sitelinks.filter((s) => {
    if (containsThirdPartyBrand(s.linkText, thirdPartyBrandTokens)) {
      r5++;
      return false;
    }
    if (googleAdsLength(s.linkText) > MAX_SITELINK_LINKTEXT_LEN) {
      rLen++;
      return false;
    }
    if (s.description1 && googleAdsLength(s.description1) > MAX_SITELINK_DESC_LEN) {
      rLen++;
      return false;
    }
    if (s.description2 && googleAdsLength(s.description2) > MAX_SITELINK_DESC_LEN) {
      rLen++;
      return false;
    }
    return true;
  });

  const rawGap: RawGapReport = {
    headlinesCount: headlines.length,
    descriptionsCount: descriptions.length,
    sitelinksCount: sitelinks.length,
    thresholdStoppedAt: result.gapReport?.thresholdStoppedAt ?? null,
    rejectionCounts: {
      ...(result.gapReport?.rejectionCounts ?? {}),
      R5: (result.gapReport?.rejectionCounts?.R5 ?? 0) + r5,
      R_LEN: rLen,
    },
  };
  return applyLocalizationSanitize(
    {
      ...result,
      headlines,
      descriptions,
      sitelinks: input.allowSitelinks ? sitelinks : [],
      gapReport: finalizeGapReport({
        ...rawGap,
        sitelinksCount: input.allowSitelinks ? sitelinks.length : 0,
      }),
    },
    input,
  );
}

function applyGenerateSanitize(result: AdAssetsResult, input: AdAssetsInput): AdAssetsResult {
  const headlines = result.headlines
    .map((h) => {
      if (googleAdsLength(h.text) > MAX_HEADLINE_LEN) {
        const truncated = truncateToGoogleAdsLength(h.text, MAX_HEADLINE_LEN, true);
        return { ...h, text: truncated, charLen: googleAdsLength(truncated) };
      }
      return h;
    })
    .filter((h) => h.text.length > 0)
    .map((h) => ({ ...h, charLen: googleAdsLength(h.text) }));
  const descriptions = result.descriptions
    .map((d) => {
      if (googleAdsLength(d.text) > MAX_DESCRIPTION_LEN) {
        const truncated = truncateToGoogleAdsLength(d.text, MAX_DESCRIPTION_LEN, true);
        return { ...d, text: truncated, charLen: googleAdsLength(truncated) };
      }
      return d;
    })
    .filter((d) => d.text.length > 0)
    .map((d) => ({ ...d, charLen: googleAdsLength(d.text) }));
  const sitelinks = enforceSitelinkUrlPool(
    result.sitelinks,
    {
      domainOrUrl: input.domain,
      validUrlPool: input.sitelinkCandidates,
      requirePoolMembership: true,
    },
  )
    .map((s) => {
      const linkText =
        googleAdsLength(s.linkText) > MAX_SITELINK_LINKTEXT_LEN
          ? truncateToGoogleAdsLength(s.linkText, MAX_SITELINK_LINKTEXT_LEN, true)
          : s.linkText;
      const description1 =
        s.description1 && googleAdsLength(s.description1) > MAX_SITELINK_DESC_LEN
          ? truncateToGoogleAdsLength(s.description1, MAX_SITELINK_DESC_LEN, true)
          : s.description1;
      const description2 =
        s.description2 && googleAdsLength(s.description2) > MAX_SITELINK_DESC_LEN
          ? truncateToGoogleAdsLength(s.description2, MAX_SITELINK_DESC_LEN, true)
          : s.description2;
      const hasBothDescriptions = Boolean(description1 && description2);
      return {
        ...s,
        linkText,
        description1: hasBothDescriptions ? description1 : undefined,
        description2: hasBothDescriptions ? description2 : undefined,
      };
    })
    .filter((s) => s.linkText.length > 0)
    .filter((s, index, list) => list.findIndex((x) => x.linkText.toLowerCase() === s.linkText.toLowerCase()) === index);

  let finalHeadlines = headlines;
  let finalDescriptions = descriptions;
  if (
    (headlines.length < 3 || descriptions.length < 2) &&
    ((input.dedupedTitles?.length ?? 0) > 0 || (input.dedupedDescriptions?.length ?? 0) > 0)
  ) {
    const completed = completeDraftCopy({
      existingHeadlines: headlines.map((h) => h.text),
      existingDescriptions: descriptions.map((d) => d.text),
      generatedHeadlines: input.dedupedTitles ?? [],
      generatedDescriptions: input.dedupedDescriptions ?? [],
    });
    const existingHeadlineTexts = new Set(headlines.map((h) => h.text.toLowerCase()));
    const existingDescTexts = new Set(descriptions.map((d) => d.text.toLowerCase()));
    const fallbackHeadlines: HeadlineItem[] = completed.headlines
      .filter((t) => !existingHeadlineTexts.has(t.toLowerCase()))
      .map((t) => ({ text: t, score: 0, type: "fallback", charLen: googleAdsLength(t), isOwn: false }));
    const fallbackDescriptions: DescriptionItem[] = completed.descriptions
      .filter((t) => !existingDescTexts.has(t.toLowerCase()))
      .map((t) => ({ text: t, score: 0, charLen: googleAdsLength(t), isOwn: false }));
    finalHeadlines = [...headlines, ...fallbackHeadlines];
    finalDescriptions = [...descriptions, ...fallbackDescriptions];
  }

  const matchers = buildDiversityMatchers(input.countryCode, input.languageCode);
  finalHeadlines = selectDiverseHeadlines(finalHeadlines, TARGET_HEADLINES, matchers);
  finalDescriptions = selectDiverseDescriptions(finalDescriptions, TARGET_DESCRIPTIONS, matchers);
  const finalSitelinks = input.allowSitelinks ? selectDiverseSitelinks(sitelinks, MAX_SITELINKS) : [];

  if (finalHeadlines.length < 3) {
    throw new Error(
      `AI 生成模式产出 ${finalHeadlines.length} 条标题，且兜底补齐后仍不足 3 条；阶段失败。建议改用筛选模式或检查上游品牌评估数据。`,
    );
  }
  if (finalDescriptions.length < 2) {
    throw new Error(
      `AI 生成模式产出 ${finalDescriptions.length} 条描述，且兜底补齐后仍不足 2 条；阶段失败。`,
    );
  }

  return applyLocalizationSanitize(
    {
      ...result,
      headlines: finalHeadlines,
      descriptions: finalDescriptions,
      sitelinks: finalSitelinks,
      gapReport: null,
    },
    input,
  );
}

function canonicalizeHeadlineBucket(item: HeadlineItem, matchers: DiversityTextMatchers): HeadlineBucket {
  const rawType = item.type.toLowerCase();
  if (rawType.includes("cta")) return "cta";
  if (rawType.includes("social") || rawType.includes("proof")) return "social_proof";
  if (rawType.includes("trust") || rawType.includes("official")) return "trust";
  if (rawType.includes("feature")) return "feature";
  if (rawType.includes("benefit") || rawType.includes("value") || rawType.includes("offer") || rawType.includes("differentiation") || rawType.includes("urgency")) return "value_prop";

  const classified = classifyAngle(item.text, []);
  if (classified.angle === "cta") return "cta";
  if (classified.angle === "trust" || classified.angle === "brand") return "trust";
  if (classified.angle === "feature") return "feature";
  if (classified.angle === "price" || classified.angle === "offer") return "value_prop";

  if (matchers.isCta(item.text)) return "cta";
  if (matchers.isTrust(item.text)) return "trust";
  if (matchers.isValue(item.text)) return "value_prop";
  return "social_proof";
}

function selectDiverseHeadlines(
  headlines: HeadlineItem[],
  target: number,
  matchers: DiversityTextMatchers,
): HeadlineItem[] {
  const deduped = headlines.filter(
    (item, index, list) => list.findIndex((x) => x.text.toLowerCase() === item.text.toLowerCase()) === index,
  );
  const sorted = deduped.sort((a, b) => b.score - a.score);
  const quotas: Record<HeadlineBucket, number> = {
    value_prop: 4,
    feature: 3,
    social_proof: 2,
    cta: 2,
    trust: 2,
  };
  const pools: Record<HeadlineBucket, HeadlineItem[]> = {
    value_prop: [],
    feature: [],
    social_proof: [],
    cta: [],
    trust: [],
  };

  for (const item of sorted) {
    pools[canonicalizeHeadlineBucket(item, matchers)].push(item);
  }

  const selected: HeadlineItem[] = [];
  for (const bucket of Object.keys(quotas) as HeadlineBucket[]) {
    for (const item of pools[bucket].slice(0, quotas[bucket])) {
      if (selected.length >= target) break;
      selected.push(item);
    }
  }

  for (const item of sorted) {
    if (selected.length >= target) break;
    if (selected.some((x) => x.text.toLowerCase() === item.text.toLowerCase())) continue;
    selected.push(item);
  }

  return selected.slice(0, target);
}

function selectDiverseDescriptions(
  descriptions: DescriptionItem[],
  target: number,
  matchers: DiversityTextMatchers,
): DescriptionItem[] {
  const deduped = descriptions.filter(
    (item, index, list) => list.findIndex((x) => x.text.toLowerCase() === item.text.toLowerCase()) === index,
  );
  const sorted = deduped.sort((a, b) => b.score - a.score);

  const selected: DescriptionItem[] = [];
  const ctaItem = sorted.find((item) => matchers.isCta(item.text));
  if (ctaItem) selected.push(ctaItem);
  const trustItem = sorted.find(
    (item) =>
      matchers.isTrust(item.text) &&
      !selected.some((x) => x.text.toLowerCase() === item.text.toLowerCase()),
  );
  if (trustItem) selected.push(trustItem);

  for (const item of sorted) {
    if (selected.length >= target) break;
    if (selected.some((x) => x.text.toLowerCase() === item.text.toLowerCase())) continue;
    selected.push(item);
  }

  return selected.slice(0, target);
}

function selectDiverseSitelinks(sitelinks: SitelinkItem[], target: number): SitelinkItem[] {
  const deduped = sitelinks.filter(
    (item, index, list) =>
      list.findIndex(
        (x) =>
          x.linkText.toLowerCase() === item.linkText.toLowerCase() &&
          x.finalUrl.toLowerCase() === item.finalUrl.toLowerCase(),
      ) === index,
  );
  const sorted = deduped.sort((a, b) => b.score - a.score);
  const selected: SitelinkItem[] = [];
  const usedAngles = new Set<string>();

  for (const item of sorted) {
    if (selected.length >= target) break;
    if (usedAngles.has(item.angle.toLowerCase())) continue;
    selected.push(item);
    usedAngles.add(item.angle.toLowerCase());
  }

  for (const item of sorted) {
    if (selected.length >= target) break;
    if (
      selected.some(
        (x) =>
          x.linkText.toLowerCase() === item.linkText.toLowerCase() &&
          x.finalUrl.toLowerCase() === item.finalUrl.toLowerCase(),
      )
    ) {
      continue;
    }
    selected.push(item);
  }

  return selected.slice(0, target);
}

function buildEmptyFilterSamplesResult(): AdAssetsResult {
  const gapReport = finalizeGapReport({
    headlinesCount: 0,
    descriptionsCount: 0,
    sitelinksCount: 0,
  });

  return {
    brandKeyword: null,
    targetLanguage: null,
    industry: null,
    headlines: [],
    descriptions: [],
    sitelinks: [],
    negativeKeywords: [],
    gapReport: {
      ...gapReport,
      suggestionReason: gapReport.suggestionReason
        ? `没有可筛选的竞品广告素材；${gapReport.suggestionReason}`
        : "没有可筛选的竞品广告素材；建议切换至 AI 生成模式重跑。",
    },
    rationale: "filter 模式没有可筛选的竞品广告素材。",
  };
}

export async function generateAdAssets(
  input: AdAssetsInput,
  deps: AdAssetsDeps,
): Promise<AdAssetsResult> {
  if (input.mode === "filter" && input.adSamples.length === 0) {
    return buildEmptyFilterSamplesResult();
  }

  const basePrompt = [
    await deps.promptLoader(input.mode),
    buildLocalizationPromptInstruction(input.countryCode, input.languageCode),
  ].filter(Boolean).join("\n");
  const systemPrompt = buildAssetSystemPrompt(basePrompt);
  const userPrompt = buildUserPrompt(input);
  const raw = await deps.llm({
    systemPrompt,
    userPrompt,
    responseFormat: "json_object",
    temperature: input.mode === "filter" ? 0.1 : 0.7,
    timeoutMs: LLM_TIMEOUT_MS,
  });
  const parsed = parseAssetResponse(raw);
  return input.mode === "filter" ? applyFilterSanitize(parsed, input) : applyGenerateSanitize(parsed, input);
}

export const defaultLlm: AdAssetsDeps["llm"] = async (args) =>
  requestLlmCompletion({
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt,
    responseFormat: args.responseFormat,
    temperature: args.temperature,
    timeoutMs: args.timeoutMs,
  });
