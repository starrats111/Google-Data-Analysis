/**
 * 竞品数据源 —— 从本系统「品牌评估」结果表读取广告创意，替代历史上
 * 通过 3UE/SemRush 爬虫拉取的旧路径（3UE 会话 403 鉴权失败后已不可用）。
 *
 * 设计原则：
 * - 纯函数 `buildCompetitorSourceFromBrandAssessment`：只做数据形状映射，
 *   不访问 DB，便于单测。
 * - I/O 函数 `fetchCompetitorFromBrandAssessment`：查 `BrandAssessmentResult`
 *   表，若缺失则抛出明确错误要求先跑品牌评估。
 *
 * 输出结构：复用 `AdCopyPoolResult` 以保持下游（ai-asset-generator / copy-completion）
 *   零改动；另附 `adSitelinks` 供 ai-asset-generator 作灵感参考。
 */

import {
  countryLookupCodes,
  countryToParams,
  normalizeCountryCode,
} from "@/lib/rival-intel/brand-assessment/country-params";
import { extractBrandName, isBrandOwnUrl } from "@/lib/rival-intel/brand-assessment/brand-extract";
import {
  deriveBrandLevel,
  deriveCountrySnapshot,
  normalizeAdEntry,
} from "@/lib/rival-intel/brand-assessment/derive";
import {
  fetchGoogleAds,
  fetchTransparency,
  type HttpGet,
} from "@/lib/rival-intel/brand-assessment/serpapi-client";
import type { AdEntry, AdSitelink } from "@/lib/rival-intel/brand-assessment/types";
import { recoverCopyFromImageCreatives } from "./creative-copy-ocr";
import type { AdCopyPoolResult } from "./ad-copy-pool";
import {
  dedupeAdDescriptions,
  dedupeAdTitles,
} from "./ad-copy-pool";
import { countryCodeToDataForSeoParams } from "./dataforseo-country-params";

const SERPAPI_FALLBACK_ESTIMATED_COST_USD = 0.195;
const FALLBACK_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_TRANSPARENCY_PAGES = 2;
const MAX_TRANSPARENCY_ADVERTISER_EXPANSIONS = 2;
const GOOGLE_ADS_DEVICES = ["desktop", "mobile"] as const;
const FILTER_MIN_TITLES = 3;
const FILTER_MIN_DESCRIPTIONS = 2;

export interface BrandAssessmentAdsRow {
  domain: string;
  brandToken?: string | null;
  llmOutput?: unknown;
  brandOwnAds: AdEntry[] | null;
  nonBrandAds: AdEntry[] | null;
  /**
   * 原始 transparency 字段（Google Ads Transparency Center 拉回的 JSON）。
   * 形如 `{ ad_creatives: [{title, body, advertiser, ...}, ...] }`。
   *
   * 历史背景（2026-05-16）：在 `fix(brand-assessment): query transparency
   * by domain` 之前，本字段长期为空，所以 buildCompetitorSourceFromBrandAssessment
   * 直接忽略它没问题。修复后 SerpApi 真的会回数据，新写入的行 transparency
   * 通常含 5~30 条 advertiser 投放的创意（多为竞品/经销商），是 ai_generate
   * 模式最稀缺的 non-brand 样本来源，必须并入 nonBrandAds。
   *
   * `defaultBrandAssessmentReader` 会从 prisma 列 `transparency` 读出来。
   */
  transparency?: unknown;
  collectionStats?: CompetitorCollectionStats;
}

export interface CompetitorSourceResult extends AdCopyPoolResult {
  /** 品牌评估 LLM 识别出的自然品牌词，优先用于广告创建核心品牌关键词。 */
  brandToken: string | null;
  /** 所有 ad.sitelinks 去重后的列表（title 作为唯一键，保持首次出现顺序）。 */
  adSitelinks: AdSitelink[];
  /**
   * 原始 brand_own_ads / non_brand_ads（每条 ad 自带 sitelinks）。
   * `ai_generate_assets` 阶段需要按 `is_brand_own` 区分样本，并把每条 ad 的
   * sitelinks 一起打平成 generator 输入（spec §5.1）。
   */
  brandOwnAds: AdEntry[];
  nonBrandAds: AdEntry[];
  collectionStats?: CompetitorCollectionStats;
}

