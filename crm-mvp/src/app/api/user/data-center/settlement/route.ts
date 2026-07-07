import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { sqlAffiliateTxnValidPlatformConnection } from "@/lib/affiliate-transaction-sql";
import { sqlTxnMonth, sqlTxnRange, nextDayStr } from "@/lib/report-metrics";

/** 当前北京时间自然日 "YYYY-MM-DD"（可回拨 N 天） */
function cstDateStr(daysAgo = 0): string {
  return new Date(Date.now() + 8 * 3600 * 1000 - daysAgo * 86400000).toISOString().slice(0, 10);
}

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
 *
 * 注意：使用 SQL 直接聚合，不拉取原始行，避免 take 上限导致数据截断。
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

  // 切日口径走 report-metrics：按各平台后台显示时间（北京时间钟面）过滤，与平台后台一致
  const startStr = dateStart
    ? dateStart
    : (() => {
        switch (range) {
          case "3m": return cstDateStr(90);
          case "6m": return cstDateStr(180);
          case "1y": return cstDateStr(365);
          case "1m":
          default:
            return `${cstDateStr().slice(0, 7)}-01`; // 本月（CST）月初
        }
      })();
  const endExclStr = nextDayStr(dateEnd || cstDateStr());

  // 确定查询范围的用户 ID 列表
  let userIds: bigint[] = [];
  let teamMembers: { id: bigint; username: string; display_name: string | null }[] = [];

  if (isLeader) {
    const members = await prisma.users.findMany({
      where: { team_id: BigInt(user.teamId!), is_deleted: 0, role: { not: "admin" } },
      select: { id: true, username: true, display_name: true },
    });
    teamMembers = members;
    if (memberId) {
      userIds = [BigInt(memberId)];
    } else {
      userIds = members.map((m) => m.id);
    }
  } else {
    userIds = [userId];
  }

  if (userIds.length === 0) {
    return apiSuccess(serializeData({
      summary: {
        total_commission: 0, approved_commission: 0, rejected_commission: 0,
        paid_commission: 0, pending_commission: 0,
        received_amount: 0, awaiting_payment: 0,
        total_orders: 0, total_order_amount: 0,
        approval_rate: 0, rejection_rate: 0, settlement_rate: 0,
      },
      merchants: [], monthly: [], members: isLeader ? [] : undefined,
      teamMembers: isLeader ? [] : undefined, isLeader: !!isLeader,
    }));
  }

  // 构建 WHERE 子句（避免直接拼接，使用参数化占位符）
  const uidPlaceholders = userIds.map(() => "?").join(",");
  const txnRange = sqlTxnRange("affiliate_transactions", startStr, endExclStr);
  const baseParams: unknown[] = [...userIds, ...txnRange.params];

  let midClause = "";
  if (mid) { midClause = " AND merchant_id = ?"; baseParams.push(mid); }

  let platformClause = "";
  if (platform) { platformClause = " AND platform = ?"; baseParams.push(platform); }

  const txnConnValid = sqlAffiliateTxnValidPlatformConnection("affiliate_transactions");
  const baseWhere = `user_id IN (${uidPlaceholders}) AND is_deleted = 0
    AND ${txnRange.cond}${midClause}${platformClause}
    AND ${txnConnValid}`;

  // ── 1. 汇总（单次聚合，不拉原始行） ──────────────────────────────────────
  const summaryRows = await prisma.$queryRawUnsafe<{
    total_commission: number;
    approved_commission: number;
    rejected_commission: number;
    paid_commission: number;
    pending_commission: number;
    total_orders: number;
    total_order_amount: number;
  }[]>(`
    SELECT
      SUM(CAST(commission_amount AS DECIMAL(14,4))) AS total_commission,
      SUM(CASE WHEN status = 'approved' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS approved_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS rejected_commission,
      SUM(CASE WHEN status = 'paid'     THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS paid_commission,
      SUM(CASE WHEN status NOT IN ('approved','rejected','paid') THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS pending_commission,
      COUNT(*)                                                                          AS total_orders,
      SUM(COALESCE(CAST(order_amount AS DECIMAL(14,4)), 0))                             AS total_order_amount
    FROM affiliate_transactions
    WHERE ${baseWhere}
  `, ...baseParams);

  // 口径B（2026-07-07 应用户要求改版，算式闭合）：
  //   总佣金 = 审核中 + 已拒绝 + 待打款 + 已到账
  //   审核中 = 交易表 status=pending；已拒绝 = status=rejected；
  //   已到账 = 支付API（affiliate_payments status=paid，按打款日在所选窗口内，
  //            金额为平台毛额、(platform,payment_no) 去重——与「支付查询」实付合计同源）；
  //   待打款 = (approved + paid 交易桶) − 已到账。
  // approved+paid 表示「平台已确认应付的佣金」，减去实际到账即为平台还欠的钱；
  // 定义式保证闭合恒等。若拒付后期转实付（carve 会把 rejected 行标回 paid），
  // 金额自动从「已拒绝」移入 approved+paid 侧，按 paid 参与计算。
  // 注意：交易按下单时间归窗、打款按打款日归窗，窗口小时（如本月）「待打款」可能为负
  // （本期到账的是更早订单的钱），属正常时间差；打款记录无商家维度，mid 筛选不作用于已到账。
  const sum = summaryRows[0] || {};
  const totalCommission    = Number(sum.total_commission    || 0);
  const approvedCommission = Number(sum.approved_commission || 0); // 已确认 = 交易表 approved
  const rejectedCommission = Number(sum.rejected_commission || 0); // 已拒付 = 交易表 rejected
  const paidCommission     = Number(sum.paid_commission     || 0); // 已支付 = 交易表 paid 桶
  const pendingCommission  = Number(sum.pending_commission  || 0); // 审核中 = 交易表 pending
  const totalOrders        = Number(sum.total_orders        || 0);
  const totalOrderAmount   = Number(sum.total_order_amount  || 0);

  // ── 1b. 已到账（支付API 账户级实付，与「支付查询」实付合计同口径）──────────
  // paid_date 为日期型（UTC 零点入库），用日期字符串边界过滤；
  // (platform, payment_no) 去重后取毛额（gross 优先，空/0 回退净额）。
  const payParams: unknown[] = [...userIds, `${startStr} 00:00:00`, `${endExclStr} 00:00:00`];
  let payPlatformClause = "";
  if (platform) { payPlatformClause = " AND platform = ?"; payParams.push(platform); }
  const receivedRows = await prisma.$queryRawUnsafe<{ received: number }[]>(`
    SELECT COALESCE(SUM(amt), 0) AS received FROM (
      SELECT MAX(CAST(COALESCE(NULLIF(gross_amount, 0), amount) AS DECIMAL(14,4))) AS amt
      FROM affiliate_payments
      WHERE user_id IN (${uidPlaceholders}) AND is_deleted = 0 AND status = 'paid'
        AND paid_date >= ? AND paid_date < ?${payPlatformClause}
      GROUP BY platform, payment_no
    ) x
  `, ...payParams);
  const receivedAmount  = Number(receivedRows[0]?.received || 0);
  // 待打款 = 平台已确认应付（approved+paid 桶）− 实际到账；定义式保证等式闭合
  const awaitingPayment = approvedCommission + paidCommission - receivedAmount;

  const fix2 = (n: number) => +n.toFixed(2);
  // 确认率=已确认/总；拒付率=拒付/总；结算率=已支付/总。
  const approvalRate   = totalCommission > 0 ? fix2(approvedCommission / totalCommission * 100) : 0;
  const rejectionRate  = totalCommission > 0 ? fix2(rejectedCommission / totalCommission * 100) : 0;
  const settlementRate = totalCommission > 0 ? fix2(paidCommission     / totalCommission * 100) : 0;

  // ── 2. 按商家聚合 ──────────────────────────────────────────────────────────
  const merchantRows = await prisma.$queryRawUnsafe<{
    platform: string; merchant_id: string; merchant_name: string;
    total: number; approved: number; rejected: number; paid: number; pending: number;
    orders: number; order_amount: number;
  }[]>(`
    SELECT
      platform,
      merchant_id,
      MAX(merchant_name) AS merchant_name,
      SUM(CAST(commission_amount AS DECIMAL(14,4))) AS total,
      SUM(CASE WHEN status = 'approved' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS rejected,
      SUM(CASE WHEN status = 'paid'     THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS paid,
      SUM(CASE WHEN status NOT IN ('approved','rejected','paid') THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS pending,
      COUNT(*) AS orders,
      SUM(COALESCE(CAST(order_amount AS DECIMAL(14,4)), 0)) AS order_amount
    FROM affiliate_transactions
    WHERE ${baseWhere}
    GROUP BY platform, merchant_id
    ORDER BY total DESC
  `, ...baseParams);

  const merchants = merchantRows.map((m) => ({
    merchant_id: m.merchant_id,
    merchant_name: m.merchant_name || m.merchant_id,
    platform: m.platform,
    total: fix2(Number(m.total)),
    approved: fix2(Number(m.approved)),
    rejected: fix2(Number(m.rejected)),
    paid: fix2(Number(m.paid)),
    pending: fix2(Number(m.pending)),
    orders: Number(m.orders),
    order_amount: fix2(Number(m.order_amount)),
  }));

  // ── 3. 按月聚合（按各平台后台显示时间归月，与平台后台一致；统一走 report-metrics）───
  const monthlyRows = await prisma.$queryRawUnsafe<{
    month: string;
    total: number; approved: number; rejected: number; paid: number; pending: number;
    orders: number;
  }[]>(`
    SELECT
      ${sqlTxnMonth("affiliate_transactions")} AS month,
      SUM(CAST(commission_amount AS DECIMAL(14,4))) AS total,
      SUM(CASE WHEN status = 'approved' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS rejected,
      SUM(CASE WHEN status = 'paid'     THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS paid,
      SUM(CASE WHEN status NOT IN ('approved','rejected','paid') THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS pending,
      COUNT(*) AS orders
    FROM affiliate_transactions
    WHERE ${baseWhere}
    GROUP BY month
    ORDER BY month DESC
  `, ...baseParams);

  const monthly = monthlyRows.map((m) => ({
    month: m.month,
    total: fix2(Number(m.total)),
    approved: fix2(Number(m.approved)),
    rejected: fix2(Number(m.rejected)),
    paid: fix2(Number(m.paid)),
    pending: fix2(Number(m.pending)),
    orders: Number(m.orders),
  }));

  // ── 4. 按员工聚合（组长专用） ─────────────────────────────────────────────
  let members: {
    user_id: string; username: string; display_name: string;
    total: number; approved: number; rejected: number; paid: number; pending: number;
    orders: number; order_amount: number;
  }[] | undefined = undefined;

  if (isLeader) {
    const memberNameMap = new Map<string, { username: string; display_name: string }>();
    for (const m of teamMembers) {
      memberNameMap.set(String(m.id), { username: m.username, display_name: m.display_name || m.username });
    }

    const memberRows = await prisma.$queryRawUnsafe<{
      user_id: bigint;
      total: number; approved: number; rejected: number; paid: number; pending: number;
      orders: number; order_amount: number;
    }[]>(`
      SELECT
        user_id,
        SUM(CAST(commission_amount AS DECIMAL(14,4))) AS total,
        SUM(CASE WHEN status = 'approved' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS approved,
        SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS rejected,
        SUM(CASE WHEN status = 'paid'     THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS paid,
        SUM(CASE WHEN status NOT IN ('approved','rejected','paid') THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS pending,
        COUNT(*) AS orders,
        SUM(COALESCE(CAST(order_amount AS DECIMAL(14,4)), 0)) AS order_amount
      FROM affiliate_transactions
      WHERE ${baseWhere}
      GROUP BY user_id
      ORDER BY total DESC
    `, ...baseParams);

    members = memberRows.map((r) => {
      const uid = String(r.user_id);
      const nameInfo = memberNameMap.get(uid) || { username: uid, display_name: uid };
      return {
        user_id: uid,
        username: nameInfo.username,
        display_name: nameInfo.display_name,
        total: fix2(Number(r.total)),
        approved: fix2(Number(r.approved)),
        rejected: fix2(Number(r.rejected)),
        paid: fix2(Number(r.paid)),
        pending: fix2(Number(r.pending)),
        orders: Number(r.orders),
        order_amount: fix2(Number(r.order_amount)),
      };
    });
  }

  const teamMemberList = isLeader
    ? teamMembers.map((m) => ({ id: String(m.id), name: m.display_name || m.username }))
    : undefined;

  return apiSuccess(serializeData({
    summary: {
      total_commission: fix2(totalCommission),
      approved_commission: fix2(approvedCommission), // 已确认 = 交易表 approved
      rejected_commission: fix2(rejectedCommission), // 已拒付 = 交易表 rejected
      paid_commission: fix2(paidCommission), // 已支付 = 交易表 paid 桶
      pending_commission: fix2(pendingCommission), // 审核中 = 交易表 pending
      received_amount: fix2(receivedAmount), // 已到账 = 支付API 实付（去重毛额）
      awaiting_payment: fix2(awaitingPayment), // 待打款 = approved+paid − 已到账
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
