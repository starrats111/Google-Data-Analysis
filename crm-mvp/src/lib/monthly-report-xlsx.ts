/**
 * R-02/R-04 月度收支报表 — xlsx 生成（复用 monthly-report 视图模型）
 *
 * buildFengduMonthSheet：月度收支表（R-06：1:1 复刻「新2026年度丰度收支统计表」
 *   月份 sheet 的版式——A/B 标签列 + C..M 合计块(SUMIF 公式) + 每成员 12 列块，
 *   宋体12、模板同款配色/边框/数字格式/行高列宽；组长导出=全员，组员导出=单人块）
 * buildAnnualSheet：年度报表（R-04.2 新口径整年 12 个月）
 */

import ExcelJS from "exceljs";
import type { MemberMonthlyReport, TeamAnnualReport, MemberAnnualReport } from "@/lib/monthly-report";
import { REPORT_PLATFORM_ORDER } from "@/lib/report-metrics";

const CLR = {
  YELLOW: "FFFF00",
  ORANGE: "FDE9D9",
  GREEN: "EBF1DE",
  GREEN_DARK: "C4D79B",
  GRAY: "D9D9D9",
  BLUE_LIGHT: "DAEEF3",
  WHITE: "FFFFFF",
};

function fill(hex: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + hex } };
}
function font(bold = false, sz = 10): Partial<ExcelJS.Font> {
  return { bold, size: sz, name: "Arial" };
}
const border: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: "FFB0B0B0" } },
  left: { style: "thin", color: { argb: "FFB0B0B0" } },
  bottom: { style: "thin", color: { argb: "FFB0B0B0" } },
  right: { style: "thin", color: { argb: "FFB0B0B0" } },
};
const NUM_FMT = "#,##0.00";
const USD_FMT = '"$"#,##0.00';
const CNY_FMT = '"¥"#,##0.00';

function setCell(
  ws: ExcelJS.Worksheet,
  r: number,
  c: number,
  value: ExcelJS.CellValue,
  opts: { fill?: string; bold?: boolean; h?: "left" | "center" | "right"; num?: boolean; numFmt?: string; wrap?: boolean } = {},
) {
  const cell = ws.getCell(r, c);
  cell.value = value;
  if (opts.fill) cell.fill = fill(opts.fill);
  cell.font = font(opts.bold);
  cell.alignment = { horizontal: opts.h || (opts.num || opts.numFmt ? "right" : "center"), vertical: "middle", wrapText: opts.wrap };
  cell.border = border;
  if (opts.numFmt) cell.numFmt = opts.numFmt;
  else if (opts.num) cell.numFmt = NUM_FMT;
}

const nv = (n: number): number | string => (n !== 0 ? +n.toFixed(2) : 0);

// ════════════════════════════════════════════════════════════════════════════
// R-06：丰度收支统计表模板 1:1 复刻
// 版式、配色、边框、数字格式、行高列宽全部取自
// 「新2026年度丰度1-12月份收支统计表」月份 sheet 的实测样式。
// ════════════════════════════════════════════════════════════════════════════

const FD = {
  YELLOW: "FFFF00", // 行1 标题条
  GREEN: "92D050",  // 币种/平台表头、合计行
  G4: "ACD78E",     // 主题绿 tint40%（5号/10号 行）——模板 theme7+0.4 的实际渲染色
  G6: "C8E5B3",     // 主题绿 tint60%（15号/20号 行）——模板 theme7+0.6 的实际渲染色
};
// 模板数字格式
const FD_NUM_AD = "0.00_ ";                    // 广告费行
const FD_NUM_RED = "0.00_);[Red]\\(0.00\\)";   // 成员数值区（负数红括号）
const FD_NUM_PROFIT = "0.00_ ;[Red]\\-0.00\\ "; // 利润行 D..M

const fdFont = (bold = false): Partial<ExcelJS.Font> => ({ name: "宋体", size: 12, bold });
const fdThin: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FF000000" } };
const fdBorderAll: Partial<ExcelJS.Borders> = { top: fdThin, left: fdThin, bottom: fdThin, right: fdThin };
const fdBorderTB: Partial<ExcelJS.Borders> = { top: fdThin, bottom: fdThin }; // 行1 黄条：仅上下框线

/** 列号 → 字母（1=A） */
function fdColL(c: number): string {
  let s = "";
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = (c - 1 - m) / 26;
  }
  return s;
}

