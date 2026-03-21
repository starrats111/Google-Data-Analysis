import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { cachedQuery, cacheDelete } from "@/lib/cache";
import { todayCST, yesterdayCST } from "@/lib/date-utils";

/**
 * GET /api/user/data-center/campaigns
 * 广告系列列表查询（数据中心主表格数据）
 *
 * 2核2G 优化：
 * - campaigns 硬限制 200 条
 * - 用数据库 groupBy 聚合代替 JS 遍历
 * - MCC 归属验证加 30 秒缓存
 *
 * 筛选参数：
 * - mcc_account_id: MCC 账户 ID（可选，不传则查所有 MCC）
 * - date_start / date_end: 日期范围
 * - status: 广告状态 ENABLED / PAUSED / REMOVED
 * - platform: 平台代码
 * - mid: 商家 MID
 * - search: 搜索广告系列名
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const mccAccountId = searchParams.get("mcc_account_id");
  const dateStart = searchParams.get("date_start");
  const dateEnd = searchParams.get("date_end");
  const statusFilter = searchParams.get("status");
  const platformFilter = searchParams.get("platform");
  const midFilter = searchParams.get("mid");
  const searchFilter = searchParams.get("search");

  const userId = BigInt(user.userId);

  // 获取用户所有 MCC 或指定 MCC
  let mccIds: bigint[];
  if (mccAccountId) {
    const mcc = await cachedQuery(
      `mcc:${user.userId}:${mccAccountId}`,
      () => prisma.google_mcc_accounts.findFirst({
        where: { id: BigInt(mccAccountId), user_id: userId, is_deleted: 0 },
      }),
      30000
    );
    if (!mcc) return apiError("MCC 账户不存在", 404);
    mccIds = [BigInt(mccAccountId)];
  } else {
    // 默认查所有 MCC
    const allMcc = await cachedQuery(
      `mcc_all:${user.userId}`,
      () => prisma.google_mcc_accounts.findMany({
        where: { user_id: userId, is_deleted: 0 },
        select: { id: true },
      }),
      30000
    );
    mccIds = (allMcc || []).map((m: { id: bigint }) => m.id);
    if (mccIds.length === 0) return apiSuccess(serializeData({ rows: [], summary: emptySummary() }));
  }

  // 日期范围（默认昨天，东八区）
  const defaultYesterday = new Date(yesterdayCST());
  const start = dateStart ? new Date(dateStart) : defaultYesterday;
  const end = dateEnd ? new Date(dateEnd) : defaultYesterday;

  // 查询 campaigns — 硬限制 200 条，只排除幽灵记录（无 google_campaign_id 的占位数据）
  const campaignWhere: Record<string, unknown> = {
    user_id: userId,
    google_campaign_id: { not: null },
    is_deleted: 0,
  };
  // 按 MCC 过滤（选择了特定 MCC 时只看该 MCC 的广告系列）
  if (mccIds.length === 1) {
    campaignWhere.mcc_id = mccIds[0];
  } else if (mccIds.length > 1) {
    campaignWhere.mcc_id = { in: mccIds };
  }
  if (statusFilter && statusFilter !== "all") {
    campaignWhere.google_status = statusFilter;
  } else {
    campaignWhere.google_status = { not: "REMOVED" };
  }
  if (searchFilter) {
    campaignWhere.campaign_name = { contains: searchFilter };
  }
  // 平台和 MID 通过 campaign_name 模式匹配（广告系列名格式: 序号-平台-商家名-国家-日期-MID）
  if (platformFilter) {
    campaignWhere.campaign_name = {
      ...(campaignWhere.campaign_name as Record<string, unknown> || {}),
      contains: `-${platformFilter}-`,
    };
  }
  if (midFilter) {
    campaignWhere.campaign_name = {
      ...(campaignWhere.campaign_name as Record<string, unknown> || {}),
      contains: midFilter,
    };
  }

  const rawCampaigns = await prisma.campaigns.findMany({
    where: campaignWhere as never,
    orderBy: { id: "asc" },
    take: 200,
    select: {
      id: true,
      google_campaign_id: true,
      customer_id: true,
      campaign_name: true,
      google_status: true,
      daily_budget: true,
      max_cpc_limit: true,
      target_country: true,
      last_google_sync_at: true,
    },
  });

  // 按 google_campaign_id 去重（保留最新的一条）
  const seenGoogleIds = new Set<string>();
  const campaigns = rawCampaigns.filter((c) => {
    const gid = c.google_campaign_id || String(c.id);
    if (seenGoogleIds.has(gid)) return false;
    seenGoogleIds.add(gid);
    return true;
  });

  const campaignIds = campaigns.map((c) => c.id);

  // 用数据库 groupBy 聚合 — 代替 JS 遍历，节省内存
  const statsAgg = campaignIds.length > 0
    ? await prisma.ads_daily_stats.groupBy({
        by: ["campaign_id"],
        where: {
          campaign_id: { in: campaignIds },
          date: { gte: start, lte: end },
          is_deleted: 0,
        } as never,
        _sum: {
          cost: true,
          clicks: true,
          impressions: true,
          commission: true,
          rejected_commission: true,
          orders: true,
        },
      })
    : [];

  // 构建聚合 Map
  const statsMap = new Map(
    statsAgg.map((s) => [
      String(s.campaign_id),
      {
        cost: Number(s._sum?.cost || 0),
        clicks: Number(s._sum?.clicks || 0),
        impressions: Number(s._sum?.impressions || 0),
        commission: Number(s._sum?.commission || 0),
        rejected_commission: Number(s._sum?.rejected_commission || 0),
        orders: Number(s._sum?.orders || 0),
      },
    ])
  );

  // 从 affiliate_transactions 直接查询佣金（三分类：全部/拒付/已付）
  const endPlusOne = new Date(end);
  endPlusOne.setDate(endPlusOne.getDate() + 1);

  const commissionAgg = await prisma.$queryRawUnsafe<
    { user_merchant_id: bigint; total_commission: number; rejected_commission: number; approved_commission: number; order_count: number }[]
  >(`
    SELECT
      user_merchant_id,
      SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
      SUM(CASE WHEN status IN ('approved', 'paid') THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as approved_commission,
      COUNT(*) as order_count
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0
      AND transaction_time >= ? AND transaction_time < ?
    GROUP BY user_merchant_id
  `, userId, start, endPlusOne);

  const commissionByMerchant = new Map<string, number>();
  const rejectedByMerchant = new Map<string, number>();
  const approvedByMerchant = new Map<string, number>();
  const ordersByMerchant = new Map<string, number>();
  let totalCommissionFromTxn = 0;
  let totalRejectedFromTxn = 0;
  let totalApprovedFromTxn = 0;
  let totalOrdersFromTxn = 0;

  for (const r of commissionAgg) {
    const key = String(r.user_merchant_id);
    commissionByMerchant.set(key, Number(r.total_commission || 0));
    rejectedByMerchant.set(key, Number(r.rejected_commission || 0));
    approvedByMerchant.set(key, Number(r.approved_commission || 0));
    ordersByMerchant.set(key, Number(r.order_count || 0));
    totalCommissionFromTxn += Number(r.total_commission || 0);
    totalRejectedFromTxn += Number(r.rejected_commission || 0);
    totalApprovedFromTxn += Number(r.approved_commission || 0);
    totalOrdersFromTxn += Number(r.order_count || 0);
  }

  // 查询 campaign → user_merchant_id 映射
  const campaignMerchantMap = new Map<string, string>();
  if (commissionAgg.length > 0) {
    const campaignsWithMerchant = await prisma.campaigns.findMany({
      where: { id: { in: campaignIds }, is_deleted: 0 },
      select: { id: true, user_merchant_id: true },
    });
    for (const c of campaignsWithMerchant) {
      campaignMerchantMap.set(String(c.id), String(c.user_merchant_id));
    }
  }

  // 每个商家只分配给一个 campaign，避免翻倍
  const merchantWritten = new Set<string>();

  // 按状态优先级排序：ENABLED → PAUSED → REMOVED，同状态按最近更新优先
  const STATUS_ORDER: Record<string, number> = { ENABLED: 0, PAUSED: 1, REMOVED: 2 };
  campaigns.sort((a, b) => {
    const pa = STATUS_ORDER[a.google_status || ""] ?? 2;
    const pb = STATUS_ORDER[b.google_status || ""] ?? 2;
    if (pa !== pb) return pa - pb;
    return 0;
  });

  // 组装行数据
  let totalCost = 0, totalCommission = 0, totalClicks = 0, totalImpressions = 0;
  let enabledCount = 0, pausedCount = 0;

  const rows = campaigns.map((c) => {
    const s = statsMap.get(String(c.id));
    const cost = s?.cost || 0;
    const clicks = s?.clicks || 0;
    const impressions = s?.impressions || 0;
    const avgCpc = clicks > 0 ? Number((cost / clicks).toFixed(4)) : 0;

    const merchantId = campaignMerchantMap.get(String(c.id));
    let commission = 0;
    let rejectedComm = 0;
    let approvedComm = 0;
    let orders = 0;
    if (merchantId && merchantId !== "0" && commissionByMerchant.has(merchantId) && !merchantWritten.has(merchantId)) {
      commission = commissionByMerchant.get(merchantId)!;
      rejectedComm = rejectedByMerchant.get(merchantId) || 0;
      approvedComm = approvedByMerchant.get(merchantId) || 0;
      orders = ordersByMerchant.get(merchantId) || 0;
      merchantWritten.add(merchantId);
    }

    const roi = cost > 0 ? Number(((approvedComm - cost) / cost * 100).toFixed(2)) : 0;

    totalCost += cost;
    totalCommission += commission;
    totalClicks += clicks;
    totalImpressions += impressions;
    if (c.google_status === "ENABLED") enabledCount++;
    if (c.google_status === "PAUSED") pausedCount++;

    return {
      id: c.id,
      google_campaign_id: c.google_campaign_id,
      customer_id: c.customer_id,
      campaign_name: c.campaign_name,
      status: c.google_status,
      daily_budget: Number(c.daily_budget),
      max_cpc: c.max_cpc_limit ? Number(c.max_cpc_limit) : null,
      cost: Number(cost.toFixed(2)),
      clicks,
      impressions,
      cpc: avgCpc,
      commission: Number(commission.toFixed(2)),
      rejected_commission: Number(rejectedComm.toFixed(2)),
      approved_commission: Number(approvedComm.toFixed(2)),
      orders,
      roi,
      target_country: c.target_country,
      last_synced: c.last_google_sync_at,
    };
  });

  const summary = {
    totalCost: Number(totalCost.toFixed(2)),
    totalCommission: Number(totalCommissionFromTxn.toFixed(2)),
    totalRejectedCommission: Number(totalRejectedFromTxn.toFixed(2)),
    totalApprovedCommission: Number(totalApprovedFromTxn.toFixed(2)),
    totalClicks,
    totalImpressions,
    avgCpc: totalClicks > 0 ? Number((totalCost / totalClicks).toFixed(4)) : 0,
    roi: totalCost > 0 ? Number(((totalApprovedFromTxn - totalCost) / totalCost * 100).toFixed(2)) : 0,
    campaignCount: campaigns.length,
    enabledCount,
    pausedCount,
  };

  return apiSuccess(serializeData({ rows, summary }));
}

function emptySummary() {
  return {
    totalCost: 0, totalCommission: 0, totalRejectedCommission: 0, totalApprovedCommission: 0,
    totalClicks: 0, totalImpressions: 0,
    avgCpc: 0, roi: 0, campaignCount: 0, enabledCount: 0, pausedCount: 0,
  };
}
