import { NextRequest, NextResponse } from "next/server";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import ExcelJS from "exceljs";
import {
  buildBankStatementSheet, buildPayeeStatementSheet,
  type BankFlowExportMethod, type BankFlowExportEntry,
} from "@/lib/bank-flow-xlsx";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/report/bank-flow/export?month=YYYY-MM[&methodId=]
 * 导出银行流水（C-179 精简为每收款人一张 sheet）：
 * - 整体导出：每个收款人一张「账户交易明细清单」合并流水单（该人所有卡/渠道入账合并、
 *   带打款方式(卡号)列、期初余额=各卡合计逐笔滚动）
 * - methodId 指定时（单卡导出按钮）：仍导出该卡单独一张流水单
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

  if (methodIdParam) {
    // 单卡导出：该卡单独一张流水单
    const m = methods[0];
    const name = `${m.payeeName}${m.payChannel ? "-" + m.payChannel : ""}${m.cardNo ? "-" + m.cardNo.slice(-4) : ""}`.slice(0, 28);
    buildBankStatementSheet(wb, month, m, entries.filter((e) => e.paymentMethodId === m.id), name);
  } else {
    // C-179：每收款人一张合并流水单（该人所有卡/渠道入账合并）
    // C-178 后 payee_name 已是纯名字；保留去括号逻辑兼容未迁移的旧文本
    const used = new Set<string>();
    const payeeOf = (m: BankFlowExportMethod) => m.payeeName.replace(/[（(].*$/, "").trim() || m.payeeName;
    const payees = [...new Set(methods.map(payeeOf))];
    for (const payee of payees) {
      const payeeMethods = methods.filter((m) => payeeOf(m) === payee);
      const methodIds = new Set(payeeMethods.map((m) => m.id));
      const payeeEntries = entries.filter((e) => methodIds.has(e.paymentMethodId));
      if (payeeEntries.length === 0 && payees.length > 1) continue; // 该收款人本月无到账则不出空表
      let name = payee.slice(0, 28);
      let i = 2;
      while (used.has(name)) name = `${payee.slice(0, 24)}(${i++})`;
      used.add(name);
      buildPayeeStatementSheet(wb, month, payee, payeeMethods, payeeEntries, name);
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
