/**
 * 纯函数层：SerpApi 原始响应 → Prompt v2 可消费的 derived 结构。
 *
 * 所有函数都无 I/O、无重试、无随机。Python 参考实现：
 *   reusable/brand_serp/brand_signal_collector.py
 *     derive_country_snapshot / derive_brand_level /
 *     _normalize_ad_entry / _pixel_y / _trend_direction /
 *     transparency_advertised_in
 */

import { isBrandOwnUrl } from "./brand-extract";
import type {
  AdEntry,
  AdSitelink,
  BrandLevel,
  CountrySnapshot,
  TrendDirection,
  TrendsData,
  TransparencyCreativeStats,
} from "./types";

const FOLD_Y_PIXELS = 800;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

function asObject(
  v: unknown,
): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * 返回一个 SERP 元素的 `pixel_position.y`；不存在返回 null。
 */
export function pixelY(entry: unknown): number | null {
  const obj = asObject(entry);
  if (!obj) return null;
  const px = asObject(obj.pixel_position);
  if (!px) return null;
  const y = px.y;
  if (typeof y === "number" && Number.isFinite(y)) return Math.trunc(y);
  return null;
}

/**
 * 归一化单条 SerpApi 广告对象为 Prompt v2 广告条目形状。
 *
 * 保留完整 creative 信息（title / description / 每条 sitelink title+snippet /
 * callouts / price / promotion 扩展 / 原始 extensions 数组）以便下游 LLM
 * 同时做投放评分 + 文案分析。
 */
export function normalizeAdEntry(ad: unknown): AdEntry {
  const a = asObject(ad) ?? {};

  const sitelinks: AdSitelink[] = [];
  for (const sl of asArray(a.sitelinks)) {
    const slObj = asObject(sl);
    if (!slObj) continue;
    const title = asString(slObj.title).trim();
    if (!title) continue;
    let snippet: string | null = null;
    const snippets = asArray(slObj.snippets);
    if (snippets.length > 0) {
      snippet = asString(snippets[0]).trim() || null;
    } else if (typeof slObj.snippet === "string") {
      snippet = slObj.snippet.trim() || null;
    }
    sitelinks.push({ title, snippet });
  }

  const extensionsRaw = asArray(a.extensions);
  const callouts: string[] = [];
  for (const e of extensionsRaw) {
    if (typeof e === "string" && e.trim()) {
      callouts.push(e.trim());
    }
  }

  const py = pixelY(a);

  return {
    title: asString(a.title).trim(),
    description: asString(a.description).trim(),
    displayed_url: asString(a.displayed_link).trim(),
    link: asString(a.link).trim(),
    block_position:
      typeof a.block_position === "string" ? a.block_position : null,
    position: typeof a.position === "number" ? a.position : null,
    sitelinks,
    sitelinks_count: sitelinks.length,
    callouts,
    callouts_count: callouts.length,
    price_extension: a.price ?? null,
    promotion_extension: a.promotion ?? null,
    extensions_raw: extensionsRaw,
    pixel_position_y: py,
    above_the_fold: py !== null && py < FOLD_Y_PIXELS,
  };
}

/**
 * 从 SerpApi `engine=google` 原始响应派生国家层面的 Prompt v2 输入结构。
 * 同时返回 `brand_own_ads` / `non_brand_ads`，方便后续展示与 LLM 消费。
 */
