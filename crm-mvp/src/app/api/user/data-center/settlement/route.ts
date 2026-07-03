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

  // 口径A（交易表四桶直白口径，等式算术恒等）：
  //   总佣金 = 交易表全部佣金。
  //   已确认 = status=approved；已拒付 = status=rejected；审核中 = status=pending；
  //   已支付 = status=paid（交易表 paid 桶）。
  // approved/rejected/pending/paid 把整张表无重叠分完，故
  //   总 = 已确认 + 已支付 + 拒付 + 审核中 恒等闭合。
  // paid 桶来源：CG/PM/LB 等交易API 带 paid_date 自动推导为 paid；RW/LH 交易API 无 paid_date，
  // 由支付细节API（按 withdrawal_id 展开 sign_id）标记。
  // 注：账户级到账金额（支付API / affiliate_payments）单独在「支付查询」页签展示，不参与本等式。
  const sum = summaryRows[0] || {};
  const totalCommission    = Number(sum.total_commission    || 0);
  const approvedCommission = Number(sum.approved_commission || 0); // 已确认 = 交易表 approved
  const rejectedCommission = Number(sum.rejected_commission || 0); // 已拒付 = 交易表 rejected
  const paidCommission     = Number(sum.paid_commission     || 0); // 已支付 = 交易表 paid 桶
  const pendingCommission  = Number(sum.pending_commission  || 0); // 审核中 = 交易表 pending
  const totalOrders        = Number(sum.total_orders        || 0);
  const totalOrderAmount   = Number(sum.total_order_amount  || 0);

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
