import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { paymentDisplayAmount } from "@/lib/report-metrics";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report/bank-flow/prefill?methodId=&platform=&date=YYYY-MM-DD
 *
 * R-07 银行流水登记的员工明细预填 — 精确跟实际到账日期走：
 * 1) 日期口径用 paid_date（实际打款日）——组长登记的是银行到账日，
 *    request_date（打款单创建日）在 CG/LH 上往往早于实际到账，会查不到或查错批次；
 * 2) 账号归属与月度报表同口径：优先用该月 payment_binding_snapshots 的
 *    收款人+卡号文本匹配（龚建成/张文俊各自的卡只拉各自名下账号），
 *    该月无快照时回退到实时绑定 payment_method_id；
 * 3) 取到账日当天的打款记录；当天没有则取 ±5 天内最近且有记录的那一天（只取那一天，
 *    保证 6-16 / 6-18 两笔到账各自预填各自批次）；
 * 4) 同一打款单在库内可能因多渠道连接存多行，按 payment_no 去重后再聚合；
 * 5) 金额 = 打款记录毛额(gross 优先) × 打款日当日或其前最近的汇率快照，折 CNY。
 */

const WINDOW_DAYS = 5;

/** 卡号归一化（去空格/横线）用于文本匹配 */
const normCard = (s: string | null | undefined) => (s || "").replace(/[\s-]/g, "");

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
  const month = dateStr.slice(0, 7);

  const method = await prisma.payment_methods.findFirst({
    where: { id: BigInt(methodId), team_id: teamId, is_deleted: 0 },
    select: { id: true, payee_name: true, card_no: true },
  });
  if (!method) return apiError("收款方式不存在");

  const members = await prisma.users.findMany({
    where: { team_id: teamId, is_deleted: 0, role: { not: "admin" } },
    select: { id: true, username: true, display_name: true },
  });
  const memberById = new Map(members.map((m) => [String(m.id), m]));
  const memberIds = members.map((m) => m.id);

  // ── 账号归属：月快照文本匹配优先（与月度报表口径一致），无快照回退实时绑定 ──
  const conns = await prisma.platform_connections.findMany({
    where: { user_id: { in: memberIds }, platform, is_deleted: 0 },
    select: { id: true, user_id: true, account_name: true, payment_method_id: true },
  });
  const snaps = await prisma.payment_binding_snapshots.findMany({
    where: { user_id: { in: memberIds }, month, platform },
    select: { user_id: true, account_name: true, payee_name: true, card_no: true },
  });

  let matchedConns: typeof conns;
  let attribution: string;
  if (snaps.length > 0) {
    // 快照匹配：收款人同名，且卡号（双方都有时）一致
    const wanted = new Set(
      snaps
        .filter((s) => {
          if ((s.payee_name || "").trim() !== (method.payee_name || "").trim()) return false;
          const mc = normCard(method.card_no);
          const sc = normCard(s.card_no);
          return !mc || !sc || mc === sc;
        })
        .map((s) => `${s.user_id}\u0000${(s.account_name || "").trim()}`),
    );
    matchedConns = conns.filter((c) => wanted.has(`${c.user_id}\u0000${(c.account_name || "").trim()}`));
    attribution = "月快照";
  } else {
    matchedConns = conns.filter((c) => c.payment_method_id === method.id);
    attribution = "实时绑定";
  }
  if (matchedConns.length === 0) {
    return apiSuccess({
      matchedDate: null, items: [],
      note: `${month} 没有归属「${method.payee_name}」×${platform} 的组员账号（按${attribution}判定），可手动填写明细`,
    });
  }
  const connById = new Map(matchedConns.map((c) => [String(c.id), c]));

  // ── 到账日 ±WINDOW_DAYS 内的打款记录（应收口径：paid + processing；按 paid_date） ──
  const center = new Date(`${dateStr}T00:00:00Z`);
  const from = new Date(center.getTime() - WINDOW_DAYS * 86400000);
  const to = new Date(center.getTime() + (WINDOW_DAYS + 1) * 86400000);
  const dateWindow = { gte: from, lt: to };
  const payments = await prisma.affiliate_payments.findMany({
    where: {
      platform,
      platform_connection_id: { in: matchedConns.map((c) => c.id) },
      is_deleted: 0,
      status: { in: ["paid", "processing"] },
      OR: [
        { paid_date: dateWindow },
        { paid_date: null, request_date: dateWindow }, // 个别平台无实际打款日时退用创建日
      ],
    },
    select: {
      payment_no: true, user_id: true, platform_connection_id: true,
      paid_date: true, request_date: true, amount: true, gross_amount: true,
    },
  });
  if (payments.length === 0) {
    return apiSuccess({
      matchedDate: null, items: [],
      note: `到账日 ${dateStr} 前后 ${WINDOW_DAYS} 天内没有「${method.payee_name}」×${platform} 的组员打款记录（按实际打款日 paid_date），可手动填写明细`,
    });
  }

  // 同一打款单可能因多渠道连接在库内有多行 → 按 payment_no 去重
  const uniq = new Map<string, (typeof payments)[number]>();
  for (const p of payments) {
    if (!uniq.has(p.payment_no)) uniq.set(p.payment_no, p);
  }

  // 只取一天：优先到账日当天；否则取距离最近的那一天（并列取更早的）
  const effDate = (p: (typeof payments)[number]) => (p.paid_date ?? p.request_date)!;
  const byDay = new Map<string, (typeof payments)[number][]>();
  for (const p of uniq.values()) {
    const key = effDate(p).toISOString().slice(0, 10);
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
      ? `已按 ${matchedDate} 当天实际打款记录预填`
      : `到账日 ${dateStr} 当天无打款记录，已按最近的 ${matchedDate} 预填`,
  });
});