function fdCell(
  ws: ExcelJS.Worksheet,
  r: number,
  c: number,
  value: ExcelJS.CellValue,
  opts: { fill?: string; bold?: boolean; numFmt?: string; tbOnly?: boolean; hDefault?: boolean } = {},
) {
  const cell = ws.getCell(r, c);
  cell.value = value;
  cell.font = fdFont(opts.bold);
  cell.alignment = opts.hDefault ? { vertical: "middle" } : { horizontal: "center", vertical: "middle" };
  cell.border = opts.tbOnly ? fdBorderTB : fdBorderAll;
  if (opts.fill) cell.fill = fill(opts.fill);
  if (opts.numFmt) cell.numFmt = opts.numFmt;
}

/** 每成员块内按平台聚合出的一列数据 */
interface FdPlatCol {
  accountNames: string;
  book: number;
  rejected: number;
  recvH1: number;
  recvH2: number;
  paidCnyH1: number;
  paidCnyH2: number;
  payees: string;
  cards: string;
}

function fdAggregate(rep: MemberMonthlyReport): Map<string, FdPlatCol> {
  const map = new Map<string, FdPlatCol>();
  for (const a of rep.accounts) {
    let col = map.get(a.platform);
    if (!col) {
      col = { accountNames: "", book: 0, rejected: 0, recvH1: 0, recvH2: 0, paidCnyH1: 0, paidCnyH2: 0, payees: "", cards: "" };
      map.set(a.platform, col);
    }
    col.accountNames = [col.accountNames, a.accountName].filter(Boolean).join("/");
    col.book += a.bookEffective;
    col.rejected += a.rejectedEffective;
    col.recvH1 += a.recvH1Effective;
    col.recvH2 += a.recvH2Effective;
    col.paidCnyH1 += a.paidCnyH1Effective;
    col.paidCnyH2 += a.paidCnyH2Effective;
    if (a.payeeName && !col.payees.split("/").includes(a.payeeName)) {
      col.payees = [col.payees, a.payeeName].filter(Boolean).join("/");
    }
    if (a.cardNo && !col.cards.split("/").includes(a.cardNo)) {
      col.cards = [col.cards, a.cardNo].filter(Boolean).join("/");
    }
  }
  return map;
}

/** 数值单元格：0 与模板一致留空 */
const fdNv = (n: number): number | string => (Math.abs(n) >= 0.005 ? +n.toFixed(2) : "");

/**
 * 月度收支表 sheet（丰度模板 1:1）：
 * A/B 标签列 + C..M 合计块（SUMIF/SUM 公式，随成员数动态定界）+ 每成员 12 列块。
 * 组长导出传全员 memberReports；组员导出传 [自己的报表]。
 */
