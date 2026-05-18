/**
 * D-018 「今日广告」Tab 数据接口（v1.16 重写：彻底修正 D-008/D-004 业务模型）
 *
 * GET /api/user/atc/today-ads?today=0|1
 *
 * 业务模型（07 D-018 拍板）：
 *   "列表的主体是【域名】，不是 notification。从关注广告主的合格商家域名
 *    挑出每个 domain，根据 root domain 匹配 user_merchants，没匹配的不显示"
 *
 * 数据流：
 *   1. 拉 user_atc_watchlist（07 关注的所有广告主，is_deleted=0）
 *   2. 拉对应 atc_advertiser_domain_snapshot.domains_json（按 advertiser_id+region）
 *   3. 拉 user_merchants 建 merchantByRoot Map（含 STATUS_PRIORITY 去重）
 *   4. FOR EACH watchlist (advertiser_id, region):
 *        FOR EACH snapshot.domains_json[i]:
 *          merchant = merchantByRoot.get(extractRootDomain(domain))
 *          IF merchant:
 *            items.push({ ... domain 单值, days = max_creative_days, merchant ... })
 *          ELSE 跳过
 *   5. 排序：has_long_running_creative=true 优先 → max_creative_days desc
 *   6. today=1 时：advertiser+region 必须在今日 type='ad' notifications 出现过
 *
 * 返回：
 *   {
 *     stats: { total, matched, available, claimed_or_paused, today_only_count },
 *     items: [{
 *       row_key,                // `${advertiser_id}|${region}|${domain}` 唯一
 *       advertiser_id, advertiser_name, region,
 *       domain,                 // 单个 domain（不再 +N）
 *       days,                   // snapshot.max_creative_days
 *       qualifying,             // snapshot.has_long_running_creative
 *       creative_count,         // snapshot.creative_count
 *       in_today_notification,  // 该 advertiser 今天是否有 ATC 推送（UI 可加 [今] 标）
 *       atc_url,                // ATC 广告主链接（按 advertiser+region 拼）
 *       matched_merchant: { ... 同 D-004 结构，必然非 null }
 *     }]
 *   }
 *
 * 排序：has_long_running_creative=true 优先 + max_creative_days desc
 */

import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { loadConnectionAccountMap, buildConnectionAccounts, type ConnectionAccount } from "@/lib/merchant-connection";

/** 今日 CST 00:00 对应的 UTC Date（CST=UTC+8，今天 00:00 CST = 昨天 16:00 UTC） */
function todayCstStartUtc(): Date {
  const now = new Date();
  const cst = new Date(now.getTime() + 8 * 3600 * 1000);
  cst.setUTCHours(0, 0, 0, 0);
  return new Date(cst.getTime() - 8 * 3600 * 1000);
}

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
  try {
    if (host.includes("://")) host = new URL(host).hostname;
    else if (host.includes("/")) host = host.split("/")[0];
  } catch {
    return null;
  }
  if (host.startsWith("www.")) host = host.slice(4);
  if (host.includes(":")) host = host.split(":")[0];
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return host || null;
  const lastTwo = parts.slice(-2).join(".");
  if (parts.length >= 3 && SECOND_LEVEL_TLD.has(lastTwo)) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

/** snapshot.domains_json 单项类型（与 ETL 写入约定一致） */
type SnapshotDomain = {
  domain: string;
  creative_count?: number;
  has_long_running_creative?: boolean;
  max_creative_days?: number;
};

