/**
 * 联盟平台 API 同步服务
 * 从 8 个联盟平台拉取商家列表，写入 user_merchants 表
 * 完全独立实现，不依赖旧后端
 */

// ── 平台 API 配置 ──

interface PlatformApiConfig {
  mode: "post_json" | "post_form" | "get";
  url: string;
  source?: string;
  pageKey: string;
  sizeKey: string;
  maxSize: number;
  rateLimitMs?: number;
  /** 该平台 API 本身只返回已加入的商家，无需再做 relationship_status 过滤 */
  assumeAllJoined?: boolean;
  /**
   * 该平台 API 要求显式携带 relationship 参数才能正常返回数据。
   * 设为 true 时请求会附带 relationshipValue（默认 "Joined"）
   */
  requiresRelationshipParam?: boolean;
  /**
   * 覆盖默认的 relationship 过滤值（默认 "Joined"）。
   * 例如 RW (Rewardoo) 平台实际状态为 Approved/Pending/Reject/Not Join，
   * 不存在 "Joined"，需传 "Approved"。
   */
  relationshipValue?: string;
}

const PLATFORM_API_CONFIG: Record<string, PlatformApiConfig> = {
  CF: {
    mode: "post_json",
    url: "https://api.creatorflare.com/api/monetization",
    source: "creatorflare",
    pageKey: "curPage", sizeKey: "perPage", maxSize: 2000, // 文档最大 2000，减少分页次数
    assumeAllJoined: true,
    requiresRelationshipParam: true, // API 要求显式传 relationship:"Joined"，否则报 filter.relationship 错误
  },
  CG: {
    mode: "post_json",
    url: "https://api.collabglow.com/api/monetization",
    source: "collabglow",
    pageKey: "curPage", sizeKey: "perPage", maxSize: 2000, // 文档最大 2000，减少分页次数
    assumeAllJoined: true,
    requiresRelationshipParam: true, // API 要求显式传 relationship:"Joined"，否则报 filter.relationship 错误
  },
  BSH: {
    mode: "post_json",
    url: "https://api.brandsparkhub.com/api/monetization",
    source: "brandsparkhub",
    pageKey: "curPage", sizeKey: "perPage", maxSize: 2000, // 文档最大 2000，减少分页次数
    assumeAllJoined: true,
    requiresRelationshipParam: true, // API 要求显式传 relationship:"Joined"，否则报 filter.relationship 错误
  },
  PM: {
    mode: "post_json",
    url: "https://api.partnermatic.com/api/monetization",
    source: "partnermatic",
    pageKey: "curPage", sizeKey: "perPage", maxSize: 2000, // 文档最大 2000，减少分页次数
    assumeAllJoined: true,
    requiresRelationshipParam: true, // API 要求显式传 relationship:"Joined"，否则报 filter.relationship 错误
  },
  LB: {
    mode: "post_form",
    url: "https://www.linkbux.com/api.php?mod=medium&op=monetization_api",
    pageKey: "page", sizeKey: "limit", maxSize: 1000,
    // LB API 对 relationship 参数大小写敏感：必须传 "Joined"（首字母大写），小写 "joined" 返回空列表
    assumeAllJoined: true,
    requiresRelationshipParam: true,
  },
  LH: {
    mode: "post_form",
    url: "https://www.linkhaitao.com/api.php?mod=medium&op=merchantBasicList3",
    pageKey: "page", sizeKey: "per_page", maxSize: 200, // 原 2000，LH 服务器单次大查询会 504，改小后每页轻量
    rateLimitMs: 1500,
    assumeAllJoined: true, // merchantBasicList3 只返回已加入商家
  },
  RW: {
    mode: "post_form",
    url: "https://admin.rewardoo.com/api.php?mod=medium&op=merchant_details",
    pageKey: "page", sizeKey: "limit", maxSize: 1000,
    // RW API 必须携带 relationship="Joined" 才能返回已批准商家（不传返回 0 条，传"Approved"返回 error 1003）。
    // UI 界面显示"Approved"，API 过滤值为"Joined"，两者是同一状态的不同术语。
    // RW 有多个账号（7000+商家每账号），并发请求会导致第3+页超时，故在 sync 层改为串行拉取。
    assumeAllJoined: true,
    requiresRelationshipParam: true,
    // 不设 relationshipValue，默认使用"Joined"（API 唯一有效的已批准过滤值）
  },
  MUI: {
    mode: "post_json",
    url: "https://api.ultrainfluence.com/api/monetization",
    source: "ultrainfluence",
    pageKey: "curPage", sizeKey: "perPage", maxSize: 2000,
    assumeAllJoined: true,
    requiresRelationshipParam: true,
  },
};