export function deriveCountrySnapshot(
  rawSerp: unknown,
  brandDomain: string,
  foldY: number = FOLD_Y_PIXELS,
): {
  serp_snapshot: CountrySnapshot;
  brand_own_ads: AdEntry[];
  non_brand_ads: AdEntry[];
} {
  const root = asObject(rawSerp) ?? {};
  const localAdsBlock = asObject(root.local_ads);
  const ads = [
    ...asArray(root.ads),
    ...(localAdsBlock ? asArray(localAdsBlock.ads) : []),
  ];
  const shopping = asArray(root.shopping_results);
  const organic = asArray(root.organic_results);
  const searchInfo = asObject(root.search_information) ?? {};

  let adsTop = 0;
  let adsBottom = 0;
  let brandOwnCount = 0;
  let aboveFoldCount = 0;
  let aboveFoldBrandOwn = false;
  const brandOwnAds: AdEntry[] = [];
  const nonBrandAds: AdEntry[] = [];

  for (const ad of ads) {
    const adObj = asObject(ad);
    if (!adObj) continue;
    const displayed = asString(adObj.displayed_link);
    const isOwn = isBrandOwnUrl(displayed, brandDomain);
    const normalized = normalizeAdEntry(ad);
    if (isOwn) {
      brandOwnCount += 1;
      brandOwnAds.push(normalized);
    } else {
      nonBrandAds.push(normalized);
    }
    if (adObj.block_position === "top") adsTop += 1;
    if (adObj.block_position === "bottom") adsBottom += 1;

    const py = pixelY(adObj);
    if (py !== null && py < foldY) {
      aboveFoldCount += 1;
      if (isOwn) aboveFoldBrandOwn = true;
    }
  }

  const top1 = asObject(organic[0]);
  const top1Displayed = asString(top1?.displayed_link);
  let top1SitelinksCount = 0;
  const top1Sitelinks = top1?.sitelinks;
  if (Array.isArray(top1Sitelinks)) {
    top1SitelinksCount = top1Sitelinks.length;
  } else if (asObject(top1Sitelinks)) {
    const s = asObject(top1Sitelinks)!;
    const inline = asArray(s.inline).length;
    const expanded = asArray(s.expanded).length;
    top1SitelinksCount = inline + expanded;
  }

  let totalResults = 0;
  const tr = searchInfo.total_results;
  if (typeof tr === "number") totalResults = Math.trunc(tr);
  else if (typeof tr === "string") {
    const n = parseInt(tr.replace(/[^0-9]/g, ""), 10);
    totalResults = Number.isFinite(n) ? n : 0;
  }

  const snapshot: CountrySnapshot = {
    ads_top_count: adsTop,
    ads_bottom_count: adsBottom,
    brand_own_ads_count: brandOwnCount,
    non_brand_ads_count: Math.max(0, ads.length - brandOwnCount),
    shopping_block_present: shopping.length > 0,
    shopping_ads_count: shopping.length,
    knowledge_graph_present: Boolean(root.knowledge_graph),
    answer_box_present: Boolean(root.answer_box),
    local_pack_present: Boolean(root.local_results || root.local_map),
    top_story_present: Boolean(root.top_stories),
    video_block_present: Boolean(root.inline_videos),
    organic_top1_is_brand: isBrandOwnUrl(top1Displayed, brandDomain),
    organic_top1_sitelinks_count: top1SitelinksCount,
    total_results: totalResults,
    above_the_fold_ad_count: aboveFoldCount,
    above_the_fold_brand_own: aboveFoldBrandOwn,
    organic_top1_pixel_y: top1 ? pixelY(top1) : null,
  };

  return {
    serp_snapshot: snapshot,
    brand_own_ads: brandOwnAds,
    non_brand_ads: nonBrandAds,
  };
}

/**
 * 用 "头 1/3 vs 尾 1/3" 均值 ±15% 阈值判断 Google Trends 方向。
 *
 *   - >15% → rising
 *   - <-15% → declining
 *   - 其余 → stable
 *
 * `head=0` 时 fallback：有 tail > 0 → rising，否则 stable（避免除零）。
 * 点数 < 3 直接 "stable"。
 */
export function trendDirection(values: number[]): TrendDirection {
  if (!Array.isArray(values) || values.length < 3) return "stable";
  const third = Math.max(1, Math.floor(values.length / 3));
  const head =
    values.slice(0, third).reduce((a, b) => a + b, 0) / third;
  const tail =
    values.slice(-third).reduce((a, b) => a + b, 0) / third;
  if (head === 0) return tail > 0 ? "rising" : "stable";
  const delta = (tail - head) / head;
  if (delta > 0.15) return "rising";
  if (delta < -0.15) return "declining";
  return "stable";
}

/**
 * 从 SerpApi Trends + Transparency 原始响应派生 "域名级" 信号。
 *
 * 其中 `trends`/`transparency` 任一 null → 对应半边产出 null（不是空对象）。
 * 这样上游能区分 "数据缺失" vs "数据为空但确已采集到"。
 */
