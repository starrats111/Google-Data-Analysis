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
};

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

  const res = await fetch(`${ATC_BASE_URL}/anji/_/rpc/SearchService/SearchCreatives?authuser=`, {
    method: "POST",
    headers: ATC_HEADERS,
    body: new URLSearchParams({ "f.req": JSON.stringify(req) }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`ATC direct HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const body = (await res.json()) as { "1"?: RawCreative[] };
  // "1" 缺失 = 合法的 0 结果（与 SerpApi "no results" 同义）
  return (body["1"] ?? []).map(parseCreative);
}
