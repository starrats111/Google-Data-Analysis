import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { parseTxnDateStart, parseTxnDateEndExclusive, txnStartOfMonthUTC } from "@/lib/date-utils";

/**
 * GET /api/user/data-center/payments
 *
 * D-072：打款/实付记录列表（affiliate_payments）。
 * 结算页「打款记录」区使用。支持时间 / 平台 / 员工筛选（与结算查询一致）。
 * 时间口径按 paid_date（实际打款日）。
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const platform = searchParams.get("platform") || "";
  const range = searchParams.get("range") || "1m";
  const dateStart = searchParams.get("date_start");
  const dateEnd = searchParams.get("date_end");
  const memberId = searchParams.get("member_id") || "";

  const userId = BigInt(user.userId);
  const isLeader = user.role === "leader" && user.teamId;

  const start = dateStart
    ? parseTxnDateStart(dateStart)
    : (() => {
        switch (range) {
          case "3m": return new Date(Date.now() - 90 * 86400000);
          case "6m": return new Date(Date.now() - 180 * 86400000);
          case "1y": return new Date(Date.now() - 365 * 86400000);
          default: return txnStartOfMonthUTC();
        }
      })();
  const end = dateEnd ? parseTxnDateEndExclusive(dateEnd) : new Date();

  // 确定查询的用户 ID 列表
  let userIds: bigint[] = [];
  if (isLeader) {
    const members = await prisma.users.findMany({
      where: { team_id: BigInt(user.teamId!), is_deleted: 0, role: { not: "admin" } },
      select: { id: true },
    });
    userIds = memberId ? [BigInt(memberId)] : members.map((m) => m.id);
  } else {
    userIds = [userId];
  }
  if (userIds.length === 0) {
    return apiSuccess(serializeData({ payments: [], byPlatform: [], total_paid: 0 }));
  }

  const where = {
    user_id: { in: userIds },
    is_deleted: 0,
    status: "paid",
    paid_date: { gte: start, lt: end },
    ...(platform ? { platform } : {}),
  } as const;

  const rows = await prisma.affiliate_payments.findMany({
    where,
    orderBy: { paid_date: "desc" },
    take: 1000,
    select: {
      id: true, platform: true, payment_no: true, source_kind: true,
      paid_date: true, amount: true, gross_amount: true, currency: true,
      payment_type: true, raw_status: true,
      platform_connection_id: true, user_id: true,
    },
  });

  // 关联账号名（platform_connections.account_name）；组长视图附带员工名便于区分
  const connIds = [...new Set(rows.map((r) => r.platform_connection_id).filter((x): x is bigint => x != null))];
  const conns = connIds.length
    ? await prisma.platform_connections.findMany({
        where: { id: { in: connIds } },
        select: { id: true, account_name: true, payee: true },
      })
    : [];
  const connNameMap = new Map(conns.map((c) => [String(c.id), c.account_name || ""]));
  const connPayeeMap = new Map(conns.map((c) => [String(c.id), c.payee || ""]));

  let userNameMap = new Map<string, string>();
  if (isLeader) {
    const us = await prisma.users.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.user_id))] } },
      select: { id: true, username: true, display_name: true },
    });
    userNameMap = new Map(us.map((u) => [String(u.id), u.display_name || u.username]));
  }

  const payments = rows.map((r) => {
    const accountName = r.platform_connection_id ? (connNameMap.get(String(r.platform_connection_id)) || "") : "";
    const memberName = isLeader ? (userNameMap.get(String(r.user_id)) || "") : "";
    const payee = r.platform_connection_id ? (connPayeeMap.get(String(r.platform_connection_id)) || "") : "";
    return {
      id: String(r.id),
      platform: r.platform,
      account_name: accountName || r.platform,
      payee,
      member_name: memberName,
      payment_no: r.payment_no,
      source_kind: r.source_kind,
      paid_date: r.paid_date ? r.paid_date.toISOString().slice(0, 10) : null,
      amount: +Number(r.amount).toFixed(2),
      gross_amount: r.gross_amount != null ? +Number(r.gross_amount).toFixed(2) : null,
      currency: r.currency,
      payment_type: r.payment_type,
      raw_status: r.raw_status,
    };
  });

  // 按平台汇总
  const platMap = new Map<string, { platform: string; count: number; amount: number }>();
  let totalPaid = 0;
  for (const p of payments) {
    totalPaid += p.amount;
    const cur = platMap.get(p.platform) ?? { platform: p.platform, count: 0, amount: 0 };
    cur.count++;
    cur.amount += p.amount;
    platMap.set(p.platform, cur);
  }
  const byPlatform = Array.from(platMap.values())
    .map((x) => ({ ...x, amount: +x.amount.toFixed(2) }))
    .sort((a, b) => b.amount - a.amount);

  return apiSuccess(serializeData({
    payments,
    byPlatform,
    total_paid: +totalPaid.toFixed(2),
  }));
}
