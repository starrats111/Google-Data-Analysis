/**
 * ATC 广告情报服务
 * 封装 SerpApi Google Ads Transparency Center 查询、过滤、缓存逻辑
 */

import prisma from "./prisma";

// ─── 类型定义 ───

export interface AtcAdvertiser {
  id: string;
  name: string;
}

export interface AtcAd {
  format: string;
  title?: string;
  domain?: string;
  first_shown?: string;
  last_shown?: string;
  thumbnail?: string;
}

export interface AtcMerchantResult {
  domain: string;
  region: string;
  rawCount: number;
  realCount: number;
  topAdvertisers: AtcAdvertiser[];
  sampleAds: AtcAd[];
  fetchedAt: Date;
  fromCache: boolean;
}

export interface AtcIntelligenceResult {
  advertisers: Array<{
    id: string;
    name: string;
    adCount: number;
    ads: AtcAd[];
  }>;
  total: number;
}

// ─── 代理商关键词过滤列表 ───
const AGENCY_KEYWORDS = [
  "agency", "media", "marketing", "digital", "advertising",
  "ads", "seo", "sem", "ppc", "performance", "growth",
  "solutions", "services", "consulting", "studio", "creative",
  "partners", "group", "associates",
];

// ─── 工具函数 ───

function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function levenshteinSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  const maxLen = Math.max(m, n);
  return maxLen === 0 ? 1 : 1 - dp[m][n] / maxLen;
}

function isMerchantSelf(advertiserName: string, merchantName: string): boolean {
  const a = normalize(advertiserName);
  const m = normalize(merchantName);
  if (!a || !m) return false;
  return a.includes(m) || m.includes(a) || levenshteinSimilarity(a, m) > 0.8;
}

function isAgency(advertiserName: string): boolean {
  const lower = advertiserName.toLowerCase();
  return AGENCY_KEYWORDS.some((kw) => lower.includes(kw));
}

export function extractDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const normalized = url.startsWith("http") ? url : `https://${url}`;
    return new URL(normalized).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * 从域名提取品牌词用于 ATC 搜索。
 * 例：ta3swim.com → "ta3swim"，shopbop.com → "shopbop"
 * 多级 TLD（.co.uk / .com.au）也能正确处理。
 */
export function extractBrand(domain: string): string {
  // 去掉端口
  const host = domain.split(":")[0];
  // 去掉已知多级 TLD
  const multiTld = host.match(/^(.+)\.(com\.[a-z]{2}|net\.[a-z]{2}|org\.[a-z]{2}|co\.[a-z]{2})$/i);
  if (multiTld) return multiTld[1].replace(/^www\./, "");
  // 普通域名取最后一个点左边的部分
  const parts = host.split(".");
  return parts.length >= 2 ? parts[parts.length - 2] : host;
}

// ─── 只保留搜索/文字广告 ───
// Google ATC 返回的 format 字段：text / image / video / html5 / display / shopping / app 等
// 只统计搜索广告（文字广告）对应的广告主，排除展示/视频/购物广告
function isSearchAd(format: string | undefined): boolean {
  if (!format) return true; // 无 format 字段时保留
  const f = format.toLowerCase();
  return f === "text" || f === "text_ad" || f === "search" || !["image", "video", "html5", "display", "shopping", "app"].some((x) => f.includes(x));
}

// ─── SerpApi Region 映射（2 字母 ISO → SerpApi 数字码）───
const REGION_CODE_MAP: Record<string, string> = {
  US: "2840", GB: "2826", AU: "2036", CA: "2124", DE: "2276", FR: "2250",
  IT: "2380", ES: "2724", NL: "2528", SE: "2752", NO: "2578", DK: "2208",
  FI: "2246", PL: "2616", AT: "2040", CH: "2756", BE: "2056", IE: "2372",
  PT: "2620", JP: "2392", SG: "2702", KR: "2410", IN: "2356", NZ: "2554",
  BR: "2076", MX: "2484",
};

/** 将前端传入的 2 字母 ISO 地区码转为 SerpApi 数字码；若已是数字码则原样返回 */
function toSerpApiRegion(region: string | undefined): string | undefined {
  if (!region) return undefined;
  if (/^\d+$/.test(region)) return region; // 已是数字码
  return REGION_CODE_MAP[region.toUpperCase()] ?? undefined;
}

// ─── SerpApi 调用 ───

interface SerpApiAd {
  advertiser_id?: string;
  advertiser?: string;       // SerpApi 实际字段名（非 advertiser_name）
  format?: string;
  title?: string;
  target_domain?: string;    // SerpApi 实际字段名（非 domain）
  first_shown?: number;
  last_shown?: number;
  image?: string;
}

