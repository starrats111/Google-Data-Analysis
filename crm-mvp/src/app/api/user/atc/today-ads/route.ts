/**
 * D-004 「今日广告」Tab 数据接口（D-008 F-13/F-14 兜底升级）
 *
 * GET /api/user/atc/today-ads
 *
 * 数据流（设计方案.md §四·D-004 §5 + §四·D-008 §4）：
 *   notifications (type='ad', 今日 CST) → 解析 metadata
 *   → 关联 user_atc_watchlist 补 advertiser_name
 *   → D-008 F-13：metadata.domain 优先；空时从 atc_advertiser_domain_snapshot.domains_json 取
 *                 全部 qualifying domain 兜底（has_long_running_creative=true 优先排序）
 *   → D-008 F-14：matched_merchant 用 domains 列表全部尝试根域名匹配 user_merchants，
 *                 第一个命中即返回；status=available > claimed/paused 优先
 *   → user_merchants.connection_campaign_links → 过滤只保留 current_user 的 conn_id（F-15）
 *   → JOIN platform_connections 拿 account_name
 *
 * 返回：
 *   {
 *     stats: { total, matched, available, claimed_or_paused },
 *     items: [
 *       {
 *         notification_id, advertiser_id, advertiser_name, region, days,
 *         creative_id,
 *         domain: string | null,              // 第一个 domain（保持向后兼容）
 *         domains: string[],                  // D-008 F-13/F-15：全部 domain（最多 5 个）
 *         domain_source: 'meta'|'snapshot'|null, // D-008 F-13/D：UI 区分来源
 *         atc_url,
 *         matched_merchant: null | { ... 同 D-004 结构 }
 *       }
 *     ]
 *   }
 *
 * 排序：按 days 降序（F-9）
 */

import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { loadConnectionAccountMap, buildConnectionAccounts, type ConnectionAccount } from "@/lib/merchant-connection";

/**
 * 今日 CST 00:00 对应的 UTC Date（用于 created_at 比较）
 * 服务器 process 是 UTC，CST = UTC+8，今天 00:00 CST = 昨天 16:00 UTC
 */
function todayCstStartUtc(): Date {
  const now = new Date();
  // 转 CST 后取 00:00
  const cst = new Date(now.getTime() + 8 * 3600 * 1000);
  cst.setUTCHours(0, 0, 0, 0);
  // 再转回 UTC（减 8h）
  return new Date(cst.getTime() - 8 * 3600 * 1000);
}

/**
 * 从 URL/hostname 提取根域名（用于 F-4 严格匹配）
 *
 *  - https://www.acegolfs.com/ → acegolfs.com
 *  - https://shop.acegolfs.com/path → acegolfs.com
 *  - acegolfs.com → acegolfs.com
 *  - acegolfs.co.uk → acegolfs.co.uk（保留二级 ccTLD）
 *  - https://www.example.com:8080/ → example.com
 *
 * MVP 策略：strip `www.` 前缀；对常见二级 ccTLD 保留 3 段
 */
const SECOND_LEVEL_TLD = new Set([
  "co.uk", "co.jp", "co.kr", "co.in", "co.nz", "co.za", "co.id", "co.th", "co.il",
  "com.au", "com.br", "com.mx", "com.sg", "com.hk", "com.tw", "com.tr", "com.cn",
  "com.ar", "com.co", "com.pe", "com.ph", "com.my", "com.vn",
  "ne.jp", "or.jp", "ac.uk", "gov.uk", "org.uk",
]);

function extractRootDomain(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") return null;
  let host = input.trim().toLowerCase();
  if (!host) return null;
  // 支持纯 hostname / 完整 URL 两种输入
  try {
    if (host.includes("://")) {
      host = new URL(host).hostname;
    } else if (host.includes("/")) {
      host = host.split("/")[0];
    }
  } catch {
    return null;
  }
  if (host.startsWith("www.")) host = host.slice(4);
  // 去掉端口
  if (host.includes(":")) host = host.split(":")[0];
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return host || null;
  const lastTwo = parts.slice(-2).join(".");
  if (parts.length >= 3 && SECOND_LEVEL_TLD.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

/**
 * 解析 notifications.metadata（可能是 JSON 字符串或 null）
 */
function parseMetadata(raw: string | null | undefined): {
  source?: string;
  advertiser_id?: string;
  creative_id?: string;
  region?: string;
  days?: number;
  domain?: string | null;
  atc_url?: string;
} | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === "object") return m as Record<string, unknown> as never;
    return null;
  } catch {
    return null;
  }
}

