import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { nowCST } from "@/lib/date-utils";

/**
 * GET /api/user/data-center/commission-by-account
 * 按平台账号聚合佣金数据（用于总佣金详情弹窗）
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const dateStart = searchParams.get("date_start");
  const dateEnd = searchParams.get("date_end");

  const userId = BigInt(user.userId);
  const cstNow = nowCST();
  const startDate = dateStart ? new Date(dateStart) : cstNow.startOf("month").toDate();
  const endDate = dateEnd ? new Date(dateEnd + "T23:59:59") : cstNow.toDate();

  // 按 platform_connection_id 聚合交易数据
  const aggRows = await prisma.$queryRawUnsafe<{
    platform_connection_id: bigint | null;
    platform: string;
    total_commission: number;
    rejected_commission: number;
    pending_commission: number;
    order_count: number;
    order_amount: number;
  }[]>(`
    SELECT
      platform_connection_id,
      platform,
      SUM(CASE WHEN status IN ('approved','paid') THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as total_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
      SUM(CASE WHEN status = 'pending' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as pending_commission,
      COUNT(*) as order_count,
      SUM(CAST(order_amount AS DECIMAL(12,2))) as order_amount
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0
      AND transaction_time >= ? AND transaction_time <= ?
    GROUP BY platform_connection_id, platform
    ORDER BY total_commission DESC
  `, userId, startDate, endDate);

  // 获取平台连接名称
  const connIds = aggRows
    .map((r) => r.platform_connection_id)
    .filter((id): id is bigint => id !== null && id !== BigInt(0));

  const connMap = new Map<string, string>();
  if (connIds.length > 0) {
    const conns = await prisma.platform_connections.findMany({
      where: { id: { in: connIds } },
      select: { id: true, account_name: true, platform: true },
    });
    for (const c of conns) {
      connMap.set(String(c.id), c.account_name || c.platform);
    }
  }

  const result = aggRows.map((r) => ({
    platform_connection_id: r.platform_connection_id ? String(r.platform_connection_id) : null,
    platform: r.platform,
    account_name: r.platform_connection_id
      ? (connMap.get(String(r.platform_connection_id)) || r.platform)
      : r.platform,
    total_commission: Number(r.total_commission),
    rejected_commission: Number(r.rejected_commission),
    pending_commission: Number(r.pending_commission),
    order_count: Number(r.order_count),
    order_amount: Number(r.order_amount),
  }));

  return apiSuccess(serializeData(result));
}
