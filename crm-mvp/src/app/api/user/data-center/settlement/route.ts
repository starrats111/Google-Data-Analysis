import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { nowCST, TZ } from "@/lib/date-utils";

/**
 * GET /api/user/data-center/settlement
 *
 * 结算查询 — 支持三种维度筛选：
 *   - 时间：range (1m/3m/6m/1y) 或 date_start + date_end
 *   - 平台：platform (CG/RW/LH/...)
 *   - 商家：mid (商家 MID)
 *   - 员工：member_id (组长筛选特定员工)
 *
 * 组长角色：查看全组员工聚合数据，额外返回 members 维度
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const mid = searchParams.get("mid") || "";
  const platform = searchParams.get("platform") || "";
  const range = searchParams.get("range") || "1m";
  const dateStart = searchParams.get("date_start");
  const dateEnd = searchParams.get("date_end");
  const memberId = searchParams.get("member_id") || "";

  const userId = BigInt(user.userId);
  const isLeader = user.role === "leader" && user.teamId;
  const cstNow = nowCST();

  const start = dateStart
    ? new Date(dateStart)
    : (() => {
        switch (range) {
          case "3m": return cstNow.subtract(3, "month").toDate();
          case "6m": return cstNow.subtract(6, "month").toDate();
          case "1y": return cstNow.subtract(1, "year").toDate();
          default: return cstNow.subtract(1, "month").toDate();
        }
      })();
  const end = dateEnd ? new Date(dateEnd + "T23:59:59") : cstNow.toDate();

  // 组长查看全组数据，普通用户只看自己
  let userFilter: unknown = userId;
  let teamMembers: { id: bigint; username: string; display_name: string | null }[] = [];

  if (isLeader) {
    const members = await prisma.users.findMany({
      where: { team_id: BigInt(user.teamId!), is_deleted: 0, role: { not: "admin" } },
      select: { id: true, username: true, display_name: true },
    });
    teamMembers = members;
    const memberIds = members.map((m) => m.id);
    if (memberId) {
      userFilter = BigInt(memberId);
    } else {
      userFilter = { in: memberIds };
    }
  }

  const where: Record<string, unknown> = {
    user_id: userFilter,
    is_deleted: 0,
    transaction_time: { gte: start, lte: end },
  };
  if (mid) where.merchant_id = mid;
  if (platform) where.platform = platform;

  const txns = await prisma.affiliate_transactions.findMany({
    where: where as never,
    orderBy: { transaction_time: "desc" },
    take: 50000,
  });

  let totalCommission = 0;
  let approvedCommission = 0;
  let rejectedCommission = 0;
  let paidCommission = 0;
  let pendingCommission = 0;
  let totalOrders = 0;
  let totalOrderAmount = 0;

  // 按商家聚合
  const merchantMap = new Map<string, {
    merchant_id: string;
    merchant_name: string;
    platform: string;
    total: number;
    approved: number;
    rejected: number;
    paid: number;
    pending: number;
    orders: number;
    order_amount: number;
  }>();

  // 按月聚合
  const monthlyMap = new Map<string, {
    month: string; total: number; approved: number; rejected: number; paid: number; pending: number; orders: number;
  }>();

  // 按员工聚合（组长专用）
  const memberMap = new Map<string, {
    user_id: string; username: string; display_name: string;
    total: number; approved: number; rejected: number; paid: number; pending: number; orders: number; order_amount: number;
  }>();

  const memberNameMap = new Map<string, { username: string; display_name: string }>();
  if (isLeader) {
    for (const m of teamMembers) {
      memberNameMap.set(String(m.id), { username: m.username, display_name: m.display_name || m.username });
    }
  }

  for (const t of txns) {
    const amt = Number(t.commission_amount || 0);
    const orderAmt = Number(t.order_amount || 0);
    totalCommission += amt;
    totalOrders += 1;
    totalOrderAmount += orderAmt;

    switch (t.status) {
      case "approved": approvedCommission += amt; break;
      case "rejected": rejectedCommission += amt; break;
      case "paid": paidCommission += amt; break;
      default: pendingCommission += amt; break;
    }

    // 按商家
    const mKey = `${t.platform}:${t.merchant_id}`;
    const existing = merchantMap.get(mKey) || {
      merchant_id: t.merchant_id, merchant_name: t.merchant_name || t.merchant_id,
      platform: t.platform, total: 0, approved: 0, rejected: 0, paid: 0, pending: 0, orders: 0, order_amount: 0,
    };
    existing.total += amt;
    existing.order_amount += orderAmt;
    if (t.status === "approved") existing.approved += amt;
    else if (t.status === "rejected") existing.rejected += amt;
    else if (t.status === "paid") existing.paid += amt;
    else existing.pending += amt;
    existing.orders += 1;
    merchantMap.set(mKey, existing);

    // 按月
    const monthKey = new Date(t.transaction_time).toLocaleDateString("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit" }).slice(0, 7);
    const mExisting = monthlyMap.get(monthKey) || {
      month: monthKey, total: 0, approved: 0, rejected: 0, paid: 0, pending: 0, orders: 0,
    };
    mExisting.total += amt;
    if (t.status === "approved") mExisting.approved += amt;
    else if (t.status === "rejected") mExisting.rejected += amt;
    else if (t.status === "paid") mExisting.paid += amt;
    else mExisting.pending += amt;
    mExisting.orders += 1;
    monthlyMap.set(monthKey, mExisting);

    // 按员工（组长视角）
    if (isLeader) {
      const uid = String(t.user_id);
      const nameInfo = memberNameMap.get(uid) || { username: uid, display_name: uid };
      const eExisting = memberMap.get(uid) || {
        user_id: uid, username: nameInfo.username, display_name: nameInfo.display_name,
        total: 0, approved: 0, rejected: 0, paid: 0, pending: 0, orders: 0, order_amount: 0,
      };
      eExisting.total += amt;
      eExisting.order_amount += orderAmt;
      if (t.status === "approved") eExisting.approved += amt;
      else if (t.status === "rejected") eExisting.rejected += amt;
      else if (t.status === "paid") eExisting.paid += amt;
      else eExisting.pending += amt;
      eExisting.orders += 1;
      memberMap.set(uid, eExisting);
    }
  }

  const fix2 = (n: number) => +n.toFixed(2);

  const approvalRate = totalCommission > 0 ? fix2(approvedCommission / totalCommission * 100) : 0;
  const rejectionRate = totalCommission > 0 ? fix2(rejectedCommission / totalCommission * 100) : 0;
  const settlementRate = totalCommission > 0 ? fix2(paidCommission / totalCommission * 100) : 0;

  const merchants = Array.from(merchantMap.values())
    .sort((a, b) => b.total - a.total)
    .map((m) => ({
      ...m,
      total: fix2(m.total), approved: fix2(m.approved), rejected: fix2(m.rejected),
      paid: fix2(m.paid), pending: fix2(m.pending), order_amount: fix2(m.order_amount),
    }));

  const monthly = Array.from(monthlyMap.values())
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((m) => ({
      ...m,
      total: fix2(m.total), approved: fix2(m.approved), rejected: fix2(m.rejected),
      paid: fix2(m.paid), pending: fix2(m.pending),
    }));

  const members = isLeader
    ? Array.from(memberMap.values())
        .sort((a, b) => b.total - a.total)
        .map((m) => ({
          ...m,
          total: fix2(m.total), approved: fix2(m.approved), rejected: fix2(m.rejected),
          paid: fix2(m.paid), pending: fix2(m.pending), order_amount: fix2(m.order_amount),
        }))
    : undefined;

  const teamMemberList = isLeader
    ? teamMembers.map((m) => ({ id: String(m.id), name: m.display_name || m.username }))
    : undefined;

  return apiSuccess(serializeData({
    summary: {
      total_commission: fix2(totalCommission),
      approved_commission: fix2(approvedCommission),
      rejected_commission: fix2(rejectedCommission),
      paid_commission: fix2(paidCommission),
      pending_commission: fix2(pendingCommission),
      total_orders: totalOrders,
      total_order_amount: fix2(totalOrderAmount),
      approval_rate: approvalRate,
      rejection_rate: rejectionRate,
      settlement_rate: settlementRate,
    },
    merchants,
    monthly,
    members,
    teamMembers: teamMemberList,
    isLeader: !!isLeader,
  }));
}
