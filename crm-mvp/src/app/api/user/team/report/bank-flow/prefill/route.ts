import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { paymentDisplayAmount } from "@/lib/report-metrics";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report/bank-flow/prefill?methodId=&platform=&date=YYYY-MM-DD
 *
 * R-07 银行流水登记的员工明细预填 — 精确跟到账日期走：
 * 取「该收款方式 × 该平台」绑定账号在【到账日当天】的组员打款记录逐笔预填；
 * 当天没有记录时，回退到 ±5 天内最近且有记录的那一天（只取那一天，
 * 保证同一下半月内 6-16 / 6-18 两笔打款各自预填各自批次，不混算）。
 * 金额 = 打款记录毛额(gross 优先) × 打款日当日或其前最近的汇率快照，折 CNY。
 */

const WINDOW_DAYS = 5;

export const GET = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");
  const teamId = BigInt(user.teamId);

  const sp = new URL(req.url).searchParams;
  const methodId = sp.get("methodId") || "";
  const platform = sp.get("platform") || "";
  const dateStr = sp.get("date") || "";
  if (!methodId) return apiError("缺少收款方式");
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(platform)) return apiError("platform 无效");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return apiError("date 格式必须为 YYYY-MM-DD");

  const method = await prisma.payment_methods.findFirst({
    where: { id: BigInt(methodId), team_id: teamId, is_deleted: 0 },
    select: { id: true },
  });
  if (!method) return apiError("收款方式不存在");

  const members = await prisma.users.findMany({
    where: { team_id: teamId, is_deleted: 0, role: { not: "admin" } },
    select: { id: true, username: true, display_name: true },
  });
  const memberById = new Map(members.map((m) => [String(m.id), m]));

  // 该收款方式 × 平台 绑定的组员账号（实时绑定）
  const conns = await prisma.platform_connections.findMany({
    where: {
      user_id: { in: members.map((m) => m.id) },
      platform,
      payment_method_id: method.id,
      is_deleted: 0,
    },
    select: { id: true, user_id: true, account_name: true },
  });
  if (conns.length === 0) {
    return apiSuccess({ matchedDate: null, items: [], note: "该收款方式×平台当前没有组员账号绑定" });
  }
  const connById = new Map(conns.map((c) => [String(c.id), c]));

  // 到账日 ±WINDOW_DAYS 内的打款记录（应收口径：paid + processing）
  const center = new Date(`${dateStr}T00:00:00Z`);
  const from = new Date(center.getTime() - WINDOW_DAYS * 86400000);
  const to = new Date(center.getTime() + (WINDOW_DAYS + 1) * 86400000);
  const payments = await prisma.affiliate_payments.findMany({
    where: {
      platform,
      platform_connection_id: { in: conns.map((c) => c.id) },
      is_deleted: 0,
      status: { in: ["paid", "processing"] },
      request_date: { gte: from, lt: to },
    },
    select: {
      user_id: true, platform_connection_id: true,
      request_date: true, amount: true, gross_amount: true,
    },
  });
  if (payments.length === 0) {
    return apiSuccess({
      matchedDate: null, items: [],
      note: `到账日 ${dateStr} 前后 ${WINDOW_DAYS} 天内没有该收款方式×${platform} 的组员打款记录，可手动填写明细`,
    });
  }

  // 只取一天：优先到账日当天；否则取距离最近的那一天（并列取更早的）
  const byDay = new Map<string, typeof payments>();
  for (const p of payments) {
    const key = p.request_date!.toISOString().slice(0, 10);
    const arr = byDay.get(key) ?? [];
    arr.push(p);
    byDay.set(key, arr);
  }
  const centerTs = center.getTime();
  const matchedDate = byDay.has(dateStr)
    ? dateStr
    : [...byDay.keys()].sort((a, b) => {
        const da = Math.abs(new Date(`${a}T00:00:00Z`).getTime() - centerTs);
        const db = Math.abs(new Date(`${b}T00:00:00Z`).getTime() - centerTs);
        return da - db || a.localeCompare(b);
      })[0];
  const dayRows = byDay.get(matchedDate)!;

  // 打款日汇率：当日或其前最近的 CNY 快照（与月报实收CNY默认值口径一致）
  const snap = await prisma.exchange_rate_snapshots.findFirst({
    where: { currency: "CNY", date: { lte: new Date(`${matchedDate}T00:00:00Z`) } },
    orderBy: { date: "desc" },
    select: { rate_to_usd: true, date: true },
  });
  const usdToCny = snap && Number(snap.rate_to_usd) > 0 ? 1 / Number(snap.rate_to_usd) : 0;

  // 同账号同日多笔合并为一行
  const agg = new Map<string, { userId: string; account: string; usd: number }>();
  for (const p of dayRows) {
    const conn = connById.get(String(p.platform_connection_id));
    if (!conn) continue;
    const usd = paymentDisplayAmount(Number(p.amount || 0), p.gross_amount == null ? null : Number(p.gross_amount));
    const key = String(p.platform_connection_id);
    const cur = agg.get(key) ?? { userId: String(conn.user_id), account: (conn.account_name || "").trim(), usd: 0 };
    cur.usd += usd;
    agg.set(key, cur);
  }

  const items = [...agg.values()]
    .filter((x) => Math.abs(x.usd) >= 0.005)
    .map((x) => {
      const m = memberById.get(x.userId);
      return {
        userId: x.userId,
        username: m?.username || "",
        displayName: m?.display_name || m?.username || "",
        platform,
        account: x.account,
        amount: Math.round(x.usd * usdToCny * 100) / 100,
        usd: Math.round(x.usd * 100) / 100,
      };
    })
    .sort((a, b) => a.username.localeCompare(b.username));

  return apiSuccess({
    matchedDate,
    rate: { usdToCny: +usdToCny.toFixed(4), date: snap?.date.toISOString().slice(0, 10) || "" },
    items,
    note: matchedDate === dateStr
      ? `已按 ${matchedDate} 当天打款记录预填`
      : `到账日 ${dateStr} 当天无记录，已按最近的 ${matchedDate} 打款记录预填`,
  });
});
