/**
 * ATC 广告情报服务
 * 封装 SerpApi Google Ads Transparency Center 查询、过滤、缓存逻辑
 */

import prisma from "./prisma";
import { fetchAdvertiserCreativesDirect, fetchDomainCreativesDirect } from "./atc-direct";
import {
  MAX_KEY_ATTEMPTS,
  getPoolKeys,
  isQuotaError,
  markKeyExhausted,
  markKeyHealthy,
  pickUntriedKey,
} from "./serpapi-key-pool";

// ─── 类型定义 ───

export interface AtcAdvertiser {
  id: string;
  name: string;
}

export interface AtcAd {
  format: string;
  title?: string;
  domain?: string;
  first_shown?: number;  // Unix 秒级时间戳
  last_shown?: number;   // Unix 秒级时间戳
  thumbnail?: string;
  creative_id?: string;  // 内部用于 creative 跨查询匹配，前端可忽略
  /** C-088：domain 缺失但 thumbnail 已入队 OCR，前端显示"识别中..." */
  _ocrPending?: boolean;
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

// C-093 / C-094.1 广告主域名分布快照（同行 vs 品牌自投判定）
//   classification（v2.1 有效同行规则，2026-08-20，07 制定）:
//     - peer        有效同行（近 7 天在投广告 >10 条，且域名重复率 ≤5%）
//     - brand_self  非有效同行（有广告但不满足上述条件，多为品牌自投/小规模投放）
//     - pending     等待 OCR 完成（部分 image 未识别）
//     - unknown     无数据或非 AR ID
export type AdvertiserClass = "peer" | "brand_self" | "pending" | "unknown";

// C-094.1：domain 详细统计，存到 atc_advertiser_domain_snapshot.domains_json
export interface DomainCreativeStat {
  domain: string;
  /** 该 domain 上 OCR 命中的广告创意数 */
  creative_count: number;
  /** 该 domain 上是否存在「单广告持续 ≥30 天」的创意（用户定义的合格条件） */
  has_long_running_creative: boolean;
  /** 该 domain 上最长的单广告投放天数（last_shown - first_shown），用于显示 */
  max_creative_days: number;
}

export interface AdvertiserDomainSnapshot {
  advertiserId: string;
  region: string;
  advertiserName: string | null;
  uniqueDomainCount: number;
  /** C-094.1：满足「单广告持续 ≥30 天」的 domain 数（判定 peer 的核心字段） */
  qualifyingDomainCount: number;
  adCount: number;
  /** 简化的 domain 列表（向后兼容） */
  domains: string[];
  /** C-094.1：每个 domain 的详细统计 */
  domainDetails: DomainCreativeStat[];
  classification: AdvertiserClass;
  /** 是否还有 OCR 任务未完成（pending 状态时为 true） */
  ocrPending: boolean;
  fetchedAt: Date;
  fromCache: boolean;
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

// ─── SerpApi Region 映射 ───
// D-008 F-1：REGION_CODE_MAP 统一从 lib/atc-regions.ts 引入（单一信源，26 国），
// 维护新国家只改 atc-regions.ts，前后端零额外改动
import { REGION_CODE_MAP } from "./atc-regions";

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
  ad_creative_id?: string;   // 创意唯一 ID，用于跨查询匹配
  format?: string;
  title?: string;
  target_domain?: string;    // 域名搜索时返回
  domain?: string;           // 部分接口返回
  url?: string;              // advertiser_id 搜索时返回完整 URL
  first_shown?: number;
  last_shown?: number;
  image?: string;
}

/** 从 SerpApi Ad 对象中提取投放域名 */
function extractAdDomain(ad: SerpApiAd): string | undefined {
  if (ad.target_domain) return ad.target_domain;
  if (ad.domain) return ad.domain;
  if (ad.url) {
    try {
      return new URL(ad.url).hostname.replace(/^www\./, "");
    } catch { /* ignore */ }
  }
  return undefined;
}

interface SerpApiResponse {
  ad_creatives?: SerpApiAd[]; // SerpApi 实际字段名（非 ads）
  error?: string;
  serpapi_pagination?: { next_page_token?: string };
  next_page_token?: string;
}

// ─── 从 Key 池中随机选一个可用 Key ───
export function pickApiKey(keys: string[]): string {
  const active = keys.filter((k) => k && k.trim());
  if (active.length === 0) throw new Error("请先配置 SerpApi Key");
  return active[Math.floor(Math.random() * active.length)];
}

/**
 * D-215：取一个 key 用于本次任务。优先全局共享池，池空时才退回传入的 key。
 * 传入的 key 仍然保留是为了兼容「用户手填 key 测试」这类场景。
 */
export async function pickPooledApiKey(fallback: string[] = []): Promise<string> {
  const pool = await getPoolKeys();
  if (pool.length > 0) return pool[0];
  return pickApiKey(fallback);
}

async function rawSerpApiCall(params: Record<string, string>, apiKey: string): Promise<SerpApiResponse> {
  const qs = new URLSearchParams({ ...params, api_key: apiKey }).toString();
  const res = await fetch(`https://serpapi.com/search?${qs}`, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text();
    // 429 是额度/限流，交给上层换 key；其余 HTTP 错误换 key 也没用，直接抛
    if (res.status === 429) return { error: `SerpApi HTTP 429: ${text.slice(0, 200)}` };
    throw new Error(`SerpApi HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<SerpApiResponse>;
}

/**
 * D-215：撞到额度耗尽时自动换池里的下一个 key 重试。
 * 放在这一层而不是各调用点，是因为全项目有 8 处 callSerpApi，逐个改容易漏。
 */
async function callSerpApi(params: Record<string, string>, apiKey: string): Promise<SerpApiResponse> {
  const tried = new Set<string>([apiKey]);
  let key = apiKey;
  let lastQuotaError: SerpApiResponse | null = null;

  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
    const data = await rawSerpApiCall(params, key);

    if (!isQuotaError(data.error)) {
      // 用 warn 而非 log：生产构建配了 removeConsole（只留 error/warn），
      // 而换 key 是需要在线上留痕的异常路径，被剥掉就没法确认池子有没有真在轮转
      if (attempt > 0) console.warn(`[SerpApiPool] 换到第 ${attempt + 1} 个 key 后调用成功`);
      await markKeyHealthy(key);
      return data;
    }

    lastQuotaError = data;
    await markKeyExhausted(key, data.error);

    const next = await pickUntriedKey(tried);
    if (!next) break;
    tried.add(next);
    key = next;
  }

  console.warn(`[SerpApiPool] 已试 ${tried.size} 个 key 均额度耗尽：${lastQuotaError?.error ?? ""}`);
  return lastQuotaError ?? { error: "SerpApi 额度已耗尽" };
}

/**
 * 通过 Google 搜索 "name site:adstransparency.google.com" 来发现广告主的 AR ID。
 * ATC 广告主主页 URL 格式：https://adstransparency.google.com/advertiser/AR123456789
 * 适用于中文等无法通过 ATC text 参数搜索的广告主名称。
 */
export async function findArIdByName(name: string, apiKey: string): Promise<string | null> {
  try {
    const params: Record<string, string> = {
      engine: "google",
      q: `"${name}" site:adstransparency.google.com`,
      num: "10",
      hl: "zh-CN",
    };
    const data = await callSerpApi(params, apiKey) as Record<string, unknown>;
    const results = (data.organic_results ?? []) as Array<{ link?: string; title?: string; snippet?: string }>;
    const lowerName = name.toLowerCase();

    for (const r of results) {
      const m = (r.link ?? "").match(/adstransparency\.google\.com\/advertiser\/(AR\d+)/i);
      if (!m) continue;
      // 验证：Google 搜索结果标题或摘要须包含被搜索的名称，防止返回无关广告主的 AR ID
      const pageText = ((r.title ?? "") + " " + (r.snippet ?? "")).toLowerCase();
      if (pageText.includes(lowerName)) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

// ─── 核心：商家竞争度查询（带缓存）───

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时

// v2.1「有效同行」判定参数（2026-08-20，07 制定，方案见《ATC广告情报系统并入方案》v2.1）
//   有效同行 = 近 ACTIVE_WINDOW 天在投广告 > MIN_ACTIVE_ADS 条，且域名重复率 ≤ MAX_DUP_RATE
//
//   窗口说明：07 原话是「昨天在投」，但 ATC 按太平洋时间统计且有 ~1 天滞后，
//   严格单日窗口会把 Qiang Xu（昨日 9 条、近 7 天 11 条）这类已确认同行排除，
//   故放宽为近 7 天（实测见方案文档 v2.1 数据表），待 07 最终确认。
const ADVERTISER_ACTIVE_WINDOW_DAYS = 7;
const ADVERTISER_MIN_ACTIVE_ADS = 10;      // 严格大于
const ADVERTISER_MAX_DOMAIN_DUP_RATE = 0.05; // (已识别数-唯一域名数)/已识别数
// v2.3（07 2026-08-20 确认）：唯一域名 ≥5 直接判同行——品牌自投顶多 1~3 个域名（主站+地区站），
// 给 5 个以上不同商家投广告的必然是联盟同行。重复率通道保留，兜住 OCR 覆盖率低
// （识别出的域名少但零重复）的同行，如 WHATECH（100 条在投只 OCR 出 2 个域名）。
const ADVERTISER_MIN_UNIQUE_DOMAINS = 5;

// 域名最长投放天数 ≥30 天仍作为信息字段展示（不再参与判定）
const ADVERTISER_MIN_DOMAIN_DAYS = 30;

/**
 * 每个 advertiser 最多 OCR 前 N 张 image。
 * v2.1：从 5 张回升到 50 张——域名重复率规则要求足量样本（07：「50 个里只能重复一次」）。
 * OCR 结果永久缓存（ad_image_ocr_cache），每张图一生只识别一次，增量成本可控。
 */
const ADVERTISER_OCR_SAMPLE_LIMIT = 50;

/**
 * v2.1 规则上线分界线：早于此时间的快照按旧规则生成（5 张抽样 + 合格域名判定），
 * 数据口径不同，一律视为过期强制重查（重查走免费直连，无配额成本）。
 * v2.3 校正：原设 00:00Z（北京 08:00），但 D-256 实际 01:15Z 才部署完成，
 * 00:29~00:30Z 之间旧代码写入的 9 行（Mac Duggal 弹窗批次）钻了空子——
 * 其 unique_domain_count 是旧 5 张抽样口径，被误当新数据放行。上调到 01:30Z 堵住。
 */
const ADVERTISER_ACTIVITY_RULE_EPOCH = new Date("2026-08-20T01:30:00Z");

// 广告主域名分布快照 TTL（按 classification 差异化）
//   - peer       (有效同行)：  90 天 — 同行身份长期稳定（C-094.15 决策沿用）
//   - brand_self (非有效同行)：7 天 — 投放量/域名结构可能变化，定期重检
//   - pending    (OCR 未完成)：1 小时 — 等 worker 跑完后重判
//   - unknown    (无数据)：    1 天  — 临时失败尽快重试
const ADVERTISER_SNAPSHOT_TTL_PEER_MS = 90 * 24 * 60 * 60 * 1000;
const ADVERTISER_SNAPSHOT_TTL_BRAND_SELF_MS = 7 * 24 * 60 * 60 * 1000;
const ADVERTISER_SNAPSHOT_TTL_PENDING_MS = 1 * 60 * 60 * 1000;
const ADVERTISER_SNAPSHOT_TTL_UNKNOWN_MS = 1 * 24 * 60 * 60 * 1000;

function ttlForClassification(cls: AdvertiserClass): number {
  switch (cls) {
    case "peer": return ADVERTISER_SNAPSHOT_TTL_PEER_MS;
    case "brand_self": return ADVERTISER_SNAPSHOT_TTL_BRAND_SELF_MS;
    case "pending": return ADVERTISER_SNAPSHOT_TTL_PENDING_MS;
    case "unknown":
    default: return ADVERTISER_SNAPSHOT_TTL_UNKNOWN_MS;
  }
}

/**
 * v2.1「有效同行」判定：
 *   - 无广告 → unknown
 *   - 近 7 天在投 ≤10 条 → brand_self（在投量不足，OCR 结果不影响结论，可立即定论）
 *   - 唯一域名 ≥5 → peer（v2.3：即使 OCR 未跑完也可提前定论，域名数只会更多不会变少）
 *   - 在投 >10 条但 OCR 未跑完 → pending（前端会轮询）
 *   - OCR 跑完后一个域名都没识别出 → unknown
 *   - 域名重复率 = (已识别广告数 - 唯一域名数) / 已识别广告数，≤5% → peer，否则 brand_self
 */
function classifyByActivity(opts: {
  adCount: number;
  uniqueDomainCount: number;
  resolvedAdCount: number;
  hasPendingOcr: boolean;
}): AdvertiserClass {
  const { adCount, uniqueDomainCount, resolvedAdCount, hasPendingOcr } = opts;
  if (adCount === 0) return "unknown";
  if (adCount <= ADVERTISER_MIN_ACTIVE_ADS) return "brand_self";
  if (uniqueDomainCount >= ADVERTISER_MIN_UNIQUE_DOMAINS) return "peer";
  if (hasPendingOcr) return "pending";
  if (resolvedAdCount === 0) return "unknown";
  const dupRate = (resolvedAdCount - uniqueDomainCount) / resolvedAdCount;
  return dupRate <= ADVERTISER_MAX_DOMAIN_DUP_RATE ? "peer" : "brand_self";
}

/**
 * 判断 domains_json 是否为 DomainCreativeStat[] 格式（旧 C-093 格式是 string[]）。
 * v2.1 起调用方已先做 epoch gate（旧规则快照一律重查），这里只需校验结构：
 * 空数组在新流程中是合法状态（在投数不足跳过 OCR / OCR 全部失败 / 真无广告）。
 */
function isNewDomainsFormat(domainsJson: unknown): domainsJson is DomainCreativeStat[] {
  if (!Array.isArray(domainsJson)) return false;
  if (domainsJson.length === 0) return true;
  const first = domainsJson[0];
  return typeof first === "object" && first !== null && "has_long_running_creative" in first;
}

/** C-094.3：持久化到 sampled_ads_json 的最小 ad creative 结构（让 cache 命中时能复算分类） */
interface SampledAd {
  image: string;
  first_shown?: number;
  last_shown?: number;
}

/** OCR 反查 + 缺图入队 + fire-and-forget worker。返回 {url→domain 已识别映射, 仍有 pending OCR 任务} */
async function queryOcrCacheAndEnqueue(imageUrls: string[]): Promise<{
  urlToDomain: Map<string, string>;
  hasPendingOcr: boolean;
}> {
  const urlToDomain = new Map<string, string>();
  let hasPendingOcr = false;
  if (imageUrls.length === 0) return { urlToDomain, hasPendingOcr };

  const { isOcrEnabled, queryCachedDomains, enqueueOcrTasks, runOcrWorker } = await import("./ocr-domain");
  if (!(await isOcrEnabled())) return { urlToDomain, hasPendingOcr };

  const cache = await queryCachedDomains(imageUrls);
  const toEnqueue: string[] = [];

  for (const url of imageUrls) {
    const hit = cache.get(url);
    if (hit?.status === "success" && hit.domain) {
      urlToDomain.set(url, hit.domain.toLowerCase());
    } else if (hit?.status === "failed" || hit?.status === "permanent_failure") {
      // 已识别失败 / 永久失败 → 跳过（这张图就是没域名/无法识别）
    } else {
      hasPendingOcr = true;
      if (!hit) toEnqueue.push(url);
    }
  }

  if (toEnqueue.length > 0) {
    await enqueueOcrTasks(toEnqueue).catch((err) => {
      console.warn("[C-094.3] enqueueOcrTasks failed:", err);
    });
    // Fire-and-forget 触发 worker，让本批 image 5-15s 内被消化
    void runOcrWorker()
      .then((r) => console.log("[C-094.3] inline worker:", JSON.stringify(r)))
      .catch((err) => console.warn("[C-094.3] inline worker failed:", err));
  }

  return { urlToDomain, hasPendingOcr };
}

/** 按 domain 聚合采样的 ad creatives → 每个 domain 的统计（creative 数 / 是否有持续 ≥30 天创意） */
function aggregateDomainStats(sampledAds: SampledAd[], urlToDomain: Map<string, string>): DomainCreativeStat[] {
  const domainStats = new Map<string, DomainCreativeStat>();
  for (const ad of sampledAds) {
    const domain = urlToDomain.get(ad.image);
    if (!domain) continue; // 还没 OCR 出来 / 已 failed → 跳过

    const stat = domainStats.get(domain) ?? {
      domain,
      creative_count: 0,
      has_long_running_creative: false,
      max_creative_days: 0,
    };
    stat.creative_count++;

    if (ad.first_shown && ad.last_shown && ad.last_shown > ad.first_shown) {
      const days = Math.floor((ad.last_shown - ad.first_shown) / 86400);
      if (days > stat.max_creative_days) stat.max_creative_days = days;
      if (days >= ADVERTISER_MIN_DOMAIN_DAYS) stat.has_long_running_creative = true;
    }

    domainStats.set(domain, stat);
  }
  return Array.from(domainStats.values());
}

/**
 * v2.1（2026-08-20）：判定一个广告主是否「有效同行」。
 *
 * 07 定义：近期在投广告 >10 条，且域名重复率 ≤5%（详见《ATC广告情报系统并入方案》v2.1；
 * 「昨天在投」实现为近 7 天窗口，原因见 ADVERTISER_ACTIVE_WINDOW_DAYS 注释）。
 *
 * 实现路径（广告主查询不返回投放域名——直连 RPC 与 SerpApi 皆然，域名只能 OCR 广告图）：
 *   1. 直连 ATC RPC 按 AR ID 查近 7 天在投创意（免费；失败降级 SerpApi 同口径查询）
 *   2. 在投数 ≤10 → 直接判 brand_self，不消耗 OCR
 *   3. 否则抽前 N 张 image（N=ADVERTISER_OCR_SAMPLE_LIMIT=50）→ 反查 ad_image_ocr_cache
 *   4. 未识别的 image → 入队 + fire-and-forget 触发 worker（异步补 OCR）
 *   5. OCR 齐后按域名重复率判定（classifyByActivity）
 *
 * C-094.3 机制沿用：sampled_ads_json 持久化采样的 image+timestamps，
 * cache 命中且 ocr_pending=1 时直接复用采样列表重查 OCR cache 重算分类，
 * 完全不消耗 SerpApi quota。OCR worker 后台跑完后，下次访问就能拿到正确结果。
 *
 * 团队级共享缓存 TTL：peer 90d / brand_self 7d / pending 1h / unknown 1d。
 */
export async function getOrFetchAdvertiserDomainSnapshot(opts: {
  advertiserId: string;
  region?: string;
  serpApiKeys: string[];
  forceRefresh?: boolean;
}): Promise<AdvertiserDomainSnapshot> {
  const { advertiserId, region = "US", serpApiKeys, forceRefresh = false } = opts;

  // AR ID 校验：非 AR 开头的 id 无法反查（如 _name_xxx）
  if (!/^AR\d+$/i.test(advertiserId)) {
    return {
      advertiserId, region,
      advertiserName: null,
      uniqueDomainCount: 0, qualifyingDomainCount: 0, adCount: 0,
      domains: [], domainDetails: [],
      classification: "unknown",
      ocrPending: false,
      fetchedAt: new Date(), fromCache: false,
    };
  }

  // 1. 缓存命中
  //    v2.1 epoch gate：规则上线前的快照口径不同（5 张抽样 + 合格域名判定），一律视为过期重查
  if (!forceRefresh) {
    const cached = await prisma.atc_advertiser_domain_snapshot.findUnique({
      where: { advertiser_id_region: { advertiser_id: advertiserId, region } },
    });
    if (
      cached &&
      cached.fetched_at >= ADVERTISER_ACTIVITY_RULE_EPOCH &&
      isNewDomainsFormat(cached.domains_json)
    ) {
      const cachedDetails = cached.domains_json as DomainCreativeStat[];
      const wasPending = cached.ocr_pending === 1;
      const provisionalCls = classifyByActivity({
        adCount: cached.ad_count,
        uniqueDomainCount: cachedDetails.length,
        resolvedAdCount: cachedDetails.reduce((s, d) => s + d.creative_count, 0),
        hasPendingOcr: wasPending,
      });
      const ttl = ttlForClassification(provisionalCls);
      const within = Date.now() - cached.fetched_at.getTime() < ttl;

      // 1a. 非 pending 状态 + TTL 内 → 直接命中，立即返回。
      //     v2.3：内存算出的分类与库存列不一致时回写（规则升级/列为 NULL 的旧行），
      //     否则「可关注广告主」等 SQL 级筛选会漏掉该行（温州诚惠案例）。
      if (within && !wasPending) {
        if (cached.classification !== provisionalCls) {
          await prisma.atc_advertiser_domain_snapshot.update({
            where: { advertiser_id_region: { advertiser_id: advertiserId, region } },
            data: { classification: provisionalCls },
          }).catch(() => {});
        }
        return {
          advertiserId, region,
          advertiserName: cached.advertiser_name,
          uniqueDomainCount: cached.unique_domain_count,
          qualifyingDomainCount: cached.qualifying_domain_count,
          adCount: cached.ad_count,
          domains: cachedDetails.map((d) => d.domain),
          domainDetails: cachedDetails,
          classification: provisionalCls,
          ocrPending: false,
          fetchedAt: cached.fetched_at,
          fromCache: true,
        };
      }

      // 1b. C-094.3：pending 状态 + TTL 内 + 有 sampled_ads_json
      //     → 复用采样列表重查 OCR cache，无需调 SerpApi
      const sampledAdsCached = Array.isArray(cached.sampled_ads_json)
        ? (cached.sampled_ads_json as unknown as SampledAd[])
        : null;
      if (within && wasPending && sampledAdsCached && sampledAdsCached.length > 0) {
        const imageUrls = sampledAdsCached.map((a) => a.image).filter((u) => typeof u === "string");
        const { urlToDomain, hasPendingOcr } = await queryOcrCacheAndEnqueue(imageUrls);
        const newDetails = aggregateDomainStats(sampledAdsCached, urlToDomain);
        const newQualifyingCount = newDetails.filter((d) => d.has_long_running_creative).length;
        const newCls = classifyByActivity({
          adCount: cached.ad_count,
          uniqueDomainCount: newDetails.length,
          resolvedAdCount: newDetails.reduce((s, d) => s + d.creative_count, 0),
          hasPendingOcr,
        });

        // 状态变化（OCR 出新结果 / 全跑完）→ 更新 snapshot，不刷新 fetched_at（保持原 SerpApi 时间）
        const changed =
          newDetails.length !== cachedDetails.length ||
          newQualifyingCount !== cached.qualifying_domain_count ||
          (hasPendingOcr ? 1 : 0) !== cached.ocr_pending;
        if (changed) {
          await prisma.atc_advertiser_domain_snapshot.update({
            where: { advertiser_id_region: { advertiser_id: advertiserId, region } },
            data: {
              unique_domain_count: newDetails.length,
              qualifying_domain_count: newQualifyingCount,
              domains_json: newDetails as unknown as object,
              ocr_pending: hasPendingOcr ? 1 : 0,
              classification: newCls,
            },
          });
        }

        return {
          advertiserId, region,
          advertiserName: cached.advertiser_name,
          uniqueDomainCount: newDetails.length,
          qualifyingDomainCount: newQualifyingCount,
          adCount: cached.ad_count,
          domains: newDetails.map((d) => d.domain),
          domainDetails: newDetails,
          classification: newCls,
          ocrPending: hasPendingOcr,
          fetchedAt: cached.fetched_at,
          fromCache: true,
        };
      }
      // 1c. pending 但无 sampled_ads_json（C-094.3 之前的旧记录）→ 落到下面 SerpApi 重拉
    }
  }

  // 2. 查近 7 天在投创意（v2.1）：直连 ATC RPC 优先（免费、anywhere），
  //    失败降级 SerpApi 同时间窗查询（保留原 region 过滤，行为保守）
  //    D-259（07 2026-08-20）：在投数必须绝对精准——直连翻页到底（上限 2000 兜底），
  //    不再截断在 100；SerpApi 降级路径同样翻页（上限 10 页，每页 1 次配额）。
  let ads: Array<{ advertiser?: string; image?: string; first_shown?: number; last_shown?: number }>;
  try {
    ads = await fetchAdvertiserCreativesDirect({
      advertiserId,
      activeDays: ADVERTISER_ACTIVE_WINDOW_DAYS,
      maxAds: 2000,
    });
  } catch (directErr) {
    console.warn(`[ATC-direct] 广告主查询直连失败，降级 SerpApi（advertiser=${advertiserId}）:`, directErr);
    const serpApiKey = pickApiKey(serpApiKeys);
    // D-259.1：降级路径不再带 region 过滤——直连查的是全球（anywhere），降级带 region
    // 会造成同一广告主两条传输路径计数不一致（实测 Vladyslav 直连 100+ vs SerpApi-US 27、
    // FC-Moto 直连 100 vs SerpApi-US 0），在投数必须口径统一才谈得上精准。
    const params: Record<string, string> = {
      engine: "google_ads_transparency_center",
      advertiser_id: advertiserId,
      ...buildDateRangeParams(ADVERTISER_ACTIVE_WINDOW_DAYS),
      num: "100",
    };

    const NO_RESULTS_MSG = "hasn't returned any results";
    ads = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const pageParams = nextPageToken ? { ...params, next_page_token: nextPageToken } : params;
      const data = await callSerpApi(pageParams, serpApiKey);
      if (data.error && !data.error.includes(NO_RESULTS_MSG)) {
        // 首页失败整体报错；后续页失败保留已取数据（计数偏低好过整单作废）
        if (page === 0) throw new Error(data.error);
        console.warn(`[ATC-serpapi] 第 ${page + 1} 页失败，按已取 ${ads.length} 条继续:`, data.error);
        break;
      }
      const batch = data.ad_creatives ?? [];
      ads.push(...batch);
      nextPageToken = data.serpapi_pagination?.next_page_token ?? data.next_page_token;
      if (!nextPageToken || batch.length === 0) break;
    }
  }

  const advertiserName = ads[0]?.advertiser ?? null;
  const now = new Date();

  // 3. 抽前 N 张带 image 的 ad（N=ADVERTISER_OCR_SAMPLE_LIMIT）
  //    在投数 ≤ 阈值时结论已定（brand_self/unknown），跳过采样不消耗 OCR
  const sampledAds: SampledAd[] =
    ads.length > ADVERTISER_MIN_ACTIVE_ADS
      ? ads
          .filter((a) => !!a.image)
          .slice(0, ADVERTISER_OCR_SAMPLE_LIMIT)
          .map((a) => ({
            image: a.image as string,
            first_shown: a.first_shown,
            last_shown: a.last_shown,
          }))
      : [];

  // 4. OCR 反查 + 入队补全
  const imageUrls = sampledAds.map((a) => a.image);
  const { urlToDomain, hasPendingOcr } = await queryOcrCacheAndEnqueue(imageUrls);

  // 5. 按 domain 聚合 sampled ads → v2.1 域名重复率判定
  const domainDetails = aggregateDomainStats(sampledAds, urlToDomain);
  const qualifyingCount = domainDetails.filter((d) => d.has_long_running_creative).length;
  const classification = classifyByActivity({
    adCount: ads.length,
    uniqueDomainCount: domainDetails.length,
    resolvedAdCount: domainDetails.reduce((s, d) => s + d.creative_count, 0),
    hasPendingOcr,
  });

  // 6. 写入团队级快照（C-094.3：sampled_ads_json 持久化采样列表）
  await prisma.atc_advertiser_domain_snapshot.upsert({
    where: { advertiser_id_region: { advertiser_id: advertiserId, region } },
    create: {
      advertiser_id: advertiserId, region,
      advertiser_name: advertiserName,
      unique_domain_count: domainDetails.length,
      qualifying_domain_count: qualifyingCount,
      ad_count: ads.length,
      domains_json: domainDetails as unknown as object,
      ocr_pending: hasPendingOcr ? 1 : 0,
      sampled_ads_json: sampledAds as unknown as object,
      classification,
      fetched_at: now,
    },
    update: {
      advertiser_name: advertiserName,
      unique_domain_count: domainDetails.length,
      qualifying_domain_count: qualifyingCount,
      ad_count: ads.length,
      domains_json: domainDetails as unknown as object,
      ocr_pending: hasPendingOcr ? 1 : 0,
      sampled_ads_json: sampledAds as unknown as object,
      classification,
      fetched_at: now,
    },
  });

  return {
    advertiserId, region,
    advertiserName,
    uniqueDomainCount: domainDetails.length,
    qualifyingDomainCount: qualifyingCount,
    adCount: ads.length,
    domains: domainDetails.map((d) => d.domain),
    domainDetails,
    classification,
    ocrPending: hasPendingOcr,
    fetchedAt: now, fromCache: false,
  };
}

export async function queryMerchantAtc(opts: {
  merchantId: bigint;
  merchantName: string;
  domain: string;
  region?: string;
  serpApiKeys: string[];
  forceRefresh?: boolean;
}): Promise<AtcMerchantResult> {
  const { merchantId, merchantName, domain, region = "US", serpApiKeys, forceRefresh = false } = opts;

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
    // 3. 调用数据源（v2.0：直连 ATC RPC 优先，SerpApi 降级）
    // 用完整域名搜索（ATC 会返回所有指向该域名的广告）
    // 使用近 7 天窗口（与 Google ATC 网站默认"过去 7 天"一致），覆盖偶尔投放的广告主
    const serpRegion = toSerpApiRegion(region);
    let allAds: SerpApiAd[];

    try {
      // 3a. 直连 ATC 内部 RPC：免费、无需 Key，口径与原 SerpApi 查询完全一致
      //     （text=域名 / platform=SEARCH / 近7天 / num=100；三方对比验证于 2026-08-19）
      allAds = await fetchDomainCreativesDirect({
        domain,
        regionNum: serpRegion,
        days: 7,
        count: 100,
        searchOnly: true,
      });
    } catch (directErr) {
      // 3b. 直连失败（协议变更/限频/网络）→ 降级 SerpApi，保持原行为
      console.warn(`[ATC-direct] 直连失败，降级 SerpApi（domain=${domain}）:`, directErr);
      const serpApiKey = pickApiKey(serpApiKeys);
      const params: Record<string, string> = {
        engine: "google_ads_transparency_center",
        text: domain,
        platform: "SEARCH",
        ...buildDateRangeParams(7),
        num: "100",
      };
      if (serpRegion) params.region = serpRegion;
      const data = await callSerpApi(params, serpApiKey);

      // "no results" 视为合法的 0 结果，而非错误
      const NO_RESULTS_MSG = "hasn't returned any results";
      if (data.error && !data.error.includes(NO_RESULTS_MSG)) throw new Error(data.error);
      allAds = data.ad_creatives ?? [];
    }

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
          domain: extractAdDomain(ad),
          first_shown: ad.first_shown,
          last_shown:  ad.last_shown,
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

/** 日期格式化工具（YYYYMMDD） */
function fmtDate(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** 构建近 N 天的查询日期范围参数（end=昨天，start=N天前） */
function buildDateRangeParams(days: number): { start_date: string; end_date: string } {
  const endD   = new Date(); endD.setDate(endD.getDate() - 1);
  const startD = new Date(); startD.setDate(startD.getDate() - days);
  return { start_date: fmtDate(startD), end_date: fmtDate(endD) };
}

/**
 * 将 SerpApiAd 数组归并进 advertiserAdsMap。
 *
 * C-089 v1（07 伙伴诉求："广告 ID 一致才能统计累计天数"）：
 * 同一 creative_id 在数据中多次出现时（不同 SerpApi 接口 / 不同 region /
 * 接口分页返回重复 / advertiser_id 查询 + domain 反查 富化路径都命中同一 creative），
 * 合并为一条：
 *   - first_shown = min(全部出现的 first_shown)
 *   - last_shown  = max(全部出现的 last_shown)
 *   - domain / thumbnail / title / format = 首次非空值（即不被后续 null 覆盖）
 * 没有 creative_id 的 ad（极少数 SerpApi 返回缺该字段）保留原行为：逐条独立累加。
 */
function mergeAdsIntoMap(
  ads: SerpApiAd[],
  advertiserAdsMap: Map<string, { name: string; ads: AtcAd[] }>,
  overwrite = false,
) {
  for (const ad of ads) {
    const rawId   = (ad.advertiser_id ?? "").trim();
    const rawName = (ad.advertiser    ?? "未知广告主").trim();
    const advId = rawId || `_name_${normalize(rawName)}`;

    if (!advertiserAdsMap.has(advId)) {
      advertiserAdsMap.set(advId, { name: rawName, ads: [] });
    } else if (overwrite) {
      advertiserAdsMap.get(advId)!.ads = [];
    }

    const entry = advertiserAdsMap.get(advId)!;
    const creativeId = ad.ad_creative_id;

    // 同一 creative_id 已存在 → 合并；不存在或无 creative_id → 新增
    const existing = creativeId
      ? entry.ads.find((a) => a.creative_id === creativeId)
      : undefined;

    if (existing) {
      if (ad.first_shown && (!existing.first_shown || ad.first_shown < existing.first_shown)) {
        existing.first_shown = ad.first_shown;
      }
      if (ad.last_shown && (!existing.last_shown || ad.last_shown > existing.last_shown)) {
        existing.last_shown = ad.last_shown;
      }
      // 缺失字段补全（保留首次非空，避免后续 null 覆盖）
      if (!existing.domain)    existing.domain    = extractAdDomain(ad);
      if (!existing.thumbnail) existing.thumbnail = ad.image;
      if (!existing.title)     existing.title     = ad.title;
      if (!existing.format && ad.format) existing.format = ad.format;
    } else {
      entry.ads.push({
        format: ad.format ?? "text",
        title: ad.title,
        domain: extractAdDomain(ad),
        first_shown: ad.first_shown,
        last_shown:  ad.last_shown,
        thumbnail: ad.image,
        creative_id: ad.ad_creative_id,
      });
    }
  }
}

/**
 * 域名反查富化：通过本地快照找到该 AR ID 出现过的域名，
 * 对每个域名做 SerpApi domain 搜索，按 ad_creative_id 匹配，
 * 补全 advertiserAdsMap 中缺失的 domain 字段，并追加新增 creative。
 * 根因：SerpApi advertiser_id 查询不返回 target_domain，但 domain 搜索会返回。
 */
async function enrichDomainsFromSnapshots(
  arId: string,
  serpApiKey: string,
  serpRegion: string | undefined,
  advertiserAdsMap: Map<string, { name: string; ads: AtcAd[] }>,
) {
  // 1. 从本地快照找该 AR ID 出现过的所有域名
  const allSnaps = await prisma.merchant_atc_snapshots.findMany({
    select: { domain: true, top_advertisers_json: true },
    where: { top_advertisers_json: { not: null } },
  });

  const matchDomains: string[] = [];
  for (const snap of allSnaps) {
    const list = snap.top_advertisers_json as { id: string; name: string }[] | null;
    if (Array.isArray(list) && list.some((a) => a.id === arId)) {
      matchDomains.push(snap.domain);
    }
  }
  if (matchDomains.length === 0) return;

  // 2. 建 creative_id → {mapKey, adIdx} 映射（用于快速定位并更新 domain）
  const creativeMap = new Map<string, { mapKey: string; adIdx: number }>();
  for (const [mapKey, { ads }] of advertiserAdsMap) {
    ads.forEach((ad, adIdx) => {
      if (ad.creative_id) creativeMap.set(ad.creative_id, { mapKey, adIdx });
    });
  }

  const NO_RESULTS_MSG = "hasn't returned any results";

  // 3. 对每个已知域名做 domain 搜索，匹配 creative_id 补全 domain
  for (const domain of matchDomains.slice(0, 5)) {
    const params: Record<string, string> = {
      engine: "google_ads_transparency_center",
      text: domain,
      num: "100",
    };
    if (serpRegion) params.region = serpRegion;

    try {
      const data = await callSerpApi(params, serpApiKey);
      if (data.error && !data.error.includes(NO_RESULTS_MSG)) continue;

      for (const ad of data.ad_creatives ?? []) {
        if (ad.advertiser_id !== arId || !ad.ad_creative_id || !ad.target_domain) continue;

        const existing = creativeMap.get(ad.ad_creative_id);
        if (existing) {
          // 已有该 creative → 补全缺失的 domain + 同步合并 first/last 边界
          // C-089 v1：保证 creative_id 一致的记录累计天数 = 全部出现的最早→最近
          const { mapKey, adIdx } = existing;
          const entry = advertiserAdsMap.get(mapKey);
          if (entry) {
            const cur = entry.ads[adIdx];
            if (!cur.domain) cur.domain = ad.target_domain;
            if (ad.first_shown && (!cur.first_shown || ad.first_shown < cur.first_shown)) {
              cur.first_shown = ad.first_shown;
            }
            if (ad.last_shown && (!cur.last_shown || ad.last_shown > cur.last_shown)) {
              cur.last_shown = ad.last_shown;
            }
          }
        } else {
          // advertiser_id 查询未返回此 creative → 追加（增加总数）
          if (!advertiserAdsMap.has(arId)) {
            advertiserAdsMap.set(arId, { name: ad.advertiser ?? "未知广告主", ads: [] });
          }
          const newIdx = advertiserAdsMap.get(arId)!.ads.length;
          advertiserAdsMap.get(arId)!.ads.push({
            format: ad.format ?? "text",
            title: ad.title,
            domain: ad.target_domain,
            first_shown: ad.first_shown,
            last_shown: ad.last_shown,
            thumbnail: ad.image,
            creative_id: ad.ad_creative_id,
          });
          creativeMap.set(ad.ad_creative_id, { mapKey: arId, adIdx: newIdx });
        }
      }
    } catch {
      // 单个域名搜索失败不影响主流程
    }
  }
}

export async function searchIntelligence(opts: {
  text?: string;
  advertiser_id?: string;   // AR... 格式，精确查指定广告主
  region?: string;
  serpApiKeys: string[];
}): Promise<AtcIntelligenceResult> {
  const { text, advertiser_id, region = "US", serpApiKeys } = opts;
  const serpApiKey = pickApiKey(serpApiKeys);
  const serpRegion = toSerpApiRegion(region);
  const NO_RESULTS_MSG = "hasn't returned any results";

  const advertiserAdsMap = new Map<string, { name: string; ads: AtcAd[] }>();

  if (advertiser_id) {
    // ── 精确查询（AR ID）：不加日期限制，获取该广告主全量历史广告 ──
    // 注：SerpApi advertiser_id 查询不返回 target_domain，通过后续域名反查补全
    const params: Record<string, string> = {
      engine: "google_ads_transparency_center",
      advertiser_id,
      num: "100",
    };
    if (serpRegion) params.region = serpRegion;

    const data = await callSerpApi(params, serpApiKey);
    if (data.error && !data.error.includes(NO_RESULTS_MSG)) throw new Error(data.error);
    mergeAdsIntoMap(data.ad_creatives ?? [], advertiserAdsMap);

    // ── 域名反查富化：从本地快照找已知域名 → 补全 target_domain + 追加遗漏 creative ──
    await enrichDomainsFromSnapshots(advertiser_id, serpApiKey, serpRegion, advertiserAdsMap);

  } else if (text) {
    // ── 文字/域名搜索：不加日期，对齐 ATC 网站默认行为 ──
    const params: Record<string, string> = {
      engine: "google_ads_transparency_center",
      text,
      num: "100",
    };
    if (serpRegion) params.region = serpRegion;

    const data = await callSerpApi(params, serpApiKey);
    if (data.error && !data.error.includes(NO_RESULTS_MSG)) throw new Error(data.error);
    mergeAdsIntoMap(data.ad_creatives ?? [], advertiserAdsMap);

    // ── BUG-2 修复：自动追查 AR ID ──
    // 文字搜索拿到 AR ID 后，逐一用 advertiser_id 精确查，
    // 获取完整广告列表（含 url 字段→domain）并覆盖原先的不完整结果
    const arIds = Array.from(advertiserAdsMap.keys())
      .filter((id) => /^AR\d+$/i.test(id))
      .slice(0, 3); // 最多追查 3 个，防止过多消耗额度

    for (const arId of arIds) {
      const followParams: Record<string, string> = {
        engine: "google_ads_transparency_center",
        advertiser_id: arId,
        num: "100",
        ...buildDateRangeParams(15),
      };
      if (serpRegion) followParams.region = serpRegion;

      try {
        const followData = await callSerpApi(followParams, serpApiKey);
        if (!followData.error || followData.error.includes(NO_RESULTS_MSG)) {
          const followAds = followData.ad_creatives ?? [];
          if (followAds.length > 0) {
            // overwrite=true：用精确查询的完整结果（含域名）替换文字搜索结果
            mergeAdsIntoMap(followAds, advertiserAdsMap, true);
          }
        }
      } catch {
        // 追查失败不影响主流程，保留文字搜索已有结果
      }
    }
  }

  // C-088：OCR 兜底补 domain（命中缓存即用，未命中异步入队）
  await applyOcrDomainEnrichment(advertiserAdsMap);

  const advertisers = Array.from(advertiserAdsMap.entries()).map(([id, v]) => ({
    id,
    name: v.name,
    adCount: v.ads.length,
    ads: v.ads,
  }));

  return {
    advertisers,
    total: advertisers.reduce((s, a) => s + a.adCount, 0),
  };
}

/**
 * C-088：对缺 domain 但有 thumbnail 的 ad 做 OCR 兜底补全
 *  - 同步：批量查 ad_image_ocr_cache，命中 success → 立即 fill ad.domain
 *  - 异步：未命中 / pending → 标 _ocrPending=true，入队让 cron worker 后台处理
 *  - 全局开关关闭时直接 noop
 */
async function applyOcrDomainEnrichment(
  advertiserAdsMap: Map<string, { name: string; ads: AtcAd[] }>,
) {
  // 懒加载 ocr-domain，避免 atc 模块在没用到 OCR 的请求里也加载 ai-providers
  const { isOcrEnabled, queryCachedDomains, enqueueOcrTasks } = await import("./ocr-domain");

  if (!(await isOcrEnabled())) return;

  // 1) 收集所有"缺 domain 但有 thumbnail"的 ad
  const targets: Array<{ ad: AtcAd; url: string }> = [];
  for (const { ads } of advertiserAdsMap.values()) {
    for (const ad of ads) {
      if (!ad.domain && ad.thumbnail) {
        targets.push({ ad, url: ad.thumbnail });
      }
    }
  }
  if (targets.length === 0) return;

  // 2) 批量查缓存
  const uniqueUrls = Array.from(new Set(targets.map((t) => t.url)));
  const cache = await queryCachedDomains(uniqueUrls);

  // 3) 命中 success → fill；其他状态 / 未命中 → 标 pending
  const toEnqueue: string[] = [];
  for (const { ad, url } of targets) {
    const hit = cache.get(url);
    if (hit?.status === "success" && hit.domain) {
      ad.domain = hit.domain;
    } else if (hit?.status === "failed" || hit?.status === "permanent_failure") {
      // 已经诊断失败：不显示"识别中"，保留 domain=undefined → 前端显示 "-"
    } else {
      ad._ocrPending = true;
      if (!hit) toEnqueue.push(url);
    }
  }

  // 4) 把未入库的 URL 入队
  if (toEnqueue.length > 0) {
    await enqueueOcrTasks(toEnqueue).catch((err) => {
      console.warn("[C-088] enqueueOcrTasks 失败（不影响主流程）:", err);
    });
  }

  // 5) Fire-and-forget 立即触发一次 worker：让本批次任务 5-15s 内被消化，
  //    前端轮询第一次就能拿到结果，避免等 cron 5 分钟周期。
  //    不 await（响应继续返回），错误兜底打印。
  const { runOcrWorker } = await import("./ocr-domain");
  void runOcrWorker()
    .then((r) => console.log("[C-088] inline worker triggered:", JSON.stringify(r)))
    .catch((err) => console.warn("[C-088] inline worker failed:", err));
}
