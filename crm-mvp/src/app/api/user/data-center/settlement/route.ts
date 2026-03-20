import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { nowCST, TZ } from "@/lib/date-utils";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const mid = searchParams.get("mid");
  const range = searchParams.get("range") || "1m"; // 1m / 3m / 6m / 1y

  if (!mid) return apiError("请提供商家 MID", 400);

  const userId = BigInt(user.userId);
  const cstNow = nowCST();
  const now = cstNow.toDate();
  const startDayjs = (() => {
    switch (range) {
      case "3m": return cstNow.subtract(3, "month");
      case "6m": return cstNow.subtract(6, "month");
      case "1y": return cstNow.subtract(1, "year");
      default: return cstNow.subtract(1, "month");
    }
  })();
  const start = startDayjs.toDate();

  // 查询该 MID 的所有交易
  const txns = await prisma.affiliate_transactions.findMany({
    where: {
      user_id: userId,
      merchant_id: mid,
      is_deleted: 0,
      transaction_time: { gte: start, lte: now },
    } as never,
    orderBy: { transaction_time: "desc" },
  });

  // 聚合计算
  let totalCommission = 0;
  let approvedCommission = 0;
  let rejectedCommission = 0;
  let paidCommission = 0;
  let pendingCommission = 0;
  let totalOrders = 0;

  // 按月聚合
  const monthlyMap = new Map<string, {
    month: string; total: number; approved: number; rejected: number; paid: number; pending: number; orders: number;
  }>();

  for (const t of txns) {
    const amt = Number(t.commission_amount || 0);
    totalCommission += amt;
    totalOrders += 1;

    switch (t.status) {
      case "approved": approvedCommission += amt; break;
      case "rejected": rejectedCommission += amt; break;
      case "paid": paidCommission += amt; break;
      default: pendingCommission += amt; break;
    }

    const monthKey = new Date(t.transaction_time).toLocaleDateString("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit" }).slice(0, 7);
    const existing = monthlyMap.get(monthKey) || {
      month: monthKey, total: 0, approved: 0, rejected: 0, paid: 0, pending: 0, orders: 0,
    };
    existing.total += amt;
    if (t.status === "approved") existing.approved += amt;
    else if (t.status === "rejected") existing.rejected += amt;
    else if (t.status === "paid") existing.paid += amt;
    else existing.pending += amt;
    existing.orders += 1;
    monthlyMap.set(monthKey, existing);
  }

  // 计算三率
  const approvalRate = totalCommission > 0 ? +(approvedCommission / totalCommission * 100).toFixed(2) : 0;
  const rejectionRate = totalCommission > 0 ? +(rejectedCommission / totalCommission * 100).toFixed(2) : 0;
  const settlementRate = totalCommission > 0 ? +(paidCommission / totalCommission * 100).toFixed(2) : 0;

  // 商家信息
  const merchant = await prisma.user_merchants.findFirst({
    where: { user_id: userId, merchant_id: mid, is_deleted: 0 } as never,
    select: { merchant_name: true, platform: true },
  });

  // 按月排序
  const monthly = Array.from(monthlyMap.values())
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((m) => ({
      ...m,
      total: +m.total.toFixed(2),
      approved: +m.approved.toFixed(2),
      rejected: +m.rejected.toFixed(2),
      paid: +m.paid.toFixed(2),
      pending: +m.pending.toFixed(2),
    }));

  return apiSuccess(serializeData({
    mid,
    merchant_name: merchant?.merchant_name || mid,
    platform: merchant?.platform || "",
    summary: {
      total_commission: +totalCommission.toFixed(2),
      approved_commission: +approvedCommission.toFixed(2),
      rejected_commission: +rejectedCommission.toFixed(2),
      paid_commission: +paidCommission.toFixed(2),
      pending_commission: +pendingCommission.toFixed(2),
      total_orders: totalOrders,
      approval_rate: approvalRate,
      rejection_rate: rejectionRate,
      settlement_rate: settlementRate,
    },
    monthly,
  }));
}