export function buildFengduMonthSheet(wb: ExcelJS.Workbook, reports: MemberMonthlyReport[], sheetName?: string) {
  const month = reports[0]?.month || "";
  const monthNum = parseInt(month.slice(5), 10) || 0;
  const ws = wb.addWorksheet(sheetName || `${monthNum}月份`);

  const P = REPORT_PLATFORM_ORDER; // 10 平台，与模板列序一致
  const NP = P.length;
  const BLOCK = NP + 2; // 每成员 12 列：10 平台 + 人民币 + 在跑广告量
  const FIRST = 14; // N 列：首个成员块起点
  const lastCol = FIRST - 1 + BLOCK * Math.max(reports.length, 1);
  const lastL = fdColL(lastCol);

  // ── 行高 / 列宽（模板实测） ──
  ws.getRow(1).height = 28;
  ws.getRow(2).height = 33;
  for (let r = 3; r <= 17; r++) ws.getRow(r).height = 28;
  ws.getColumn(1).width = 23;
  ws.getColumn(2).width = 13.5;
  ws.getColumn(3).width = 16.25;
  ws.getColumn(4).width = 14.25;
  for (let c = 5; c <= lastCol; c++) ws.getColumn(c).width = 11;

  // 先给合并区每个格子刷样式再合并（合并后从属格样式无法单独写，
  // 否则从属格在文件里残留默认 Calibri，边框/字体与模板逐格比对不一致）
  const merge = (
    r1: number,
    c1: number,
    r2: number,
    c2: number,
    value: ExcelJS.CellValue,
    opts: Parameters<typeof fdCell>[4] = {},
  ) => {
    for (let rr = r1; rr <= r2; rr++) {
      for (let cc = c1; cc <= c2; cc++) fdCell(ws, rr, cc, rr === r1 && cc === c1 ? value : null, opts);
    }
    ws.mergeCells(r1, c1, r2, c2);
  };

  // ── A/B 标签列 ──
  const label = (r1: number, r2: number, c1: number, c2: number, text: string) => {
    merge(r1, c1, r2, c2, text, { bold: true });
  };
  label(1, 1, 1, 2, "月份");
  label(2, 2, 1, 2, "MCC");
  label(3, 3, 1, 2, "币种");
  label(4, 4, 1, 2, "广告费");
  label(5, 5, 1, 2, "广告联盟");
  label(6, 6, 1, 2, "账号名称");
  label(7, 7, 1, 2, "账面佣金（美金）");
  label(8, 8, 1, 2, "失效佣金（美金）");
  merge(9, 1, 11, 1, "应收佣金（美金）", { bold: true });
  fdCell(ws, 9, 2, "5号", { fill: FD.G4, bold: true });
  fdCell(ws, 10, 2, "15号", { fill: FD.G6, bold: true });
  fdCell(ws, 11, 2, "合计", { fill: FD.GREEN, bold: true });
  merge(12, 1, 14, 1, "实收佣金（人民币）", { bold: true });
  fdCell(ws, 12, 2, "10号", { fill: FD.G4, bold: true });
  fdCell(ws, 13, 2, "20号", { fill: FD.G6, bold: true });
  fdCell(ws, 14, 2, "合计", { fill: FD.GREEN, bold: true });
  label(15, 15, 1, 2, "收款人");
  label(16, 16, 1, 2, "收款卡号");
  label(17, 17, 1, 2, "可分配利润（实收佣金-广告费）");

  // ── 行1 黄条（C..last，无左右框线，与模板一致） ──
  for (let c = 3; c <= lastCol; c++) fdCell(ws, 1, c, "", { fill: FD.YELLOW, bold: true, tbOnly: true });

  // ── C..M 合计块（公式动态定界到最后一个成员块） ──
  merge(2, 3, 2, 13, "合计", { bold: true });

  merge(3, 3, 3, 5, "美金", { fill: FD.GREEN });
  merge(3, 6, 3, 8, "人民币", { fill: FD.GREEN });
  merge(3, 9, 3, 13, "在跑广告量", { fill: FD.GREEN });

  const sumifRow = (row: number, keyCell: string) =>
    ({ formula: `SUMIF($N$3:$${lastL}$3,${keyCell},$N${row}:$${lastL}${row})` });
  merge(4, 3, 4, 5, sumifRow(4, "C$3"), { numFmt: FD_NUM_AD });
  merge(4, 6, 4, 8, sumifRow(4, "F$3"), { numFmt: FD_NUM_AD });
  merge(4, 9, 4, 13, sumifRow(4, "I$3"), { numFmt: FD_NUM_AD });

  P.forEach((p, i) => fdCell(ws, 5, 3 + i, p, { fill: FD.GREEN }));
  fdCell(ws, 5, 13, "合计", { fill: FD.GREEN, bold: true });
  for (let c = 3; c <= 13; c++) fdCell(ws, 6, c, "", { fill: FD.GREEN });

  // 平台聚合公式行：SUMIF 匹配行5 平台代码
  const platSumif = (row: number, fillHex?: string) => {
    for (let i = 0; i < NP; i++) {
      const cL = fdColL(3 + i);
      fdCell(ws, row, 3 + i, { formula: `SUMIF($N$5:$${lastL}$5,${cL}$5,$N${row}:$${lastL}${row})` }, { fill: fillHex });
    }
  };
  platSumif(7);
  fdCell(ws, 7, 13, { formula: "SUM(C7:L7)" }, { bold: true, numFmt: FD_NUM_AD });
  platSumif(8);
  fdCell(ws, 8, 13, { formula: "SUM(C8:L8)" }, { bold: true, numFmt: FD_NUM_AD });
  platSumif(9, FD.G4);
  fdCell(ws, 9, 13, { formula: "SUM(C9:L9)" }, { fill: FD.G4, bold: true });
  platSumif(10, FD.G4);
  fdCell(ws, 10, 13, { formula: "SUM(C10:L10)" }, { fill: FD.G4, bold: true });
  for (let i = 0; i < NP; i++) {
    const cL = fdColL(3 + i);
    fdCell(ws, 11, 3 + i, { formula: `SUM(${cL}9:${cL}10)` }, { fill: FD.GREEN });
  }
  fdCell(ws, 11, 13, { formula: "SUM(C11:L11)" }, { fill: FD.GREEN, bold: true });
  platSumif(12, FD.G4);
  fdCell(ws, 12, 13, { formula: "SUM(C12:L12)" }, { fill: FD.G4, bold: true });
  platSumif(13, FD.G4);
  fdCell(ws, 13, 13, { formula: "SUM(C13:L13)" }, { fill: FD.G4, bold: true });
  for (let i = 0; i < NP; i++) {
    const cL = fdColL(3 + i);
    fdCell(ws, 14, 3 + i, { formula: `SUM(${cL}12:${cL}13)` }, { fill: FD.GREEN });
  }
  fdCell(ws, 14, 13, { formula: "SUM(C14:L14)" }, { fill: FD.GREEN, bold: true });

  for (let c = 3; c <= 13; c++) {
    fdCell(ws, 15, c, "", {});
    fdCell(ws, 16, c, "", {});
  }
  fdCell(ws, 17, 3, "", { hDefault: true });
  for (let c = 4; c <= 12; c++) fdCell(ws, 17, c, "", { numFmt: FD_NUM_PROFIT, hDefault: true });
  fdCell(ws, 17, 13, { formula: "M14-C4" }, { numFmt: FD_NUM_PROFIT, hDefault: true });

  // ── 每成员 12 列块 ──
  reports.forEach((rep, mi) => {
    const c0 = FIRST + BLOCK * mi; // 块内第 1 列（对应模板 N）
    const cCny = c0 + NP;          // 人民币列（对应模板 X）
    const cCnt = c0 + NP + 1;      // 在跑广告量列（对应模板 Y）
    const agg = fdAggregate(rep);

    merge(2, c0, 2, cCnt, rep.displayName || rep.username, {});

    // 行3 币种：前 9 列美金、第 10 列留空（模板如此）、人民币、在跑广告量
    for (let i = 0; i < NP - 1; i++) fdCell(ws, 3, c0 + i, "美金", { fill: FD.GREEN });
    fdCell(ws, 3, c0 + NP - 1, "", { fill: FD.GREEN });
    fdCell(ws, 3, cCny, "人民币", { fill: FD.GREEN });
    fdCell(ws, 3, cCnt, "在跑广告量", { fill: FD.GREEN });

    // 行4 广告费
    fdCell(ws, 4, c0, fdNv(rep.adCostTotalUsd), { numFmt: FD_NUM_AD });
    for (let i = 1; i < NP; i++) fdCell(ws, 4, c0 + i, "", { numFmt: FD_NUM_AD });
    fdCell(ws, 4, cCny, fdNv(rep.adCostTotalCny), { numFmt: FD_NUM_AD });
    fdCell(ws, 4, cCnt, rep.enabledCampaigns || "", {});

    // 行5 平台 / 行6 账号名称
    P.forEach((p, i) => fdCell(ws, 5, c0 + i, p, { fill: FD.GREEN }));
    fdCell(ws, 5, cCny, "", { fill: FD.GREEN });
    fdCell(ws, 5, cCnt, "", { fill: FD.GREEN });
    P.forEach((p, i) => fdCell(ws, 6, c0 + i, agg.get(p)?.accountNames || "", { fill: FD.GREEN }));
    fdCell(ws, 6, cCny, "", { fill: FD.GREEN });
    fdCell(ws, 6, cCnt, "", { fill: FD.GREEN });

    // 数值行：7账面 8失效 9应收5号 10应收15号 12实收10号 13实收20号
    const valueRow = (row: number, get: (col: FdPlatCol) => number, fillHex?: string) => {
      P.forEach((p, i) => {
        const col = agg.get(p);
        fdCell(ws, row, c0 + i, col ? fdNv(get(col)) : "", { fill: fillHex, numFmt: FD_NUM_RED });
      });
      fdCell(ws, row, cCny, "", { fill: fillHex, numFmt: FD_NUM_RED });
      fdCell(ws, row, cCnt, "", { fill: fillHex });
    };
    valueRow(7, (c) => c.book);
    valueRow(8, (c) => c.rejected);
    valueRow(9, (c) => c.recvH1, FD.G4);
    valueRow(10, (c) => c.recvH2, FD.G6);
    valueRow(11, () => 0, FD.GREEN); // 模板成员块合计行留空（合计在 C..M 公式区）
    valueRow(12, (c) => c.paidCnyH1, FD.G4);
    valueRow(13, (c) => c.paidCnyH2, FD.G6);
    valueRow(14, () => 0, FD.GREEN);

    // 行15/16 收款人、卡号
    P.forEach((p, i) => fdCell(ws, 15, c0 + i, agg.get(p)?.payees || "", {}));
    fdCell(ws, 15, cCny, "", {});
    fdCell(ws, 15, cCnt, "", {});
    P.forEach((p, i) => fdCell(ws, 16, c0 + i, agg.get(p)?.cards || "", {}));
    fdCell(ws, 16, cCny, "", {});
    fdCell(ws, 16, cCnt, "", {});

    // 行17 利润行（成员块与模板一致留空，仅保留数字格式）
    for (let i = 0; i < NP + 1; i++) fdCell(ws, 17, c0 + i, "", { numFmt: FD_NUM_RED, hDefault: true });
    fdCell(ws, 17, cCnt, "", { hDefault: true });
  });
}