interface SerpApiResponse {
  ad_creatives?: SerpApiAd[]; // SerpApi 实际字段名（非 ads）
  error?: string;
}

// ─── 从 Key 池中随机选一个可用 Key ───
export function pickApiKey(keys: string[]): string {
  const active = keys.filter((k) => k && k.trim());
  if (active.length === 0) throw new Error("请先配置 SerpApi Key");
  return active[Math.floor(Math.random() * active.length)];
}

async function callSerpApi(params: Record<string, string>, apiKey: string): Promise<SerpApiResponse> {
  const qs = new URLSearchParams({ ...params, api_key: apiKey }).toString();
  const res = await fetch(`https://serpapi.com/search?${qs}`, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SerpApi HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<SerpApiResponse>;
}

// ─── 核心：商家竞争度查询（带缓存）───

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

export async function queryMerchantAtc(opts: {
  merchantId: bigint;
  merchantName: string;
  domain: string;
  region?: string;
  serpApiKeys: string[];
  forceRefresh?: boolean;
}): Promise<AtcMerchantResult> {
  const { merchantId, merchantName, domain, region = "US", serpApiKeys, forceRefresh = false } = opts;
  const serpApiKey = pickApiKey(serpApiKeys);

  // 1. 检查团队共享缓存
  if (!forceRefresh) {
    const cached = await prisma.merchant_atc_snapshots.findUnique({
      where: { domain_region: { domain, region } },
    });
    if (cached && Date.now() - cached.fetched_at.getTime() < CACHE_TTL_MS) {
      // 缓存命中：更新 user_merchants 统计，不消耗 SerpApi 额度
      await prisma.user_merchants.update({
        where: { id: merchantId },
        data: {
          atc_advertiser_count: cached.real_advertiser_count,
          atc_last_synced_at: cached.fetched_at,
          atc_sync_status: "done",
        },
      });
      return {
        domain,
        region,
        rawCount: cached.raw_advertiser_count,
        realCount: cached.real_advertiser_count,
        topAdvertisers: (cached.top_advertisers_json as AtcAdvertiser[]) ?? [],
        sampleAds: (cached.sample_ads_json as AtcAd[]) ?? [],
        fetchedAt: cached.fetched_at,
        fromCache: true,
      };
    }
  }

  // 2. 标记 syncing
  await prisma.user_merchants.update({
    where: { id: merchantId },
    data: { atc_sync_status: "syncing" },
  });

  try {
    // 3. 调用 SerpApi
    // 用完整域名搜索（ATC 会返回所有指向该域名的广告），日期="昨天"
    // 说明：SerpApi 的"单天"需要 end_date = start_date + 1 天
    const serpRegion = toSerpApiRegion(region);
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const today     = new Date();
    const fmt = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const params: Record<string, string> = {
      engine: "google_ads_transparency_center",
      text: domain,
      platform: "SEARCH",
      start_date: fmt(yesterday),
      end_date:   fmt(today),
      num: "100",
    };
    if (serpRegion) params.region = serpRegion;
    const data = await callSerpApi(params, serpApiKey);

    // "no results" 视为合法的 0 结果，而非错误
    const NO_RESULTS_MSG = "hasn't returned any results";
    if (data.error && !data.error.includes(NO_RESULTS_MSG)) throw new Error(data.error);

    const allAds: SerpApiAd[] = data.ad_creatives ?? [];

    // 4a. 只保留搜索/文字广告（format=text 或无 format）
    const searchAds = allAds.filter((ad) => isSearchAd(ad.format));

    // 4b. 按 advertiser_id 严格去重（优先用 id，无 id 则用 name 去重）
    const advertiserMap = new Map<string, string>(); // id → name
    const seenNames = new Set<string>();             // 无 id 时用 name 去重
    const sampleAds: AtcAd[] = [];

    for (const ad of searchAds) {
      const advId   = (ad.advertiser_id ?? "").trim();
      const advName = (ad.advertiser    ?? "").trim(); // 正确字段名

      if (advId) {
        if (!advertiserMap.has(advId)) advertiserMap.set(advId, advName);
      } else if (advName) {
        const normName = normalize(advName);
        if (!seenNames.has(normName)) {
          seenNames.add(normName);
          advertiserMap.set(`_name_${normName}`, advName);
        }
      }

      if (sampleAds.length < 10) {
        sampleAds.push({
          format: ad.format ?? "text",
          title: ad.title,
          domain: ad.target_domain,    // 正确字段名
          first_shown: ad.first_shown ? String(ad.first_shown) : undefined,
          last_shown:  ad.last_shown  ? String(ad.last_shown)  : undefined,
          thumbnail: ad.image,
        });
      }
    }

    const rawCount = advertiserMap.size;

    // 5. 过滤：排除商家自身 + 排除代理商
    const realAdvertisers: AtcAdvertiser[] = [];
    for (const [id, name] of advertiserMap) {
      if (!isMerchantSelf(name, merchantName) && !isAgency(name)) {
        realAdvertisers.push({ id, name });
      }
    }

    const realCount = realAdvertisers.length;
    const topAdvertisers = realAdvertisers.slice(0, 20);
    const now = new Date();

    // 6. 写入团队缓存
    await prisma.merchant_atc_snapshots.upsert({
      where: { domain_region: { domain, region } },
      create: {
        domain,
        region,
        raw_advertiser_count: rawCount,
        real_advertiser_count: realCount,
        top_advertisers_json: topAdvertisers,
        sample_ads_json: sampleAds,
        fetched_at: now,
      },
      update: {
        raw_advertiser_count: rawCount,
        real_advertiser_count: realCount,
        top_advertisers_json: topAdvertisers,
        sample_ads_json: sampleAds,
        fetched_at: now,
      },
    });

    // 7. 更新 user_merchants
    await prisma.user_merchants.update({
      where: { id: merchantId },
      data: {
        atc_advertiser_count: realCount,
        atc_last_synced_at: now,
        atc_sync_status: "done",
      },
    });

    return {
      domain,
      region,
      rawCount,
      realCount,
      topAdvertisers,
      sampleAds,
      fetchedAt: now,
      fromCache: false,
    };
  } catch (err) {
    await prisma.user_merchants.update({
      where: { id: merchantId },
      data: { atc_sync_status: "error" },
    });
    throw err;
  }
}

// ─── 广告情报：按广告主名称搜索 ───

export async function searchIntelligence(opts: {
  text: string;
  region?: string;
  serpApiKeys: string[];
}): Promise<AtcIntelligenceResult> {
  const { text, region = "US", serpApiKeys } = opts;
  const serpApiKey = pickApiKey(serpApiKeys);

  // 情报搜索：不限平台，用近 30 天范围（让用户能看到广告主全平台投放）
  const serpRegion = toSerpApiRegion(region);
  const endDate2   = new Date(); endDate2.setDate(endDate2.getDate() - 1);   // 昨天
  const startDate2 = new Date(); startDate2.setDate(startDate2.getDate() - 31); // 31 天前
  const fmt2 = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const params: Record<string, string> = {
    engine: "google_ads_transparency_center",
    text,
    // 不加 platform 过滤，允许全平台（Search/Display/YouTube 等）
    start_date: fmt2(startDate2),
    end_date:   fmt2(endDate2),
    num: "100",
  };
  if (serpRegion) params.region = serpRegion;
  const data = await callSerpApi(params, serpApiKey);

  const NO_RESULTS_MSG = "hasn't returned any results";
  if (data.error && !data.error.includes(NO_RESULTS_MSG)) throw new Error(data.error);

  const allAds: SerpApiAd[] = data.ad_creatives ?? [];
  // 情报页展示全部格式的广告
  const ads = allAds;

  // 按广告主分组（严格去重：优先用 advertiser_id）
  const advertiserAdsMap = new Map<string, { name: string; ads: AtcAd[] }>();
  const seenNames = new Set<string>();
  for (const ad of ads) {
    const rawId   = (ad.advertiser_id ?? "").trim();
    const rawName = (ad.advertiser    ?? "未知广告主").trim(); // 正确字段名
    const advId = rawId || `_name_${normalize(rawName)}`;
    if (!rawId) {
      const normName = normalize(rawName);
      if (seenNames.has(normName)) continue;
      seenNames.add(normName);
    }
    if (!advertiserAdsMap.has(advId)) {
      advertiserAdsMap.set(advId, { name: rawName, ads: [] });
    }
    advertiserAdsMap.get(advId)!.ads.push({
      format: ad.format ?? "text",
      title: ad.title,
      domain: ad.target_domain,        // 正确字段名
      first_shown: ad.first_shown ? String(ad.first_shown) : undefined,
      last_shown:  ad.last_shown  ? String(ad.last_shown)  : undefined,
      thumbnail: ad.image,
    });
  }

  const advertisers = Array.from(advertiserAdsMap.entries()).map(([id, v]) => ({
    id,
    name: v.name,
    adCount: v.ads.length,
    ads: v.ads,
  }));

  return {
    advertisers,
    total: ads.length,
  };
}
