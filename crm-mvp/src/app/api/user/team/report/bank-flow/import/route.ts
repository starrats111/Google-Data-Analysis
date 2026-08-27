import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import * as XLSX from "xlsx";
import { paymentDisplayAmount } from "@/lib/report-metrics";
import { resolveBankFlowScope, scopeMembers, scopeEntryWhere } from "@/lib/bank-flow-scope";
import {
  parseBankSheet, matchBankRows, SPLIT_WINDOW_DAYS,
  type ImportMethod, type ImportPayment, type ParsedSheet,
  type ExistingEntry, type ExistingBreakdownItem,
} from "@/lib/bank-flow-import";

export const dynamic = "force-dynamic";

/**
 * D-279 银行流水导入财务月表 — 解析 + 金额比对，返回预览提案，**不写库**。
 * 入库由前端按用户勾选逐条走既有 POST /api/user/team/report/bank-flow
 * （复用 C-180 混平台拆分、D-274.1 手续费不为负、breakdown.sourceDate 防重复预填的全部既有逻辑）。
 *
 * POST multipart/form-data：file（财务 xls/xlsx）
 *
 * 数据通道：零新增 API 读取——候选打款单读库内 affiliate_payments（正式同步流程入库），
 * 汇率读 exchange_rate_snapshots，归属口径与 prefill/candidates 完全一致
 * （月快照文本匹配 + C-179 逐笔修正最优先 + payment_no 去重 + gross 优先折 CNY）。
 */

const normCard = (s: string | null | undefined) => (s || "").replace(/[\s-]/g, "");
const normPayee = (s: string | null | undefined) =>
  (s || "").replace(/（/g, "(").replace(/）/g, ")").replace(/\s/g, "");