/** 年度报表 sheet（R-04.2：整年 12 个月新口径） */
export function buildAnnualSheet(wb: ExcelJS.Workbook, rep: TeamAnnualReport) {
  const ws = wb.addWorksheet(`${rep.year}年度`, { views: [{ state: "frozen", ySplit: 2 }] });

  const HEADERS = [
    "月份", "广告费($)", "广告费(¥)", "核算广告费(¥)", "账面佣金($)", "失效佣金($)",
    "应收佣金($)", "实收佣金($)", "默认实收(¥)", "实际佣金(¥)", "可分配利润(¥)", "汇率(锁定日)",
  ];
  ws.getColumn(1).width = 8;
  for (let c = 2; c <= HEADERS.length; c++) ws.getColumn(c).width = 14;

  ws.mergeCells(1, 1, 1, HEADERS.length);
  setCell(ws, 1, 1, `${rep.year} 年度团队收支报表（新口径 · 全员累计）· 生成 ${rep.generatedAt}`, { fill: CLR.YELLOW, bold: true });
  ws.getRow(1).height = 22;
  HEADERS.forEach((h, i) => setCell(ws, 2, 1 + i, h, { fill: CLR.GRAY, bold: true, wrap: true }));

  let r = 3;
  for (const m of rep.months) {
    setCell(ws, r, 1, `${parseInt(m.month.slice(5), 10)}月`, { bold: true });
    setCell(ws, r, 2, nv(m.adUsd), { numFmt: USD_FMT });
    setCell(ws, r, 3, nv(m.adCny), { numFmt: CNY_FMT });
    setCell(ws, r, 4, nv(m.profitAdCostCny), { numFmt: CNY_FMT });
    setCell(ws, r, 5, nv(m.book), { numFmt: USD_FMT });
    setCell(ws, r, 6, nv(m.rejected), { numFmt: USD_FMT });
    setCell(ws, r, 7, nv(m.recvTotal), { numFmt: USD_FMT });
    setCell(ws, r, 8, nv(m.paidTotal), { numFmt: USD_FMT });
    setCell(ws, r, 9, nv(m.estPaidCny), { numFmt: CNY_FMT });
    setCell(ws, r, 10, m.actualPaidCny != null ? nv(m.actualPaidCny) : "—", { numFmt: m.actualPaidCny != null ? CNY_FMT : undefined });
    setCell(ws, r, 11, nv(m.profitCny), { numFmt: CNY_FMT, bold: true });
    setCell(ws, r, 12, `${m.rate.usdToCny.toFixed(4)}（${m.rate.date}${m.rate.locked ? "" : " 实时"}）`, { wrap: true });
    r++;
  }
  // 年合计
  setCell(ws, r, 1, "年合计", { fill: CLR.GREEN, bold: true });
  setCell(ws, r, 2, nv(rep.totals.adUsd), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
  setCell(ws, r, 3, nv(rep.totals.adCny), { fill: CLR.GREEN, bold: true, numFmt: CNY_FMT });
  setCell(ws, r, 4, nv(rep.totals.profitAdCostCny), { fill: CLR.GREEN, bold: true, numFmt: CNY_FMT });
  setCell(ws, r, 5, nv(rep.totals.book), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
  setCell(ws, r, 6, nv(rep.totals.rejected), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
  setCell(ws, r, 7, nv(rep.totals.recvTotal), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
  setCell(ws, r, 8, nv(rep.totals.paidTotal), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
  setCell(ws, r, 9, nv(rep.totals.estPaidCny), { fill: CLR.GREEN, bold: true, numFmt: CNY_FMT });
  setCell(ws, r, 10, nv(rep.totals.effectiveActualCny), { fill: CLR.GREEN, bold: true, numFmt: CNY_FMT });
  setCell(ws, r, 11, nv(rep.totals.profitCny), { fill: CLR.GREEN_DARK, bold: true, numFmt: CNY_FMT });
  setCell(ws, r, 12, "", { fill: CLR.GREEN });
}

/** 组员个人年度报表 sheet（R-05：逐月合计一行，不分上下半月） */
export function buildMemberAnnualSheet(wb: ExcelJS.Workbook, rep: MemberAnnualReport) {
  const ws = wb.addWorksheet(`${rep.year}年度`, { views: [{ state: "frozen", ySplit: 2 }] });

  const HEADERS = [
    "月份", "广告费($)", "广告费(¥)", "核算广告费($)", "账面佣金($)", "失效佣金($)",
    "应收佣金($)", "实收佣金($)", "实收佣金(¥)", "可分配利润($)", "可分配利润(¥)", "汇率(锁定日)",
  ];
  ws.getColumn(1).width = 8;
  for (let c = 2; c <= HEADERS.length; c++) ws.getColumn(c).width = 14;

  ws.mergeCells(1, 1, 1, HEADERS.length);
  setCell(ws, 1, 1, `${rep.year} 年度个人收支报表（${rep.displayName} / ${rep.username}）· 生成 ${rep.generatedAt}`, { fill: CLR.YELLOW, bold: true });
  ws.getRow(1).height = 22;
  HEADERS.forEach((h, i) => setCell(ws, 2, 1 + i, h, { fill: CLR.GRAY, bold: true, wrap: true }));

  let r = 3;
  for (const m of rep.months) {
    setCell(ws, r, 1, `${parseInt(m.month.slice(5), 10)}月`, { bold: true });
    setCell(ws, r, 2, nv(m.adUsd), { numFmt: USD_FMT });
    setCell(ws, r, 3, nv(m.adCny), { numFmt: CNY_FMT });
    setCell(ws, r, 4, nv(m.profitAdCostUsd), { numFmt: USD_FMT });
    setCell(ws, r, 5, nv(m.book), { numFmt: USD_FMT });
    setCell(ws, r, 6, nv(m.rejected), { numFmt: USD_FMT });
    setCell(ws, r, 7, nv(m.recvTotal), { numFmt: USD_FMT });
    setCell(ws, r, 8, nv(m.paidTotal), { numFmt: USD_FMT });
    setCell(ws, r, 9, nv(m.paidCnyTotal), { numFmt: CNY_FMT });
    setCell(ws, r, 10, nv(m.profitUsd), { numFmt: USD_FMT });
    setCell(ws, r, 11, nv(m.profitCny), { numFmt: CNY_FMT, bold: true });
    setCell(ws, r, 12, `${m.rate.usdToCny.toFixed(4)}（${m.rate.date}${m.rate.locked ? "" : " 实时"}）`, { wrap: true });
    r++;
  }
  // 年合计
  setCell(ws, r, 1, "年合计", { fill: CLR.GREEN, bold: true });
  setCell(ws, r, 2, nv(rep.totals.adUsd), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
  setCell(ws, r, 3, nv(rep.totals.adCny), { fill: CLR.GREEN, bold: true, numFmt: CNY_FMT });
  setCell(ws, r, 4, nv(rep.totals.profitAdCostUsd), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
  setCell(ws, r, 5, nv(rep.totals.book), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
  setCell(ws, r, 6, nv(rep.totals.rejected), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
  setCell(ws, r, 7, nv(rep.totals.recvTotal), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
  setCell(ws, r, 8, nv(rep.totals.paidTotal), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
  setCell(ws, r, 9, nv(rep.totals.paidCnyTotal), { fill: CLR.GREEN, bold: true, numFmt: CNY_FMT });
  setCell(ws, r, 10, nv(rep.totals.profitUsd), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
  setCell(ws, r, 11, nv(rep.totals.profitCny), { fill: CLR.GREEN_DARK, bold: true, numFmt: CNY_FMT });
  setCell(ws, r, 12, "", { fill: CLR.GREEN });
}