export interface CompetitorCollectionStats {
  transparencyPages: number;
  transparencyCreatives: number;
  transparencyPublishableAds?: number;
  /**
   * 列表里拿到、但提取不出文案的创意条数——它们的文案印在 `image` 那张广告截图里，
   * 只能靠 OCR 取。实测这个数通常等于创意总数（SerpApi 对文本广告不回文字）。
   */
  transparencyInspirationOnly?: number;
  transparencyAdvertiserQueries?: number;
  /** D-273.4 识图补文案：送识别的张数 / 图片缓存命中 / 真正提出文案的条数 */
  copyOcrAttempted?: number;
  copyOcrCacheHits?: number;
  copyOcrRecovered?: number;
  /** 判定为商品网格购物广告而跳过的条数（这类图没有标题描述结构） */
  copyOcrShoppingSkipped?: number;
  /** 识图串位触发的拆批重跑次数，长期不为 0 说明批量上限要下调 */
  copyOcrMisalignedRetries?: number;
  googleAdsQueries: number;
  googleAdsAds: number;
  serpapiCostUsd: number;
  queries: string[];
}

export function normalizeDomain(input: string): string {
  let d = input.trim();
  if (d.includes("://")) {
    try {
      d = new URL(d).hostname;
    } catch {
      d = d.replace(/^https?:\/\//, "").split("/")[0] ?? d;
    }
  }
  d = d.replace(/^www\./, "");
  d = d.replace(/\/.*$/, "");
  return d.toLowerCase();
}

/**
 * 命中分支专用：把 transparency.ad_creatives 也归入 non-brand 创意池。
 *
 * 与 `collectTransparencyAds` 共用同一个 normalize 函数 `normalizeTransparencyCreative`，
 * 所以输出形状与 SerpApi fallback 分支完全一致。fallback domain 用 row.domain，
 * 失败时退回到外层 `params.domain`（在 buildCompetitorSourceFromBrandAssessment 里传）。
 */
function collectTransparencyAdsFromRow(
  row: BrandAssessmentAdsRow | null,
  fallbackDomain: string,
): AdEntry[] {
  if (!row || row.transparency == null) return [];
  const rowDomain = row.domain?.trim();
  const domain = rowDomain && rowDomain.length > 0 ? rowDomain : fallbackDomain;
  return collectTransparencyAds(row.transparency, domain);
}

function collectAds(row: BrandAssessmentAdsRow | null): AdEntry[] {
  if (!row) return [];
  const own = Array.isArray(row.brandOwnAds) ? row.brandOwnAds : [];
  const non = Array.isArray(row.nonBrandAds) ? row.nonBrandAds : [];
  const transparency = collectTransparencyAdsFromRow(row, row.domain ?? "");
  return [...own, ...non, ...transparency];
}

function collectCreativeSamples(
  ads: AdEntry[],
): { title: string; description: string }[] {
  const samples: { title: string; description: string }[] = [];
  for (const ad of ads) {
    const title = (ad?.title ?? "").toString().trim();
    const description = (ad?.description ?? "").toString().trim();
    if (!title && !description) continue;
    samples.push({ title, description });
  }
  return samples;
}

function collectAdSitelinks(ads: AdEntry[]): AdSitelink[] {
  const out: AdSitelink[] = [];
  const seen = new Set<string>();
  for (const ad of ads) {
    const sitelinks = Array.isArray(ad?.sitelinks) ? ad.sitelinks : [];
    for (const sl of sitelinks) {
      const title = (sl?.title ?? "").toString().trim();
      if (!title) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const snippet =
        typeof sl?.snippet === "string" && sl.snippet.trim().length > 0
          ? sl.snippet.trim()
          : null;
      out.push({ title, snippet });
    }
  }
  return out;
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractMetadataBrandToken(llmOutput: unknown): string | null {
  const root = asObject(llmOutput);
  const metadata = asObject(root?.metadata);
  return cleanText(metadata?.brand_token);
}

function resolveBrandToken(row: BrandAssessmentAdsRow | null): string | null {
  return extractMetadataBrandToken(row?.llmOutput) ?? cleanText(row?.brandToken);
}

export function buildCompetitorSourceFromBrandAssessment(params: {
  domain: string;
  row: BrandAssessmentAdsRow | null;
}): CompetitorSourceResult {
  const ads = collectAds(params.row);
  const creativeSamples = collectCreativeSamples(ads);

  const titlePool = creativeSamples
    .map((s) => s.title)
    .filter((t) => t.length > 0);
  const descPool = creativeSamples
    .map((s) => s.description)
    .filter((d) => d.length > 0);

  const dedupedTitles = dedupeAdTitles(titlePool);
  const dedupedDescriptions = dedupeAdDescriptions(descPool);

  const rowDomain = params.row?.domain?.trim();
  const domain = rowDomain && rowDomain.length > 0
    ? normalizeDomain(rowDomain)
    : normalizeDomain(params.domain);

  // 命中分支：把 row.transparency.ad_creatives 一并并入 nonBrandAds，
  // 与 SerpApi fallback 分支 (competitor-source.ts 中 fetchCompetitorFromBrandAssessment)
  // 的 `nonBrandAds = [...serpNonBrandAds, ...transparencyAds]` 保持一致。
  const existingNonBrandAds = Array.isArray(params.row?.nonBrandAds)
    ? params.row!.nonBrandAds
    : [];
  const transparencyAds = collectTransparencyAdsFromRow(params.row, params.domain);
  const nonBrandAds = [...existingNonBrandAds, ...transparencyAds];

  return {
    domain,
    brandToken: resolveBrandToken(params.row),
    keywords: [],
    adsOverview: creativeSamples,
    copies: {
      date: "",
      total: creativeSamples.length,
      samples: creativeSamples,
    },
    creativeSamples,
    dedupedTitles,
    dedupedDescriptions,
    adSitelinks: collectAdSitelinks(ads),
    brandOwnAds: Array.isArray(params.row?.brandOwnAds) ? params.row!.brandOwnAds : [],
    nonBrandAds,
    ...(params.row?.collectionStats ? { collectionStats: params.row.collectionStats } : {}),
  };
}

export type BrandAssessmentReader = (args: {
  domain: string;
  country: string;
}) => Promise<BrandAssessmentAdsRow | null>;

type MoneyLike = number | string | { toString(): string } | null;

export type SerpApiConfigReader = () => Promise<{
  serpapi_key: string | null;
  daily_brand_budget_usd?: MoneyLike;
} | null>;

export interface PersistFallbackResultInput {
  /** 仅审计：记下谁最早为这个 (域名, 国家) 付的钱。结果本身全公司共享。 */
  userId?: bigint | null;
  domain: string;
  country: string;
  brandToken: string;
  countrySnapshot: unknown;
  brandLevel: unknown;
  brandOwnAds: AdEntry[];
  nonBrandAds: AdEntry[];
  transparency: unknown;
  engineStatus: Record<string, string>;
  warnings: string[];
  serpapiCostUsd: number;
  now: Date;
}

export type PersistFallbackResult = (input: PersistFallbackResultInput) => Promise<void>;

/**
 * 拉 Google 广告透明中心的在投创意。
 *
 * ⚠️ 别再加「拉创意详情补文本」那一步（2026-08-24 D-273 实证删除）：
 * SerpApi 的 `google_ads_transparency_center_ad_details` 引擎对 `format=text` 的创意
 * **只回一个 `image` 链接，不回任何 headline / description**——列表接口如此，详情接口
 * 也一样。Google 的透明中心本身就是把文本广告渲染成图片存档的，文案在图里。
 *
 * 删掉的那一步每次兜底要打最多 20 次详情请求（占单次兜底 35 次调用的 57%），
 * 而全库历史 9 行品牌评估数据里，它一条可用文案都没产出过——纯烧额度。
 *
 * 要拿到这些文案只能 OCR `image`（本地 tesseract 与 gemini 视觉均已实测可准确读出
 * 标题/描述），那是独立方案，不在本函数职责内。
 */
async function fetchTransparencyDeep(params: {
  domain: string;
  apiKey: string;
  region: string | null;
  httpGet: HttpGet;
}): Promise<{
  status: "ok" | "failed";
  data: unknown;
  error?: string;
  costUsd: number;
  pages: number;
  advertiserQueries: number;
}> {
  const payloads: unknown[] = [];
  let costUsd = 0;
  let nextPageToken: string | null = null;
  let lastError = "";
  let advertiserQueries = 0;

  for (let page = 0; page < MAX_TRANSPARENCY_PAGES; page++) {
    const res = await fetchTransparency({
      domain: params.domain,
      apiKey: params.apiKey,
      region: params.region,
      nextPageToken,
      deps: { httpGet: params.httpGet },
    });
    costUsd += res.costUsd;
    if (res.status !== "ok") {
      lastError = res.error ?? "failed";
      break;
    }
    payloads.push(res.data);
    nextPageToken = getNextPageToken(res.data);
    if (!nextPageToken) break;
  }

  if (payloads.length === 0) {
    return {
      status: "failed",
      data: null,
      error: lastError || "failed",
      costUsd,
      pages: 0,
      advertiserQueries: 0,
    };
  }

  const advertiserIds = collectOfficialTransparencyAdvertiserIds(
    mergeTransparencyPayloads(payloads),
    params.domain,
  );
  for (const advertiserId of advertiserIds.slice(0, MAX_TRANSPARENCY_ADVERTISER_EXPANSIONS)) {
    const res = await fetchTransparency({
      domain: params.domain,
      advertiserId,
      platform: "SEARCH",
      creativeFormat: "text",
      region: params.region,
      apiKey: params.apiKey,
      deps: { httpGet: params.httpGet },
    });
    costUsd += res.costUsd;
    advertiserQueries += 1;
    if (res.status === "ok") payloads.push(res.data);
  }

  return {
    status: "ok",
    data: mergeTransparencyPayloads(payloads),
    costUsd,
    pages: payloads.length,
    advertiserQueries,
  };
}

async function fetchGoogleAdsMatrix(params: {
  brandToken: string;
  domain: string;
  countryParams: ReturnType<typeof countryToParams>;
  apiKey: string;
  httpGet: HttpGet;
}): Promise<{
  brandOwnAds: AdEntry[];
  nonBrandAds: AdEntry[];
  status: "ok" | "failed";
  warnings: string[];
  costUsd: number;
  queryCount: number;
  adCount: number;
  queries: string[];
}> {
  const queries = buildGoogleAdsQueries(params.brandToken);
  const brandOwnAds: AdEntry[] = [];
  const nonBrandAds: AdEntry[] = [];
  const seenOwn = new Set<string>();
  const seenNonBrand = new Set<string>();
  const warnings: string[] = [];
  let costUsd = 0;
  let queryCount = 0;
  let okCount = 0;
  let adCount = 0;

  for (const q of queries) {
    for (const device of GOOGLE_ADS_DEVICES) {
      queryCount += 1;
      const res = await fetchGoogleAds({
        q,
        countryParams: params.countryParams,
        apiKey: params.apiKey,
        device,
        deps: { httpGet: params.httpGet },
      });
      costUsd += res.costUsd;
      if (res.status !== "ok") {
        warnings.push(`google_ads failed: q=${q}, device=${device}, error=${res.error ?? "unknown"}`);
        continue;
      }
      okCount += 1;
      const derived = deriveCountrySnapshot(res.data, params.domain);
      adCount += derived.brand_own_ads.length + derived.non_brand_ads.length;
      for (const ad of derived.brand_own_ads) pushUniqueAd(brandOwnAds, seenOwn, ad);
      for (const ad of derived.non_brand_ads) pushUniqueAd(nonBrandAds, seenNonBrand, ad);
    }
  }

  return {
    brandOwnAds,
    nonBrandAds,
    status: okCount > 0 ? "ok" : "failed",
    warnings,
    costUsd,
    queryCount,
    adCount,
    queries,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function stringifyText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => stringifyText(item))
      .filter(Boolean)
      .join(" ")
      .trim();
  }
  return "";
}

function normalizeSitelinks(...values: unknown[]): { title: string }[] {
  return values
    .flatMap((value) => asArray(value))
    .map((value) => {
      if (typeof value === "string") return { title: value };
      return value;
    })
    .filter((value): value is { title: string } => {
      const obj = asObject(value);
      return typeof obj?.title === "string" && obj.title.trim().length > 0;
    });
}

function normalizeTransparencyCreative(creative: unknown, fallbackDomain: string): AdEntry | null {
  const c = asObject(creative);
  if (!c) return null;

  const title = firstString(
    c.headline,
    c.long_headline,
    c.title,
    c.ad_title,
  );
  const description = firstString(
    c.description,
    c.body,
    c.snippet,
    c.text,
    c.ad_creative_body,
    c.creative_text,
    c.call_to_action,
    stringifyText(c.snippets),
  );
  if (!title && !description) return null;

  return normalizeAdEntry({
    title,
    description,
    displayed_link: firstString(
      c.displayed_link,
      c.displayed_url,
      c.visible_link,
      c.target_domain,
      c.domain,
    ),
    link: firstString(c.link, c.final_url, c.url, fallbackDomain),
    sitelinks: normalizeSitelinks(c.sitelinks, c.sitelink_texts),
  });
}

function collectTransparencyAds(rawTransparency: unknown, fallbackDomain: string): AdEntry[] {
  const root = asObject(rawTransparency);
  const creatives = asArray(root?.ad_creatives);
  return creatives
    .map((creative) => normalizeTransparencyCreative(creative, fallbackDomain))
    .filter((creative): creative is AdEntry => creative !== null);
}

/**
 * 将 Transparency 创意按展示域名拆成 brand_own / non_brand，与 SERP 派生逻辑一致。
 */
export function partitionTransparencyAdsByDomain(
  ads: AdEntry[],
  brandDomain: string,
): { brandOwnAds: AdEntry[]; nonBrandAds: AdEntry[] } {
  const brandOwnAds: AdEntry[] = [];
  const nonBrandAds: AdEntry[] = [];
  for (const ad of ads) {
    const displayed = (ad.displayed_url ?? ad.link ?? "").trim();
    if (isBrandOwnUrl(displayed, brandDomain)) {
      brandOwnAds.push(ad);
    } else {
      nonBrandAds.push(ad);
    }
  }
  return { brandOwnAds, nonBrandAds };
}

function getNextPageToken(raw: unknown): string | null {
  const root = asObject(raw);
  const pagination = asObject(root?.serpapi_pagination);
  return cleanText(pagination?.next_page_token) ?? cleanText(root?.next_page_token);
}

function transparencyAdvertiserId(creative: unknown): string | null {
  const c = asObject(creative);
  return cleanText(c?.advertiser_id) ?? cleanText(c?.advertiserId);
}

function isOfficialTransparencyAdvertiserCandidate(
  creative: unknown,
  brandDomain: string,
): boolean {
  const c = asObject(creative);
  if (!c) return false;
  const target = firstString(c.target_domain, c.domain, c.visible_link, c.displayed_url);
  if (target && isBrandOwnUrl(target, brandDomain)) return true;

  const brandToken = extractBrandName(brandDomain)?.toLowerCase();
  const advertiser = firstString(c.advertiser, c.advertiser_name).toLowerCase();
  return Boolean(brandToken && advertiser.includes(brandToken));
}

function collectOfficialTransparencyAdvertiserIds(
  rawTransparency: unknown,
  brandDomain: string,
): string[] {
  const root = asObject(rawTransparency);
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const creative of asArray(root?.ad_creatives)) {
    const id = transparencyAdvertiserId(creative);
    if (!id || seen.has(id)) continue;
    if (!isOfficialTransparencyAdvertiserCandidate(creative, brandDomain)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function creativeArray(raw: unknown): unknown[] {
  return asArray(asObject(raw)?.ad_creatives);
}

function mergeTransparencyPayloads(payloads: unknown[]): unknown {
  const first = asObject(payloads[0]) ?? {};
  return {
    ...first,
    ad_creatives: payloads.flatMap((payload) => creativeArray(payload)),
  };
}

function adKey(ad: AdEntry): string {
  return [
    ad.title.trim().toLowerCase(),
    ad.description.trim().toLowerCase(),
    ad.displayed_url.trim().toLowerCase(),
  ].join("|");
}

function pushUniqueAd(out: AdEntry[], seen: Set<string>, ad: AdEntry) {
  if (!ad.title.trim() && !ad.description.trim()) return;
  const key = adKey(ad);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(ad);
}

function buildGoogleAdsQueries(brandToken: string): string[] {
  const brand = brandToken.trim();
  return [
    brand,
    `${brand} official`,
    `${brand} coupon`,
    `${brand} discount`,
    `${brand} sale`,
    `${brand} online`,
  ];
}

function hasUsableCreative(row: BrandAssessmentAdsRow): boolean {
  return collectCreativeSamples(collectAds(row)).length > 0;
}

function hasFilterMinimumCandidatePool(row: BrandAssessmentAdsRow, domain: string): boolean {
  const source = buildCompetitorSourceFromBrandAssessment({ domain, row });
  return (
    source.dedupedTitles.length >= FILTER_MIN_TITLES &&
    source.dedupedDescriptions.length >= FILTER_MIN_DESCRIPTIONS
  );
}

function canUseBrandAssessmentRow(
  row: BrandAssessmentAdsRow,
  domain: string,
  generationMode?: "filter" | "ai_generate" | null,
): boolean {
  if (!hasUsableCreative(row)) return false;
  if (generationMode === "filter") {
    return hasFilterMinimumCandidatePool(row, domain);
  }
  return true;
}

function moneyToNumber(value: MoneyLike | undefined): number {
  if (value == null) return Number.POSITIVE_INFINITY;
  if (typeof value === "number") return value;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * 生产用 httpGet：走 SerpApi 共享池，撞额度自动换 key。
 *
 * 一次兜底最多要打几十个 SerpApi 请求（6 个品牌词 × 2 种设备，再加 transparency 翻页
 * 与创意详情），中途把某个 key 的额度打满是常态，不换 key 就会整单失败。
 */
async function createDefaultHttpGet(initialKey: string): Promise<HttpGet> {
  const { createPooledSerpApiHttpGet } = await import("@/lib/serpapi-key-pool");
  return createPooledSerpApiHttpGet({ initialKey });
}

/**
 * D-233：kyads 把 SerpApi 单 key 和每日预算都存在它自己的 `ai_model_configs` 一行里。
 * CRM 侧 SerpApi 是**多 key 共享池**（user_serpapi_keys，额度耗尽自动冷却换 key），
 * 每日预算存 system_configs。这里按 CRM 的口径取，不再引入第二套 key 存储。
 */
const defaultSerpApiConfigReader: SerpApiConfigReader = async () => {
  const [{ getPoolKeys }, { readDailyBudgetUsd }] = await Promise.all([
    import("@/lib/serpapi-key-pool"),
    import("@/lib/rival-intel/brand-assessment/repository"),
  ]);
  const keys = await getPoolKeys();
  const budget = await readDailyBudgetUsd();
  return {
    serpapi_key: keys[0] ?? null,
    daily_brand_budget_usd: Number.isFinite(budget) ? budget : null,
  };
};

const defaultGetTodayTotalUsd = async (params: { now: Date }): Promise<number> => {
  const { getTodayTotalUsd } = await import("@/lib/rival-intel/brand-assessment/repository");
  return getTodayTotalUsd(params);
};

const defaultAddCostLedger = async (params: {
  ledgerDate: Date;
  amountUsd: number;
}): Promise<void> => {
  const { addCostLedger } = await import("@/lib/rival-intel/brand-assessment/repository");
  await addCostLedger({ ...params, provider: "serpapi" });
};

const defaultPersistFallbackResult: PersistFallbackResult = async (input) => {
  const { upsertResult } = await import("@/lib/rival-intel/brand-assessment/repository");
  await upsertResult({
    userId: input.userId ?? null,
    jobId: BigInt(0),
    domain: input.domain,
    country: input.country,
    brandToken: input.brandToken,
    countrySnapshot: input.countrySnapshot,
    brandLevel: input.brandLevel,
    brandOwnAds: input.brandOwnAds,
    nonBrandAds: input.nonBrandAds,
    trends: null,
    transparency: input.transparency,
    autocompleteVariants: [],
    engineStatus: input.engineStatus,
    llmOutput: null,
    warnings: input.warnings,
    source: "fresh",
    serpapiCostUsd: input.serpapiCostUsd,
    llmCostUsd: 0,
    ttlExpiresAt: new Date(input.now.getTime() + FALLBACK_TTL_MS),
  });
};

export const defaultBrandAssessmentReader: BrandAssessmentReader = async ({
  domain,
  country,
}) => {
  const { prisma } = await import("@/lib/prisma");
  const row = await prisma.brand_assessment_results.findFirst({
    where: { domain, country, is_deleted: 0 },
    orderBy: { created_at: "desc" },
    select: {
      domain: true,
      brand_token: true,
      llm_output: true,
      brand_own_ads: true,
      non_brand_ads: true,
      // 2026-05-16: 修复 fetchTransparency 后该字段开始有数据，
      // 命中分支需要它来补 nonBrandAds。
      transparency: true,
    },
  });
  if (!row) return null;
  return {
    domain: row.domain,
    brandToken: row.brand_token,
    llmOutput: row.llm_output,
    brandOwnAds: (row.brand_own_ads as AdEntry[] | null) ?? [],
    nonBrandAds: (row.non_brand_ads as AdEntry[] | null) ?? [],
    transparency: row.transparency,
  };
};

export async function fetchCompetitorFromBrandAssessment(
  input: {
    domain: string;
    countryCode: string;
    /** 仅审计：记下谁最早为这个 (域名, 国家) 付的钱 */
    userId?: bigint;
    generationMode?: "filter" | "ai_generate" | null;
  },
  deps: {
    reader?: BrandAssessmentReader;
    configReader?: SerpApiConfigReader;
    httpGet?: HttpGet;
    now?: () => Date;
    getTodayTotalUsd?: (params: { now: Date }) => Promise<number>;
    addCostLedger?: (params: { ledgerDate: Date; amountUsd: number }) => Promise<void>;
    persistFallbackResult?: PersistFallbackResult;
  } = {},
): Promise<CompetitorSourceResult> {
  const reader = deps.reader ?? defaultBrandAssessmentReader;
  const domain = normalizeDomain(input.domain);
  if (!domain) throw new Error(`无法规范化域名：${input.domain}`);

  const country = normalizeCountryCode(input.countryCode);
  let row: BrandAssessmentAdsRow | null = null;
  for (const lookupCountry of countryLookupCodes(country)) {
    row = await reader({ domain, country: lookupCountry });
    if (row && canUseBrandAssessmentRow(row, domain, input.generationMode)) break;
    row = null;
  }

  if (row) {
    return buildCompetitorSourceFromBrandAssessment({ domain, row });
  }

  const configReader = deps.configReader ?? defaultSerpApiConfigReader;
  const cfg = await configReader();
  const apiKey = cfg?.serpapi_key?.trim();
  if (!apiKey) {
    throw new Error("SerpApi key 未配置，无法在缺少品牌评估时拉取竞品创意");
  }

  const userId = input.userId;
  const now = deps.now ? deps.now() : new Date();
  // 预算门控改成全公司一本账：钱是公司出的，按人分摊起不到控总额的作用。
  // 未配置 brand_intel_daily_budget_usd 时 moneyToNumber 得到 Infinity，即不设限。
  const budget = moneyToNumber(cfg?.daily_brand_budget_usd);
  if (Number.isFinite(budget)) {
    const getTodayTotalUsd = deps.getTodayTotalUsd ?? defaultGetTodayTotalUsd;
    const usedToday = await getTodayTotalUsd({ now });
    if (usedToday + SERPAPI_FALLBACK_ESTIMATED_COST_USD > budget) {
      throw new Error(
        `daily cost cap exceeded: used=${usedToday} + est=${SERPAPI_FALLBACK_ESTIMATED_COST_USD} > cap=${budget}`,
      );
    }
  }

  const brandToken = extractBrandName(domain);
  if (!brandToken) throw new Error(`无法从域名提取品牌词：${domain}`);

  const countryParams = countryToParams(country);
  const transparencyRegion = String(countryCodeToDataForSeoParams(country).locationCode);
  const httpGet = deps.httpGet ?? (await createDefaultHttpGet(apiKey));
  const googleAdsRes = await fetchGoogleAdsMatrix({
    brandToken,
    domain,
    countryParams,
    apiKey,
    httpGet,
  });
  const transparencyRes = await fetchTransparencyDeep({
    domain,
    apiKey,
    region: transparencyRegion,
    httpGet,
  });

  const serpCost = roundCost(googleAdsRes.costUsd + transparencyRes.costUsd);
  const serp_snapshot = {
    google_ads_queries: googleAdsRes.queryCount,
    google_ads_ads: googleAdsRes.adCount,
  };
  const rawTransparency = transparencyRes.status === "ok" ? transparencyRes.data : null;
  const brandLevel = deriveBrandLevel(null, rawTransparency);
  const transparencyAds = rawTransparency
    ? collectTransparencyAds(rawTransparency, domain)
    : [];

  // D-273.4：透明中心把文本广告渲染成图片存档，文案提不出来的那批只能识图取。
  // 识图挂了不能连累整条竞品拉取——这里拿到的本来就是「原本要丢弃」的创意。
  const warnings: string[] = [...googleAdsRes.warnings];
  let copyOcrAds: AdEntry[] = [];
  let copyOcrStats: Awaited<ReturnType<typeof recoverCopyFromImageCreatives>>["stats"] | null = null;
  if (rawTransparency) {
    try {
      const recovered = await recoverCopyFromImageCreatives(creativeArray(rawTransparency), domain);
      copyOcrAds = recovered.ads;
      copyOcrStats = recovered.stats;
      warnings.push(...recovered.warnings);
    } catch (err) {
      warnings.push(`创意文案识图失败: ${(err as Error).message}`.slice(0, 200));
    }
  }

  const partitionedTransparency = partitionTransparencyAdsByDomain(
    [...transparencyAds, ...copyOcrAds],
    domain,
  );
  const brandOwnAds = [...googleAdsRes.brandOwnAds, ...partitionedTransparency.brandOwnAds];
  const nonBrandAds = [...googleAdsRes.nonBrandAds, ...partitionedTransparency.nonBrandAds];
  if (transparencyRes.status !== "ok") {
    warnings.push(`transparency failed: ${transparencyRes.error ?? "unknown"}`);
  }
  const publishableAds = transparencyAds.length + copyOcrAds.length;
  const collectionStats: CompetitorCollectionStats = {
    transparencyPages: transparencyRes.pages,
    transparencyCreatives: publishableAds,
    transparencyPublishableAds: publishableAds,
    transparencyInspirationOnly: Math.max(
      0,
      creativeArray(rawTransparency).length - publishableAds,
    ),
    transparencyAdvertiserQueries: transparencyRes.advertiserQueries,
    copyOcrAttempted: copyOcrStats?.attempted,
    copyOcrCacheHits: copyOcrStats?.cacheHits,
    copyOcrRecovered: copyOcrStats?.recovered,
    copyOcrShoppingSkipped: copyOcrStats?.shoppingSkipped,
    copyOcrMisalignedRetries: copyOcrStats?.misalignedRetries,
    googleAdsQueries: googleAdsRes.queryCount,
    googleAdsAds: googleAdsRes.adCount,
    serpapiCostUsd: serpCost,
    queries: googleAdsRes.queries,
  };

  // SerpApi 失败也计费（它按调用扣），所以记账不能跟成功与否挂钩，也不再依赖有没有 userId。
  const addCostLedger = deps.addCostLedger ?? defaultAddCostLedger;
  await addCostLedger({ ledgerDate: now, amountUsd: serpCost });

  if (googleAdsRes.status !== "ok" && transparencyRes.status !== "ok") {
    const { isMonthlyQuotaError } = await import("@/lib/serpapi-key-pool");
    const allFailures = [...warnings, transparencyRes.error ?? ""].join(" | ");
    if (isMonthlyQuotaError(allFailures)) {
      throw new Error(
        "SerpApi 额度已耗尽：池内每个 Key 都打满了本月配额（免费版 250 次/月），" +
          "已自动逐个换过仍无可用额度。请联系管理员在「管理员控制台 → SerpApi Key 池」补充可用 Key，或等下个计费周期。",
      );
    }
    throw new Error(
      `缺少可用品牌评估创意，且 SerpApi 竞品创意拉取失败：google_ads=failed, transparency=${transparencyRes.error ?? "failed"}`,
    );
  }

  {
    const persistFallbackResult = deps.persistFallbackResult ?? defaultPersistFallbackResult;
    await persistFallbackResult({
      userId,
      domain,
      country,
      brandToken,
      countrySnapshot: serp_snapshot,
      brandLevel,
      brandOwnAds,
      nonBrandAds,
      transparency: (brandLevel as { transparency: unknown }).transparency,
      engineStatus: {
        serp: googleAdsRes.status === "ok" ? "ok" : "failed",
        trends: "skipped",
        transparency: transparencyRes.status === "ok" ? "ok" : "failed",
        autocomplete: "skipped",
        llm: "skipped",
      },
      warnings,
      serpapiCostUsd: serpCost,
      now,
    });
  }

  return buildCompetitorSourceFromBrandAssessment({
    domain,
    row: {
      domain,
      brandToken,
      brandOwnAds,
      nonBrandAds,
      collectionStats,
    },
  });
}
