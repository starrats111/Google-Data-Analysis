import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { parseTxnDateStart, parseTxnDateEndExclusive, txnStartOfMonthUTC } from "@/lib/date-utils";
import { paymentDisplayAmount } from "@/lib/report-metrics";

/**
 * GET /api/user/data-center/payments
 *
 * D-072：打款/实付记录列表（affiliate_payments）。
 * 结算页「打款记录」区使用。支持时间 / 平台 / 员工筛选（与结算查询一致）。
 * 时间口径按 paid_date（实际打款日）。
 * 金额口径（2026-07 对齐平台后台）：amount 一律为平台毛额（gross 优先，空则回退净额），
 * 与平台后台打款记录逐笔一致；净额与手续费以 net_amount / fee 附带返回。
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

  // 审核中(processing，如 LB 打款单确认期)也展示，便于核对；合计仅计已到账 paid
  const where = {
    user_id: { in: userIds },
    is_deleted: 0,
    status: { in: ["paid", "processing"] },
    paid_date: { gte: start, lt: end },
    ...(platform ? { platform } : {}),
  };

  // 取原始行：同一总帐号下若配置了多个渠道(连接)，重复行会显著放大行数，
  // 适当放宽上限，避免重复行把真实明细挤出截断窗口（去重后再分页展示）。
  const rowsRaw = await prisma.affiliate_payments.findMany({
    where,
    orderBy: { paid_date: "desc" },
    take: 5000,
    select: {
      id: true, platform: true, payment_no: true, source_kind: true,
      paid_date: true, amount: true, gross_amount: true, currency: true,
      status: true, raw_status: true,
      platform_connection_id: true, user_id: true,
    },
  });

  // 关联账号名 / 收款方式（platform_connections → payment_methods）。先取出全部原始行涉及的连接，
  // 以便去重时优先保留「带收款方式绑定的主连接」，避免折叠后丢失收款人/账号归属信息。
  // C-178：收款人/打款方式统一从组员绑定的收款方式（payment_methods）取，弃用连接上的旧 payee 文本。
  const allConnIds = [...new Set(rowsRaw.map((r) => r.platform_connection_id).filter((x): x is bigint => x != null))];
  const conns = allConnIds.length
    ? await prisma.platform_connections.findMany({
        where: { id: { in: allConnIds } },
        select: { id: true, account_name: true, payment_method_id: true },
      })
    : [];
  const methodIds = [...new Set(conns.map((c) => c.payment_method_id).filter((x): x is bigint => x != null))];
  const methods = methodIds.length
    ? await prisma.payment_methods.findMany({
        where: { id: { in: methodIds } }, // 不过滤 is_deleted：已删清单项仍按原文本显示
        select: { id: true, payee_name: true, pay_channel: true },
      })
    : [];
  const methodById = new Map(methods.map((m) => [String(m.id), m]));
  const connNameMap = new Map(conns.map((c) => [String(c.id), c.account_name || ""]));
  const connMethodMap = new Map(
    conns.map((c) => [String(c.id), c.payment_method_id ? methodById.get(String(c.payment_method_id)) ?? null : null]),
  );

  // 病灶根除（读取端兜底）：同一「总帐号」下的多个渠道(连接)各自配置了不同 api_key，
  // 联盟支付接口按账号返回同一笔打款单(payment_no)，导致同一笔实付按渠道在库里存了多行。
  // payment_no 在平台内全局唯一 → 按 (platform, payment_no) 折叠为「一个总帐号一笔」，
  // 只展示并计入一次（列表/按平台/总额）。折叠时优先保留带「收款人」、其次带账号名的
  // 主连接行，确保归属落在总帐号上（其余渠道 API 仅作为同一总帐号的来源，不重复计）。
  const connScore = (r: (typeof rowsRaw)[number]): number => {
    const cid = r.platform_connection_id ? String(r.platform_connection_id) : "";
    const hasMethod = cid && connMethodMap.get(cid) ? 2 : 0;
    const hasName = cid && connNameMap.get(cid) ? 1 : 0;
    return hasMethod + hasName;
  };
  const bestByPayment = new Map<string, (typeof rowsRaw)[number]>();
  for (const r of rowsRaw) {
    const key = `${r.platform}::${r.payment_no}`;
    const cur = bestByPayment.get(key);
    // 优先级：主连接得分高者 > 打款日较新者 > id 较小者（稳定）
    if (
      !cur ||
      connScore(r) > connScore(cur) ||
      (connScore(r) === connScore(cur) &&
        (r.paid_date?.getTime() ?? 0) > (cur.paid_date?.getTime() ?? 0))
    ) {
      bestByPayment.set(key, r);
    }
  }
  const rows = [...bestByPayment.values()].sort(
    (a, b) => (b.paid_date?.getTime() ?? 0) - (a.paid_date?.getTime() ?? 0),
  );

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
    // 收款人 / 打款方式：一律取绑定的收款方式（未绑定则留空，前端展示 —/未绑定）
    const method = r.platform_connection_id ? connMethodMap.get(String(r.platform_connection_id)) ?? null : null;
    const payee = method?.payee_name || "";
    // 对齐平台后台：展示金额一律用毛额（gross 优先），净额/手续费附带返回
    const netAmount = +Number(r.amount).toFixed(2);
    const displayAmount = +paymentDisplayAmount(Number(r.amount), r.gross_amount != null ? Number(r.gross_amount) : null).toFixed(2);
    return {
      id: String(r.id),
      platform: r.platform,
      account_name: accountName || r.platform,
      payee,
      member_name: memberName,
      payment_no: r.payment_no,
      source_kind: r.source_kind,
      paid_date: r.paid_date ? r.paid_date.toISOString().slice(0, 10) : null,
      amount: displayAmount,
      net_amount: netAmount,
      fee: +(displayAmount - netAmount).toFixed(2),
      gross_amount: r.gross_amount != null ? +Number(r.gross_amount).toFixed(2) : null,
      currency: r.currency,
      // C-178：打款方式 = 绑定收款方式的 pay_channel（不再展示平台 API 原始 payment_type）
      payment_type: method?.pay_channel || null,
      status: r.status,
      raw_status: r.raw_status,
    };
  });

  // 按平台汇总（合计只计已到账 paid；审核中单仅在明细展示）
  const platMap = new Map<string, { platform: string; count: number; amount: number }>();
  let totalPaid = 0;
  for (const p of payments) {
    if (p.status !== "paid") continue;
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