export const GET = withUser(async (_req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const since = todayCstStartUtc();

  // ─── 1. 拉今日 type=ad 通知（source=atc_watchlist） ───
  const notifications = await prisma.notifications.findMany({
    where: {
      user_id: userId,
      type: "ad",
      is_deleted: 0,
      created_at: { gte: since },
    },
    orderBy: { id: "desc" },
  });

  // 解析 metadata + 仅保留 atc_watchlist 来源
  type ParsedNotif = {
    notification_id: string;
    advertiser_id: string;
    creative_id: string;
    region: string;
    days: number;
    /** metadata 里的 domain（可能 null）；D-008 F-13 后域名展示走下面 enrichedDomains */
    metaDomain: string | null;
    atc_url: string;
    /** metadata.domain 的根域名 */
    metaRootDomain: string | null;
    created_at: string;
    title: string;
  };
  const parsed: ParsedNotif[] = [];
  for (const n of notifications) {
    const meta = parseMetadata(n.metadata ?? null);
    if (!meta) continue;
    if (meta.source && meta.source !== "atc_watchlist") continue;
    const advId = String(meta.advertiser_id ?? "");
    const creativeId = String(meta.creative_id ?? "");
    if (!advId || !creativeId) continue;
    const metaDomain = meta.domain ? String(meta.domain) : null;
    parsed.push({
      notification_id: n.id.toString(),
      advertiser_id: advId,
      creative_id: creativeId,
      region: String(meta.region ?? "US"),
      days: typeof meta.days === "number" ? meta.days : 0,
      metaDomain,
      atc_url: String(meta.atc_url ?? ""),
      metaRootDomain: extractRootDomain(metaDomain),
      created_at: n.created_at.toISOString(),
      title: n.title,
    });
  }

  if (parsed.length === 0) {
    return apiSuccess(serializeData({
      stats: { total: 0, matched: 0, available: 0, claimed_or_paused: 0 },
      items: [],
    }));
  }

  // ─── 2. 关联 watchlist 补 advertiser_name ───
  const advIds = Array.from(new Set(parsed.map((p) => p.advertiser_id)));
  const watchlists = await prisma.user_atc_watchlist.findMany({
    where: { user_id: userId, advertiser_id: { in: advIds }, is_deleted: 0 },
    select: { advertiser_id: true, advertiser_name: true, region: true },
  });
  const advNameMap = new Map<string, string>();
  for (const w of watchlists) {
    advNameMap.set(`${w.advertiser_id}|${w.region}`, w.advertiser_name ?? "");
    if (!advNameMap.has(w.advertiser_id)) advNameMap.set(w.advertiser_id, w.advertiser_name ?? "");
  }

  // ─── 2.5 D-008 F-13：拉 atc_advertiser_domain_snapshot 兜底 domain ───
  // 收集 (advertiser_id, region) 二元组，一次性查所有快照
  const advRegionPairs = Array.from(
    new Set(parsed.map((p) => `${p.advertiser_id}|${p.region}`))
  ).map((s) => {
    const [advertiser_id, region] = s.split("|");
    return { advertiser_id, region };
  });
  const advSnapshots = advRegionPairs.length > 0
    ? await prisma.atc_advertiser_domain_snapshot.findMany({
        where: {
          OR: advRegionPairs.map((p) => ({
            advertiser_id: p.advertiser_id,
            region: p.region,
          })),
        },
        select: {
          advertiser_id: true,
          region: true,
          domains_json: true,
          qualifying_domain_count: true,
        },
      })
    : [];

  // advertiser_id|region → 兜底 domain 列表（按 has_long_running_creative=true 优先 + creative_count desc 排序）
  type DomainStat = { domain: string; creative_count?: number; has_long_running_creative?: boolean };
  const advSnapshotDomains = new Map<string, string[]>();
  for (const s of advSnapshots) {
    const list = Array.isArray(s.domains_json) ? (s.domains_json as DomainStat[]) : [];
    const sorted = list
      .filter((d) => d && typeof d.domain === "string" && d.domain.length > 0)
      .sort((a, b) => {
        const aQ = a.has_long_running_creative ? 1 : 0;
        const bQ = b.has_long_running_creative ? 1 : 0;
        if (aQ !== bQ) return bQ - aQ; // qualifying 优先
        return (b.creative_count ?? 0) - (a.creative_count ?? 0); // 再按创意数 desc
      })
      .map((d) => d.domain.toLowerCase())
      .slice(0, 5); // 最多 5 个 domain（前端 chip "+2" 形式展开）
    if (sorted.length > 0) {
      advSnapshotDomains.set(`${s.advertiser_id}|${s.region}`, sorted);
    }
  }

  // ─── 3. 拉当前用户所有 user_merchants（用于根域名严格匹配 + connection_campaign_links） ───
  // 一次性加载，建 rootDomain → merchant 的 Map（user_id=8 实测 17,376 行，内存 OK）
  const allMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: {
      id: true,
      merchant_id: true,
      merchant_name: true,
      merchant_url: true,
      platform: true,
      status: true,
      policy_status: true,
      policy_category_code: true,
      supported_regions: true,
      campaign_link: true,
      tracking_link: true,
      connection_campaign_links: true,
      logo_url: true,
    },
  });
  type MerchantRow = (typeof allMerchants)[number];

  // F-4：rootDomain → merchant；多个候选时按 status=available > claimed/paused > 其他 优先
  const STATUS_PRIORITY: Record<string, number> = {
    available: 0,
    claimed: 1,
    paused: 1,
    expired: 2,
    pending: 3,
  };
  const merchantByRoot = new Map<string, MerchantRow>();
  for (const m of allMerchants) {
    const root = extractRootDomain(m.merchant_url);
    if (!root) continue;
    const existing = merchantByRoot.get(root);
    if (!existing) {
      merchantByRoot.set(root, m);
      continue;
    }
    const exPriority = STATUS_PRIORITY[existing.status] ?? 99;
    const myPriority = STATUS_PRIORITY[m.status] ?? 99;
    if (myPriority < exPriority) merchantByRoot.set(root, m);
  }

  // ─── 4&5. 解析涉及到的 platform_connections（F-15 跨用户安全已经由 helper 保证） ───
  // D-008 F-14：matched_merchant 用 multi-domain 列表全部尝试根域名匹配 user_merchants
  //
  // 每条 parsed 的候选 domain 池 = metaDomain 优先 + advSnapshot 兜底（去重，最多 5 个）
  // 匹配优先级：候选 domain 顺序（metaDomain 优先于 snapshot）→ user_merchants STATUS_PRIORITY
  function buildCandidateDomains(p: ParsedNotif): { domains: string[]; source: "meta" | "snapshot" | null } {
    const list: string[] = [];
    let source: "meta" | "snapshot" | null = null;
    if (p.metaDomain) {
      const root = extractRootDomain(p.metaDomain);
      if (root) {
        list.push(root.toLowerCase());
        source = "meta";
      }
    }
    const fb = advSnapshotDomains.get(`${p.advertiser_id}|${p.region}`) ?? [];
    for (const d of fb) {
      const root = extractRootDomain(d);
      if (root && !list.includes(root.toLowerCase())) {
        list.push(root.toLowerCase());
        if (source === null) source = "snapshot";
      }
    }
    return { domains: list, source };
  }

  // 先算每条 parsed 的候选 domains（用于后续 matched_merchant + UI 展示）
  const parsedWithDomains = parsed.map((p) => {
    const { domains, source } = buildCandidateDomains(p);
    return { p, domains, source };
  });

  // 收集所有 matched 到的 merchants 用于一次性 loadConnectionAccountMap
  const matchedMerchants: typeof allMerchants = [];
  const matchedSet = new Set<string>();
  for (const item of parsedWithDomains) {
    for (const root of item.domains) {
      const m = merchantByRoot.get(root);
      if (m && !matchedSet.has(m.id.toString())) {
        matchedMerchants.push(m);
        matchedSet.add(m.id.toString());
        break; // 第一个命中即可
      }
    }
  }
  const connAccountMap = await loadConnectionAccountMap(matchedMerchants, userId);

  // ─── 6. 组装 items ───
  const items = parsedWithDomains.map(({ p, domains, source }) => {
    const advName = advNameMap.get(`${p.advertiser_id}|${p.region}`) || advNameMap.get(p.advertiser_id) || null;
    let matched: ReturnType<typeof formatMerchant> | null = null;
    for (const root of domains) {
      const m = merchantByRoot.get(root);
      if (m) {
        matched = formatMerchant(m, connAccountMap);
        break; // 第一个命中即可（domains 已按 metaDomain 优先 → snapshot qualifying 排序）
      }
    }
    return {
      notification_id: p.notification_id,
      advertiser_id: p.advertiser_id,
      advertiser_name: advName,
      creative_id: p.creative_id,
      region: p.region,
      days: p.days,
      // 向后兼容：domain 字段保留，取第一个候选
      domain: domains[0] ?? p.metaDomain ?? null,
      // D-008 F-13/F-15：全部候选 domain（前端 chip 多 domain 展示）
      domains,
      // D-008 F-13/D：UI 区分来源（meta=metadata.domain；snapshot=兜底；null=都没有）
      domain_source: source,
      atc_url: p.atc_url,
      title: p.title,
      created_at: p.created_at,
      matched_merchant: matched,
    };
  });

  // F-9：按 days 降序
  items.sort((a, b) => b.days - a.days);

  // ─── 7. 统计 stats ───
  let matchedCount = 0;
  let availableCount = 0;
  let claimedOrPausedCount = 0;
  for (const it of items) {
    if (it.matched_merchant) {
      matchedCount++;
      const s = it.matched_merchant.status;
      if (s === "available") availableCount++;
      else if (s === "claimed" || s === "paused") claimedOrPausedCount++;
    }
  }

  return apiSuccess(serializeData({
    stats: {
      total: items.length,
      matched: matchedCount,
      available: availableCount,
      claimed_or_paused: claimedOrPausedCount,
    },
    items,
  }));
});

