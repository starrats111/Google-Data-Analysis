import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { resolveBankFlowScope, scopeEntryWhere } from "@/lib/bank-flow-scope";
import ExcelJS from "exceljs";
import {
  buildBankStatementSheet, buildPayeeStatementSheet,
  buildYearOverviewSheet, buildYearMonthDetailSheet, entryCurrency,
  type BankFlowExportMethod, type BankFlowExportEntry, type BankFlowYearEntry, type FlowCurrency,
} from "@/lib/bank-flow-xlsx";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report/bank-flow/export?month=YYYY-MM[&methodId=]
 * GET /api/user/team/report/bank-flow/export?year=YYYY          （D-287 年度导出）
 * 导出银行流水（C-179 精简为每收款人一张 sheet）：
 * - 整体导出：每个收款人一张「账户交易明细清单」合并流水单（该人所有卡/渠道入账合并、
 *   带打款方式(卡号)列、期初余额=各卡合计逐笔滚动）
 * - methodId 指定时（单卡导出按钮）：仍导出该卡单独一张流水单
 * - year 指定时：一个工作簿 = 「年度总览」（12 个月 × 各收款人到账合计）+ 有到账的
 *   月份各一张逐笔明细（含收款人列），供财务全年上报
 */
export const GET = withUser(async (req: NextRequest, { user }) => {
  // D-275.1 双口径：组长=团队卡全量；组员=只导自己的自填卡
  const scope = await resolveBankFlowScope(user);
  if (!scope) return new NextResponse("未关联小组", { status: 400 });
  const { searchParams } = new URL(req.url);
  const yearParam = searchParams.get("year");
  const month = searchParams.get("month") || "";
  const methodIdParam = searchParams.get("methodId");
  if (yearParam) {
    if (!/^\d{4}$/.test(yearParam)) return new NextResponse("year 格式必须为 YYYY", { status: 400 });
  } else if (!/^\d{4}-\d{2}$/.test(month)) {
    return new NextResponse("month 格式必须为 YYYY-MM", { status: 400 });
  }
  // 年度导出按 month 前缀取全年条目；月度导出精确匹配
  const monthWhere = yearParam ? { startsWith: `${yearParam}-` } : month;

  const entryWhere = await scopeEntryWhere(scope);
  const [methodRows, entryRows, openings] = await Promise.all([
    prisma.payment_methods.findMany({
      where: { ...scope.methodWhere, is_deleted: 0, ...(methodIdParam ? { id: BigInt(methodIdParam) } : {}) },
      orderBy: { created_at: "asc" },
      select: { id: true, payee_name: true, pay_channel: true, card_no: true },
    }),
    prisma.bank_flow_entries.findMany({
      where: {
        ...entryWhere, month: monthWhere, is_deleted: 0,
        ...(methodIdParam ? { payment_method_id: BigInt(methodIdParam) } : {}),
      },
      orderBy: { txn_at: "asc" },
    }),
    yearParam
      ? Promise.resolve([])
      : prisma.report_overrides.findMany({
          where: { user_id: scope.userId, month, scope_key: { startsWith: "bank_open:" }, is_deleted: 0 },
          select: { scope_key: true, value: true },
        }),
  ]);
  if (methodRows.length === 0) return new NextResponse("暂无收款方式", { status: 404 });

  const openMap = new Map(openings.map((o) => [o.scope_key.slice("bank_open:".length), Number(o.value)]));
  const methods: BankFlowExportMethod[] = methodRows.map((m) => ({
    id: String(m.id),
    payeeName: m.payee_name,
    payChannel: m.pay_channel,
    cardNo: m.card_no,
    openingBalance: openMap.get(String(m.id)) ?? null,
  }));
  const rawEntries: (BankFlowExportEntry & { month: string })[] = entryRows.map((e) => {
    let breakdown: BankFlowExportEntry["breakdown"] = [];
    try { breakdown = e.breakdown ? JSON.parse(e.breakdown) : []; } catch { /* 脏数据容错 */ }
    return {
      id: String(e.id),
      month: e.month,
      paymentMethodId: String(e.payment_method_id),
      txnAt: e.txn_at,
      platform: e.platform,
      txnGroup: e.txn_group,
      counterparty: e.counterparty,
      summary: e.summary,
      amount: Number(e.amount),
      currency: e.currency,
      expectedAmount: Number(e.expected_amount),
      fee: Number(e.fee),
      breakdown,
      remark: e.remark || "",
    };
  });

  // C-180：同一笔银行到账按平台拆分的条目（同卡同 txn_group）导出时合并回一行，
  // 与真实银行流水一致（银行只到账一笔总额）
  const entries: (BankFlowExportEntry & { month: string })[] = [];
  const grouped = new Map<string, BankFlowExportEntry & { month: string }>();
  for (const e of rawEntries) {
    if (!e.txnGroup) {
      entries.push(e);
      continue;
    }
    const key = `${e.paymentMethodId}\u0000${e.txnGroup}`;
    const cur = grouped.get(key);
    if (!cur) {
      const merged = { ...e, breakdown: [...e.breakdown] };
      grouped.set(key, merged);
      entries.push(merged);
      continue;
    }
    cur.amount = Math.round((cur.amount + e.amount) * 100) / 100;
    cur.expectedAmount = Math.round((cur.expectedAmount + e.expectedAmount) * 100) / 100;
    cur.fee = Math.round((cur.fee + e.fee) * 100) / 100;
    cur.breakdown.push(...e.breakdown);
    if (!cur.platform.split("+").includes(e.platform)) cur.platform = `${cur.platform}+${e.platform}`;
    if (e.txnAt < cur.txnAt) cur.txnAt = e.txnAt;
    if (!cur.counterparty && e.counterparty) cur.counterparty = e.counterparty;
    if (e.remark && !cur.remark.includes(e.remark)) cur.remark = cur.remark ? `${cur.remark}；${e.remark}` : e.remark;
  }
  entries.sort((a, b) => a.txnAt.getTime() - b.txnAt.getTime());

  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM System";
  wb.created = new Date();

  const payeeOfMethod = (m: BankFlowExportMethod) => m.payeeName.replace(/[（(].*$/, "").trim() || m.payeeName;

  // D-314：一张表只放一种币（美金不折人民币，混在一起余额没法滚）。
  // 人民币表照旧先出，有美金到账时再各出一张 (USD) 表；没有美金就跟改动前一模一样。
  const currenciesOf = (es: BankFlowExportEntry[]): FlowCurrency[] => {
    const list: FlowCurrency[] = [];
    if (es.length === 0 || es.some((e) => entryCurrency(e) === "CNY")) list.push("CNY"); // 无到账也出人民币空表（原行为）
    if (es.some((e) => entryCurrency(e) === "USD")) list.push("USD");
    return list;
  };
  const ofCur = <T extends BankFlowExportEntry>(es: T[], cur: FlowCurrency) => es.filter((e) => entryCurrency(e) === cur);

  if (yearParam) {
    // D-287 年度导出：年度总览 + 有到账的月份各一张明细
    const methodById = new Map(methods.map((m) => [m.id, m]));
    const yearEntries: BankFlowYearEntry[] = entries.map((e) => {
      const m = methodById.get(e.paymentMethodId);
      return { ...e, payee: m ? payeeOfMethod(m) : "—" };
    });
    // 收款人列顺序按收款方式创建先后；仅全年有到账的出列（无到账收款人不出空列）
    const payeeOrder = [...new Set(methods.map(payeeOfMethod))];
    // D-314：币种各出一套（总览 + 该币种有到账的月份明细），人民币在前
    for (const cur of currenciesOf(yearEntries)) {
      const curEntries = ofCur(yearEntries, cur);
      const withData = new Set(curEntries.map((e) => e.payee));
      let payees = payeeOrder.filter((p) => withData.has(p));
      if (payees.length === 0) payees = payeeOrder; // 全年无到账：仍出全员空总览
      buildYearOverviewSheet(wb, yearParam, payees, curEntries, cur);
      const monthsWithData = [...new Set(curEntries.map((e) => e.month))].sort();
      for (const ym of monthsWithData) {
        buildYearMonthDetailSheet(
          wb, yearParam, Number(ym.slice(5)), payees, methods,
          curEntries.filter((e) => e.month === ym), cur,
        );
      }
    }
  } else if (methodIdParam) {
    // 单卡导出：该卡单独一张流水单（D-314：该卡收过美金则美金另出一张）
    const m = methods[0];
    const cardEntries = entries.filter((e) => e.paymentMethodId === m.id);
    const base = `${m.payeeName}${m.payChannel ? "-" + m.payChannel : ""}${m.cardNo ? "-" + m.cardNo.slice(-4) : ""}`;
    for (const cur of currenciesOf(cardEntries)) {
      buildBankStatementSheet(
        wb, month, m, ofCur(cardEntries, cur),
        `${base.slice(0, cur === "CNY" ? 28 : 22)}${cur === "USD" ? "(USD)" : ""}`, cur,
      );
    }
  } else {
    // C-179：每收款人一张合并流水单（该人所有卡/渠道入账合并）
    // C-178 后 payee_name 已是纯名字；去括号逻辑兼容未迁移的旧文本
    const used = new Set<string>();
    const payeeOf = payeeOfMethod;
    const payees = [...new Set(methods.map(payeeOf))];
    for (const payee of payees) {
      const payeeMethods = methods.filter((m) => payeeOf(m) === payee);
      const methodIds = new Set(payeeMethods.map((m) => m.id));
      const payeeEntries = entries.filter((e) => methodIds.has(e.paymentMethodId));
      if (payeeEntries.length === 0 && payees.length > 1) continue; // 该收款人本月无到账则不出空表
      // D-314：同一个收款人的人民币卡与香港美金卡各出一张表，两种钱不滚进同一个余额
      for (const cur of currenciesOf(payeeEntries)) {
        const suffix = cur === "USD" ? "(USD)" : "";
        let name = `${payee.slice(0, 28 - suffix.length)}${suffix}`;
        let i = 2;
        while (used.has(name)) name = `${payee.slice(0, 24 - suffix.length)}${suffix}(${i++})`;
        used.add(name);
        buildPayeeStatementSheet(wb, month, payee, payeeMethods, ofCur(payeeEntries, cur), name, cur);
      }
    }
    if (wb.worksheets.length === 0) {
      // 全部收款人本月都无到账：仍给每人一张空表，避免空 workbook
      for (const payee of payees) {
        buildPayeeStatementSheet(wb, month, payee, methods.filter((m) => payeeOf(m) === payee), [], payee.slice(0, 28));
      }
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const filename = encodeURIComponent(
    yearParam
      ? `银行流水-${yearParam}年度.xlsx`
      : `银行流水-${month}${methodIdParam ? `-${methods[0].payeeName}${methods[0].payChannel ? `(${methods[0].payChannel})` : ""}` : ""}.xlsx`,
  );
  return new NextResponse(new Uint8Array(buffer as ArrayBuffer), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
    },
  });
});