export const GET = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const url = new URL(req.url);
  const todayOnly = url.searchParams.get("today") === "1";

  // ─── 1. 拉 watchlist（07 关注的所有广告主） ───
  const watchlists = await prisma.user_atc_watchlist.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { advertiser_id: true, advertiser_name: true, region: true },
  });
  if (watchlists.length === 0) {
    return apiSuccess(serializeData({
      stats: { total: 0, matched: 0, available: 0, claimed_or_paused: 0, today_only_count: 0 },
      items: [],
    }));
  }

  // ─── 2. 拉对应 snapshot ───
  const snapshots = await prisma.atc_advertiser_domain_snapshot.findMany({
    where: {
      OR: watchlists.map((w) => ({ advertiser_id: w.advertiser_id, region: w.region })),
    },
    select: {
      advertiser_id: true,
      region: true,
      domains_json: true,
    },
  });
  const snapshotByKey = new Map<string, SnapshotDomain[]>();
  for (const s of snapshots) {
    const list = Array.isArray(s.domains_json) ? (s.domains_json as SnapshotDomain[]) : [];
    if (list.length > 0) snapshotByKey.set(`${s.advertiser_id}|${s.region}`, list);
  }

  // ─── 3. 拉 user_merchants 建 merchantByRoot Map ───
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

  // ─── 4. 拉今日 notification 涉及的 advertiser+region 集合（同时支持 todayOnly filter + in_today_notification 标志）───
  const since = todayCstStartUtc();
  const todayNotifs = await prisma.notifications.findMany({
    where: {
      user_id: userId,
      type: "ad",
      is_deleted: 0,
      created_at: { gte: since },
    },
    select: { metadata: true },
  });
  const todayAdvSet = new Set<string>();
  for (const n of todayNotifs) {
    if (!n.metadata) continue;
    try {
      const meta = JSON.parse(n.metadata) as { source?: string; advertiser_id?: unknown; region?: unknown };
      if (meta.source && meta.source !== "atc_watchlist") continue;
      const advId = meta.advertiser_id ? String(meta.advertiser_id) : "";
      const region = meta.region ? String(meta.region) : "US";
      if (advId) todayAdvSet.add(`${advId}|${region}`);
    } catch { /* skip */ }
  }

  // ─── 5. 笛卡尔积过滤：watchlist × snapshot.domains → merchant 命中即保留 ───
  type Item = {
    row_key: string;
    advertiser_id: string;
    advertiser_name: string | null;
    region: string;
    domain: string;
    days: number;
    qualifying: boolean;
    creative_count: number;
    in_today_notification: boolean;
    atc_url: string;
    matched_merchant: ReturnType<typeof formatMerchant>;
  };
  const matchedMerchantRows: MerchantRow[] = [];
  const matchedMerchantIdSet = new Set<string>();
  const pendingItems: Array<{
    row_key: string;
    advertiser_id: string;
    advertiser_name: string | null;
    region: string;
    domain: string;
    days: number;
    qualifying: boolean;
    creative_count: number;
    in_today_notification: boolean;
    atc_url: string;
    merchant: MerchantRow;
  }> = [];

  for (const w of watchlists) {
    const advKey = `${w.advertiser_id}|${w.region}`;
    if (todayOnly && !todayAdvSet.has(advKey)) continue;
    const inToday = todayAdvSet.has(advKey);

    const snapshotDomains = snapshotByKey.get(advKey) ?? [];
    for (const sd of snapshotDomains) {
      if (!sd || typeof sd.domain !== "string" || sd.domain.length === 0) continue;
      const root = extractRootDomain(sd.domain);
      if (!root) continue;
      const merchant = merchantByRoot.get(root);
      if (!merchant) continue;
      if (!matchedMerchantIdSet.has(merchant.id.toString())) {
        matchedMerchantRows.push(merchant);
        matchedMerchantIdSet.add(merchant.id.toString());
      }
      pendingItems.push({
        row_key: `${w.advertiser_id}|${w.region}|${root}`,
        advertiser_id: w.advertiser_id,
        advertiser_name: w.advertiser_name,
        region: w.region,
        domain: root,
        days: typeof sd.max_creative_days === "number" ? sd.max_creative_days : 0,
        qualifying: sd.has_long_running_creative === true,
        creative_count: typeof sd.creative_count === "number" ? sd.creative_count : 0,
        in_today_notification: inToday,
        atc_url: `https://adstransparency.google.com/advertiser/${w.advertiser_id}${w.region ? `?region=${w.region}` : ""}`,
        merchant,
      });
    }
  }

  // 一次性加载 conn account map
  const connAccountMap = await loadConnectionAccountMap(matchedMerchantRows, userId);

  // 组装最终 items
  const items: Item[] = pendingItems.map((p) => ({
    row_key: p.row_key,
    advertiser_id: p.advertiser_id,
    advertiser_name: p.advertiser_name,
    region: p.region,
    domain: p.domain,
    days: p.days,
    qualifying: p.qualifying,
    creative_count: p.creative_count,
    in_today_notification: p.in_today_notification,
    atc_url: p.atc_url,
    matched_merchant: formatMerchant(p.merchant, connAccountMap),
  }));

  // ─── 6. 排序：qualifying 优先 + days desc + advertiser_name asc ───
  items.sort((a, b) => {
    if (a.qualifying !== b.qualifying) return a.qualifying ? -1 : 1;
    if (b.days !== a.days) return b.days - a.days;
    return (a.advertiser_name ?? "").localeCompare(b.advertiser_name ?? "");
  });

  // ─── 7. 统计 ───
  let availableCount = 0;
  let claimedOrPausedCount = 0;
  let todayCount = 0;
  for (const it of items) {
    const s = it.matched_merchant.status;
    if (s === "available") availableCount++;
    else if (s === "claimed" || s === "paused") claimedOrPausedCount++;
    if (it.in_today_notification) todayCount++;
  }

  return apiSuccess(serializeData({
    stats: {
      total: items.length,
      matched: items.length, // 新模型下 items 全是 matched
      available: availableCount,
      claimed_or_paused: claimedOrPausedCount,
      today_only_count: todayCount,
    },
    items,
  }));
});

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