// ── 统一商家数据结构 ──

export interface PlatformMerchant {
  merchant_id: string;
  merchant_name: string;
  category: string;
  commission_rate: string;
  supported_regions: string[];
  merchant_url: string;
  logo_url: string;
  campaign_link: string;
  relationship_status: string; // joined / not_joined / pending
}

// ── API 请求 ──

const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_RETRIES = 2;

// 商家列表 API 超时：60s，最多重试 2 次（单页最长 60+2+60+4+60=186s）
// PM 实测大账号（16k+商家）单页响应偶尔超 30s；RW page1~page2 响应 17~25s。
// 增大超时与重试次数，确保每页都能完整拉回，避免大账号被截断。
const MERCHANT_API_TIMEOUT = 60000;
const MERCHANT_API_MAX_RETRIES = 2;

async function callPlatformApi(
  config: PlatformApiConfig,
  token: string,
  page: number,
  relationship?: string,
): Promise<Record<string, unknown>> {
  const { mode, url, source, pageKey, sizeKey, maxSize } = config;

  const maxRetries = MERCHANT_API_MAX_RETRIES;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeout = MERCHANT_API_TIMEOUT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      let resp: Response;

      if (mode === "post_json") {
        const payload: Record<string, unknown> = {
          source, token,
          [pageKey]: page,
          [sizeKey]: maxSize,
        };
        if (relationship) payload.relationship = relationship;
        resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } else if (mode === "post_form") {
        const form = new URLSearchParams();
        form.set("token", token);
        form.set(pageKey, String(page));
        form.set(sizeKey, String(maxSize));
        if (relationship) form.set("relationship", relationship);
        resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: controller.signal,
        });
      } else {
        const params = new URLSearchParams({
          token, [pageKey]: String(page), [sizeKey]: String(maxSize),
        });
        if (relationship) params.set("relationship", relationship);
        resp = await fetch(`${url}&${params}`, { signal: controller.signal });
      }

      if (!resp.ok) {
        if (RETRYABLE_STATUS.has(resp.status) && attempt < maxRetries) {
          const delay = (attempt + 1) * 2000;
          console.warn(`[Platform] ${url} HTTP ${resp.status}，${delay / 1000}s 后重试 (${attempt + 1}/${maxRetries})`);
          clearTimeout(timer);
          await sleep(delay);
          continue;
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      return await resp.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < maxRetries && err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        const delay = (attempt + 1) * 2000;
        console.warn(`[Platform] ${url} 超时，${delay / 1000}s 后重试 (${attempt + 1}/${maxRetries})`);
        await sleep(delay);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("max retries exceeded");
}

// ── 解析商家数据（各平台返回格式不同，统一提取） ──

function parseMerchants(platform: string, data: Record<string, unknown>, assumeAllJoined = false): PlatformMerchant[] {
  const root = (data.data || data) as Record<string, unknown>;
  const list = (root.list || root.items || root.merchants || []) as Record<string, unknown>[];

  if (!Array.isArray(list)) return [];

  return list.map((item, idx) => {
    // LH 的字段命名和其他平台相反：mcid=数字MID，m_id=slug MCID
    // PM/BSH/CF/CG/MUI：mid 已被 API 文档标注为 deprecated（将来会移除），
    // 正式 ID 为 brand_id（数值）和 mcid（字符串 slug），两者当前与 mid 同值。
    // 提前将 brand_id 加入兜底链，避免未来 mid 字段消失后 merchant_id 全为空。
    const mid = platform === "LH"
      ? String(item.mcid || item.mid || item.m_id || item.id || "")
      : String(item.mid || item.brand_id || item.m_id || item.merchant_id || item.id || "");
    // RW 部分商家 merchant_name 为空字符串，用 site_url 域名或 mcid 兜底，避免被过滤掉
    const rawName = String(item.merchant_name || item.name || item.merchantName || "");
    const nameFallback = (() => {
      if (rawName) return rawName;
      const siteUrl = String(item.site_url || item.siteUrl || "");
      if (siteUrl) {
        try { return new URL(siteUrl).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
      }
      return String(item.mcid || item.m_id || "");
    })();
    const name = nameFallback;
    const category = String(item.category || item.categories || item.category_name || item.categoryName || "");
    // 各平台均返回 snake_case 字段名（comm_rate / site_url / support_region），同时兼容 camelCase 备用
    const commission = String(item.comm_rate || item.commRate || item.commission_rate || item.commissionRate || item.commission || "");
    const regions = parseRegions(item.support_region || item.supportRegion || item.supported_regions || item.regions || item.country || "");
    const url = String(item.site_url || item.siteUrl || item.merchant_url || item.url || item.website || item.domain || item.homepage || "");
    const logo = String(
      item.logo || item.logo_url || item.logoUrl ||
      item.icon || item.icon_url || item.iconUrl ||
      item.merchant_logo || item.merchantLogo ||
      item.image || item.image_url || item.imageUrl ||
      item.thumbnail || item.thumb ||
      item.m_icon || item.favicon || ""
    );
    const campaignLink = String(
      item.tracking_url || item.trackingUrl ||
      item.campaign_link || item.campaignLink ||
      item.tracking_link || item.trackingLink ||
      item.promote_link || item.promoteLink ||
      item.aff_link || item.affLink ||
      item.link || ""
    );

    // assumeAllJoined：该平台 API 本身只返回已加入商家，强制标记为 joined
    let relationshipStatus: string;
    if (assumeAllJoined) {
      relationshipStatus = "joined";
    } else {
      const rawStatus = String(item.relationship || item.relationship_status || item.status || "not_joined");
      relationshipStatus = normalizeStatus(rawStatus);
      // 首条商家诊断日志
      if (idx === 0) {
        console.log(`[MerchantDiag] ${platform} 首条商家 status 字段: relationship=${item.relationship} relationship_status=${item.relationship_status} status=${item.status} → normalized=${relationshipStatus}`);
      }
    }

    return {
      merchant_id: mid,
      merchant_name: name,
      category,
      commission_rate: commission,
      supported_regions: regions,
      merchant_url: url,
      logo_url: logo,
      campaign_link: campaignLink,
      relationship_status: relationshipStatus,
    };
  }).filter((m) => m.merchant_id && m.merchant_name);
}

function parseRegions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw) return raw.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function normalizeStatus(s: string): string {
  const lower = s.toLowerCase().trim();
  if (["joined", "approved", "active", "accepted", "confirmed", "enabled", "member", "success", "1", "2"].includes(lower)) return "joined";
  if (["pending", "applied", "waiting", "reviewing", "under_review", "in_review"].includes(lower)) return "pending";
  return "not_joined";
}

// ── 获取总页数 ──

function getTotalPages(data: Record<string, unknown>, maxSize: number): number {
  const root = (data.data || data) as Record<string, unknown>;

  // 有些平台直接返回 total_page（总页数）
  const totalPage = Number(root.total_page || root.totalPage || root.totalPages || 0);
  if (totalPage > 0) return totalPage;

  // 其他平台返回 total（总条数），需要计算页数
  const total = Number(root.total || root.totalCount || root.total_mcid || root.count || 0);
  if (total <= 0) return 1;
  return Math.ceil(total / maxSize);
}

// ── 主同步函数 ──

export interface SyncResult {
  platform: string;
  total: number;
  new: number;
  updated: number;
  error?: string;
}

/**
 * 从单个平台拉取全部商家列表
 * @param relationshipFilter 可选：传 "joined" 让 API 只返回已加入的品牌（更高效，避免翻页上限漏掉末尾品牌）
 */
export async function fetchAllMerchants(
  platform: string,
  token: string,
  relationshipFilter?: string,
): Promise<{ merchants: PlatformMerchant[]; error?: string }> {
  const config = PLATFORM_API_CONFIG[platform];
  if (!config) return { merchants: [], error: `不支持的平台: ${platform}` };

  const allMerchants: PlatformMerchant[] = [];
  const seen = new Set<string>();

  const assumeAllJoined = config.assumeAllJoined === true;

  // requiresRelationshipParam：该平台 API 必须显式携带 relationship 参数才能返回数据。
  // 默认值为 "Joined"，各平台可通过 relationshipValue 覆盖（例如 RW 实际状态为 "Approved"）。
  const effectiveRelFilter = config.requiresRelationshipParam
    ? (config.relationshipValue ?? "Joined")
    : (assumeAllJoined ? undefined : relationshipFilter);

  try {
    const firstPage = await callPlatformApi(config, token, 1, effectiveRelFilter);
    // 兼容两种错误格式：
    //   1. PM/BSH/CF/CG/MUI：{ "code": "1001", "message": "..." }（顶层 code）
    //   2. LB/LH/RW：{ "status": { "code": 1000, "msg": "..." }, "data": {...} }（status 包装层）
    const topCode = String((firstPage as Record<string, unknown>).code ?? "");
    const statusCode = (firstPage as any).status?.code;
    const effectiveCode = topCode && topCode !== "0" ? topCode
      : (statusCode != null && statusCode !== 0 ? String(statusCode) : "0");
    if (effectiveCode !== "0" && effectiveCode !== "200") {
      const msg = String(
        (firstPage as Record<string, unknown>).message ||
        (firstPage as any).status?.msg ||
        "API 返回错误"
      );
      return { merchants: [], error: `${platform}: ${msg}` };
    }

    // 首页诊断：打印首条原始记录的链接相关字段
    const diagRoot = ((firstPage as any).data || firstPage) as Record<string, unknown>;
    const diagList = (diagRoot.list || diagRoot.items || diagRoot.merchants || []) as Record<string, unknown>[];
    if (Array.isArray(diagList) && diagList.length > 0) {
      const sample = diagList[0];
      const linkFields: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(sample)) {
        const kl = k.toLowerCase();
        if (["url", "link", "track", "site", "domain", "homepage", "promote", "aff"].some(w => kl.includes(w))) {
          linkFields[k] = v;
        }
      }
      console.log(`[MerchantDiag] ${platform} 首条商家链接字段:`, JSON.stringify(linkFields));
      console.log(`[MerchantDiag] ${platform} assumeAllJoined=${assumeAllJoined}`);
    }

    // 获取首页原始列表数量（用于判断是否是最后一页，不受 parseMerchants 过滤影响）
    const firstRoot = ((firstPage as any).data || firstPage) as Record<string, unknown>;
    const firstRawList = (firstRoot.list || firstRoot.items || firstRoot.merchants || []) as unknown[];
    const firstRawCount = Array.isArray(firstRawList) ? firstRawList.length : 0;

    const firstBatch = parseMerchants(platform, firstPage, assumeAllJoined);
    for (const m of firstBatch) {
      if (!seen.has(m.merchant_id)) { seen.add(m.merchant_id); allMerchants.push(m); }
    }

    // 分页计算：API 实际返回条数可能小于请求的 maxSize（平台侧限制），
    // 必须用实际返回条数（而非 maxSize）来计算总页数和判断末页
    const apiRoot = ((firstPage as any).data || firstPage) as Record<string, unknown>;
    const apiTotal = Number(apiRoot.total || apiRoot.totalCount || apiRoot.total_mcid || apiRoot.count || 0);
    const actualPageSize = firstRawCount;

    let totalPages: number;
    if (apiTotal > 0 && actualPageSize > 0) {
      totalPages = Math.ceil(apiTotal / actualPageSize);
    } else {
      totalPages = getTotalPages(firstPage, config.maxSize);
    }

    // 回退：如果无法确定总页数但首页返回了满页数据，按逐页拉取直到空页
    if (totalPages <= 1 && actualPageSize >= config.maxSize) {
      totalPages = 200;
    }

    if (totalPages > 1) {
      console.log(`[MerchantSync] ${platform}: total=${apiTotal}, page1=${actualPageSize}, totalPages=${totalPages}`);
    }

    // 后续页
    // 部分平台（如 LH）会间歇性返回空页（限流/缓存），不能遇空就停，需重试
    let consecutiveEmpty = 0;
    const MAX_EMPTY_RETRIES = 2;    // 单页空响应最多重试 2 次
    const MAX_CONSECUTIVE_EMPTY = 3; // 连续 3 页都为空才放弃

    for (let page = 2; page <= Math.min(totalPages, 200); page++) {
      if (config.rateLimitMs) await sleep(config.rateLimitMs);
      else await sleep(100);

      let pageRawCount = 0;
      let pageData: Record<string, unknown> = {};

      for (let retry = 0; retry <= MAX_EMPTY_RETRIES; retry++) {
        if (retry > 0) {
          console.warn(`[MerchantSync] ${platform} page ${page} 空/错误响应，${(retry + 1) * 2}s 后重试 (${retry}/${MAX_EMPTY_RETRIES})`);
          await sleep((retry + 1) * 2000);
        }
        try {
          pageData = await callPlatformApi(config, token, page, effectiveRelFilter);
        } catch (pageErr) {
          // 单页请求彻底失败（超时/网络），降级为空页处理，让 consecutiveEmpty 机制决定是否放弃，
          // 而不是直接 throw 中断整个同步（避免大账号因一页故障丢失后续数百页数据）
          console.warn(`[MerchantSync] ${platform} page ${page} 请求失败 (${retry}/${MAX_EMPTY_RETRIES}): ${pageErr instanceof Error ? pageErr.message : String(pageErr)}`);
          pageRawCount = 0;
          continue;
        }
        const pageRoot = ((pageData as any).data || pageData) as Record<string, unknown>;
        const pageRawList = (pageRoot.list || pageRoot.items || pageRoot.merchants || []) as unknown[];
        pageRawCount = Array.isArray(pageRawList) ? pageRawList.length : 0;
        if (pageRawCount > 0) break;
      }

      if (pageRawCount === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) {
          console.warn(`[MerchantSync] ${platform} 连续 ${consecutiveEmpty} 页为空，停止翻页 (page=${page})`);
          break;
        }
        continue; // 跳过空页，继续下一页
      }
      consecutiveEmpty = 0;

      const batch = parseMerchants(platform, pageData, assumeAllJoined);
      for (const m of batch) {
        if (!seen.has(m.merchant_id)) { seen.add(m.merchant_id); allMerchants.push(m); }
      }

      // 仅当 totalPages 是由 fallback（200）估算时，才用末页判断提前终止；
      // 若 API 已返回准确总数（totalPages 由 apiTotal 计算），则完全信任总页数，
      // 避免某页因网络抖动/限流返回不完整数据时错误截断后续分页。
      const totalPagesFromApi = apiTotal > 0 && actualPageSize > 0;
      if (!totalPagesFromApi && pageRawCount < actualPageSize) break;
    }

    return { merchants: allMerchants };
  } catch (err) {
    return { merchants: allMerchants, error: `${platform}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════════════════════════
// 交易数据 API — 从各联盟平台拉取交易明细
// ══════════════════════════════════════════════════════════════

interface PlatformTxnConfig {
  mode: "post_json" | "post_form" | "get";
  url: string;
  source?: string;
  dateFormat: "camel" | "snake"; // beginDate/endDate vs begin_date/end_date
  pageKey: string;
  sizeKey: string;
  maxSize: number;
  rateLimitMs?: number;
}

const PLATFORM_TXN_CONFIG: Record<string, PlatformTxnConfig> = {
  CG: {
    mode: "post_json",
    url: "https://api.collabglow.com/api/transaction",
    source: "collabglow",
    dateFormat: "camel", pageKey: "curPage", sizeKey: "perPage", maxSize: 2000,
  },
  CF: {
    mode: "post_json",
    url: "https://api.creatorflare.com/api/transaction",
    source: "creatorflare",
    dateFormat: "camel", pageKey: "curPage", sizeKey: "perPage", maxSize: 2000,
  },
  PM: {
    mode: "post_json",
    url: "https://api.partnermatic.com/api/transaction",
    source: "partnermatic",
    dateFormat: "camel", pageKey: "curPage", sizeKey: "perPage", maxSize: 2000,
  },
  BSH: {
    mode: "post_json",
    url: "https://api.brandsparkhub.com/api/transaction",
    source: "brandsparkhub",
    dateFormat: "camel", pageKey: "curPage", sizeKey: "perPage", maxSize: 2000,
  },
  RW: {
    mode: "post_form",
    url: "https://admin.rewardoo.com/api.php?mod=medium&op=transaction_details",
    dateFormat: "snake", pageKey: "page", sizeKey: "limit", maxSize: 1000,
  },
  LH: {
    mode: "get",
    url: "https://www.linkhaitao.com/api.php?mod=medium&op=cashback2",
    dateFormat: "snake", pageKey: "page", sizeKey: "per_page", maxSize: 40000,
    rateLimitMs: 4000,
  },
  LB: {
    mode: "get",
    url: "https://www.linkbux.com/api.php?mod=medium&op=transaction",
    dateFormat: "snake", pageKey: "page", sizeKey: "limit", maxSize: 2000,
  },
  MUI: {
    mode: "post_json",
    url: "https://api.ultrainfluence.com/api/transaction_v3",
    source: "ultrainfluence",
    dateFormat: "camel", pageKey: "curPage", sizeKey: "perPage", maxSize: 2000,
  },
};

export interface PlatformTransaction {
  transaction_id: string;
  order_id?: string;          // 原始 order_id（CG/PM/BSH/CF 平台用于辅助去重）
  transaction_time: string; // YYYY-MM-DD HH:MM:SS
  merchant: string;
  merchant_id: string;
  order_amount: number;
  commission_amount: number;
  status: string; // approved / pending / rejected
  raw_status: string;
}

async function callTxnApi(
  config: PlatformTxnConfig,
  token: string,
  startDate: string,
  endDate: string,
  page: number,
): Promise<Record<string, unknown>> {
  const { mode, url, source, dateFormat, pageKey, sizeKey, maxSize } = config;

  const beginKey = dateFormat === "camel" ? "beginDate" : "begin_date";
  const endKey = dateFormat === "camel" ? "endDate" : "end_date";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);

    try {
      let resp: Response;

      if (mode === "post_json") {
        const payload: Record<string, unknown> = {
          token, [beginKey]: startDate, [endKey]: endDate,
          [pageKey]: page, [sizeKey]: maxSize,
          status: ["All"],
        };
        if (source) payload.source = source;
        resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } else if (mode === "post_form") {
        const form = new URLSearchParams();
        form.set("token", token);
        form.set(beginKey, startDate);
        form.set(endKey, endDate);
        form.set(pageKey, String(page));
        form.set(sizeKey, String(maxSize));
        form.set("status", "all");
        resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: controller.signal,
        });
      } else {
        const params = new URLSearchParams({
          token,
          [beginKey]: startDate,
          [endKey]: endDate,
          [pageKey]: String(page),
          [sizeKey]: String(maxSize),
          status: "all",
        });
        resp = await fetch(`${url}&${params}`, { signal: controller.signal });
      }

      if (!resp.ok) {
        if (RETRYABLE_STATUS.has(resp.status) && attempt < MAX_RETRIES) {
          const delay = (attempt + 1) * 5000;
          console.warn(`[TxnAPI] ${url} HTTP ${resp.status}，${delay / 1000}s 后重试 (${attempt + 1}/${MAX_RETRIES})`);
          clearTimeout(timer);
          await sleep(delay);
          continue;
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      return await resp.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < MAX_RETRIES && err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        const delay = (attempt + 1) * 5000;
        console.warn(`[TxnAPI] ${url} 超时，${delay / 1000}s 后重试 (${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("max retries exceeded");
}

/**
 * 解析各种格式的时间戳为 ISO 字符串。
 * 关键修复：无时区后缀的日期字符串（如 "2026-03-23 15:30:00"）
 * 强制视为 UTC，避免被 new Date() 按服务器本地时区（UTC+8）解析导致偏移。
 */
function parseTimestamp(raw: unknown): string {
  if (!raw) return new Date().toISOString();
  const s = String(raw).trim();
  // Unix 时间戳（秒）
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  // Unix 时间戳（毫秒）
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  // 已有时区标识（Z / +HH:MM / -HH:MM）→ 直接解析
  if (/[Zz]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // "YYYY-MM-DD HH:MM:SS" 或 "YYYY-MM-DDTHH:MM:SS"（无时区）→ 强制 UTC
  const utcMatch = s.match(/^(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2})$/);
  if (utcMatch) {
    const d = new Date(`${utcMatch[1]}T${utcMatch[2]}Z`);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // 其他格式兜底
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return s;
}

const TXN_STATUS_MAP: Record<string, string> = {
  approved: "approved", confirmed: "approved", locked: "approved",
  active: "approved", effective: "approved",
  paid: "paid", settled: "paid",
  pending: "pending", under_review: "pending", processing: "pending",
  waiting: "pending", untreated: "pending", "preliminary effective": "pending",
  rejected: "rejected", declined: "rejected", reversed: "rejected",
  invalid: "rejected", adjusted: "rejected", cancelled: "rejected",
  voided: "rejected", expired: "rejected", "preliminary expired": "rejected",
};

function normalizeTxnStatus(s: string): string {
  const lower = String(s).toLowerCase().trim();
  return TXN_STATUS_MAP[lower] || "pending";
}

/**
 * 从多个候选字段中提取第一个有效的非零数值。
 * 修复 `||` 链对 "0.00" 等 truthy 字符串的短路问题：
 *   旧代码: item.sale_comm || item.commission → "0.00" 是 truthy，后续字段被跳过
 *   新代码: 逐个尝试，优先取非零值，全为零时返回 0
 */
function pickNumericField(...candidates: unknown[]): number {
  for (const c of candidates) {
    if (c == null) continue;
    const n = parseFloat(String(c));
    if (!isNaN(n) && n !== 0) return n;
  }
  for (const c of candidates) {
    if (c == null) continue;
    const n = parseFloat(String(c));
    if (!isNaN(n)) return n;
  }
  return 0;
}

let _diagLogged = new Set<string>();

function parseTransactions(platform: string, data: Record<string, unknown>): PlatformTransaction[] {
  const root = (data.data || data) as Record<string, unknown>;
  let list = (root.list || root.transactions || root.items || []) as Record<string, unknown>[];
  if (!Array.isArray(list)) return [];

  // MUI 交易数据为 订单→商品行 嵌套结构，需展平为逐行记录
  if (platform === "MUI") {
    const flat: Record<string, unknown>[] = [];
    for (const order of list) {
      const items = (order as any).items;
      if (Array.isArray(items) && items.length > 0) {
        for (const sub of items) {
          flat.push({ ...order, ...sub });
        }
      } else {
        flat.push(order);
      }
    }
    list = flat;
  }

  // 每个平台只打印一次首条交易的原始字段（诊断用）
  if (list.length > 0 && !_diagLogged.has(platform)) {
    _diagLogged.add(platform);
    const sample = list[0] as Record<string, unknown>;
    const commFields: Record<string, string> = {};
    for (const [k, v] of Object.entries(sample)) {
      const kl = k.toLowerCase();
      if (["comm", "amount", "sale", "cashback", "cost", "price", "revenue", "fee", "payout", "earning"].some(w => kl.includes(w))) {
        commFields[k] = `${JSON.stringify(v)} (${typeof v})`;
      }
    }
    console.log(`[TxnDiag] ${platform} 首条交易金额相关字段:`, JSON.stringify(commFields));

    // 模拟旧逻辑对比
    const oldComm = parseFloat(String(
      sample.sale_comm || sample.saleComm || sample.commission_amount || sample.commission ||
      sample.saleCommission || sample.cashback || "0"
    )) || 0;
    const newComm = pickNumericField(
      sample.sale_comm, sample.saleComm, sample.commission_amount, sample.commission,
      sample.saleCommission, sample.cashback
    );
    if (oldComm !== newComm) {
      console.log(`[TxnDiag] ★★★ ${platform} Bug1 确认! 旧逻辑=${oldComm}, 新逻辑=${newComm}, 差=${newComm - oldComm}`);
    }
  }

  return list.map((item) => {
    // 优先使用平台级商品/明细 ID（每个商品独立），再 fallback 到 order_id
    // API 字段用下划线命名（如 collabgrow_id），代码同时兼容驼峰
    const txnId = String(
      item.ultrainfluence_id || item.ultrainfluenceId ||
      item.collabgrow_id || item.collabgrowId ||
      item.creatorflare_id || item.creatorflareId ||
      item.brandsparkhub_id || item.brandsparkhubId ||
      item.partnermatic_id || item.partnermaticId ||
      item.linkbux_id || item.linkbuxId ||
      item.rewardoo_id || item.rewardooId ||
      item.sign_id || item.action_id ||
      item.order_id || item.transaction_id || item.orderId ||
      item.id || ""
    );

    // 同时保留原始 order_id，用于辅助去重（同一 order_id 可能对应多个商品行 ID）
    const rawOrderId = String(item.order_id || item.orderId || "");

    const merchant = String(
      item.merchant || item.merchant_name || item.merchantName ||
      item.advertiser_name || item.brand || item.name || ""
    );

    const midCandidates = platform === "LH"
      ? [item.mcid, item.mid, item.m_id, item.brand_id, item.merchant_id, item.merchantId, item.advertiser_id]
      : [item.mid, item.m_id, item.merchant_id, item.merchantId, item.brand_id, item.advertiser_id];
    let mid = "";
    for (const c of midCandidates) {
      if (c != null) {
        const s = String(c).trim();
        if (s && /^\d+$/.test(s)) { mid = s; break; }
      }
    }

    const orderAmount = pickNumericField(
      item.sale_amount, item.saleAmount, item.order_amount, item.amount
    );

    const commissionAmount = pickNumericField(
      item.sale_comm, item.saleComm, item.commission_amount, item.commission,
      item.saleCommission, item.cashback
    );

    const rawStatus = String(item.status || item.raw_status || "pending");

    const txnTime = parseTimestamp(
      item.order_time || item.orderTime || item.transaction_time || item.report_time || item.created_at
    );

    return {
      transaction_id: txnId,
      order_id: rawOrderId || undefined,
      transaction_time: txnTime,
      merchant,
      merchant_id: mid,
      order_amount: orderAmount,
      commission_amount: commissionAmount,
      status: normalizeTxnStatus(rawStatus),
      raw_status: rawStatus,
    };
  }).filter((t) => t.transaction_id);
}

function getTxnTotalPages(data: Record<string, unknown>, maxSize: number): number {
  const root = (data.data || data) as Record<string, unknown>;
  const totalPage = Number(root.total_page || root.totalPage || root.totalPages || 0);
  if (totalPage > 0) return totalPage;
  const total = Number(root.total || root.totalCount || root.total_trans || root.total_items || root.count || 0);
  if (total <= 0) return 1;
  return Math.ceil(total / maxSize);
}

/**
 * 从单个平台拉取指定日期范围内的全部交易数据
 */
export async function fetchAllTransactions(
  platform: string,
  token: string,
  startDate: string, // YYYY-MM-DD
  endDate: string,   // YYYY-MM-DD
): Promise<{ transactions: PlatformTransaction[]; error?: string }> {
  const config = PLATFORM_TXN_CONFIG[platform];
  if (!config) return { transactions: [], error: `不支持的平台交易 API: ${platform}` };

  const allTxns: PlatformTransaction[] = [];
  const txnIndex = new Map<string, number>(); // transaction_id → index in allTxns

  // CG API 限制查询跨度不超过 62 天，统一用 60 天切片
  const maxDays = 60;
  const dateChunks = splitDateRange(startDate, endDate, maxDays);

  const mergeTxn = (t: PlatformTransaction) => {
    const idx = txnIndex.get(t.transaction_id);
    if (idx !== undefined) {
      // 同一 ID 多次出现：累加金额（跨日期段重复拉取时可能出现）
      const existing = allTxns[idx];
      existing.commission_amount += t.commission_amount;
      existing.order_amount += t.order_amount;
      existing.status = t.status;
      existing.raw_status = t.raw_status;
    } else {
      txnIndex.set(t.transaction_id, allTxns.length);
      allTxns.push({ ...t });
    }
  };

  try {
    for (const chunk of dateChunks) {
      const firstPage = await callTxnApi(config, token, chunk.start, chunk.end, 1);
      const code = String((firstPage as Record<string, unknown>).code ?? (firstPage as Record<string, unknown>).status ? ((firstPage as any).status?.code ?? "0") : "0");

      const statusCode = (firstPage as any).status?.code;
      if (statusCode !== undefined && statusCode !== 0 && String(statusCode) !== "0") {
        const msg = String((firstPage as any).status?.msg || "API 错误");
        if (msg.toLowerCase().includes("no data") || msg.toLowerCase().includes("no record")) continue;
        return { transactions: allTxns, error: `${platform}: ${msg}` };
      }
      if (code !== "0" && code !== "200" && code !== "undefined") {
        const msg = String((firstPage as Record<string, unknown>).message || "API 返回错误");
        if (msg.toLowerCase().includes("no data")) continue;
        return { transactions: allTxns, error: `${platform}: ${msg}` };
      }

      const firstBatch = parseTransactions(platform, firstPage);
      for (const t of firstBatch) mergeTxn(t);

      const totalPages = getTxnTotalPages(firstPage, config.maxSize);

      for (let page = 2; page <= Math.min(totalPages, 50); page++) {
        if (config.rateLimitMs) await sleep(config.rateLimitMs);
        else await sleep(100);

        const pageData = await callTxnApi(config, token, chunk.start, chunk.end, page);
        const batch = parseTransactions(platform, pageData);
        if (batch.length === 0) break;

        for (const t of batch) mergeTxn(t);
      }
    }

    return { transactions: allTxns };
  } catch (err) {
    return {
      transactions: allTxns,
      error: `${platform}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function splitDateRange(start: string, end: string, maxDays: number): { start: string; end: string }[] {
  const chunks: { start: string; end: string }[] = [];
  let cur = new Date(start);
  const endDate = new Date(end);

  while (cur <= endDate) {
    const chunkEnd = new Date(cur);
    chunkEnd.setDate(chunkEnd.getDate() + maxDays - 1);
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime());
    chunks.push({
      start: cur.toISOString().slice(0, 10),
      end: chunkEnd.toISOString().slice(0, 10),
    });
    cur = new Date(chunkEnd);
    cur.setDate(cur.getDate() + 1);
  }
  return chunks;
}

export { PLATFORM_API_CONFIG, PLATFORM_TXN_CONFIG };
