import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { paymentDisplayAmount } from "@/lib/report-metrics";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report/bank-flow/prefill?methodId=&platform=&date=YYYY-MM-DD[&excludeId=]
 *
 * R-07 银行流水登记的员工明细预填 — 精确跟实际到账日期走：
 * 1) 日期口径用 paid_date（实际打款日）——组长登记的是银行到账日，
 *    request_date（打款单创建日）在 CG/LH 上往往早于实际到账，会查不到或查错批次；
 * 2) 账号归属逐账号判定：该月快照有该账号且收款人非空 → 按快照收款人+卡号文本匹配
 *    （龚建成/张文俊各自的卡只拉各自名下账号）；快照缺失或收款人为空 → 退回实时绑定
 *    payment_method_id（避免个别账号快照漏登导致整批少人）；
 *    C-179 逐笔修正（payment_method_id_override）最优先：被改到本卡的笔计入、
 *    被改走的笔剔除（治员工月中换绑串改历史笔归属）；
 * 3) 取到账日当天的打款记录；当天没有则取 ±WINDOW_DAYS 内最近且有记录的那一天
 *    （只取那一天，保证 6-16 / 6-18 两笔到账各自预填各自批次）；
 *    银行到账可能晚于平台打款日数天（实测 LH 平台 6-22 批次 6-18 就到账，
 *    也有反过来的），所以窗口双向找；
 * 4) 已登记过的批次不再重复预填：排除本卡×本平台现有条目的 source_date
 *    （编辑时用 excludeId 跳过自己）；
 * 5) 同一打款单在库内可能因多渠道连接存多行，按 payment_no 去重后再聚合；
 * 6) 金额 = 打款记录毛额(gross 优先) × 打款日当日或其前最近的汇率快照，折 CNY。
 */

const WINDOW_DAYS = 5;

/** 卡号归一化（去空格/横线）用于文本匹配 */
const normCard = (s: string | null | undefined) => (s || "").replace(/[\s-]/g, "");

/** 收款人文本归一化（全角括号转半角、去空格），兼容历史快照「张文俊（工商）」与新组合文本「张文俊(工商)」 */
const normPayee = (s: string | null | undefined) =>
  (s || "").replace(/（/g, "(").replace(/）/g, ")").replace(/\s/g, "");

