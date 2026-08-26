/**
 * R-07 银行流水 — xlsx 生成
 *
 * 每个收款方式一张「账户交易明细清单」sheet（正规银行流水单版式：
 * 户名/账号/期间抬头 + 序号/交易日期/时间/摘要/对方户名/收入/支出/余额/手续费 表体 +
 * 本期合计 + 制表/复核签章栏，期初余额起算逐笔滚动余额），
 * 末尾附一张「打款对账明细」sheet（应到=员工明细合计、实际到账、手续费、费率、逐人明细）。
 *
 * D-204：表体增加「手续费(¥)」列（= 员工明细合计 − 实际到账）。手续费在平台侧打款时
 * 已扣除，银行只到账净额，因此该列不参与收入/支出/余额滚动，仅作对账展示；
 * 本期合计行给出手续费支出合计。
 */

import ExcelJS from "exceljs";
import { apportionFee } from "@/lib/bank-flow-fee";

export interface BankFlowExportMethod {
  id: string;
  payeeName: string;
  /** C-178：打款方式（收款银行/渠道） */
  payChannel: string;
  cardNo: string;
  openingBalance: number | null;
}

export interface BankFlowExportEntry {
  id: string;
  paymentMethodId: string;
  txnAt: Date;
  /** C-180 合并导出后可能是 "CG+BSH" 形式的组合标签 */
  platform: string;
  /** C-180：同一笔银行到账拆分组号（导出前已按组合并，仅作标识） */
  txnGroup?: string | null;
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

/** 手续费列口径说明（银行只到账净额，故该列不进收入/支出/余额） */
const FEE_NOTE =
  "注：手续费 = 员工明细合计 − 实际到账，由平台/银行在打款时预先扣除，账户只收到净额，"
  + "故「手续费」列不计入收入、支出与账户余额，仅用于核对本期手续费支出。";

const money = (n: number) => n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  const COLS = 10;
  const widths = [6, 13, 9, 16, 22, 15, 15, 16, 14, 24];
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
  const HEAD = ["序号", "交易日期", "交易时间", "交易摘要", "对方户名", "收入金额(贷)", "支出金额(借)", "账户余额", "手续费(¥)", "备注"];
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
    cell(ws, r, 9, e.fee, { numFmt: MONEY, h: "right", bold: e.fee !== 0 });
    cell(ws, r, 10, e.remark || `${e.platform} 平台佣金打款`, { wrap: true, h: "left", sz: 10 });
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
  const totalFee = Math.round(sorted.reduce((s, e) => s + e.fee, 0) * 100) / 100;
  ws.mergeCells(r, 1, r, 5);
  cell(ws, r, 1, `本期合计：收入 ${sorted.length} 笔，手续费支出 ¥${money(totalFee)}`, { bold: true, fill: GRAY, h: "left" });
  cell(ws, r, 6, totalIn, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 7, 0, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 8, Math.round(balance * 100) / 100, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 9, totalFee, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 10, "", { fill: GRAY });
  ws.getRow(r).height = 24;
  r++;

  ws.mergeCells(r, 1, r, COLS);
  cell(ws, r, 1, FEE_NOTE, { h: "left", sz: 10, noBorder: true });
  ws.getRow(r).height = 20;
  r += 2;

  // 签章栏
  ws.mergeCells(r, 1, r, COLS);
  cell(ws, r, 1, "制表人：＿＿＿＿＿＿　　　复核人：＿＿＿＿＿＿　　　日期：＿＿＿＿年＿＿月＿＿日", { h: "left", noBorder: true });
  ws.getRow(r).height = 26;
}

/**
 * C-179：每收款人一张「账户交易明细清单」合并流水单——
 * 该收款人名下所有卡/渠道的入账合并按到账时间排序，新增「打款方式(卡号)」列，
 * 期初余额 = 各卡期初合计，逐笔滚动余额。
 */
