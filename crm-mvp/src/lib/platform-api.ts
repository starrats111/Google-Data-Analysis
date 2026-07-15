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
    // 原 1000：RW 服务端单页 1000 条需 60s+，撞上 60s 请求超时必 504/abort（2026-07-15 yz04 RW2
    // 整账号 11124 商家 0 条入库事故）。实测 limit=200 约 20s/页、limit=500 约 39s/页，
    // 降到 200 留 3 倍余量（同 LH 2000→200 的先例）。代价：单账号全量约 56 页 / ~19 分钟。
    pageKey: "page", sizeKey: "limit", maxSize: 200,
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
  EV: {
    mode: "post_json",
    url: "https://api.engagevantage.com/api/monetization",
    source: "engagevantage",
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
  /** 近30天每次点击收益（EPC），从平台 API 提取；若平台不提供则为 null */
  epc_30d: number | null;
  /** 商家在平台的入驻日期（YYYY-MM-DD），从平台 API 提取；若平台不提供则为 null */
  join_date: string | null;
  /** C-029 AD：cookie 时长（天）。其他平台不提供，字段可缺省 */
  cookie_duration?: number | null;
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
        const sep = url.includes("?") ? "&" : "?";
        resp = await fetch(`${url}${sep}${params}`, { signal: controller.signal });
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

function parseMerchants(
  platform: string,
  data: Record<string, unknown>,
  assumeAllJoined = false,
): PlatformMerchant[] {
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
    // 部分平台 feed 的 site_url 实际是带未展开宏的追踪链接（如 doubleclick 的 ${gdpr}、weborama 的 [random]），
    // 宏字面量入库后会传染到爬虫/落地页解析，这里统一剔除
    const url = String(item.site_url || item.siteUrl || item.merchant_url || item.url || item.website || item.domain || item.homepage || "")
      .replace(/\$\{[^}]*\}/g, "")
      .replace(/\[random\]/gi, "");
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

    // ── 近30天 EPC ─────────────────────────────────────────────────────────
    // 所有平台文档均未暴露 EPC 字段；若未来 API 新增则自动捕获
    const epc30d = (() => {
      const raw =
        item.epc_30  ?? item.epc30  ?? item.epc_30d ??
        item.thirty_day_epc ?? item.thirtyDayEpc   ??
        item.epc_value ?? item.clicks_epc           ??
        item.epc      ?? null;
      if (raw == null) return null;
      const n = parseFloat(String(raw));
      return isNaN(n) ? null : n;
    })();

    // ── 入驻时间（商家在平台的加入日期） ───────────────────────────────────
    // API 文档确认：8个平台均使用 "datetime" 字段
    //   - CG/MUI/BSH/CF/PM/LB/RW: Unix 秒级时间戳（如 1761036243）
    //   - LH: 日期字符串（如 "2022-07-27 09:40:03"）
    const joinDate = (() => {
      const raw = item.datetime ?? null;
      if (raw == null) return null;
      const s = String(raw).trim();
      if (!s || s === "0") return null;
      // Unix 秒级时间戳
      if (/^\d{9,10}$/.test(s)) return new Date(Number(s) * 1000).toISOString().slice(0, 10);
      // Unix 毫秒级时间戳
      if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
      // LH 日期字符串 "YYYY-MM-DD HH:MM:SS"（视为 UTC）
      const normalized = s.includes("T") ? s : s.replace(" ", "T") + "Z";
      const d = new Date(normalized);
      return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    })();

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
      epc_30d: epc30d,
      join_date: joinDate,
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
  /**
   * 日期参数命名：
   *   - "camel"：beginDate/endDate（CG/CF/PM/BSH/MUI）
   *   - "snake"：begin_date/end_date（RW/LH/LB）
   *   - "ad"   ：transactionStart/transactionEnd（C-029 AD）
   */
  dateFormat: "camel" | "snake" | "ad";
  pageKey: string;
  sizeKey: string;
  maxSize: number;
  rateLimitMs?: number;
  /** C-029：AD 不要 status:"all" 等伪过滤参数 */
  omitStatusAll?: boolean;
  /** C-029 AD：日期跨度上限（天），splitDateRange 按此切片 */
  maxDateSpanDays?: number;
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
    // LH 实测每页封顶 2000 行（per_page=40000 被忽略），且响应不返回 total_page/total_trans，
    // 必须按「满页则继续翻」的策略翻页，否则每段只取到前 2000 行、其余被静默丢弃。
    dateFormat: "snake", pageKey: "page", sizeKey: "per_page", maxSize: 2000,
    rateLimitMs: 4000,
    // LH 文档：查询跨度不能超过 31 天（错误码 1006），用 30 天保守切片。
    maxDateSpanDays: 30,
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
  EV: {
    mode: "post_json",
    url: "https://api.engagevantage.com/api/transaction_v3",
    source: "engagevantage",
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
  merchant_url?: string; // 平台返回的商家/着陆/点击 URL（用于 url_direct 商家 domain 兜底，C-020）
}

async function callTxnApi(
  config: PlatformTxnConfig,
  token: string,
  startDate: string,
  endDate: string,
  page: number,
): Promise<Record<string, unknown>> {
  const { mode, url, source, dateFormat, pageKey, sizeKey, maxSize, omitStatusAll } = config;

  // C-029：AD 用 transactionStart/transactionEnd；其他沿用 camel/snake
  const beginKey =
    dateFormat === "ad" ? "transactionStart" :
    dateFormat === "camel" ? "beginDate" : "begin_date";
  const endKey =
    dateFormat === "ad" ? "transactionEnd" :
    dateFormat === "camel" ? "endDate" : "end_date";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);

    try {
      let resp: Response;

      if (mode === "post_json") {
        const payload: Record<string, unknown> = {
          token, [beginKey]: startDate, [endKey]: endDate,
          [pageKey]: page, [sizeKey]: maxSize,
          // JSON 系联盟 API（PM/BSH/CF/CG/MUI/EV）必须带 dataScope=user，
          // 否则返回的是近乎为空的默认范围（实测 PM 单月仅 2 条 vs 用户级 2798 条），
          // 导致交易/佣金大面积缺失。与 kyads json-platform 同步实现保持一致。
          dataScope: "user",
        };
        if (!omitStatusAll) payload.status = ["All"];
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
        if (!omitStatusAll) form.set("status", "all");
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
        });
        if (!omitStatusAll) params.set("status", "all");
        // LH/LB 的 URL 已经带 ?mod=...&op=...；AD 是裸路径，需要 ? 开头
        const sep = url.includes("?") ? "&" : "?";
        resp = await fetch(`${url}${sep}${params}`, { signal: controller.signal });
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
  if (!s || s === "null" || s === "0") return new Date().toISOString();
  // Unix 时间戳（秒）
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  // Unix 时间戳（毫秒）
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  // 已有时区标识（Z / +HH:MM / -HH:MM）→ 直接解析
  if (/[Zz]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // "MM-DD-YYYY" 格式（PM/CG/BSH/CF/MUI 平台某些字段如 last_update_time）
  // 例：「04-30-2026」→「2026-04-30T00:00:00.000Z」
  // 注：C-082 起 transaction_time 不再使用 last_update_time，但本格式仍可能
  // 出现在其他字段（如未来新增的 attribution_date 字段），保留解析能力。
  const mdyMatch = s.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (mdyMatch) {
    const d = new Date(`${mdyMatch[3]}-${mdyMatch[1]}-${mdyMatch[2]}T00:00:00Z`);
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
  // C-029 QA6 封板：AD 交易 status 是数字（Settings orderStatus 实证一致）
  "1": "pending", "2": "approved", "3": "rejected",
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

  // MUI / EV 交易数据为 订单→商品行 嵌套结构，需展平为逐行记录
  // EV 结构：order 字段（oid/mid/mcid/order_time）+ items[].engagevantage_id/sale_amount/sale_comm/status
  if (platform === "MUI" || platform === "EV") {
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
      item.engagevantage_id || item.engagevantageId ||
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

    // D-072：v3 系交易接口（CG/PM/BSH/CF/MUI/EV）每行带 paid_date / paid_status，
    // 平台实际打款后该字段才有值。识别为已支付 → status 置 'paid'（覆盖 approved），
    // 点亮结算页「已支付」按商家/按月维度。rejected 不会被打款，故排除。
    const paidDateRaw = item.paid_date ?? item.paidDate;
    const paidStatusRaw = item.paid_status ?? item.paidStatus;
    const isPaid =
      (paidDateRaw != null && !["", "0", "null"].includes(String(paidDateRaw).trim())) ||
      String(paidStatusRaw ?? "") === "1";
    const baseStatus = normalizeTxnStatus(rawStatus);
    const finalStatus = isPaid && baseStatus !== "rejected" ? "paid" : baseStatus;

    // C-082: transaction_time 严格使用 order_time（订单下单时间，唯一不变）。
    // 历史 commit 1788f95f 曾把 last_update_time 写入 transaction_time，
    // 导致：① 同 last_update 日的不同订单被错误聚合；② 订单状态变更后
    // last_update_time 漂移、update 路径不刷 transaction_time → 同一订单
    // 的不同 line items 跨组双计。语义层面 transaction_time 必须 = 下单
    // 时间（订单标识的天然时间锚），absolutely 不允许写入 last_update_time。
    // 若月度归月需要按 last_update_time 切分，应单独加字段，不可复用本字段。
    //
    // C-087：MUI/EV 等 v3 端点平台同时返回 `ori_order_time`（Unix 秒，无时区歧义）
    // 和 `order_time`（"YYYY-MM-DD HH:MM:SS"，**实测是 CST 字符串**）。parseTimestamp
    // 对无时区字符串强制按 UTC 解析（line ~857），会导致 CST 字符串被错解为 UTC，
    // 产生 8h 偏移：4/30 16:00-24:00 CST 下单的订单会被错放到 5/1。
    // 必须优先用 ori_order_time（Unix 秒）保证时区正确。
    //
    // 2026-07-02 对齐平台重构·时区总结（阶段0逐平台实测，勿轻改）：
    // - RW/CG/PM/BSH/CF/LB：order_time 为 Unix 秒 → 真 UTC 入库，无漂移。
    // - MUI/EV：走 ori_order_time（Unix 秒）→ 真 UTC 入库，无漂移。
    // - LH：交易 API **只有** CST 字符串（无 Unix 字段，report_time 实测为北京时间），
    //   经本函数强制按 UTC 解析后，库内 transaction_time 实为「CST 钟面」。
    //   ⚠️ 刻意保持现状不改：全部 LH 历史数据均为此约定，改真 UTC 需回刷全量历史。
    //   展示层统一由 report-metrics.ts 的 CST_FACE_PLATFORMS 处理（LH 不再 +8）。
    //   如未来改动此处 LH 解析，必须同步回刷历史 + 更新 CST_FACE_PLATFORMS。
    const txnTime = parseTimestamp(
      // C-087：Unix 秒字段优先（无时区歧义）
      item.ori_order_time || item.oriOrderTime ||
      // C-029 AD 的字段名：transactionTime（camelCase）
      item.order_time || item.orderTime || item.transaction_time || item.transactionTime || item.report_time || item.created_at
    );

    const merchantUrl = String(
      item.merchant_url || item.merchantUrl ||
      item.shop_url || item.shopUrl ||
      item.click_url || item.clickUrl ||
      item.landing_url || item.landingUrl ||
      item.link_url || item.linkUrl ||
      item.product_url || item.productUrl ||
      item.website || item.web_url ||
      ""
    );

    return {
      transaction_id: txnId,
      order_id: rawOrderId || undefined,
      transaction_time: txnTime,
      merchant,
      merchant_id: mid,
      order_amount: orderAmount,
      commission_amount: commissionAmount,
      status: finalStatus,
      raw_status: rawStatus,
      merchant_url: merchantUrl || undefined,
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

  // CG API 限制查询跨度不超过 62 天，统一用 60 天切片；
  // C-029 AD 上限未知（错误码 50003 暗示有限制），QA4 封板用 30 天保守切片
  const maxDays = config.maxDateSpanDays ?? 60;
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

      let totalPages = getTxnTotalPages(firstPage, config.maxSize);
      // 某些平台（如 LH）响应不返回 total_page/total_trans，getTxnTotalPages 会退化为 1，
      // 导致仅取首页（LH 每页封顶 2000 行，其余被静默丢弃）。此时只要首页是满页
      // （行数 >= 每页上限），就视为"未知总页数"，放开到翻页上限，靠"不满页/空页即停"收尾。
      let unknownPagination = false;
      if (totalPages <= 1 && firstBatch.length >= config.maxSize) {
        totalPages = 50;
        unknownPagination = true;
      }

      let consecutiveEmptyTxn = 0;
      const MAX_EMPTY_TXN_RETRIES = 2;
      const MAX_CONSECUTIVE_EMPTY_TXN = 3;

      for (let page = 2; page <= Math.min(totalPages, 50); page++) {
        if (config.rateLimitMs) await sleep(config.rateLimitMs);
        else await sleep(100);

        let pageData: Record<string, unknown> = {};
        let batch: PlatformTransaction[] = [];

        for (let retry = 0; retry <= MAX_EMPTY_TXN_RETRIES; retry++) {
          if (retry > 0) {
            console.warn(`[TxnSync] ${platform} page ${page} 空响应，${(retry + 1) * 2}s 后重试 (${retry}/${MAX_EMPTY_TXN_RETRIES})`);
            await sleep((retry + 1) * 2000);
          }
          try {
            pageData = await callTxnApi(config, token, chunk.start, chunk.end, page);
          } catch (pageErr) {
            console.warn(`[TxnSync] ${platform} page ${page} 请求失败 (${retry}/${MAX_EMPTY_TXN_RETRIES}): ${pageErr instanceof Error ? pageErr.message : String(pageErr)}`);
            continue;
          }
          batch = parseTransactions(platform, pageData);
          if (batch.length > 0) break;
        }

        if (batch.length === 0) {
          consecutiveEmptyTxn++;
          if (consecutiveEmptyTxn >= MAX_CONSECUTIVE_EMPTY_TXN) {
            console.warn(`[TxnSync] ${platform} 连续 ${consecutiveEmptyTxn} 页为空，停止翻页 (page=${page})`);
            break;
          }
          continue;
        }
        consecutiveEmptyTxn = 0;

        for (const t of batch) mergeTxn(t);

        // 未知总页数模式下：不满页 = 已到最后一页，停止翻页。
        // 已知总页数的平台仍按 totalPages 收尾，避免中途偶发短页导致漏拉。
        if (unknownPagination && batch.length < config.maxSize) break;
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

// ══════════════════════════════════════════════════════════════
// 点击数据 API — 从各联盟平台拉取点击明细，聚合为「商家×自然日」计数
// 需求2：订单/点击比控制刷点击的数据源（fetchAllClicks）。
// 仅返回计数，不落明细；merchant_id 取数值型（与 parseTransactions / affiliate_transactions 同口径，便于按商家 join 订单）。
// click_time 各平台均为 UTC+8 → click_date 直接取其日期部分（与平台后台/交易切日口径一致）。
// ══════════════════════════════════════════════════════════════

interface PlatformClickConfig {
  mode: "post_json" | "post_form" | "get";
  url: string;
  source?: string;
  /** beginDate/endDate(camel) vs begin_date/end_date(snake) */
  dateFormat: "camel" | "snake";
  /** true=传 "YYYY-MM-DD HH:mm:ss"；false=传 "YYYY-MM-DD"(LH 按天) */
  withTime: boolean;
  pageKey: string;
  sizeKey: string;
  maxSize: number;
  /** 两次请求最小间隔（限频）。定版：LH/LB/RW 15/60s≈4200ms；MUI/PM 及同构 SaaS 10/min≈6500ms */
  rateLimitMs: number;
  /** 单次查询时间窗上限（小时）：多数 ≤1h，LH ≤1d */
  maxWindowHours: number;
  /** 列表所在位置：SaaS=data.list(code 0)；LH=根级 list(status 0)；LB/RW=payliad.list(原文档拼写,status 200) */
  listPath: "data" | "payload" | "payliad" | "root";
}

const CLICK_RATE_SAAS = 6500; // 10/min
const CLICK_RATE_LEGACY = 4200; // 15/60s

const PLATFORM_CLICK_CONFIG: Record<string, PlatformClickConfig> = {
  // ── SaaS 同构：POST JSON /api/click_report，source+dataScope=user，窗口≤1h，10/min ──
  MUI: { mode: "post_json", url: "https://api.ultrainfluence.com/api/click_report", source: "ultrainfluence", dateFormat: "camel", withTime: true, pageKey: "curPage", sizeKey: "perPage", maxSize: 2000, rateLimitMs: CLICK_RATE_SAAS, maxWindowHours: 1, listPath: "data" },
  PM:  { mode: "post_json", url: "https://api.partnermatic.com/api/click_report", source: "partnermatic", dateFormat: "camel", withTime: true, pageKey: "curPage", sizeKey: "perPage", maxSize: 2000, rateLimitMs: CLICK_RATE_SAAS, maxWindowHours: 1, listPath: "data" },
  // CG/CF/BSH/EV：无独立文档，按 SaaS 同构推断 /api/click_report（⚠️ 需真 token 联调验证 url/source/字段）
  CG:  { mode: "post_json", url: "https://api.collabglow.com/api/click_report", source: "collabglow", dateFormat: "camel", withTime: true, pageKey: "curPage", sizeKey: "perPage", maxSize: 2000, rateLimitMs: CLICK_RATE_SAAS, maxWindowHours: 1, listPath: "data" },
  CF:  { mode: "post_json", url: "https://api.creatorflare.com/api/click_report", source: "creatorflare", dateFormat: "camel", withTime: true, pageKey: "curPage", sizeKey: "perPage", maxSize: 2000, rateLimitMs: CLICK_RATE_SAAS, maxWindowHours: 1, listPath: "data" },
  BSH: { mode: "post_json", url: "https://api.brandsparkhub.com/api/click_report", source: "brandsparkhub", dateFormat: "camel", withTime: true, pageKey: "curPage", sizeKey: "perPage", maxSize: 2000, rateLimitMs: CLICK_RATE_SAAS, maxWindowHours: 1, listPath: "data" },
  EV:  { mode: "post_json", url: "https://api.engagevantage.com/api/click_report", source: "engagevantage", dateFormat: "camel", withTime: true, pageKey: "curPage", sizeKey: "perPage", maxSize: 2000, rateLimitMs: CLICK_RATE_SAAS, maxWindowHours: 1, listPath: "data" },
  // ── 独立文档平台 ──
  // LB：只接受纯日期(withTime=false)，窗口≤24h；否则返回 status 1007 Wrong time format
  LB:  { mode: "get", url: "https://www.linkbux.com/api.php?mod=medium&op=user_click", dateFormat: "snake", withTime: false, pageKey: "page", sizeKey: "per_page", maxSize: 2000, rateLimitMs: CLICK_RATE_LEGACY, maxWindowHours: 24, listPath: "payliad" },
  // LH：实际返回 {status:0, list:[...]}（list 在根级、成功标志 status=0），故 listPath=root
  LH:  { mode: "get", url: "https://www.linkhaitao.com/api.php?mod=medium&op=user_click2", dateFormat: "snake", withTime: false, pageKey: "page", sizeKey: "per_page", maxSize: 2000, rateLimitMs: CLICK_RATE_LEGACY, maxWindowHours: 24, listPath: "root" },
  // RW：click_details / user_click 是真实 handler（返回 status:200 格式），但实测对我方所有 medium token
  //     在任意窗口（今日/昨天/7天/纯日期/带时分/Unix 时间戳/带不带 status）恒返回 total:0 —— RW 不通过 API 暴露点击数据。
  //     故不纳入 click-sync（否则每轮空打接口浪费限流、还会撞上 RW 网关偶发 504 制造错误噪声）。
  //     auto-click 对 RW 仍正常工作：effectiveC 用我方 kyads_click_task_items 成功/在途数兜底（见 auto-click.ts），
  //     不依赖平台点击 API，不会过刷；代价仅是看不到自然点击（偏保守，方向安全）。
};

export interface PlatformClickCount {
  merchant_id: string; // 数值型平台商家ID（与 affiliate_transactions.merchant_id 同口径）
  merchant_name: string;
  click_date: string; // YYYY-MM-DD（UTC+8）
  clicks: number;
}

/** 点击 item → 数值型 merchant_id（与 parseTransactions 同口径） */
function pickClickMerchantId(item: Record<string, unknown>, platform: string): string {
  const candidates =
    platform === "LH"
      ? [item.mcid, item.mid, item.m_id, item.brand_id, item.brandId, item.merchant_id]
      : [item.mid, item.m_id, item.merchant_id, item.merchantId, item.brand_id, item.brandId, item.advertiser_id];
  for (const c of candidates) {
    if (c != null) {
      const s = String(c).trim();
      if (s && /^\d+$/.test(s)) return s;
    }
  }
  return "";
}

function clickMerchantName(item: Record<string, unknown>): string {
  return String(item.merchant_name || item.merchantName || item.brand || item.name || "");
}

/** click_time → YYYY-MM-DD（UTC+8 自然日）；取不到返回空。
 *  兼容两类：日期串("YYYY-MM-DD HH:mm:ss"，如 LH)；Unix 时间戳(LB 为秒级，如 1782931668，也兼容毫秒级)。 */
function clickDateOf(item: Record<string, unknown>): string {
  const t = String(item.click_time ?? item.clickTime ?? item.click_date ?? "").trim()
  if (!t) return ""
  const m = t.match(/^(\d{4}-\d{2}-\d{2})/)
  if (m) return m[1]
  if (/^\d{10}$/.test(t) || /^\d{13}$/.test(t)) {
    const ms = t.length === 13 ? Number(t) : Number(t) * 1000
    if (Number.isFinite(ms)) return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10)
  }
  return ""
}

function clickRefOf(item: Record<string, unknown>): string {
  return String(item.click_ref || item.clickRef || "").trim();
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function clickContainer(listPath: PlatformClickConfig["listPath"], data: Record<string, unknown>): Record<string, unknown> | undefined {
  if (listPath === "data") return asObj(data.data);
  if (listPath === "payload") return asObj(data.payload);
  if (listPath === "root") return data; // LH：list 直接在根级
  return asObj(data.payliad) ?? asObj(data.payload);
}

function getClickList(listPath: PlatformClickConfig["listPath"], data: Record<string, unknown>): Record<string, unknown>[] {
  const list = clickContainer(listPath, data)?.list;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

function getClickTotalPages(listPath: PlatformClickConfig["listPath"], data: Record<string, unknown>, maxSize: number): number {
  const container = clickContainer(listPath, data);
  const totalNode = listPath === "data" || listPath === "root" ? container : asObj(container?.total);
  if (!totalNode) return 1;
  const tp = Number(totalNode.total_page ?? totalNode.totalPage);
  if (Number.isFinite(tp) && tp > 0) return tp;
  const ti = Number(totalNode.total_items ?? totalNode.totalItems);
  if (Number.isFinite(ti) && ti > 0 && maxSize > 0) return Math.ceil(ti / maxSize);
  return 1;
}

/** 错误判定：SaaS code!="0"；LB/RW status="200" 成功、LH status="0" 成功（两者都接受，其余判为错误如 LB 1007） */
function clickErrorMessage(listPath: PlatformClickConfig["listPath"], data: Record<string, unknown>): string | null {
  if (listPath === "data") {
    const code = data.code;
    if (code !== undefined && String(code) !== "0") return String(data.message ?? `code ${code}`);
    return null;
  }
  const status = data.status;
  if (status !== undefined && String(status) !== "200" && String(status) !== "0") return String(data.msg ?? `status ${status}`);
  return null;
}

/** 把 [begin,end] 按窗口上限切片（字符串按 UTC 解析仅用于跨度计算，输出原样 "YYYY-MM-DD HH:mm:ss"） */
function splitDateTimeRange(begin: string, end: string, maxHours: number): { start: string; end: string }[] {
  const toMs = (s: string) => new Date(`${s.replace(" ", "T")}Z`).getTime();
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  const beginMs = toMs(begin);
  const endMs = toMs(end);
  if (!Number.isFinite(beginMs) || !Number.isFinite(endMs) || beginMs >= endMs) return [{ start: begin, end }];
  const stepMs = Math.max(1, maxHours) * 3600_000;
  const chunks: { start: string; end: string }[] = [];
  let cur = beginMs;
  while (cur < endMs) {
    const chunkEnd = Math.min(cur + stepMs, endMs);
    chunks.push({ start: fmt(cur), end: fmt(chunkEnd) });
    cur = chunkEnd;
  }
  return chunks;
}

async function callClickApi(
  config: PlatformClickConfig,
  token: string,
  beginStr: string,
  endStr: string,
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
          token,
          [beginKey]: beginStr,
          [endKey]: endStr,
          [pageKey]: page,
          [sizeKey]: maxSize,
          dataScope: "user",
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
        form.set(beginKey, beginStr);
        form.set(endKey, endStr);
        form.set(pageKey, String(page));
        form.set(sizeKey, String(maxSize));
        resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: controller.signal,
        });
      } else {
        const params = new URLSearchParams({ token, [beginKey]: beginStr, [endKey]: endStr, [pageKey]: String(page), [sizeKey]: String(maxSize) });
        const sep = url.includes("?") ? "&" : "?";
        resp = await fetch(`${url}${sep}${params}`, { signal: controller.signal });
      }

      if (!resp.ok) {
        if (RETRYABLE_STATUS.has(resp.status) && attempt < MAX_RETRIES) {
          clearTimeout(timer);
          await sleep((attempt + 1) * 5000);
          continue;
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      return await resp.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt < MAX_RETRIES && err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
        await sleep((attempt + 1) * 5000);
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
 * 拉取某平台某时间段的点击，聚合为「数值型商家ID × 自然日(UTC+8)」计数。
 * @param beginDateTime "YYYY-MM-DD HH:mm:ss"（UTC+8 口径）
 * @param endDateTime   "YYYY-MM-DD HH:mm:ss"
 */
export async function fetchAllClicks(
  platform: string,
  token: string,
  beginDateTime: string,
  endDateTime: string,
): Promise<{ clicks: PlatformClickCount[]; error?: string }> {
  const config = PLATFORM_CLICK_CONFIG[platform];
  if (!config) return { clicks: [], error: `不支持的平台点击 API: ${platform}` };

  const agg = new Map<string, PlatformClickCount>();
  const seenRefs = new Set<string>(); // 按 click_ref 去重（相邻窗口边界秒可能重复返回）
  const addClick = (item: Record<string, unknown>) => {
    const ref = clickRefOf(item);
    if (ref) {
      if (seenRefs.has(ref)) return;
      seenRefs.add(ref);
    }
    const mid = pickClickMerchantId(item, platform);
    const date = clickDateOf(item);
    if (!mid || !date) return;
    const key = `${mid}|${date}`;
    const cur = agg.get(key);
    if (cur) {
      cur.clicks++;
      if (!cur.merchant_name) cur.merchant_name = clickMerchantName(item);
    } else {
      agg.set(key, { merchant_id: mid, merchant_name: clickMerchantName(item), click_date: date, clicks: 1 });
    }
  };
  const toArray = () => Array.from(agg.values());

  try {
    // 时间窗平台：按 maxWindowHours 小时切片；纯日期平台(LB/LH)：按自然日切片，
    // 保证每次请求 begin_date==end_date。否则跨午夜的 6h 窗会得到 begin=昨日/end=今日，
    // LB 按「begin_date 00:00 ~ end_date 23:59」理解成近 48h → 报 "Interval cannot be longer than 24 hour"。
    const windows = config.withTime
      ? splitDateTimeRange(beginDateTime, endDateTime, config.maxWindowHours)
      : splitDateRange(beginDateTime.slice(0, 10), endDateTime.slice(0, 10), 1).map((d) => ({
          start: `${d.start} 00:00:00`,
          end: `${d.end} 23:59:59`,
        }));
    let first = true;
    for (const w of windows) {
      const beginStr = config.withTime ? w.start : w.start.slice(0, 10);
      const endStr = config.withTime ? w.end : w.end.slice(0, 10);

      if (!first) await sleep(config.rateLimitMs);
      first = false;
      const firstPage = await callClickApi(config, token, beginStr, endStr, 1);

      const errMsg = clickErrorMessage(config.listPath, firstPage);
      if (errMsg) {
        if (/no data|no record|无数据|empty/i.test(errMsg)) continue;
        return { clicks: toArray(), error: `${platform}: ${errMsg}` };
      }

      const firstList = getClickList(config.listPath, firstPage);
      for (const it of firstList) addClick(it);

      let totalPages = getClickTotalPages(config.listPath, firstPage, config.maxSize);
      let unknownPagination = false;
      if (totalPages <= 1 && firstList.length >= config.maxSize) {
        totalPages = 50;
        unknownPagination = true;
      }

      for (let page = 2; page <= Math.min(totalPages, 50); page++) {
        await sleep(config.rateLimitMs);
        let pageData: Record<string, unknown>;
        try {
          pageData = await callClickApi(config, token, beginStr, endStr, page);
        } catch (e) {
          console.warn(`[ClickAPI] ${platform} page ${page} 请求失败: ${e instanceof Error ? e.message : String(e)}`);
          break;
        }
        const list = getClickList(config.listPath, pageData);
        if (list.length === 0) break;
        for (const it of list) addClick(it);
        if (unknownPagination && list.length < config.maxSize) break;
      }
    }
    return { clicks: toArray() };
  } catch (err) {
    return { clicks: toArray(), error: `${platform}: ${err instanceof Error ? err.message : String(err)}` };
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

export { PLATFORM_API_CONFIG, PLATFORM_TXN_CONFIG, PLATFORM_CLICK_CONFIG };