export const GET = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");
  const teamId = BigInt(user.teamId);

  const sp = new URL(req.url).searchParams;
  const methodId = sp.get("methodId") || "";
  const platform = sp.get("platform") || "";
  const dateStr = sp.get("date") || "";
  const excludeId = sp.get("excludeId") || "";
  if (!methodId) return apiError("缺少收款方式");
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(platform)) return apiError("platform 无效");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return apiError("date 格式必须为 YYYY-MM-DD");
  const month = dateStr.slice(0, 7);

  const method = await prisma.payment_methods.findFirst({
    where: { id: BigInt(methodId), team_id: teamId, is_deleted: 0 },
    select: { id: true, payee_name: true, pay_channel: true, card_no: true },
  });
  if (!method) return apiError("收款方式不存在");
  // C-178：快照仍存组合文本「名字(打款方式)」，匹配时按组合文本比对
  const methodPayeeText = method.pay_channel ? `${method.payee_name}(${method.pay_channel})` : method.payee_name;

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

  // 逐账号判定归属：该月快照有该账号且收款人非空 → 按快照文本匹配；否则退回实时绑定
  const snapByKey = new Map(snaps.map((s) => [`${s.user_id}\u0000${(s.account_name || "").trim()}`, s]));
  const matchedConns = conns.filter((c) => {
    const s = snapByKey.get(`${c.user_id}\u0000${(c.account_name || "").trim()}`);
    if (s && (s.payee_name || "").trim()) {
      if (normPayee(s.payee_name) !== normPayee(methodPayeeText)) return false;
      const mc = normCard(method.card_no);
      const sc = normCard(s.card_no);
      return !mc || !sc || mc === sc;
    }
    return c.payment_method_id === method.id;
  });
  // C-179：账号没匹配上也不能提前返回——可能有逐笔修正指到本收款方式的打款记录
  const matchedConnIds = new Set(matchedConns.map((c) => String(c.id)));
  // 归属解析用全量团队连接（逐笔修正的笔可能挂在未匹配的连接上）
  const connById = new Map(conns.map((c) => [String(c.id), c]));

  // ── 已登记过的批次不再重复预填 ──
  // source_date 精确排除；旧数据（无 source_date）按其到账日兜底排除；
  // C-180：手动添加的明细行随行携带 sourceDate（可能与条目 source_date 不同批次），一并排除
  const existing = await prisma.bank_flow_entries.findMany({
    where: {
      team_id: teamId, payment_method_id: method.id, platform, is_deleted: 0,
      ...(excludeId ? { id: { not: BigInt(excludeId) } } : {}),
    },
    select: { source_date: true, txn_at: true, breakdown: true },
  });
  const usedDays = new Set(
    existing.map((e) => (e.source_date ?? e.txn_at).toISOString().slice(0, 10)),
  );
  for (const e of existing) {
    try {
      const rows: { platform?: unknown; sourceDate?: unknown }[] = e.breakdown ? JSON.parse(e.breakdown) : [];
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const sd = String(r?.sourceDate ?? "");
        if (/^\d{4}-\d{2}-\d{2}$/.test(sd) && String(r?.platform || platform) === platform) usedDays.add(sd);
      }
    } catch { /* 脏数据跳过 */ }
  }

  // ── 到账日 ±WINDOW_DAYS 内的打款记录（应收口径：paid + processing；按 paid_date） ──
  const center = new Date(`${dateStr}T00:00:00Z`);
  const from = new Date(center.getTime() - WINDOW_DAYS * 86400000);
  const to = new Date(center.getTime() + (WINDOW_DAYS + 1) * 86400000);
  const dateWindow = { gte: from, lt: to };
  const paymentsAll = await prisma.affiliate_payments.findMany({
    where: {
      platform,
      user_id: { in: memberIds },
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
      payment_method_id_override: true,
    },
  });

  // C-179：逐笔修正优先——同一 payment_no 任一渠道行带 override 即以 override 为准；
  // 被改到别的收款方式的笔从本卡预填剔除，被改到本卡的笔即使账号归属不匹配也计入。
  const overrideByNo = new Map<string, bigint>();
  for (const p of paymentsAll) {
    if (p.payment_method_id_override != null) overrideByNo.set(p.payment_no, p.payment_method_id_override);
  }
  const payments = paymentsAll.filter((p) => {
    const ov = overrideByNo.get(p.payment_no);
    if (ov != null) return ov === method.id;
    return p.platform_connection_id != null && matchedConnIds.has(String(p.platform_connection_id));
  });
  if (payments.length === 0) {
    return apiSuccess({
      matchedDate: null, items: [],
      note: `到账日 ${dateStr} 前后 ${WINDOW_DAYS} 天内没有「${methodPayeeText}」×${platform} 的组员打款记录（按实际打款日 paid_date，含逐笔修正归属），可手动填写明细`,
    });
  }

  // 同一打款单可能因多渠道连接在库内有多行 → 按 payment_no 去重（优先取连接可解析的行）
  const uniq = new Map<string, (typeof payments)[number]>();
  for (const p of payments) {
    const cur = uniq.get(p.payment_no);
    if (!cur || (!connById.has(String(cur.platform_connection_id)) && connById.has(String(p.platform_connection_id)))) {
      uniq.set(p.payment_no, p);
    }
  }

  // 只取一天：优先到账日当天；否则取距离最近的那一天（并列取更早的）。
  // 已登记过的批次日剔除，避免同一批打款被重复预填。
  const effDate = (p: (typeof payments)[number]) => (p.paid_date ?? p.request_date)!;
  const byDay = new Map<string, (typeof payments)[number][]>();
  const skippedUsed: string[] = [];
  for (const p of uniq.values()) {
    const key = effDate(p).toISOString().slice(0, 10);
    if (usedDays.has(key)) {
      if (!skippedUsed.includes(key)) skippedUsed.push(key);
      continue;
    }
    const arr = byDay.get(key) ?? [];
    arr.push(p);
    byDay.set(key, arr);
  }
  if (byDay.size === 0) {
    return apiSuccess({
      matchedDate: null, items: [],
      note: `到账日 ${dateStr} 前后 ${WINDOW_DAYS} 天内的打款批次（${skippedUsed.sort().join("、")}）都已登记过，不再重复预填；如需补录请手动填写明细`,
    });
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

  // 同账号同日多笔合并为一行（逐笔修正的笔连接可能已删，按 user_id 兜底归属）
  const agg = new Map<string, { userId: string; account: string; usd: number }>();
  for (const p of dayRows) {
    const conn = connById.get(String(p.platform_connection_id));
    const usd = paymentDisplayAmount(Number(p.amount || 0), p.gross_amount == null ? null : Number(p.gross_amount));
    const key = conn ? String(p.platform_connection_id) : `u${p.user_id}`;
    const cur = agg.get(key) ?? {
      userId: conn ? String(conn.user_id) : String(p.user_id),
      account: conn ? (conn.account_name || "").trim() : "(已删连接)",
      usd: 0,
    };
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

  const skipNote = skippedUsed.length > 0 ? `（已登记过的批次 ${skippedUsed.sort().join("、")} 已跳过）` : "";
  return apiSuccess({
    matchedDate,
    rate: { usdToCny: +usdToCny.toFixed(4), date: snap?.date.toISOString().slice(0, 10) || "" },
    items,
    note: (matchedDate === dateStr
      ? `已按 ${matchedDate} 当天实际打款记录预填`
      : `到账日 ${dateStr} 当天无打款记录，已按最近的 ${matchedDate} 批次预填`) + skipNote,
  });
});
