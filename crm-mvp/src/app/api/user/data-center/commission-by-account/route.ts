import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { sqlAffiliateTxnValidPlatformConnection } from "@/lib/affiliate-transaction-sql";
import { sqlTxnRange, nextDayStr } from "@/lib/report-metrics";

/** 当前北京时间自然日 "YYYY-MM-DD" */
function cstToday(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * GET /api/user/data-center/commission-by-account
 * 佣金明细：同时返回"按平台账号"和"按商家"两个维度，供审核复核。
 * 切日口径走 report-metrics（按各平台后台显示时间，与平台后台一致）。
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const dateStart = searchParams.get("date_start");
  const dateEnd = searchParams.get("date_end");

  const userId = BigInt(user.userId);
  const today = cstToday();
  const startStr = dateStart || `${today.slice(0, 7)}-01`;
  const endExclStr = nextDayStr(dateEnd || today);
  const txnRange = sqlTxnRange("t", startStr, endExclStr);

  const txnConnValid = sqlAffiliateTxnValidPlatformConnection("t");

  // ─── 维度一：按平台账号聚合 ───
  const byAccountRows = await prisma.$queryRawUnsafe<{
    platform_connection_id: bigint | null;
    platform: string;
    total_commission: number;
    approved_commission: number;
    paid_commission: number;
    rejected_commission: number;
    pending_commission: number;
    order_count: number;
    order_amount: number;
  }[]>(`
    SELECT
      platform_connection_id,
      platform,
      SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
      SUM(CASE WHEN status = 'approved' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as approved_commission,
      SUM(CASE WHEN status = 'paid' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as paid_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
      SUM(CASE WHEN status = 'pending' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as pending_commission,
      COUNT(*) as order_count,
      SUM(CAST(order_amount AS DECIMAL(12,2))) as order_amount
    FROM affiliate_transactions t
    WHERE t.user_id = ? AND t.is_deleted = 0
      AND ${txnRange.cond}
      AND ${txnConnValid}
    GROUP BY t.platform_connection_id, t.platform
    ORDER BY total_commission DESC
  `, userId, ...txnRange.params);

  const connIds = byAccountRows
    .map((r) => r.platform_connection_id)
    .filter((id): id is bigint => id !== null && id !== BigInt(0));

  const connMap = new Map<string, { name: string; createdAt: Date | null }>();
  if (connIds.length > 0) {
    const conns = await prisma.platform_connections.findMany({
      where: { id: { in: connIds } },
      select: { id: true, account_name: true, platform: true, created_at: true },
    });
    for (const c of conns) {
      connMap.set(String(c.id), { name: c.account_name || c.platform, createdAt: c.created_at });
    }
  }

  const byAccount = byAccountRows.map((r) => {
    const conn = r.platform_connection_id ? connMap.get(String(r.platform_connection_id)) : undefined;
    const connCreatedAt = conn?.createdAt ? conn.createdAt.toISOString().slice(0, 10) : null;
    return {
      platform_connection_id: r.platform_connection_id ? String(r.platform_connection_id) : null,
      platform: r.platform,
      account_name: conn?.name || r.platform,
      // 换绑说明用：连接创建（绑定）日期。若晚于查询起始日，说明该行仅含绑定后的数据，
      // 绑定前同账号的历史佣金仍归属原员工（口径：保持发生时归属，见 2026-07 拍板）。
      connection_created_at: connCreatedAt,
      bound_after_range_start: !!(connCreatedAt && connCreatedAt > startStr),
      total_commission: Number(r.total_commission || 0),
      approved_commission: Number(r.approved_commission || 0),
      paid_commission: Number(r.paid_commission || 0),
      rejected_commission: Number(r.rejected_commission || 0),
      pending_commission: Number(r.pending_commission || 0),
      order_count: Number(r.order_count || 0),
      order_amount: Number(r.order_amount || 0),
    };
  });

  // ─── 维度二：按商家聚合（与总览同口径，用于审核复核） ───
  const byMerchantRows = await prisma.$queryRawUnsafe<{
    user_merchant_id: bigint;
    merchant_name: string;
    platform: string;
    total_commission: number;
    approved_commission: number;
    paid_commission: number;
    rejected_commission: number;
    pending_commission: number;
    order_count: number;
    order_amount: number;
  }[]>(`
    SELECT
      user_merchant_id,
      MAX(merchant_name) as merchant_name,
      MAX(platform) as platform,
      SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
      SUM(CASE WHEN status = 'approved' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as approved_commission,
      SUM(CASE WHEN status = 'paid' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as paid_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
      SUM(CASE WHEN status = 'pending' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as pending_commission,
      COUNT(*) as order_count,
      SUM(CAST(order_amount AS DECIMAL(12,2))) as order_amount
    FROM affiliate_transactions t
    WHERE t.user_id = ? AND t.is_deleted = 0
      AND ${txnRange.cond}
      AND ${txnConnValid}
    GROUP BY t.user_merchant_id
    ORDER BY total_commission DESC
  `, userId, ...txnRange.params);

  const byMerchant = byMerchantRows.map((r) => ({
    user_merchant_id: String(r.user_merchant_id),
    merchant_name: r.merchant_name || `未知商家 (${r.user_merchant_id})`,
    platform: r.platform || "",
    total_commission: Number(r.total_commission || 0),
    approved_commission: Number(r.approved_commission || 0),
    paid_commission: Number(r.paid_commission || 0),
    rejected_commission: Number(r.rejected_commission || 0),
    pending_commission: Number(r.pending_commission || 0),
    order_count: Number(r.order_count || 0),
    order_amount: Number(r.order_amount || 0),
  }));

  return apiSuccess(serializeData({ byAccount, byMerchant }));
}
