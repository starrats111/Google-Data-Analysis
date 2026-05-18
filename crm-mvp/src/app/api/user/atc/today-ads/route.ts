/**
 * D-018 v2「今日广告」Tab API（v1.18 二次重写：07 二次纠正后的最终业务模型）
 *
 * GET /api/user/atc/today-ads
 *
 * 业务定义（07 v1.18 拍板）：
 *   "今日广告应该是符合阈值，且在昨天依旧有投放的广告"
 *
 * 真实数据源 = notifications 表（不是 snapshot.domains_json）
 *   理由：atc-watchlist-scanner (C-089 v2) 每日 cron 已严格按 07 规则过滤后写 notifications：
 *     - days ≥ watchlist.min_days
 *     - last_shown 是 CST 昨天（昨天还在投放）
 *     - 同 user × 同 creative × 同日期不重复推
 *
 * 数据流：
 *   1. SELECT notifications WHERE user_id=X AND type='ad' AND source='atc_watchlist'
 *        AND is_deleted=0 AND created_at >= today_cst_00:00
 *      → 解析 metadata: { advertiser_id, region, domain, creative_id, days, source }
 *   2. 对每条 notif 取 metadata.domain → extractRootDomain → merchantByRoot.get(root)
 *   3. 未命中商家 → 跳过（07 D-018 v1 既有规则保留）
 *   4. 同 (root, merchant_id) 合并为 1 row：days 取最大值 + creative_count = N（兼顾去重 + 信息密度）
 *   5. 排序：days desc
 *
 * 删除 D-018 v1 的：
 *   - watchlist + snapshot.domains_json 笛卡尔积逻辑（snapshot 缓存数据有 4 天延迟，不符"昨天还在投放"）
 *   - ?today=1 query 参数 + 「仅看今日推送」Switch（默认就是今日，本来就是 today-ads）
 *   - qualifying / has_long_running_creative 字段（scanner 已隐含过滤）
 *   - in_today_notification 标志（list 本身就全是今日）
 *
 * 返回：
 *   {
 *     stats: { total, available, claimed_or_paused, advertiser_count },
 *     items: [{
 *       row_key,           // `${advertiser_id}|${region}|${domain}` 唯一
 *       advertiser_id, advertiser_name, region,
 *       domain,            // 单 root domain
 *       days,              // 该 (adv, domain) 下最大 days（最长的那条 creative）
 *       creative_count,    // 该 (adv, domain) 下今日 notif 条数
 *       atc_url,
 *       matched_merchant,  // 必非 null
 *     }]
 *   }
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

type NotifMeta = {
  source?: string;
  advertiser_id?: unknown;
  region?: unknown;
  domain?: unknown;
  creative_id?: unknown;
  days?: unknown;
  atc_url?: unknown;
};

export const GET = withUser(async (_req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);

  // ─── 1. 拉今日 (CST 0:00 起) ATC notifications ───
  const since = todayCstStartUtc();
  const notifs = await prisma.notifications.findMany({
    where: {
      user_id: userId,
      type: "ad",
      is_deleted: 0,
      created_at: { gte: since },
    },
    select: {
      id: true,
      title: true,
      metadata: true,
      created_at: true,
    },
    orderBy: { created_at: "desc" },
  });

  // ─── 2. 解析 metadata + 取 root domain（过滤无 source/domain 的）───
  type ParsedNotif = {
    notif_id: bigint;
    advertiser_id: string;
    region: string;
    root: string;
    days: number;
    atc_url: string;
  };
  const parsed: ParsedNotif[] = [];
  for (const n of notifs) {
    if (!n.metadata) continue;
    let meta: NotifMeta;
    try {
      meta = JSON.parse(n.metadata) as NotifMeta;
    } catch {
      continue;
    }
    // 兼容老 notif（无 source 字段 = 早期 scanner 写的，仍按 atc_watchlist 处理）
    if (meta.source && meta.source !== "atc_watchlist") continue;
    const advId = meta.advertiser_id ? String(meta.advertiser_id) : "";
    if (!advId) continue;
    const region = meta.region ? String(meta.region) : "US";
    const rawDomain = meta.domain ? String(meta.domain) : "";
    if (!rawDomain) continue;
    const root = extractRootDomain(rawDomain);
    if (!root) continue;
    const days = typeof meta.days === "number"
      ? meta.days
      : (typeof meta.days === "string" ? Number.parseInt(meta.days, 10) || 0 : 0);
    const atcUrl = meta.atc_url ? String(meta.atc_url)
      : `https://adstransparency.google.com/advertiser/${advId}${region ? `?region=${region}` : ""}`;
    parsed.push({
      notif_id: n.id,
      advertiser_id: advId,
      region,
      root,
      days,
      atc_url: atcUrl,
    });
  }

  if (parsed.length === 0) {
    return apiSuccess(serializeData({
      stats: { total: 0, available: 0, claimed_or_paused: 0, advertiser_count: 0 },
      items: [],
    }));
  }

  // ─── 3. 拉相关 advertiser_name（从 user_atc_watchlist + notification.title fallback）───
  const advRegionPairs = Array.from(
    new Set(parsed.map((p) => `${p.advertiser_id}|${p.region}`))
  ).map((s) => {
    const [advId, region] = s.split("|");
    return { advertiser_id: advId, region };
  });
  const watchRows = await prisma.user_atc_watchlist.findMany({
    where: {
      user_id: userId,
      is_deleted: 0,
      OR: advRegionPairs,
    },
    select: { advertiser_id: true, region: true, advertiser_name: true },
  });
  const advNameMap = new Map<string, string>();
  for (const w of watchRows) {
    if (w.advertiser_name) advNameMap.set(`${w.advertiser_id}|${w.region}`, w.advertiser_name);
  }

  // ─── 4. 拉 user_merchants 建 merchantByRoot Map ───
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

  // ─── 5. notification → merchant 匹配 + 同 (root, advertiser) 合并 ───
  // key = `${advertiser_id}|${region}|${root}`
  type AggRow = {
    row_key: string;
    advertiser_id: string;
    advertiser_name: string | null;
    region: string;
    domain: string;
    days: number;          // max
    creative_count: number; // count
    atc_url: string;
    merchant: MerchantRow;
  };
  const aggMap = new Map<string, AggRow>();
  const matchedMerchantSet = new Set<string>();
  const matchedMerchantRows: MerchantRow[] = [];

  for (const p of parsed) {
    const merchant = merchantByRoot.get(p.root);
    if (!merchant) continue;
    if (!matchedMerchantSet.has(merchant.id.toString())) {
      matchedMerchantSet.add(merchant.id.toString());
      matchedMerchantRows.push(merchant);
    }
    const key = `${p.advertiser_id}|${p.region}|${p.root}`;
    const existing = aggMap.get(key);
    if (!existing) {
      aggMap.set(key, {
        row_key: key,
        advertiser_id: p.advertiser_id,
        advertiser_name: advNameMap.get(`${p.advertiser_id}|${p.region}`) ?? null,
        region: p.region,
        domain: p.root,
        days: p.days,
        creative_count: 1,
        atc_url: p.atc_url,
        merchant,
      });
    } else {
      if (p.days > existing.days) existing.days = p.days;
      existing.creative_count += 1;
    }
  }

  // 一次性加载 conn account map
  const connAccountMap = await loadConnectionAccountMap(matchedMerchantRows, userId);

  // ─── 6. 组装 items + 排序 ───
  type Item = {
    row_key: string;
    advertiser_id: string;
    advertiser_name: string | null;
    region: string;
    domain: string;
    days: number;
    creative_count: number;
    atc_url: string;
    matched_merchant: ReturnType<typeof formatMerchant>;
  };
  const items: Item[] = Array.from(aggMap.values()).map((a) => ({
    row_key: a.row_key,
    advertiser_id: a.advertiser_id,
    advertiser_name: a.advertiser_name,
    region: a.region,
    domain: a.domain,
    days: a.days,
    creative_count: a.creative_count,
    atc_url: a.atc_url,
    matched_merchant: formatMerchant(a.merchant, connAccountMap),
  }));

  items.sort((a, b) => {
    if (b.days !== a.days) return b.days - a.days;
    return (a.advertiser_name ?? "").localeCompare(b.advertiser_name ?? "");
  });

  // ─── 7. 统计 ───
  let availableCount = 0;
  let claimedOrPausedCount = 0;
  const advSet = new Set<string>();
  for (const it of items) {
    const s = it.matched_merchant.status;
    if (s === "available") availableCount++;
    else if (s === "claimed" || s === "paused") claimedOrPausedCount++;
    advSet.add(`${it.advertiser_id}|${it.region}`);
  }

  return apiSuccess(serializeData({
    stats: {
      total: items.length,
      available: availableCount,
      claimed_or_paused: claimedOrPausedCount,
      advertiser_count: advSet.size,
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
