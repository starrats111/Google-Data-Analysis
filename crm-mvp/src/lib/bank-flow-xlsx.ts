/**
 * R-07 银行流水 — xlsx 生成
 *
 * 每个收款方式一张「账户交易明细清单」sheet（正规银行流水单版式：
 * 户名/账号/期间抬头 + 序号/交易日期/时间/摘要/对方户名/收入/支出/余额 表体 +
 * 本期合计 + 制表/复核签章栏，期初余额起算逐笔滚动余额），
 * 末尾附一张「打款对账明细」sheet（应到=员工明细合计、实际到账、手续费、费率、逐人明细）。
 */

import ExcelJS from "exceljs";
import { apportionFee } from "@/lib/bank-flow-fee";

export interface BankFlowExportMethod {
  id: string;
  payeeName: string;
  cardNo: string;
  openingBalance: number | null;
}

export interface BankFlowExportEntry {
  id: string;
  paymentMethodId: string;
  txnAt: Date;
  platform: string;
  counterparty: string;
  summary: string;
  amount: number;
  currency: string;
  expectedAmount: number;
  fee: number;
  breakdown: { userId: string; username: string; displayName: string; platform: string; account: string; amount: number }[];
  remark: string;
}

const THIN: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FF000000" } };
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const GRAY = "FFD9D9D9";
const MONEY = "#,##0.00";

function songti(sz: number, bold = false): Partial<ExcelJS.Font> {
  return { name: "宋体", size: sz, bold };
}

function cell(
  ws: ExcelJS.Worksheet,
  r: number,
  c: number,
  value: ExcelJS.CellValue,
  opts: { sz?: number; bold?: boolean; h?: "left" | "center" | "right"; fill?: string; numFmt?: string; wrap?: boolean; noBorder?: boolean } = {},
) {
  const cl = ws.getCell(r, c);
  cl.value = value;
  cl.font = songti(opts.sz ?? 11, opts.bold);
  cl.alignment = { horizontal: opts.h ?? "center", vertical: "middle", wrapText: opts.wrap };
  if (!opts.noBorder) cl.border = BORDER;
  if (opts.fill) cl.fill = { type: "pattern", pattern: "solid", fgColor: { argb: opts.fill } };
  if (opts.numFmt) cl.numFmt = opts.numFmt;
}

