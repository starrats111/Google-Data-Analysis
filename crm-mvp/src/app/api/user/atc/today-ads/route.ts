/**
 * D-004 「今日广告」Tab 数据接口
 *
 * GET /api/user/atc/today-ads
 *
 * 数据流（设计方案.md §四·D-004 §5）：
 *   notifications (type='ad', 今日 CST) → 解析 metadata
 *   → 关联 user_atc_watchlist 补 advertiser_name
 *   → metadata.domain → 用根域名严格匹配 user_merchants（F-4）
 *   → user_merchants.connection_campaign_links → 过滤只保留 current_user 的 conn_id（F-15）
 *   → JOIN platform_connections 拿 account_name
 *
 * 返回：
 *   {
 *     stats: { total, matched, available, claimed_or_paused },
 *     items: [
 *       {
 *         notification_id, advertiser_id, advertiser_name, region, days,
 *         creative_id, domain, atc_url,
 *         matched_merchant: null | {
 *           id, merchant_name, merchant_id, platform, merchant_url, status,
 *           policy_status, policy_category_code, supported_regions,
 *           campaign_link, tracking_link,
 *           connection_accounts: [{ id, account_name, platform, link }]
 *         }
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
    domain: string | null;
    atc_url: string;
    rootDomain: string | null;
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
    const domain = meta.domain ? String(meta.domain) : null;
    parsed.push({
      notification_id: n.id.toString(),
      advertiser_id: advId,
      creative_id: creativeId,
      region: String(meta.region ?? "US"),
      days: typeof meta.days === "number" ? meta.days : 0,
      domain,
      atc_url: String(meta.atc_url ?? ""),
      rootDomain: extractRootDomain(domain),
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
  // 只对真正 matched 到的 merchants 拉 connection map（避免无关 merchant 的 conn 也被加载）
  const matchedMerchants: typeof allMerchants = [];
  const matchedSet = new Set<string>();
  for (const p of parsed) {
    if (!p.rootDomain) continue;
    const m = merchantByRoot.get(p.rootDomain);
    if (m && !matchedSet.has(m.id.toString())) {
      matchedMerchants.push(m);
      matchedSet.add(m.id.toString());
    }
  }
  const connAccountMap = await loadConnectionAccountMap(matchedMerchants, userId);

  // ─── 6. 组装 items ───
  const items = parsed.map((p) => {
    const advName = advNameMap.get(`${p.advertiser_id}|${p.region}`) || advNameMap.get(p.advertiser_id) || null;
    let matched: ReturnType<typeof formatMerchant> | null = null;
    if (p.rootDomain) {
      const m = merchantByRoot.get(p.rootDomain);
      if (m) matched = formatMerchant(m, connAccountMap);
    }
    return {
      notification_id: p.notification_id,
      advertiser_id: p.advertiser_id,
      advertiser_name: advName,
      creative_id: p.creative_id,
      region: p.region,
      days: p.days,
      domain: p.domain,
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
