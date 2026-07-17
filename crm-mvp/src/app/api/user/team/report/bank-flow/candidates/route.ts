import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { paymentDisplayAmount } from "@/lib/report-metrics";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report/bank-flow/candidates?methodId=&date=YYYY-MM-DD[&excludeId=]
 *
 * C-180 银行流水「手动添加」候选打款记录 —— 与 ./prefill 同一套口径
 * （账号归属按月快照文本匹配 + C-179 逐笔修正最优先、paid_date 日期口径、
 * gross 优先金额 × 打款日汇率折 CNY），差异是：
 * 1) **不限平台**：BSH+CG 一起提现时可以把另一个平台的批次勾进同一笔登记；
 * 2) **不限单日**：返回 ±WINDOW_DAYS 内全部逐笔打款单（payment_no 粒度），由组长自选；
 * 3) 已登记过的批次（条目级 source_date / 明细行级 sourceDate，按平台）标记 used，前端禁选。
 */

const WINDOW_DAYS = 5;

const normCard = (s: string | null | undefined) => (s || "").replace(/[\s-]/g, "");
const normPayee = (s: string | null | undefined) =>
  (s || "").replace(/（/g, "(").replace(/）/g, ")").replace(/\s/g, "");

export const GET = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");
  const teamId = BigInt(user.teamId);

  const sp = new URL(req.url).searchParams;
  const methodId = sp.get("methodId") || "";
  const dateStr = sp.get("date") || "";
  const excludeId = sp.get("excludeId") || "";
  if (!methodId) return apiError("缺少收款方式");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return apiError("date 格式必须为 YYYY-MM-DD");
  const month = dateStr.slice(0, 7);

  const method = await prisma.payment_methods.findFirst({
    where: { id: BigInt(methodId), team_id: teamId, is_deleted: 0 },
    select: { id: true, payee_name: true, pay_channel: true, card_no: true },
  });
  if (!method) return apiError("收款方式不存在");
  const methodPayeeText = method.pay_channel ? `${method.payee_name}(${method.pay_channel})` : method.payee_name;

  const members = await prisma.users.findMany({
    where: { team_id: teamId, is_deleted: 0, role: { not: "admin" } },
    select: { id: true, username: true, display_name: true },
  });
  const memberById = new Map(members.map((m) => [String(m.id), m]));
  const memberIds = members.map((m) => m.id);

  // ── 账号归属（全平台）：月快照文本匹配优先，无快照回退实时绑定（与 prefill 一致） ──
  const conns = await prisma.platform_connections.findMany({
    where: { user_id: { in: memberIds }, is_deleted: 0 },
    select: { id: true, user_id: true, platform: true, account_name: true, payment_method_id: true },
  });
  const snaps = await prisma.payment_binding_snapshots.findMany({
    where: { user_id: { in: memberIds }, month },
    select: { user_id: true, platform: true, account_name: true, payee_name: true, card_no: true },
  });
  const snapByKey = new Map(
    snaps.map((s) => [`${s.user_id}\u0000${s.platform}\u0000${(s.account_name || "").trim()}`, s]),
  );
  const matchedConnIds = new Set(
    conns
      .filter((c) => {
        const s = snapByKey.get(`${c.user_id}\u0000${c.platform}\u0000${(c.account_name || "").trim()}`);
        if (s && (s.payee_name || "").trim()) {
          if (normPayee(s.payee_name) !== normPayee(methodPayeeText)) return false;
          const mc = normCard(method.card_no);
          const sc = normCard(s.card_no);
          return !mc || !sc || mc === sc;
        }
        return c.payment_method_id === method.id;
      })
      .map((c) => String(c.id)),
  );
  const connById = new Map(conns.map((c) => [String(c.id), c]));

  // ── 已登记批次（本卡全部条目）：条目级 source_date + 明细行级 sourceDate，按平台记日 ──
  const existing = await prisma.bank_flow_entries.findMany({
    where: {
      team_id: teamId, payment_method_id: method.id, is_deleted: 0,
      ...(excludeId ? { id: { not: BigInt(excludeId) } } : {}),
    },
    select: { platform: true, source_date: true, txn_at: true, breakdown: true },
  });
  const usedDays = new Map<string, Set<string>>();
  const markUsed = (platform: string, day: string) => {
    let set = usedDays.get(platform);
    if (!set) { set = new Set(); usedDays.set(platform, set); }
    set.add(day);
  };
  for (const e of existing) {
    markUsed(e.platform, (e.source_date ?? e.txn_at).toISOString().slice(0, 10));
    try {
      const rows: { platform?: unknown; sourceDate?: unknown }[] = e.breakdown ? JSON.parse(e.breakdown) : [];
      if (Array.isArray(rows)) {
        for (const r of rows) {
          const sd = String(r?.sourceDate ?? "");
          if (/^\d{4}-\d{2}-\d{2}$/.test(sd)) markUsed(String(r?.platform || e.platform), sd);
        }
      }
    } catch { /* 脏数据跳过 */ }
  }

  // ── 到账日 ±WINDOW_DAYS 内全平台打款记录（paid + processing；按 paid_date） ──
  const center = new Date(`${dateStr}T00:00:00Z`);
  const from = new Date(center.getTime() - WINDOW_DAYS * 86400000);
  const to = new Date(center.getTime() + (WINDOW_DAYS + 1) * 86400000);
  const dateWindow = { gte: from, lt: to };
  const paymentsAll = await prisma.affiliate_payments.findMany({
    where: {
      user_id: { in: memberIds },
      is_deleted: 0,
      status: { in: ["paid", "processing"] },
      OR: [
        { paid_date: dateWindow },
        { paid_date: null, request_date: dateWindow },
      ],
    },
    select: {
      payment_no: true, platform: true, user_id: true, platform_connection_id: true,
      paid_date: true, request_date: true, amount: true, gross_amount: true,
      payment_method_id_override: true,
    },
  });

  // C-179 逐笔修正最优先（payment_no 在平台内唯一，键带平台防跨平台撞号）
  const overrideByNo = new Map<string, bigint>();
  for (const p of paymentsAll) {
    if (p.payment_method_id_override != null) overrideByNo.set(`${p.platform}\u0000${p.payment_no}`, p.payment_method_id_override);
  }
  const payments = paymentsAll.filter((p) => {
    const ov = overrideByNo.get(`${p.platform}\u0000${p.payment_no}`);
    if (ov != null) return ov === method.id;
    return p.platform_connection_id != null && matchedConnIds.has(String(p.platform_connection_id));
  });

  // 同一打款单多渠道行去重（优先取连接可解析的行）
  const uniq = new Map<string, (typeof payments)[number]>();
  for (const p of payments) {
    const key = `${p.platform}\u0000${p.payment_no}`;
    const cur = uniq.get(key);
    if (!cur || (!connById.has(String(cur.platform_connection_id)) && connById.has(String(p.platform_connection_id)))) {
      uniq.set(key, p);
    }
  }

  const rows = [...uniq.values()];
  if (rows.length === 0) {
    return apiSuccess({
      items: [],
      note: `到账日 ${dateStr} 前后 ${WINDOW_DAYS} 天内没有「${methodPayeeText}」名下任何平台的组员打款记录`,
    });
  }

  // 逐日汇率：打款日当日或其前最近的 CNY 快照（与 prefill 口径一致）
  const effDate = (p: (typeof rows)[number]) => (p.paid_date ?? p.request_date)!;
  const days = [...new Set(rows.map((p) => effDate(p).toISOString().slice(0, 10)))];
  const rateByDay = new Map<string, number>();
  for (const day of days) {
    const snap = await prisma.exchange_rate_snapshots.findFirst({
      where: { currency: "CNY", date: { lte: new Date(`${day}T00:00:00Z`) } },
      orderBy: { date: "desc" },
      select: { rate_to_usd: true },
    });
    rateByDay.set(day, snap && Number(snap.rate_to_usd) > 0 ? 1 / Number(snap.rate_to_usd) : 0);
  }

  const items = rows
    .map((p) => {
      const day = effDate(p).toISOString().slice(0, 10);
      const conn = connById.get(String(p.platform_connection_id));
      const m = memberById.get(conn ? String(conn.user_id) : String(p.user_id));
      const usd = paymentDisplayAmount(Number(p.amount || 0), p.gross_amount == null ? null : Number(p.gross_amount));
      const rate = rateByDay.get(day) ?? 0;
      return {
        paymentNo: p.payment_no,
        platform: p.platform,
        date: day,
        userId: conn ? String(conn.user_id) : String(p.user_id),
        username: m?.username || "",
        displayName: m?.display_name || m?.username || "",
        account: conn ? (conn.account_name || "").trim() : "(已删连接)",
        usd: Math.round(usd * 100) / 100,
        amount: Math.round(usd * rate * 100) / 100,
        used: usedDays.get(p.platform)?.has(day) ?? false,
      };
    })
    .filter((x) => Math.abs(x.usd) >= 0.005)
    .sort((a, b) => a.date.localeCompare(b.date) || a.platform.localeCompare(b.platform) || a.username.localeCompare(b.username));

  return apiSuccess({ items, note: null });
});
