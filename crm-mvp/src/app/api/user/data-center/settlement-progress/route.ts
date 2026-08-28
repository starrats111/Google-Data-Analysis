import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { getMonthlyProgressLive } from "@/lib/monthly-settlement-tracker";

/**
 * GET /api/user/data-center/settlement-progress
 *
 * 返回当前用户每月结算进度。
 *
 * 行为（D-294 改）：每次都从 affiliate_transactions 实时聚合，与结算查询汇总、
 * 按月份表、数据中心佣金卡同源同口径。改造前读的是 daily-sync 每天刷一次的
 * monthly_settlement_status 快照，daily-sync 一挂卡片就停在旧数（2026-08-26 起
 * 连挂三天，团队 1 的 8 月少了 $7808.37）；快照表现在只负责驱动同步和记 settled_at。
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

    const months = await getMonthlyProgressLive([targetUserId]);

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

  // 全组一次查完：按月合并，"已结算"= 该月全组都没有 pending（同一条 SQL 天然满足）
  const months = await getMonthlyProgressLive(members.map((m) => m.id));

  return apiSuccess(serializeData({
    months,
    summary: buildSummary(months),
    teamMembers: members.map((m) => ({ id: String(m.id), name: m.display_name || m.username })),
    isLeader: true,
  }));
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
