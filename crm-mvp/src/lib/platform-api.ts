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
}

const PLATFORM_API_CONFIG: Record<string, PlatformApiConfig> = {
  CF: {
    mode: "post_json",
    url: "https://api.creatorflare.com/api/monetization",
    source: "creatorflare",
    pageKey: "curPage", sizeKey: "perPage", maxSize: 500,
  },
  CG: {
    mode: "post_json",
    url: "https://api.collabglow.com/api/monetization",
    source: "collabglow",
    pageKey: "curPage", sizeKey: "perPage", maxSize: 500,
  },
  BSH: {
    mode: "post_json",
    url: "https://api.brandsparkhub.com/api/monetization",
    source: "brandsparkhub",
    pageKey: "curPage", sizeKey: "perPage", maxSize: 500,
  },
  PM: {
    mode: "post_json",
    url: "https://api.partnermatic.com/api/monetization",
    source: "partnermatic",
    pageKey: "curPage", sizeKey: "perPage", maxSize: 500,
  },
  LB: {
    mode: "post_form",
    url: "https://www.linkbux.com/api.php?mod=medium&op=monetization_api",
    pageKey: "page", sizeKey: "limit", maxSize: 1000,
  },
  LH: {
    mode: "post_form",
    url: "https://www.linkhaitao.com/api.php?mod=medium&op=merchantBasicList3",
    pageKey: "page", sizeKey: "per_page", maxSize: 2000,
    rateLimitMs: 4000,
  },
  RW: {
    mode: "post_form",
    url: "https://admin.rewardoo.com/api.php?mod=medium&op=monetization_api",
    pageKey: "page", sizeKey: "limit", maxSize: 1000,
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

async function callPlatformApi(
  config: PlatformApiConfig,
  token: string,
  page: number,
  relationship?: string,
): Promise<Record<string, unknown>> {
  const { mode, url, source, pageKey, sizeKey, maxSize } = config;
  const timeout = 120000; // 2分钟，LH等平台分页多+限速需要更长时间
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

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── 解析商家数据（各平台返回格式不同，统一提取） ──

function parseMerchants(platform: string, data: Record<string, unknown>): PlatformMerchant[] {
  const root = (data.data || data) as Record<string, unknown>;
  const list = (root.list || root.items || root.merchants || []) as Record<string, unknown>[];

  if (!Array.isArray(list)) return [];

  return list.map((item) => {
    // LH 的字段命名和其他平台相反：mcid=数字MID，m_id=slug MCID
    const mid = platform === "LH"
      ? String(item.mcid || item.mid || item.m_id || item.id || "")
      : String(item.mid || item.m_id || item.merchant_id || item.id || "");
    const name = String(item.merchant_name || item.name || item.merchantName || "");
    const category = String(item.category || item.categories || item.category_name || item.categoryName || "");
    const commission = String(item.comm_rate || item.commission_rate || item.commissionRate || item.commission || "");
    const regions = parseRegions(item.support_region || item.supported_regions || item.regions || item.country || "");
    const url = String(item.site_url || item.merchant_url || item.url || item.website || item.domain || "");
    const logo = String(item.logo || item.logo_url || item.logoUrl || "");
    const campaignLink = String(item.tracking_url || item.campaign_link || item.campaignLink || item.tracking_link || item.trackingLink || item.link || "");
    const status = String(item.relationship || item.relationship_status || item.status || "not_joined");

    return {
      merchant_id: mid,
      merchant_name: name,
      category,
      commission_rate: commission,
      supported_regions: regions,
      merchant_url: url,
      logo_url: logo,
      campaign_link: campaignLink,
      relationship_status: normalizeStatus(status),
    };
  }).filter((m) => m.merchant_id && m.merchant_name);
}

function parseRegions(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw) return raw.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function normalizeStatus(s: string): string {
  const lower = s.toLowerCase();
  if (["joined", "approved", "active", "accepted"].includes(lower)) return "joined";
  if (["pending", "applied", "waiting"].includes(lower)) return "pending";
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
 */
export async function fetchAllMerchants(
  platform: string,
  token: string,
): Promise<{ merchants: PlatformMerchant[]; error?: string }> {
  const config = PLATFORM_API_CONFIG[platform];
  if (!config) return { merchants: [], error: `不支持的平台: ${platform}` };

  const allMerchants: PlatformMerchant[] = [];
  const seen = new Set<string>();

  try {
    // 第一页
    const firstPage = await callPlatformApi(config, token, 1);
    const code = String((firstPage as Record<string, unknown>).code ?? "0");
    if (code !== "0" && code !== "200") {
      const msg = String((firstPage as Record<string, unknown>).message || "API 返回错误");
      return { merchants: [], error: `${platform}: ${msg}` };
    }

    const firstBatch = parseMerchants(platform, firstPage);
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

      const pageData = await callPlatformApi(config, token, page);
      const batch = parseMerchants(platform, pageData);
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
    url: "https://www.linkbux.com/api.php?mod=medium&op=transaction_v2",
    dateFormat: "snake", pageKey: "page", sizeKey: "limit", maxSize: 2000,
  },
};

export interface PlatformTransaction {
  transaction_id: string;
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);

  const beginKey = dateFormat === "camel" ? "beginDate" : "begin_date";
  const endKey = dateFormat === "camel" ? "endDate" : "end_date";

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

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
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
    const txnId = String(
      item.order_id || item.transaction_id || item.collabgrowId || item.orderId ||
      item.linkbux_id || item.creatorflare_id || item.brandsparkhub_id ||
      item.partnermaticId || item.sign_id || item.action_id || item.id || ""
    );

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

  const maxDays = (platform === "RW" || platform === "LB") ? 60 : 90;
  const dateChunks = splitDateRange(startDate, endDate, maxDays);

  const mergeTxn = (t: PlatformTransaction) => {
    const idx = txnIndex.get(t.transaction_id);
    if (idx !== undefined) {
      const existing = allTxns[idx];
      // 相同金额 → 分页重复，用最新状态覆盖即可
      if (existing.commission_amount === t.commission_amount && existing.order_amount === t.order_amount) {
        if (t.status !== existing.status) existing.status = t.status;
        if (t.raw_status !== existing.raw_status) existing.raw_status = t.raw_status;
        return;
      }
      // 不同金额 → 同一订单的不同子项，累加
      existing.commission_amount += t.commission_amount;
      existing.order_amount += t.order_amount;
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