const fmtDate = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const fmtTime = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, "0")}` };
}

/** 单个收款方式的「账户交易明细清单」sheet */
export function buildBankStatementSheet(
  wb: ExcelJS.Workbook,
  month: string,
  method: BankFlowExportMethod,
  entries: BankFlowExportEntry[],
  sheetName: string,
) {
  const ws = wb.addWorksheet(sheetName);
  const COLS = 9;
  const widths = [6, 13, 9, 16, 22, 15, 15, 16, 24];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  const { start, end } = monthRange(month);
  const opening = method.openingBalance ?? 0;

  // 抬头
  ws.mergeCells(1, 1, 1, COLS);
  cell(ws, 1, 1, "账户交易明细清单", { sz: 16, bold: true, noBorder: true });
  ws.getRow(1).height = 34;

  ws.mergeCells(2, 1, 2, 3);
  cell(ws, 2, 1, `户　名：${method.payeeName}`, { h: "left", noBorder: true });
  ws.mergeCells(2, 4, 2, 6);
  cell(ws, 2, 4, `账　号：${method.cardNo || "—"}`, { h: "left", noBorder: true });
  ws.mergeCells(2, 7, 2, COLS);
  cell(ws, 2, 7, `币　种：人民币(CNY)`, { h: "left", noBorder: true });

  const now = new Date();
  ws.mergeCells(3, 1, 3, 3);
  cell(ws, 3, 1, `查询期间：${start} 至 ${end}`, { h: "left", noBorder: true });
  ws.mergeCells(3, 4, 3, 6);
  cell(ws, 3, 4, `期初余额：${opening.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}`, { h: "left", noBorder: true });
  ws.mergeCells(3, 7, 3, COLS);
  cell(ws, 3, 7, `打印时间：${fmtDate(now)} ${fmtTime(now)}`, { h: "left", noBorder: true });
  for (let r = 2; r <= 3; r++) ws.getRow(r).height = 22;

  // 表头
  const HEAD = ["序号", "交易日期", "交易时间", "交易摘要", "对方户名", "收入金额(贷)", "支出金额(借)", "账户余额", "备注"];
  HEAD.forEach((h, i) => cell(ws, 5, 1 + i, h, { bold: true, fill: GRAY }));
  ws.getRow(5).height = 24;

  // 逐笔（按到账时间升序滚动余额）
  const sorted = [...entries].sort((a, b) => a.txnAt.getTime() - b.txnAt.getTime());
  let balance = opening;
  let r = 6;
  sorted.forEach((e, i) => {
    balance += e.amount;
    cell(ws, r, 1, i + 1, {});
    cell(ws, r, 2, fmtDate(e.txnAt), {});
    cell(ws, r, 3, fmtTime(e.txnAt), {});
    cell(ws, r, 4, e.summary || "佣金结算", {});
    cell(ws, r, 5, e.counterparty || e.platform, { wrap: true });
    cell(ws, r, 6, e.amount, { numFmt: MONEY, h: "right" });
    cell(ws, r, 7, "", {});
    cell(ws, r, 8, Math.round(balance * 100) / 100, { numFmt: MONEY, h: "right" });
    cell(ws, r, 9, e.remark || `${e.platform} 平台佣金打款`, { wrap: true, h: "left", sz: 10 });
    ws.getRow(r).height = 22;
    r++;
  });
  if (sorted.length === 0) {
    ws.mergeCells(r, 1, r, COLS);
    cell(ws, r, 1, "本期无交易记录", {});
    r++;
  }

  // 合计
  const totalIn = Math.round(sorted.reduce((s, e) => s + e.amount, 0) * 100) / 100;
  ws.mergeCells(r, 1, r, 5);
  cell(ws, r, 1, `本期合计：收入 ${sorted.length} 笔`, { bold: true, fill: GRAY, h: "left" });
  cell(ws, r, 6, totalIn, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 7, 0, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 8, Math.round(balance * 100) / 100, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 9, "", { fill: GRAY });
  ws.getRow(r).height = 24;
  r += 2;

  // 签章栏
  ws.mergeCells(r, 1, r, COLS);
  cell(ws, r, 1, "制表人：＿＿＿＿＿＿　　　复核人：＿＿＿＿＿＿　　　日期：＿＿＿＿年＿＿月＿＿日", { h: "left", noBorder: true });
  ws.getRow(r).height = 26;
}

/** 打款对账明细 sheet（核对应到/实到/手续费 + 逐人明细） */
export function buildBankReconSheet(
  wb: ExcelJS.Workbook,
  month: string,
  methods: BankFlowExportMethod[],
  entries: BankFlowExportEntry[],
) {
  const ws = wb.addWorksheet("打款对账明细");
  const widths = [20, 18, 8, 16, 16, 16, 14, 9, 46, 20];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  ws.mergeCells(1, 1, 1, 10);
  cell(ws, 1, 1, `${month} 平台打款对账明细（手续费 = 员工明细合计 − 实际到账；个人手续费按费率分摊，费率 = 手续费 ÷ 明细合计）`, { sz: 14, bold: true, noBorder: true });
  ws.getRow(1).height = 30;

  const HEAD = ["收款人", "收款卡号", "平台", "到账时间", "员工明细合计(¥)", "实际到账(¥)", "手续费(¥)", "费率", "员工收款明细（含个人手续费/净到手）", "备注"];
  HEAD.forEach((h, i) => cell(ws, 2, 1 + i, h, { bold: true, fill: GRAY }));
  ws.getRow(2).height = 24;

  const byId = new Map(methods.map((m) => [m.id, m]));
  const sorted = [...entries].sort((a, b) => a.txnAt.getTime() - b.txnAt.getTime());
  let r = 3;
  const money = (n: number) => n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const e of sorted) {
    const m = byId.get(e.paymentMethodId);
    const fees = apportionFee(e.breakdown.map((b) => b.amount || 0), e.fee);
    const detail = e.breakdown
      .map((b, i) => {
        const fee = fees[i] ?? 0;
        const net = Math.round(((b.amount || 0) - fee) * 100) / 100;
        return `${b.displayName || b.username}｜${b.platform} ${b.account}｜应发¥${money(b.amount)}｜手续费¥${money(fee)}｜净到手¥${money(net)}`;
      })
      .join("\n");
    cell(ws, r, 1, m?.payeeName || "—", {});
    cell(ws, r, 2, m?.cardNo || "—", {});
    cell(ws, r, 3, e.platform, {});
    cell(ws, r, 4, `${fmtDate(e.txnAt)} ${fmtTime(e.txnAt)}`, {});
    cell(ws, r, 5, e.expectedAmount, { numFmt: MONEY, h: "right" });
    cell(ws, r, 6, e.amount, { numFmt: MONEY, h: "right" });
    cell(ws, r, 7, e.fee, { numFmt: MONEY, h: "right", bold: e.fee !== 0 });
    cell(ws, r, 8, e.expectedAmount > 0 ? `${((e.fee / e.expectedAmount) * 100).toFixed(2)}%` : "—", {});
    cell(ws, r, 9, detail || "—", { wrap: true, h: "left", sz: 10 });
    cell(ws, r, 10, e.remark || "", { wrap: true, h: "left", sz: 10 });
    ws.getRow(r).height = Math.max(22, Math.min(6, e.breakdown.length) * 15 + 8);
    r++;
  }

  // 合计
  const sum = (f: (e: BankFlowExportEntry) => number) => Math.round(sorted.reduce((s, e) => s + f(e), 0) * 100) / 100;
  ws.mergeCells(r, 1, r, 4);
  cell(ws, r, 1, `合计（${sorted.length} 笔）`, { bold: true, fill: GRAY, h: "left" });
  cell(ws, r, 5, sum((e) => e.expectedAmount), { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 6, sum((e) => e.amount), { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 7, sum((e) => e.fee), { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  for (const c of [8, 9, 10]) cell(ws, r, c, "", { fill: GRAY });
  ws.getRow(r).height = 24;
}
