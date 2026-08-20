/**
 * ATC 直连数据源：逆向 adstransparency.google.com 内部 RPC
 * `SearchService/SearchCreatives`，免费、无需 API Key。
 *
 * 背景（2026-08-19，方案见《ATC广告情报系统并入方案》v2.0）：
 *   - 协议字段经 ATC 网页抓包逐一验证（网页前端调的就是同一个接口）；
 *   - 三方对比测试（生产 SerpApi 快照 vs 本接口 vs ATC 网页）确认数据同源一致；
 *   - 参考实现：github.com/block-town/google-ads-transparency-mcp（Python）。
 *
 * f.req 协议（数字键为 Google 内部 proto 字段号）：
 *   "2"        返回条数（≤100，同 SerpApi num 上限）
 *   "3.6/3.7"  起止日期 YYYYMMDD（数字）
 *   "3.8"      [地区数字码]，与 SerpApi region 同一套编码（2000 + ISO 数字码，US=2840）
 *   "3.12"     { "1": 搜索文本/域名, "2": true=域名精确匹配 }
 *   "3.14"     [平台]，3 = Google 搜索
 *   "7.1"      固定 1
 *
 * 响应字段（列表项）：
 *   "1" 广告主 AR ID  "2" 创意 CR ID  "12" 广告主名称  "14" 投放域名
 *   "6.1"/"7.1" first/last_shown Unix 秒  "3.3.2" 预览 HTML（含缩略图 <img src>）
 *
 * ⚠️ 非官方接口，Google 可能改协议或限频。调用方必须保留 SerpApi 降级路径。
 */

const ATC_BASE_URL = "https://adstransparency.google.com";

const ATC_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

// ─── Cookie 引导 + 429 重试（2026-08-20 实测）───────────────────────────────
// 无 Cookie 的裸请求在突发流量下会被 Google 429（同 IP 上带 Cookie 的请求正常）。
// 参考 block-town 实现：先 GET 一次 ATC 首页拿 Set-Cookie，之后请求都带上。
// 惰性策略：首次请求不取 Cookie（低频场景裸请求即可），遇到 429 才引导 + 重试一次。

let atcCookieHeader: string | null = null;

