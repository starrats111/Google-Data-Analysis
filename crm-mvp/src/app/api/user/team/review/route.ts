import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { parseCSTDateStart, parseCSTDateEndExclusive } from "@/lib/date-utils";
import { computePauseWindow, PAUSE_SOURCE_LABELS } from "@/lib/review-analysis";

export const dynamic = "force-dynamic";

/** 单次最多返回的系列数（按暂停时间倒序截断，防止无筛选时全量扫表） */
const MAX_ROWS = 500;

/**
 * D-245 组长「复盘分析」列表
 *
 * GET /api/user/team/review?member_id=&paused_start=&paused_end=
 *
 * 范围：本组组员名下、曾被暂停（paused_at 非空）且当前 PAUSED / REMOVED 的系列；
 *       重新启用的系列 paused_at 已被清空，自然不在列表。
 * 指标：每系列聚合「暂停日前 7 个完整投放日」（不含暂停当天）的 ads_daily_stats，实时口径。
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");
  const { searchParams } = new URL(req.url);

  // ─── 组员清单（同时用于前端筛选下拉） ───
  const members = await prisma.users.findMany({
    where: { team_id: BigInt(user.teamId), is_deleted: 0 },
    select: { id: true, username: true, display_name: true },
    orderBy: { id: "asc" },
  });
  const memberById = new Map(members.map((m) => [m.id.toString(), m]));

  const memberIdParam = searchParams.get("member_id");
  let targetUserIds = members.map((m) => m.id);
  if (memberIdParam) {
    let memberId: bigint;
    try {
      memberId = BigInt(memberIdParam);
    } catch {
      return apiError("member_id 格式无效");
    }
    if (!memberById.has(memberId.toString())) return apiError("该用户不属于您的小组", 403);
    targetUserIds = [memberId];
  }

  // ─── 暂停日期筛选（CST 日历日 → paused_at DATETIME 范围） ───
  const pausedAtFilter: { not: null; gte?: Date; lt?: Date } = { not: null };
  const pausedStart = searchParams.get("paused_start");
  const pausedEnd = searchParams.get("paused_end");
  if (pausedStart && /^\d{4}-\d{2}-\d{2}$/.test(pausedStart)) {
    pausedAtFilter.gte = parseCSTDateStart(pausedStart);
  }
  if (pausedEnd && /^\d{4}-\d{2}-\d{2}$/.test(pausedEnd)) {
    pausedAtFilter.lt = parseCSTDateEndExclusive(pausedEnd);
  }

  const campaigns = await prisma.campaigns.findMany({
    where: {
      user_id: { in: targetUserIds },
      is_deleted: 0,
      google_status: { in: ["PAUSED", "REMOVED"] },
      paused_at: pausedAtFilter,
    },
    select: {
      id: true, user_id: true, customer_id: true, campaign_name: true,
      google_status: true, paused_at: true, pause_source: true, daily_budget: true,
    },
    orderBy: { paused_at: "desc" },
    take: MAX_ROWS,
  });

  if (campaigns.length === 0) {
    return apiSuccess(serializeData({
      rows: [], members, truncated: false,
      summary: {
        totalImpressions: 0, totalClicks: 0, totalOrders: 0, avgCpc: 0,
        totalCost: 0, totalCommission: 0, totalRejectedCommission: 0, roi: 0, campaignCount: 0,
      },
    }));
  }

  // ─── 每系列的 7 天窗口；一次取全局区间内的日表行，再按各自窗口过滤 ───
  const windows = new Map(campaigns.map((c) => [c.id.toString(), computePauseWindow(c.paused_at!)]));
  let globalStart: Date | null = null;
  let globalEnd: Date | null = null;
  for (const w of windows.values()) {
    if (!globalStart || w.dateStart < globalStart) globalStart = w.dateStart;
    if (!globalEnd || w.dateEndExclusive > globalEnd) globalEnd = w.dateEndExclusive;
  }

  const campaignIds = campaigns.map((c) => c.id);
  const stats = await prisma.ads_daily_stats.findMany({
    where: {
      campaign_id: { in: campaignIds },
      is_deleted: 0,
      date: { gte: globalStart!, lt: globalEnd! },
    },
    select: {
      campaign_id: true, date: true, impressions: true, clicks: true,
      cost: true, orders: true, commission: true, rejected_commission: true,
      is_budget: true, is_rank: true,
    },
    orderBy: { date: "asc" },
  });
  const statsByCampaign = new Map<string, typeof stats>();
  for (const s of stats) {
    const key = s.campaign_id.toString();
    const arr = statsByCampaign.get(key);
    if (arr) arr.push(s);
    else statsByCampaign.set(key, [s]);
  }

  // ─── 投放天数：暂停日（CST）前累计有消费的天数（全历史，raw SQL 按各自暂停日界定） ───
  // paused_at 为 UTC 存储，+8h 取 CST 日历日；与 computePauseWindow 的口径一致
  const idList = campaignIds.map((id) => id.toString()).join(",");
  const activeDayRows: Array<{ campaign_id: bigint; active_days: bigint | number }> =
    await prisma.$queryRawUnsafe(`
      SELECT s.campaign_id AS campaign_id, COUNT(*) AS active_days
      FROM ads_daily_stats s
      JOIN campaigns c ON c.id = s.campaign_id
      WHERE s.is_deleted = 0 AND s.cost > 0
        AND s.campaign_id IN (${idList})
        AND s.date < DATE(CONVERT_TZ(c.paused_at, '+00:00', '+08:00'))
      GROUP BY s.campaign_id
    `);
  const activeDaysById = new Map(activeDayRows.map((r) => [r.campaign_id.toString(), Number(r.active_days)]));

  // ─── 聚合成行 ───
  let totImpressions = 0, totClicks = 0, totOrders = 0, totCost = 0, totCommission = 0, totRejected = 0;
  const rows = campaigns.map((c) => {
    const key = c.id.toString();
    const w = windows.get(key)!;
    const inWindow = (statsByCampaign.get(key) || []).filter(
      (s) => s.date >= w.dateStart && s.date < w.dateEndExclusive,
    );
    const cost = inWindow.reduce((s, d) => s + Number(d.cost || 0), 0);
    const clicks = inWindow.reduce((s, d) => s + Number(d.clicks || 0), 0);
    const impressions = inWindow.reduce((s, d) => s + Number(d.impressions || 0), 0);
    const orders = inWindow.reduce((s, d) => s + Number(d.orders || 0), 0);
    const commission = inWindow.reduce((s, d) => s + Number(d.commission || 0), 0);
    const rejected = inWindow.reduce((s, d) => s + Number(d.rejected_commission || 0), 0);
    // IS 份额取窗口内最新一日的非空值（与数据中心 D-238 口径一致）
    let isBudget: number | null = null;
    let isRank: number | null = null;
    for (let i = inWindow.length - 1; i >= 0; i -= 1) {
      if (isBudget == null && inWindow[i].is_budget != null) isBudget = Number(inWindow[i].is_budget);
      if (isRank == null && inWindow[i].is_rank != null) isRank = Number(inWindow[i].is_rank);
      if (isBudget != null && isRank != null) break;
    }

    totImpressions += impressions; totClicks += clicks; totOrders += orders;
    totCost += cost; totCommission += commission; totRejected += rejected;

    const owner = memberById.get(c.user_id.toString());
    return {
      id: key,
      campaign_name: c.campaign_name,
      customer_id: c.customer_id,
      google_status: c.google_status,
      paused_at: c.paused_at!.toISOString(),
      pause_date: w.pauseDateStr,
      pause_source: c.pause_source,
      pause_source_label: PAUSE_SOURCE_LABELS[c.pause_source || ""] || c.pause_source || "未知",
      window_start: w.startStr,
      window_end: w.endStr,
      user_id: c.user_id.toString(),
      username: owner?.username || c.user_id.toString(),
      display_name: owner?.display_name || null,
      daily_budget: Number(c.daily_budget || 0),
      active_days: activeDaysById.get(key) || 0,
      // 指标列（7 天合计；CPC/ROI 按总量重算，与共享列定义的量纲一致）
      cost: Number(cost.toFixed(2)),
      clicks,
      impressions,
      cpc: clicks > 0 ? Number((cost / clicks).toFixed(4)) : 0,
      orders,
      commission: Number(commission.toFixed(2)),
      rejected_commission: Number(rejected.toFixed(2)),
      roi: cost > 0 ? Number(((commission - cost) / cost).toFixed(4)) : 0,
      is_budget: isBudget,
      is_rank: isRank,
    };
  });

  return apiSuccess(serializeData({
    rows,
    members,
    truncated: campaigns.length >= MAX_ROWS,
    summary: {
      totalImpressions: totImpressions,
      totalClicks: totClicks,
      totalOrders: totOrders,
      avgCpc: totClicks > 0 ? Number((totCost / totClicks).toFixed(4)) : 0,
      totalCost: Number(totCost.toFixed(2)),
      totalCommission: Number(totCommission.toFixed(2)),
      totalRejectedCommission: Number(totRejected.toFixed(2)),
      roi: totCost > 0 ? Number(((totCommission - totCost) / totCost).toFixed(4)) : 0,
      campaignCount: rows.length,
    },
  }));
});