export function buildPayeeStatementSheet(
  wb: ExcelJS.Workbook,
  month: string,
  payeeName: string,
  methods: BankFlowExportMethod[],
  entries: BankFlowExportEntry[],
  sheetName: string,
) {
  const ws = wb.addWorksheet(sheetName);
  const COLS = 11;
  const widths = [6, 13, 9, 16, 20, 26, 15, 15, 16, 14, 22];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  const { start, end } = monthRange(month);
  const methodById = new Map(methods.map((m) => [m.id, m]));
  const opening = methods.reduce((s, m) => s + (m.openingBalance ?? 0), 0);
  const cardNos = [...new Set(methods.map((m) => m.cardNo).filter(Boolean))];
  const acctLabel = cardNos.length === 0 ? "—" : cardNos.length === 1 ? cardNos[0] : `共 ${cardNos.length} 张卡（见「打款方式」列）`;

  // 抬头
  ws.mergeCells(1, 1, 1, COLS);
  cell(ws, 1, 1, "账户交易明细清单", { sz: 16, bold: true, noBorder: true });
  ws.getRow(1).height = 34;

  ws.mergeCells(2, 1, 2, 3);
  cell(ws, 2, 1, `户　名：${payeeName}`, { h: "left", noBorder: true });
  ws.mergeCells(2, 4, 2, 6);
  cell(ws, 2, 4, `账　号：${acctLabel}`, { h: "left", noBorder: true });
  ws.mergeCells(2, 7, 2, COLS);
  cell(ws, 2, 7, `币　种：人民币(CNY)`, { h: "left", noBorder: true });

  const now = new Date();
  ws.mergeCells(3, 1, 3, 3);
  cell(ws, 3, 1, `查询期间：${start} 至 ${end}`, { h: "left", noBorder: true });
  ws.mergeCells(3, 4, 3, 6);
  cell(ws, 3, 4, `期初余额：${opening.toLocaleString("zh-CN", { minimumFractionDigits: 2 })}（各卡合计）`, { h: "left", noBorder: true });
  ws.mergeCells(3, 7, 3, COLS);
  cell(ws, 3, 7, `打印时间：${fmtDate(now)} ${fmtTime(now)}`, { h: "left", noBorder: true });
  for (let r = 2; r <= 3; r++) ws.getRow(r).height = 22;

  // 表头
  const HEAD = ["序号", "交易日期", "交易时间", "交易摘要", "对方户名", "打款方式(卡号)", "收入金额(贷)", "支出金额(借)", "账户余额", "手续费(¥)", "备注"];
  HEAD.forEach((h, i) => cell(ws, 5, 1 + i, h, { bold: true, fill: GRAY }));
  ws.getRow(5).height = 24;

  // 逐笔（按到账时间升序滚动余额）
  const sorted = [...entries].sort((a, b) => a.txnAt.getTime() - b.txnAt.getTime());
  let balance = opening;
  let r = 6;
  sorted.forEach((e, i) => {
    const m = methodById.get(e.paymentMethodId);
    balance += e.amount;
    cell(ws, r, 1, i + 1, {});
    cell(ws, r, 2, fmtDate(e.txnAt), {});
    cell(ws, r, 3, fmtTime(e.txnAt), {});
    cell(ws, r, 4, e.summary || "佣金结算", {});
    cell(ws, r, 5, e.counterparty || e.platform, { wrap: true });
    cell(ws, r, 6, m ? `${m.payChannel || "—"} ${m.cardNo || ""}`.trim() : "—", { sz: 10 });
    cell(ws, r, 7, e.amount, { numFmt: MONEY, h: "right" });
    cell(ws, r, 8, "", {});
    cell(ws, r, 9, Math.round(balance * 100) / 100, { numFmt: MONEY, h: "right" });
    cell(ws, r, 10, e.fee, { numFmt: MONEY, h: "right", bold: e.fee !== 0 });
    cell(ws, r, 11, e.remark || `${e.platform} 平台佣金打款`, { wrap: true, h: "left", sz: 10 });
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
  const totalFee = Math.round(sorted.reduce((s, e) => s + e.fee, 0) * 100) / 100;
  ws.mergeCells(r, 1, r, 6);
  cell(ws, r, 1, `本期合计：收入 ${sorted.length} 笔，手续费支出 ¥${money(totalFee)}`, { bold: true, fill: GRAY, h: "left" });
  cell(ws, r, 7, totalIn, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 8, 0, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 9, Math.round(balance * 100) / 100, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 10, totalFee, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 11, "", { fill: GRAY });
  ws.getRow(r).height = 24;
  r++;

  ws.mergeCells(r, 1, r, COLS);
  cell(ws, r, 1, FEE_NOTE, { h: "left", sz: 10, noBorder: true });
  ws.getRow(r).height = 20;
  r += 2;

  // 签章栏
  ws.mergeCells(r, 1, r, COLS);
  cell(ws, r, 1, "制表人：＿＿＿＿＿＿　　　复核人：＿＿＿＿＿＿　　　日期：＿＿＿＿年＿＿月＿＿日", { h: "left", noBorder: true });
  ws.getRow(r).height = 26;
}

/** D-287 年度导出用：条目附归属月份与收款人 */
export interface BankFlowYearEntry extends BankFlowExportEntry {
  /** YYYY-MM */
  month: string;
  /** 收款人（payment_methods.payee_name 去括号后） */
  payee: string;
}

/**
 * D-287 年度总览 sheet：1-12 月逐行 × 各收款人到账合计列 + 当月合计/手续费/笔数，
 * 底部年度合计行；无到账月份显示「—」；仅给全年有到账的收款人出列。
 */
export function buildYearOverviewSheet(
  wb: ExcelJS.Workbook,
  year: string,
  payees: string[],
  entries: BankFlowYearEntry[],
) {
  const ws = wb.addWorksheet("年度总览");
  const widths = [10, ...payees.map(() => 16), 16, 13, 8];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const NC = widths.length;

  ws.mergeCells(1, 1, 1, NC);
  cell(ws, 1, 1, `${year} 年度银行流水总览表`, { sz: 16, bold: true, noBorder: true });
  ws.getRow(1).height = 34;
  const now = new Date();
  ws.mergeCells(2, 1, 2, NC);
  cell(ws, 2, 1, `单位：人民币元　　统计期间：${year}-01-01 至 ${year}-12-31　　制表时间：${fmtDate(now)} ${fmtTime(now)}`, { h: "left", noBorder: true, sz: 10 });
  ws.getRow(2).height = 20;

  const HEAD = ["月份", ...payees.map((p) => `${p} 到账(¥)`), "当月合计(¥)", "手续费(¥)", "笔数"];
  HEAD.forEach((h, i) => cell(ws, 4, 1 + i, h, { bold: true, fill: GRAY }));
  ws.getRow(4).height = 24;

  const R2 = (n: number) => Math.round(n * 100) / 100;
  let r = 5;
  const yearByPayee = new Map(payees.map((p) => [p, 0]));
  let yearTotal = 0, yearFee = 0, yearCnt = 0;
  for (let m = 1; m <= 12; m++) {
    const ym = `${year}-${String(m).padStart(2, "0")}`;
    const es = entries.filter((e) => e.month === ym);
    cell(ws, r, 1, `${m}月`, {});
    payees.forEach((p, i) => {
      const v = R2(es.filter((e) => e.payee === p).reduce((s, e) => s + e.amount, 0));
      yearByPayee.set(p, R2((yearByPayee.get(p) ?? 0) + v));
      if (es.length) cell(ws, r, 2 + i, v, { numFmt: MONEY, h: "right" });
      else cell(ws, r, 2 + i, "—", {});
    });
    const tot = R2(es.reduce((s, e) => s + e.amount, 0));
    const fee = R2(es.reduce((s, e) => s + e.fee, 0));
    yearTotal = R2(yearTotal + tot); yearFee = R2(yearFee + fee); yearCnt += es.length;
    if (es.length) {
      cell(ws, r, 2 + payees.length, tot, { numFmt: MONEY, h: "right", bold: true });
      cell(ws, r, 3 + payees.length, fee, { numFmt: MONEY, h: "right" });
      cell(ws, r, 4 + payees.length, es.length, {});
    } else {
      cell(ws, r, 2 + payees.length, "—", {});
      cell(ws, r, 3 + payees.length, "—", {});
      cell(ws, r, 4 + payees.length, "—", {});
    }
    ws.getRow(r).height = 22;
    r++;
  }
  cell(ws, r, 1, "年度合计", { bold: true, fill: GRAY });
  payees.forEach((p, i) => cell(ws, r, 2 + i, yearByPayee.get(p) ?? 0, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" }));
  cell(ws, r, 2 + payees.length, yearTotal, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 3 + payees.length, yearFee, { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 4 + payees.length, yearCnt, { bold: true, fill: GRAY });
  ws.getRow(r).height = 24;
  r++;

  ws.mergeCells(r, 1, r, NC);
  cell(ws, r, 1, "注：到账金额为银行/渠道实际入账净额；手续费在平台打款时已预扣，不计入到账金额。逐笔明细见后续各月份表。", { h: "left", sz: 10, noBorder: true });
  r += 2;
  ws.mergeCells(r, 1, r, NC);
  cell(ws, r, 1, "制表人：＿＿＿＿＿＿　　　复核人：＿＿＿＿＿＿　　　日期：＿＿＿＿年＿＿月＿＿日", { h: "left", noBorder: true });
  ws.getRow(r).height = 26;
}

/**
 * D-287 年度导出的单月明细 sheet：当月全部收款人逐笔（含收款人列），
 * 末尾各收款人小计 + 当月合计。txn_group 合并已在调用方完成。
 */
export function buildYearMonthDetailSheet(
  wb: ExcelJS.Workbook,
  year: string,
  monthNum: number,
  payees: string[],
  methods: BankFlowExportMethod[],
  entries: BankFlowYearEntry[],
) {
  const ws = wb.addWorksheet(`${monthNum}月`);
  const widths = [6, 12, 8, 10, 24, 12, 14, 16, 15, 13, 20];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const NC = widths.length;
  const methodById = new Map(methods.map((m) => [m.id, m]));
  const R2 = (n: number) => Math.round(n * 100) / 100;
  const ym = `${year}-${String(monthNum).padStart(2, "0")}`;

  ws.mergeCells(1, 1, 1, NC);
  cell(ws, 1, 1, `${year} 年 ${monthNum} 月银行流水明细`, { sz: 15, bold: true, noBorder: true });
  ws.getRow(1).height = 30;
  ws.mergeCells(2, 1, 2, NC);
  const { start, end } = monthRange(ym);
  cell(ws, 2, 1, `单位：人民币元　　期间：${start} 至 ${end}`, { h: "left", noBorder: true, sz: 10 });

  const HEAD = ["序号", "交易日期", "时间", "收款人", "打款方式(卡号)", "平台", "交易摘要", "对方户名", "到账金额(¥)", "手续费(¥)", "备注"];
  HEAD.forEach((h, i) => cell(ws, 4, 1 + i, h, { bold: true, fill: GRAY }));
  ws.getRow(4).height = 24;

  const sorted = [...entries].sort((a, b) => a.txnAt.getTime() - b.txnAt.getTime());
  let r = 5;
  sorted.forEach((e, i) => {
    const m = methodById.get(e.paymentMethodId);
    cell(ws, r, 1, i + 1, {});
    cell(ws, r, 2, fmtDate(e.txnAt), {});
    cell(ws, r, 3, fmtTime(e.txnAt), {});
    cell(ws, r, 4, e.payee, {});
    cell(ws, r, 5, m ? `${m.payChannel || "—"} ${m.cardNo ? "尾号" + m.cardNo.slice(-4) : ""}`.trim() : "—", { sz: 10 });
    cell(ws, r, 6, e.platform, {});
    cell(ws, r, 7, e.summary || "佣金结算", {});
    cell(ws, r, 8, e.counterparty || e.platform, {});
    cell(ws, r, 9, e.amount, { numFmt: MONEY, h: "right" });
    cell(ws, r, 10, e.fee, { numFmt: MONEY, h: "right" });
    cell(ws, r, 11, e.remark || `${e.platform} 平台佣金打款`, { h: "left", sz: 10, wrap: true });
    ws.getRow(r).height = 22;
    r++;
  });

  for (const p of payees) {
    const pes = sorted.filter((e) => e.payee === p);
    if (pes.length === 0) continue;
    ws.mergeCells(r, 1, r, 8);
    cell(ws, r, 1, `${p} 小计（${pes.length} 笔）`, { bold: true, h: "right" });
    cell(ws, r, 9, R2(pes.reduce((s, e) => s + e.amount, 0)), { bold: true, numFmt: MONEY, h: "right" });
    cell(ws, r, 10, R2(pes.reduce((s, e) => s + e.fee, 0)), { bold: true, numFmt: MONEY, h: "right" });
    cell(ws, r, 11, "", {});
    r++;
  }
  ws.mergeCells(r, 1, r, 8);
  cell(ws, r, 1, `当月合计（${sorted.length} 笔）`, { bold: true, fill: GRAY, h: "right" });
  cell(ws, r, 9, R2(sorted.reduce((s, e) => s + e.amount, 0)), { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 10, R2(sorted.reduce((s, e) => s + e.fee, 0)), { bold: true, fill: GRAY, numFmt: MONEY, h: "right" });
  cell(ws, r, 11, "", { fill: GRAY });
  ws.getRow(r).height = 24;
}

/** 打款对账明细 sheet（核对应到/实到/手续费 + 逐人明细）；按收款人分表时传 sheetName/payeeName */
export function buildBankReconSheet(
  wb: ExcelJS.Workbook,
  month: string,
  methods: BankFlowExportMethod[],
  entries: BankFlowExportEntry[],
  sheetName = "打款对账明细",
  payeeName = "",
) {
  const ws = wb.addWorksheet(sheetName);
  const widths = [20, 18, 8, 16, 16, 16, 14, 9, 46, 20];
  widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));

  ws.mergeCells(1, 1, 1, 10);
  cell(ws, 1, 1, `${month} ${payeeName ? `${payeeName} ` : ""}平台打款对账明细（手续费 = 员工明细合计 − 实际到账；个人手续费按费率分摊，费率 = 手续费 ÷ 明细合计）`, { sz: 14, bold: true, noBorder: true });
  ws.getRow(1).height = 30;

  const HEAD = ["收款人", "收款卡号", "平台", "到账时间", "员工明细合计(¥)", "实际到账(¥)", "手续费(¥)", "费率", "员工收款明细（含个人手续费/净到手）", "备注"];
  HEAD.forEach((h, i) => cell(ws, 2, 1 + i, h, { bold: true, fill: GRAY }));
  ws.getRow(2).height = 24;

  const byId = new Map(methods.map((m) => [m.id, m]));
  const sorted = [...entries].sort((a, b) => a.txnAt.getTime() - b.txnAt.getTime());
  let r = 3;
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
    cell(ws, r, 1, m ? `${m.payeeName}${m.payChannel ? `(${m.payChannel})` : ""}` : "—", {});
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
