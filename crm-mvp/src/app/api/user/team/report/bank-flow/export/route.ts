import { NextRequest, NextResponse } from "next/server";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import ExcelJS from "exceljs";
import {
  buildBankStatementSheet, buildBankReconSheet,
  type BankFlowExportMethod, type BankFlowExportEntry,
} from "@/lib/bank-flow-xlsx";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report/bank-flow/export?month=YYYY-MM[&methodId=]
 * 导出银行流水：每个收款方式一张正规「账户交易明细清单」sheet +
 * 按实际收款人（去掉括号里的银行标注归并，如 龚建成(农业)/龚建成(WISE) → 龚建成）
 * 各一张「打款对账明细」sheet。methodId 指定时只导出该收款方式。
 */
export const GET = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return new NextResponse("未关联小组", { status: 400 });
  const teamId = BigInt(user.teamId);
  const { searchParams } = new URL(req.url);
  const month = searchParams.get("month") || "";
  const methodIdParam = searchParams.get("methodId");
  if (!/^\d{4}-\d{2}$/.test(month)) return new NextResponse("month 格式必须为 YYYY-MM", { status: 400 });

  const [methodRows, entryRows, openings] = await Promise.all([
    prisma.payment_methods.findMany({
      where: { team_id: teamId, is_deleted: 0, ...(methodIdParam ? { id: BigInt(methodIdParam) } : {}) },
      orderBy: { created_at: "asc" },
      select: { id: true, payee_name: true, pay_channel: true, card_no: true },
    }),
    prisma.bank_flow_entries.findMany({
      where: {
        team_id: teamId, month, is_deleted: 0,
        ...(methodIdParam ? { payment_method_id: BigInt(methodIdParam) } : {}),
      },
      orderBy: { txn_at: "asc" },
    }),
    prisma.report_overrides.findMany({
      where: { user_id: BigInt(user.userId), month, scope_key: { startsWith: "bank_open:" }, is_deleted: 0 },
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
  const entries: BankFlowExportEntry[] = entryRows.map((e) => {
    let breakdown: BankFlowExportEntry["breakdown"] = [];
    try { breakdown = e.breakdown ? JSON.parse(e.breakdown) : []; } catch { /* 脏数据容错 */ }
    return {
      id: String(e.id),
      paymentMethodId: String(e.payment_method_id),
      txnAt: e.txn_at,
      platform: e.platform,
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

  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM System";
  wb.created = new Date();

  // 每个收款方式一张流水单（sheet 名去重；同名同卡不同打款方式时靠渠道区分）
  const used = new Set<string>();
  for (const m of methods) {
    let name = `${m.payeeName}${m.payChannel ? "-" + m.payChannel : ""}${m.cardNo ? "-" + m.cardNo.slice(-4) : ""}`.slice(0, 28);
    let i = 2;
    while (used.has(name)) name = `${m.payeeName.slice(0, 24)}(${i++})`;
    used.add(name);
    buildBankStatementSheet(wb, month, m, entries.filter((e) => e.paymentMethodId === m.id), name);
  }
  // 对账明细按实际收款人分表（龚建成 / 张文俊 各一张，卡不同也归同一收款人）
  // C-178 后 payee_name 已是纯名字；保留去括号逻辑兼容未迁移的旧文本
  const payees = [...new Set(methods.map((m) => m.payeeName.replace(/[（(].*$/, "").trim() || m.payeeName))];
  for (const payee of payees) {
    const payeeMethods = methods.filter((m) => (m.payeeName.replace(/[（(].*$/, "").trim() || m.payeeName) === payee);
    const methodIds = new Set(payeeMethods.map((m) => m.id));
    const payeeEntries = entries.filter((e) => methodIds.has(e.paymentMethodId));
    if (payeeEntries.length === 0 && payees.length > 1) continue; // 该收款人本月无到账则不出空表
    let name = `对账-${payee}`.slice(0, 28);
    let i = 2;
    while (used.has(name)) name = `对账-${payee.slice(0, 20)}(${i++})`;
    used.add(name);
    buildBankReconSheet(wb, month, payeeMethods, payeeEntries, name, payee);
  }

  const buffer = await wb.xlsx.writeBuffer();
  const filename = encodeURIComponent(
    `银行流水-${month}${methodIdParam ? `-${methods[0].payeeName}${methods[0].payChannel ? `(${methods[0].payChannel})` : ""}` : ""}.xlsx`,
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