export function deriveBrandLevel(
  rawTrends: unknown,
  rawTransparency: unknown,
): BrandLevel {
  let trendsOut: TrendsData | null = null;
  const tr = asObject(rawTrends);
  if (tr) {
    const iot = asObject(tr.interest_over_time);
    const timeline = asArray(iot?.timeline_data);

    const series: number[] = [];
    const peaks: Record<string, number> = {};
    let latest: number | null = null;

    for (const point of timeline) {
      const p = asObject(point);
      if (!p) continue;
      const values = asArray(p.values);
      const v0 = asObject(values[0]);
      const v = v0?.extracted_value;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const iv = Math.trunc(v);
      series.push(iv);
      latest = iv;
      const date = asString(p.date);
      for (let idx = 0; idx < MONTH_NAMES.length; idx++) {
        const mm = `-${String(idx + 1).padStart(2, "0")}`;
        if (date.includes(mm)) {
          const name = MONTH_NAMES[idx]!;
          peaks[name] = Math.max(peaks[name] ?? 0, iv);
          break;
        }
      }
    }

    let peakMonth = "";
    let peakVal = -1;
    for (const [k, v] of Object.entries(peaks)) {
      if (v > peakVal) {
        peakMonth = k;
        peakVal = v;
      }
    }

    const regions = asArray(tr.interest_by_region)
      .map((r) => asObject(r))
      .filter((r): r is Record<string, unknown> => r !== null)
      .sort(
        (a, b) =>
          Number(b.extracted_value ?? 0) - Number(a.extracted_value ?? 0),
      )
      .slice(0, 5)
      .map((r) => ({
        region: asString(r.location),
        value: Number(r.extracted_value ?? 0) | 0,
      }));

    trendsOut = {
      interest_score_0_100: latest ?? 0,
      trend_direction: trendDirection(series),
      seasonality_peak_month: peakMonth,
      interest_by_region_top5: regions,
    };
  }

  let transparencyOut: TransparencyCreativeStats | null = null;
  const rp = asObject(rawTransparency);
  if (rp) {
    const creatives = asArray(rp.ad_creatives);
    const platforms = new Set<string>();
    const firstDates: string[] = [];
    const lastDates: string[] = [];

    for (const c of creatives) {
      const co = asObject(c);
      if (!co) continue;
      if (typeof co.platform === "string" && co.platform)
        platforms.add(co.platform);
      if (typeof co.first_shown === "string") firstDates.push(co.first_shown);
      if (typeof co.last_shown === "string") lastDates.push(co.last_shown);
    }

    let historyDays = 0;
    if (firstDates.length > 0 && lastDates.length > 0) {
      const firsts = firstDates
        .map((d) => Date.parse(d))
        .filter(Number.isFinite);
      const lasts = lastDates
        .map((d) => Date.parse(d))
        .filter(Number.isFinite);
      if (firsts.length > 0 && lasts.length > 0) {
        const first = Math.min(...firsts);
        const last = Math.max(...lasts);
        historyDays = Math.max(
          0,
          Math.floor((last - first) / (1000 * 60 * 60 * 24)),
        );
      }
    }

    let refresh = 0;
    if (historyDays > 0 && creatives.length > 0) {
      const months = Math.max(1, historyDays / 30);
      refresh = Math.round((creatives.length / months) * 100) / 100;
    }

    transparencyOut = {
      brand_advertised_in_country: null,
      brand_ads_history_days: historyDays,
      creative_refresh_per_month: refresh,
      platforms: [...platforms].sort(),
    };
  }

  return { trends: trendsOut, transparency: transparencyOut };
}

/**
 * 判断 ads transparency 响应里是否有在指定国家投放的 creative。
 * 未知国家 = "未投放"（绝不凭空假设覆盖）。
 */
export function transparencyAdvertisedIn(
  country: string,
  rawTransparency: unknown,
): boolean {
  const obj = asObject(rawTransparency);
  if (!obj) return false;
  const creatives = asArray(obj.ad_creatives);
  const target = country.trim().toUpperCase();
  for (const c of creatives) {
    const co = asObject(c);
    if (!co) continue;
    const regions = asArray(co.regions_shown).map((r) =>
      asString(r).trim().toUpperCase(),
    );
    if (regions.includes(target)) return true;
  }
  return false;
}

/**
 * 把 derive 结果打包为 LLM input 的 JSON payload。
 *
 * **不能泄露任何凭证**（api_key / serpapi_key）——这里只接受 derived 层。
 */
export function compactForLlm(params: {
  domain: string;
  country: string;
  brandToken: string;
  countrySnapshot: CountrySnapshot;
  brandOwnAds: AdEntry[];
  nonBrandAds: AdEntry[];
  brandLevel: BrandLevel;
  autocompleteVariants: Array<{ seed: string; suggestion: string }>;
  engineStatus: Record<string, string>;
}): Record<string, unknown> {
  return {
    domain: params.domain,
    country: params.country,
    brand_token: params.brandToken,
    country_snapshot: params.countrySnapshot,
    brand_own_ads: params.brandOwnAds,
    non_brand_ads: params.nonBrandAds,
    brand_level: params.brandLevel,
    autocomplete_variants: params.autocompleteVariants,
    engine_status: params.engineStatus,
    optional_business_metrics: null,
  };
}