export const POST = withUser(async (req: NextRequest, { user }) => {
  const scope = await resolveBankFlowScope(user);
  if (!scope) return apiError("未关联小组");
  const teamId = scope.teamId;

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return apiError("请求格式错误，需要 multipart/form-data");
  }
  const file = formData.get("file") as File | null;
  if (!file) return apiError("请上传财务月表文件（xls/xlsx）");
  if (file.size > 10 * 1024 * 1024) return apiError("文件过大（>10MB），请确认是财务月表");

  // ── 解析 ──
  let sheets: ParsedSheet[] = [];
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buf, { type: "buffer" });
    for (const name of wb.SheetNames) {
      const data = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: false, defval: null });
      const parsed = parseBankSheet(name.trim(), data as unknown[][]);
      if (parsed) sheets.push(parsed);
    }
  } catch (e) {
    return apiError(`表格解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  sheets = sheets.filter((s) => s.rows.length > 0);
  // D-290：按投手分摊的明细表不是银行流水，解析出来只为了在预览里说明「这张跳过了」
  const detailSheets = sheets.filter((s) => s.kind === "detail");
  sheets = sheets.filter((s) => s.kind === "flow");
  if (sheets.length === 0) {
    return apiError(
      detailSheets.length > 0
        ? `只解析到按投手分摊的明细表（${detailSheets.map((s) => s.name).join("、")}），里面不是银行到账金额，本次不做任何改动`
        : "没有解析到任何到账行（需要含「时间 / 收款人户名 / 人民币」列的表头），本次不做任何改动",
    );
  }

  // ── 基础数据 ──
  const methodRows = await prisma.payment_methods.findMany({
    where: { ...scope.methodWhere, is_deleted: 0 },
    select: { id: true, payee_name: true, pay_channel: true, card_no: true },
  });
  const methods: ImportMethod[] = methodRows.map((m) => ({
    id: String(m.id), payeeName: m.payee_name, payChannel: m.pay_channel, cardNo: m.card_no,
  }));
  if (methods.length === 0) return apiError("尚未维护收款方式，请先到「小组设置」添加收款人和卡号");

  const members = await scopeMembers(scope);
  const memberById = new Map(members.map((m) => [String(m.id), m]));
  const memberIds = members.map((m) => m.id);

  // 全部到账行的日期范围 ± 拆分窗口
  const allDates = sheets.flatMap((s) => s.rows.map((r) => r.date)).sort();
  const from = new Date(Date.parse(allDates[0]) - SPLIT_WINDOW_DAYS * 86400000);
  const to = new Date(Date.parse(allDates[allDates.length - 1]) + (SPLIT_WINDOW_DAYS + 1) * 86400000);
  const dateWindow = { gte: from, lt: to };

  // ── 打款单（与 candidates 同口径） ──
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

  const conns = await prisma.platform_connections.findMany({
    where: { user_id: { in: memberIds }, is_deleted: 0 },
    select: { id: true, user_id: true, platform: true, account_name: true, payment_method_id: true },
  });
  const connById = new Map(conns.map((c) => [String(c.id), c]));

  // 打款日覆盖到的全部月份的绑定快照
  const effDate = (p: (typeof paymentsAll)[number]) => (p.paid_date ?? p.request_date)!;
  const monthsNeeded = [...new Set(paymentsAll.map((p) => effDate(p).toISOString().slice(0, 7)))];
  const snaps = monthsNeeded.length > 0
    ? await prisma.payment_binding_snapshots.findMany({
        where: { user_id: { in: memberIds }, month: { in: monthsNeeded } },
        select: { user_id: true, month: true, platform: true, account_name: true, payee_name: true, card_no: true },
      })
    : [];
  const snapByKey = new Map(
    snaps.map((s) => [`${s.user_id}\u0000${s.month}\u0000${s.platform}\u0000${(s.account_name || "").trim()}`, s]),
  );

  const methodIdSet = new Set(methods.map((m) => m.id));
  const methodTextById = new Map(
    methodRows.map((m) => [
      String(m.id),
      normPayee(m.pay_channel ? `${m.payee_name}(${m.pay_channel})` : m.payee_name),
    ]),
  );

  /** 连接 → 收款方式归属（月粒度，与 prefill/candidates 的判定完全一致，泛化为多卡版本） */
  const connMethodCache = new Map<string, string | null>();
  const connMethodOf = (connId: string, month: string): string | null => {
    const ck = `${connId}\u0000${month}`;
    const cached = connMethodCache.get(ck);
    if (cached !== undefined) return cached;
    const conn = connById.get(connId);
    let result: string | null = null;
    if (conn) {
      const realtime = conn.payment_method_id != null && methodIdSet.has(String(conn.payment_method_id))
        ? String(conn.payment_method_id) : null;
      const s = snapByKey.get(`${conn.user_id}\u0000${month}\u0000${conn.platform}\u0000${(conn.account_name || "").trim()}`);
      if (s && (s.payee_name || "").trim()) {
        const snapPayee = normPayee(s.payee_name);
        const withCard = methodRows.filter((m) => {
          if (methodTextById.get(String(m.id)) !== snapPayee) return false;
          const mc = normCard(m.card_no);
          const sc = normCard(s.card_no);
          return !mc || !sc || mc === sc;
        });
        if (withCard.length >= 1) {
          result = String(withCard[0].id);
        } else if (!snapPayee.includes("(")) {
          // 老格式裸名快照：渠道未知，回退实时绑定（2026-08-24 修正口径）
          const rb = realtime ? methodRows.find((m) => String(m.id) === realtime) : null;
          result = rb && normPayee(rb.payee_name) === snapPayee ? realtime : null;
        } else {
          result = null; // 快照明确指向本口径没有的卡
        }
      } else {
        result = realtime;
      }
    }
    connMethodCache.set(ck, result);
    return result;
  };

  // C-179 逐笔修正最优先（payment_no 平台内唯一）
  const overrideByNo = new Map<string, bigint>();
  for (const p of paymentsAll) {
    if (p.payment_method_id_override != null) {
      overrideByNo.set(`${p.platform}\u0000${p.payment_no}`, p.payment_method_id_override);
    }
  }

  // 同一打款单多渠道行去重（优先取连接可解析的行）
  const uniq = new Map<string, (typeof paymentsAll)[number]>();
  for (const p of paymentsAll) {
    const key = `${p.platform}\u0000${p.payment_no}`;
    const cur = uniq.get(key);
    if (!cur || (!connById.has(String(cur.platform_connection_id)) && connById.has(String(p.platform_connection_id)))) {
      uniq.set(key, p);
    }
  }

  // 逐日汇率（打款日当日或其前最近的 CNY 快照）
  const days = [...new Set([...uniq.values()].map((p) => effDate(p).toISOString().slice(0, 10)))];
  const rateByDay = new Map<string, number>();
  for (const day of days) {
    const snap = await prisma.exchange_rate_snapshots.findFirst({
      where: { currency: "CNY", date: { lte: new Date(`${day}T00:00:00Z`) } },
      orderBy: { date: "desc" },
      select: { rate_to_usd: true },
    });
    rateByDay.set(day, snap && Number(snap.rate_to_usd) > 0 ? 1 / Number(snap.rate_to_usd) : 0);
  }

  const payments: ImportPayment[] = [];
  for (const p of uniq.values()) {
    const day = effDate(p).toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const ov = overrideByNo.get(`${p.platform}\u0000${p.payment_no}`);
    let methodId: string | null;
    if (ov != null) {
      methodId = methodIdSet.has(String(ov)) ? String(ov) : null;
    } else {
      methodId = p.platform_connection_id != null ? connMethodOf(String(p.platform_connection_id), month) : null;
    }
    if (!methodId) continue;
    const usd = paymentDisplayAmount(Number(p.amount || 0), p.gross_amount == null ? null : Number(p.gross_amount));
    if (Math.abs(usd) < 0.005) continue;
    const conn = connById.get(String(p.platform_connection_id));
    const m = memberById.get(conn ? String(conn.user_id) : String(p.user_id));
    const rate = rateByDay.get(day) ?? 0;
    payments.push({
      paymentKey: `${p.platform}\u0000${p.payment_no}`,
      platform: p.platform,
      date: day,
      methodId,
      userId: conn ? String(conn.user_id) : String(p.user_id),
      username: m?.username || "",
      displayName: m?.display_name || m?.username || "",
      account: conn ? (conn.account_name || "").trim() : "(已删连接)",
      usd: Math.round(usd * 100) / 100,
      cny: Math.round(usd * rate * 100) / 100,
    });
  }

  // ── 既有条目：已登记批次防重复 + 「已录过」判定 ──
  const entryWhere = await scopeEntryWhere(scope);
  const existing = await prisma.bank_flow_entries.findMany({
    where: { ...entryWhere, team_id: teamId, is_deleted: 0 },
    select: {
      id: true, payment_method_id: true, platform: true, txn_group: true, source_date: true, txn_at: true,
      amount: true, expected_amount: true, fee: true, breakdown: true,
    },
  });
  const channelOf = new Map(methodRows.map((m) => [String(m.id), m.pay_channel || ""]));
  const usedBatchKeys = new Set<string>();
  // C-180：同一笔银行到账拆分出的多条目（共享 txn_group）合并回一笔再比金额，否则拆分条目对不上到账行
  const groupAgg = new Map<string, ExistingEntry>();
  const existingEntries: ExistingEntry[] = [];
  for (const e of existing) {
    const mid = String(e.payment_method_id);
    usedBatchKeys.add(`${mid}\u0000${e.platform}\u0000${(e.source_date ?? e.txn_at).toISOString().slice(0, 10)}`);
    try {
      const rows: { platform?: unknown; sourceDate?: unknown }[] = e.breakdown ? JSON.parse(e.breakdown) : [];
      if (Array.isArray(rows)) {
        for (const r of rows) {
          const sd = String(r?.sourceDate ?? "");
          if (/^\d{4}-\d{2}-\d{2}$/.test(sd)) usedBatchKeys.add(`${mid}\u0000${String(r?.platform || e.platform)}\u0000${sd}`);
        }
      }
    } catch { /* 脏数据跳过 */ }
    // D-290：条目明细与费率一并带上，供「按银行拆分」把人精确落到各笔到账
    let bd: ExistingBreakdownItem[] = [];
    try {
      const parsed = e.breakdown ? JSON.parse(e.breakdown) : [];
      if (Array.isArray(parsed)) bd = parsed as ExistingBreakdownItem[];
    } catch { /* 脏数据：明细置空，拆分提案自然不会出 */ }
    const item: ExistingEntry = {
      ids: [String(e.id)],
      methodId: mid,
      payChannel: channelOf.get(mid) ?? "",
      amount: Number(e.amount),
      txnDate: e.txn_at.toISOString().slice(0, 10),
      expected: Number(e.expected_amount),
      fee: Number(e.fee),
      breakdown: bd,
      splittable: true,
    };
    if (e.txn_group) {
      // C-180 同组的多条合并成一项比金额；组条目已按平台拆过，不再按银行拆
      const g = groupAgg.get(e.txn_group);
      if (g) {
        g.amount = Math.round((g.amount + item.amount) * 100) / 100;
        g.expected = Math.round((g.expected + item.expected) * 100) / 100;
        g.fee = Math.round((g.fee + item.fee) * 100) / 100;
        g.ids.push(...item.ids);
        g.breakdown.push(...item.breakdown);
        if (item.txnDate < g.txnDate) g.txnDate = item.txnDate;
      } else {
        groupAgg.set(e.txn_group, { ...item, splittable: false });
      }
    } else {
      existingEntries.push(item);
    }
  }
  existingEntries.push(...groupAgg.values());

  // ── 逐 sheet 匹配（sheet 之间互不影响：2-5月工作簿常含「逐人视图」与「逐笔视图」两张冗余表） ──
  const methodLabel = (id: string | null) => {
    if (!id) return null;
    const m = methods.find((x) => x.id === id);
    return m ? `${m.payeeName}${m.payChannel ? `(${m.payChannel})` : ""} ${m.cardNo || ""}`.trim() : null;
  };
  const resultSheets = sheets.map((s) => {
    const proposals = matchBankRows({ rows: s.rows, methods, payments, usedBatchKeys, existingEntries });
    const stats = { auto: 0, review: 0, exists: 0, unmatched: 0, usd: 0, no_method: 0, date_fix: 0, split_existing: 0 };
    for (const p of proposals) stats[p.status]++;
    return {
      name: s.name,
      rowCount: s.rows.length,
      skipped: s.skipped,
      stats,
      proposals: proposals.map((p) => ({
        ...p,
        methodLabel: methodLabel(p.methodId),
        rows: p.rows.map((r) => ({
          rowNo: r.rowNo, date: r.date, payee: r.payee, acct: r.acct,
          cny: r.cny, usd: r.usd, note: r.note,
        })),
      })),
    };
  });

  return apiSuccess({
    sheets: resultSheets,
    // D-290：跳过的按人分摊明细表如实告知，避免 07 以为漏读了一张
    skippedSheets: detailSheets.map((s) => ({ name: s.name, rowCount: s.rows.length, reason: s.detailReason ?? "" })),
    note: "以上为金额比对结果预览，尚未入库；勾选确认后才会写入银行流水",
  });
});
