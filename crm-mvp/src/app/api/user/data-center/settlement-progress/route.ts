import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { getMonthlyProgressForUser, recomputeMonthlySettlementForUser } from "@/lib/monthly-settlement-tracker";

/**
 * GET /api/user/data-center/settlement-progress
 *
 * 返回当前用户每月结算进度。
 *
 * 行为：
 *   - 首次访问且 monthly_settlement_status 为空 → 实时计算一次后返回
 *   - 否则直接读快照表（每天 daily-sync 后会自动刷新）
 *
 * 组长：可传 ?member_id=<userId> 查看团队某成员
 *   - 没传 member_id → 返回全组聚合（按月把所有成员合并）
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const memberId = searchParams.get("member_id") || "";

  const userId = BigInt(user.userId);
  const isLeader = user.role === "leader" && user.teamId;

  // ─── 普通用户：返回自己的月份进度 ───
  if (!isLeader || memberId) {
    const targetUserId = memberId ? BigInt(memberId) : userId;

    // 越权防护：组长查询的成员必须在自己的 team
    if (memberId && isLeader) {
      const member = await prisma.users.findFirst({
        where: { id: targetUserId, team_id: BigInt(user.teamId!), is_deleted: 0 },
        select: { id: true },
      });
      if (!member) return apiError("无权访问该成员数据", 403);
    }

    let months = await getMonthlyProgressForUser(targetUserId);

    // 首次访问：从 affiliate_transactions 实时初始化
    if (months.length === 0) {
      await recomputeMonthlySettlementForUser(targetUserId);
      months = await getMonthlyProgressForUser(targetUserId);
    }

    return apiSuccess(serializeData({
      months,
      summary: buildSummary(months),
      isLeader: !!isLeader,
    }));
  }

  // ─── 组长视角：聚合全组所有成员的月份数据 ───
  const members = await prisma.users.findMany({
    where: { team_id: BigInt(user.teamId!), is_deleted: 0, role: { not: "admin" } },
    select: { id: true, username: true, display_name: true },
  });

  if (members.length === 0) {
    return apiSuccess(serializeData({
      months: [],
      summary: buildSummary([]),
      teamMembers: [],
      isLeader: true,
    }));
  }

  // 把所有成员的月份数据按 month 维度聚合
  type Aggr = ReturnType<typeof emptyAggr>;
  const monthMap = new Map<string, Aggr>();

  for (const m of members) {
    const myMonths = await getMonthlyProgressForUser(m.id);
    for (const row of myMonths) {
      const cur = monthMap.get(row.month) ?? emptyAggr(row.month);
      cur.total_count += row.total_count;
      cur.total_amount += row.total_amount;
      cur.pending_count += row.pending_count;
      cur.pending_amount += row.pending_amount;
      cur.approved_count += row.approved_count;
      cur.approved_amount += row.approved_amount;
      cur.paid_count += row.paid_count;
      cur.paid_amount += row.paid_amount;
      cur.rejected_count += row.rejected_count;
      cur.rejected_amount += row.rejected_amount;
      cur.last_synced_at_max =
        cur.last_synced_at_max && row.last_synced_at && cur.last_synced_at_max > row.last_synced_at
          ? cur.last_synced_at_max
          : row.last_synced_at ?? cur.last_synced_at_max;
      // 团队聚合的"已结算"= 所有成员该月都没有 pending
      cur.is_settled = cur.is_settled && row.is_settled;
      monthMap.set(row.month, cur);
    }
  }

  const months = Array.from(monthMap.values())
    .map((a) => {
      const settledAmt = a.approved_amount + a.paid_amount + a.rejected_amount;
      const progress = a.total_amount > 0 ? +((settledAmt / a.total_amount) * 100).toFixed(2) : 0;
      return {
        month: a.month,
        total_count: a.total_count,
        total_amount: +a.total_amount.toFixed(2),
        pending_count: a.pending_count,
        pending_amount: +a.pending_amount.toFixed(2),
        approved_count: a.approved_count,
        approved_amount: +a.approved_amount.toFixed(2),
        paid_count: a.paid_count,
        paid_amount: +a.paid_amount.toFixed(2),
        rejected_count: a.rejected_count,
        rejected_amount: +a.rejected_amount.toFixed(2),
        is_settled: a.is_settled,
        settled_at: null,
        last_synced_at: a.last_synced_at_max,
        settled_amount: +settledAmt.toFixed(2),
        settle_progress: progress,
      };
    })
    .sort((a, b) => (a.month < b.month ? 1 : -1));

  return apiSuccess(serializeData({
    months,
    summary: buildSummary(months),
    teamMembers: members.map((m) => ({ id: String(m.id), name: m.display_name || m.username })),
    isLeader: true,
  }));
}

function emptyAggr(month: string) {
  return {
    month,
    total_count: 0,
    total_amount: 0,
    pending_count: 0,
    pending_amount: 0,
    approved_count: 0,
    approved_amount: 0,
    paid_count: 0,
    paid_amount: 0,
    rejected_count: 0,
    rejected_amount: 0,
    is_settled: true, // 初值 true，遇到任一成员该月有 pending 即翻为 false
    last_synced_at_max: null as string | null,
  };
}

function buildSummary(
  months: Array<{
    is_settled: boolean;
    pending_amount: number;
    approved_amount: number;
    paid_amount: number;
    rejected_amount: number;
    total_amount: number;
  }>,
) {
  let settled = 0;
  let unsettled = 0;
  let pendingAmt = 0;
  let approvedAmt = 0;
  let paidAmt = 0;
  let rejectedAmt = 0;
  let totalAmt = 0;
  for (const m of months) {
    if (m.is_settled) settled++;
    else unsettled++;
    pendingAmt += m.pending_amount;
    approvedAmt += m.approved_amount;
    paidAmt += m.paid_amount;
    rejectedAmt += m.rejected_amount;
    totalAmt += m.total_amount;
  }
  return {
    months_settled: settled,
    months_unsettled: unsettled,
    months_total: months.length,
    pending_amount: +pendingAmt.toFixed(2),
    approved_amount: +approvedAmt.toFixed(2),
    paid_amount: +paidAmt.toFixed(2),
    rejected_amount: +rejectedAmt.toFixed(2),
    total_amount: +totalAmt.toFixed(2),
    settle_progress: totalAmt > 0
      ? +(((approvedAmt + paidAmt + rejectedAmt) / totalAmt) * 100).toFixed(2)
      : 0,
  };
}
