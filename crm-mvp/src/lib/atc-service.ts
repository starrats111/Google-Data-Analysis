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

// ─── SerpApi 调用 ───

interface SerpApiAd {
  advertiser_id?: string;
  advertiser_name?: string;
  format?: string;
  title?: string;
  domain?: string;
  first_shown?: string;
  last_shown?: string;
  thumbnail?: string;
}

interface SerpApiResponse {
  ads?: SerpApiAd[];
  error?: string;
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
  serpApiKey: string;
  forceRefresh?: boolean;
}): Promise<AtcMerchantResult> {
  const { merchantId, merchantName, domain, region = "US", serpApiKey, forceRefresh = false } = opts;

  // 1. 检查团队共享缓存
  if (!forceRefresh) {
    const cached = await prisma.merchant_atc_snapshots.findUnique({
      where: { uk_domain_region: { domain, region } },
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
    const data = await callSerpApi(
      { engine: "google_ads_transparency_center", domain, region, num: "100" },
      serpApiKey
    );

    if (data.error) throw new Error(data.error);

    const ads: SerpApiAd[] = data.ads ?? [];

    // 4. 去重广告主
    const advertiserMap = new Map<string, string>();
    const sampleAds: AtcAd[] = [];
    for (const ad of ads) {
      const advId = ad.advertiser_id ?? "";
      const advName = ad.advertiser_name ?? "";
      if (advId && !advertiserMap.has(advId)) {
        advertiserMap.set(advId, advName);
      }
      if (sampleAds.length < 10) {
        sampleAds.push({
          format: ad.format ?? "text",
          title: ad.title,
          domain: ad.domain,
          first_shown: ad.first_shown,
          last_shown: ad.last_shown,
          thumbnail: ad.thumbnail,
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
      where: { uk_domain_region: { domain, region } },
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
  serpApiKey: string;
}): Promise<AtcIntelligenceResult> {
  const { text, region = "US", serpApiKey } = opts;

  const data = await callSerpApi(
    { engine: "google_ads_transparency_center", text, region, num: "100" },
    serpApiKey
  );

  if (data.error) throw new Error(data.error);

  const ads: SerpApiAd[] = data.ads ?? [];

  // 按广告主分组
  const advertiserAdsMap = new Map<string, { name: string; ads: AtcAd[] }>();
  for (const ad of ads) {
    const advId = ad.advertiser_id ?? `unknown_${Math.random()}`;
    const advName = ad.advertiser_name ?? "未知广告主";
    if (!advertiserAdsMap.has(advId)) {
      advertiserAdsMap.set(advId, { name: advName, ads: [] });
    }
    advertiserAdsMap.get(advId)!.ads.push({
      format: ad.format ?? "text",
      title: ad.title,
      domain: ad.domain,
      first_shown: ad.first_shown,
      last_shown: ad.last_shown,
      thumbnail: ad.thumbnail,
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