async function refreshAtcCookies(): Promise<void> {
  try {
    const res = await fetch(`${ATC_BASE_URL}/?region=anywhere`, {
      headers: {
        "user-agent": ATC_HEADERS["user-agent"],
        "accept-language": ATC_HEADERS["accept-language"],
      },
      signal: AbortSignal.timeout(15000),
    });
    const raw =
      (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    const jar = raw.map((c) => c.split(";")[0]).filter(Boolean);
    atcCookieHeader = jar.length > 0 ? jar.join("; ") : null;
  } catch {
    atcCookieHeader = null;
  }
}

/** SearchCreatives RPC 底层调用：带 Cookie（如有）、429 时引导 Cookie 后重试一次 */
async function postSearchCreatives(
  req: Record<string, unknown>
): Promise<{ "1"?: RawCreative[]; "2"?: string }> {
  for (let attempt = 0; ; attempt++) {
    const headers: Record<string, string> = { ...ATC_HEADERS };
    if (atcCookieHeader) headers["cookie"] = atcCookieHeader;

    const res = await fetch(`${ATC_BASE_URL}/anji/_/rpc/SearchService/SearchCreatives?authuser=`, {
      method: "POST",
      headers,
      body: new URLSearchParams({ "f.req": JSON.stringify(req) }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) return (await res.json()) as { "1"?: RawCreative[]; "2"?: string };

    if (res.status === 429 && attempt === 0) {
      await refreshAtcCookies();
      continue;
    }
    throw new Error(`ATC direct HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** 与 atc-service.ts 的 SerpApiAd 字段名对齐，方便下游零改动复用 */
export interface AtcDirectAd {
  advertiser_id?: string;
  advertiser?: string;
  ad_creative_id?: string;
  format?: string;
  target_domain?: string;
  first_shown?: number;
  last_shown?: number;
  image?: string;
}

/** 列表项原始结构（数字键 proto） */
interface RawCreative {
  "1"?: string;                          // advertiser_id
  "2"?: string;                          // creative_id
  "3"?: { "3"?: { "2"?: string } };      // 预览 HTML
  "6"?: { "1"?: string };                // first_shown（Unix 秒，字符串）
  "7"?: { "1"?: string };                // last_shown
  "12"?: string;                         // advertiser_name
  "14"?: string;                         // target_domain
}

function fmtDateNum(d: Date): number {
  return Number(
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`
  );
}

/** 从预览 HTML 中提取缩略图 URL（如 <img src="https://tpc.googlesyndication.com/..."/>） */
function extractThumbnail(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const m = html.match(/src="([^"]+)"/);
  return m ? m[1] : undefined;
}

function parseCreative(raw: RawCreative): AtcDirectAd {
  const firstShown = raw["6"]?.["1"] ? Number(raw["6"]["1"]) : undefined;
  const lastShown = raw["7"]?.["1"] ? Number(raw["7"]["1"]) : undefined;
  return {
    advertiser_id: raw["1"],
    advertiser: raw["12"],
    ad_creative_id: raw["2"],
    // 列表响应不含格式字段；调用方按 platform=搜索 过滤后默认视为 text
    format: undefined,
    target_domain: raw["14"],
    first_shown: Number.isFinite(firstShown) ? firstShown : undefined,
    last_shown: Number.isFinite(lastShown) ? lastShown : undefined,
    image: extractThumbnail(raw["3"]?.["3"]?.["2"]),
  };
}

/**
 * 按域名搜创意（对齐 CRM 商家竞争度口径）。
 * 失败时抛异常，由调用方降级到 SerpApi。
 *
 * @param opts.regionNum SerpApi 数字地区码（REGION_CODE_MAP 产物）；undefined = 全球
 * @param opts.days      近 N 天（end=昨天，与 buildDateRangeParams 口径一致）；undefined = 不限时间
 * @param opts.searchOnly true 时仅 Google 搜索平台（"14":[3]）
 */
export async function fetchDomainCreativesDirect(opts: {
  domain: string;
  regionNum?: string;
  days?: number;
  count?: number;
  searchOnly?: boolean;
}): Promise<AtcDirectAd[]> {
  const { domain, regionNum, days, count = 100, searchOnly = true } = opts;

  const filter: Record<string, unknown> = {
    "12": { "1": domain, "2": true },
  };
  if (regionNum) filter["8"] = [Number(regionNum)];
  if (searchOnly) filter["14"] = [3];
  if (days && days > 0) {
    const end = new Date();
    end.setDate(end.getDate() - 1);
    const start = new Date();
    start.setDate(start.getDate() - days);
    filter["6"] = fmtDateNum(start);
    filter["7"] = fmtDateNum(end);
  }

  const req = { "2": Math.min(count, 100), "3": filter, "7": { "1": 1 } };

  const body = await postSearchCreatives(req);
  // "1" 缺失 = 合法的 0 结果（与 SerpApi "no results" 同义）
  return (body["1"] ?? []).map(parseCreative);
}

/**
 * 按广告主 AR ID 搜创意（v2.1 有效同行判定，2026-08-20）。
 *
 * 协议要点（实测验证，见《ATC广告情报系统并入方案》v2.1）：
 *   - filter "13".1 = [AR ID]，需同时带 "12" 空文本占位；
 *   - 日期过滤 "6"/"7"：语义是「投放期与区间有交集」，且 "7"（结束日）必须含今天，
 *     否则返回空（单日区间 end<今天 实测恒为空）；
 *   - 响应列表项**不含**投放域名（"14" 仅域名搜索时回显），域名需对广告图走 OCR；
 *   - 分页：响应 "2" 为下一页 token，请求置于 "4"。
 *
 * 不带地区过滤（anywhere）：同行身份是全局属性，按地区过滤会漏掉只投其他国家的同行。
 *
 * @param opts.activeDays 近 N 天在投（start=今天-N，end=今天）；undefined = 不限时间
 * @param opts.maxAds     跨页累计上限（默认 100，判定阈值仅 >10，一页已足够）
 */
export async function fetchAdvertiserCreativesDirect(opts: {
  advertiserId: string;
  activeDays?: number;
  maxAds?: number;
}): Promise<AtcDirectAd[]> {
  const { advertiserId, activeDays, maxAds = 100 } = opts;

  const filter: Record<string, unknown> = {
    "12": { "1": "", "2": true },
    "13": { "1": [advertiserId] },
  };
  if (activeDays && activeDays > 0) {
    const start = new Date();
    start.setDate(start.getDate() - activeDays);
    filter["6"] = fmtDateNum(start);
    filter["7"] = fmtDateNum(new Date());
  }

  const ads: AtcDirectAd[] = [];
  let pageToken: string | undefined;

  while (ads.length < maxAds) {
    const req: Record<string, unknown> = {
      "2": Math.min(maxAds - ads.length, 100),
      "3": filter,
      "7": { "1": 1 },
    };
    if (pageToken) req["4"] = pageToken;

    const body = await postSearchCreatives(req);
    const batch = body["1"] ?? [];
    ads.push(...batch.map(parseCreative));
    pageToken = body["2"];
    if (!pageToken || batch.length === 0) break;
  }

  return ads;
}
