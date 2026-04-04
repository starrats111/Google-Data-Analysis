/**
 * 联盟平台 API 同步服务
 * 从 7 个联盟平台拉取商家列表，写入 user_merchants 表
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
   * 不传时 API 报错：filter.relationship must be one of the following values: Joined, Pending...
   * 设为 true 时请求会固定附带 relationship: "Joined"
   */
  requiresRelationshipParam?: boolean;
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
    // LB API 返回所有平台商家（含 Joined/Rejected/No Relationship/Pending），
    // 必须读取 relationship 字段过滤，不能 assumeAllJoined
    assumeAllJoined: false,
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
    assumeAllJoined: true, // 加 relationship=Joined 过滤后 API 只返回已加入商家
    requiresRelationshipParam: true, // 必须显式传 relationship:"Joined"；官方文档 merchant_details 端口支持此过滤
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

// 商家列表 API 超时：15s，最多重试 1 次（单页最长 15+2+15=32s）
// 交易 API 超时更长（120s），保持不变
const MERCHANT_API_TIMEOUT = 15000;
const MERCHANT_API_MAX_RETRIES = 1;

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
    const mid = platform === "LH"
      ? String(item.mcid || item.mid || item.m_id || item.id || "")
      : String(item.mid || item.m_id || item.merchant_id || item.id || "");
    const name = String(item.merchant_name || item.name || item.merchantName || "");
    const category = String(item.category || item.categories || item.category_name || item.categoryName || "");
    // PM (Partnermatic) 返回 camelCase 字段名（commRate / siteUrl / supportRegion），其余平台为 snake_case
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

  // requiresRelationshipParam：该平台 API 必须显式携带 relationship:"Joined"，
  // 不传时会返回错误（filter.relationship must be one of the following values: Joined...）
  // assumeAllJoined 但不需要显式参数的平台（LH/LB/RW）不传该字段，避免不兼容
  const effectiveRelFilter = config.requiresRelationshipParam
    ? "Joined"
    : (assumeAllJoined ? undefined : relationshipFilter);

  try {
    const firstPage = await callPlatformApi(config, token, 1, effectiveRelFilter);
    const code = String((firstPage as Record<string, unknown>).code ?? "0");
    if (code !== "0" && code !== "200") {
      const msg = String((firstPage as Record<string, unknown>).message || "API 返回错误");
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

    const firstBatch = parseMerchants(platform, firstPage, assumeAllJoined);
    for (const m of firstBatch) {
      if (!seen.has(m.merchant_id)) { seen.add(m.merchant_id); allMerchants.push(m); }
    }

    let totalPages = getTotalPages(firstPage, config.maxSize);

    // 回退：如果无法解析总页数但首页返回了满页数据，按逐页拉取直到空页
    const useProbing = totalPages <= 1 && firstBatch.length >= config.maxSize;
    if (useProbing) totalPages = 200; // 设置一个安全上限

    // 后续页
    for (let page = 2; page <= Math.min(totalPages, 200); page++) {
      if (config.rateLimitMs) await sleep(config.rateLimitMs);
      else await sleep(100);

      const pageData = await callPlatformApi(config, token, page, effectiveRelFilter);
      const batch = parseMerchants(platform, pageData, assumeAllJoined);
      if (batch.length === 0) break;

      for (const m of batch) {
        if (!seen.has(m.merchant_id)) { seen.add(m.merchant_id); allMerchants.push(m); }
      }

      // 如果本页数据量不足 maxSize，说明是最后一页
      if (batch.length < config.maxSize) break;
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
  const list = (root.list || root.transactions || root.items || []) as Record<string, unknown>[];
  if (!Array.isArray(list)) return [];

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