/**
 * 把 user_merchant 行格式化为前端可消费的 merchant 对象，
 * 并把 connection_campaign_links 解析为 connection_accounts[]（用共享 helper）。
 */
function formatMerchant(
  m: {
    id: bigint;
    merchant_id: string;
    merchant_name: string;
    merchant_url: string | null;
    platform: string;
    status: string;
    policy_status: string | null;
    policy_category_code: string | null;
    supported_regions: unknown;
    campaign_link: string | null;
    tracking_link: string | null;
    connection_campaign_links: unknown;
    logo_url: string | null;
  },
  connAccountMap: Map<string, { account_name: string; platform: string }>,
): {
  id: string;
  merchant_id: string;
  merchant_name: string;
  merchant_url: string | null;
  platform: string;
  status: string;
  policy_status: string | null;
  policy_category_code: string | null;
  supported_regions: unknown;
  campaign_link: string | null;
  tracking_link: string | null;
  logo_url: string | null;
  connection_accounts: ConnectionAccount[];
} {
  return {
    id: m.id.toString(),
    merchant_id: m.merchant_id,
    merchant_name: m.merchant_name,
    merchant_url: m.merchant_url,
    platform: m.platform,
    status: m.status,
    policy_status: m.policy_status,
    policy_category_code: m.policy_category_code,
    supported_regions: m.supported_regions,
    campaign_link: m.campaign_link,
    tracking_link: m.tracking_link,
    logo_url: m.logo_url,
    connection_accounts: buildConnectionAccounts(m.connection_campaign_links, connAccountMap),
  };
}
