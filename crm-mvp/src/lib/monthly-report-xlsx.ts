/**
 * R-02 月度收支报表 — xlsx 生成（复用 monthly-report 视图模型，版式对齐 7号机 Excel）
 *
 * buildMemberSheet：组员单月表（月份/MCC段/广告费/账号列/佣金区/收款方式/可分配利润）
 * buildSummarySheet：组长总计表（平台聚合 + 实收3列 + 核算广告费CNY + 可分配利润CNY）
 */

import ExcelJS from "exceljs";
import type { MemberMonthlyReport, TeamMonthlySummary } from "@/lib/monthly-report";

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

function setCell(
  ws: ExcelJS.Worksheet,
  r: number,
  c: number,
  value: ExcelJS.CellValue,
  opts: { fill?: string; bold?: boolean; h?: "left" | "center" | "right"; num?: boolean; wrap?: boolean } = {},
) {
  const cell = ws.getCell(r, c);
  cell.value = value;
  if (opts.fill) cell.fill = fill(opts.fill);
  cell.font = font(opts.bold);
  cell.alignment = { horizontal: opts.h || (opts.num ? "right" : "center"), vertical: "middle", wrapText: opts.wrap };
  cell.border = border;
  if (opts.num) cell.numFmt = NUM_FMT;
}

const nv = (n: number): number | string => (n !== 0 ? +n.toFixed(2) : 0);

/** 组员单月表 sheet（版式对齐 7号机 Excel） */
export function buildMemberSheet(wb: ExcelJS.Workbook, rep: MemberMonthlyReport, sheetName?: string) {
  const ws = wb.addWorksheet(sheetName || `${rep.displayName}`);
  const monthNum = parseInt(rep.month.slice(5), 10);

  const mccCols = rep.mccs.length * 2; // 每 MCC 美金/人民币两列
  const acctCols = rep.accounts.length;
  const dataCols = Math.max(mccCols, acctCols, 1);
  const C0 = 3; // 数据列起点（A=标签 B=子标签）
  const totalCol = C0 + dataCols; // 广告费合计 / 佣金合计
  const profitCol = totalCol + 1; // 核算广告费
  const enabledCol = totalCol + 2; // 在投广告数
  const remarkCol = totalCol + 3; // 备注

  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 8;
  for (let c = C0; c <= remarkCol; c++) ws.getColumn(c).width = 13;

  // ── Row1 月份 ──
  setCell(ws, 1, 1, "月份", { fill: CLR.GRAY, bold: true });
  ws.mergeCells(1, 2, 1, totalCol - 1);
  setCell(ws, 1, 2, `${monthNum}月（${rep.displayName} / ${rep.username}）`, { fill: CLR.YELLOW, bold: true });
  ws.mergeCells(1, totalCol, 1, remarkCol);
  setCell(ws, 1, totalCol, `汇率 1USD=${rep.rate.usdToCny.toFixed(4)}CNY（${rep.rate.date}${rep.rate.locked ? " 月末锁定" : " 实时"}）`, { fill: CLR.YELLOW });

  // ── Row2 MCC 段头 ──
  setCell(ws, 2, 1, "MCC", { fill: CLR.GRAY, bold: true });
  setCell(ws, 2, 2, "", { fill: CLR.GRAY });
  rep.mccs.forEach((m, i) => {
    const start = C0 + i * 2;
    ws.mergeCells(2, start, 2, start + 1);
    setCell(ws, 2, start, `${m.mccName}\n(${m.mccId})`, { fill: CLR.ORANGE, bold: true, wrap: true });
  });
  for (let c = C0 + mccCols; c < totalCol; c++) setCell(ws, 2, c, "", {});
  setCell(ws, 2, totalCol, "广告费合计", { fill: CLR.GRAY, bold: true, wrap: true });
  setCell(ws, 2, profitCol, "用于核算利润的广告费", { fill: CLR.GRAY, bold: true, wrap: true });
  setCell(ws, 2, enabledCol, "在投广告数", { fill: CLR.GRAY, bold: true, wrap: true });
  setCell(ws, 2, remarkCol, "备注", { fill: CLR.GRAY, bold: true });
  ws.getRow(2).height = 30;

  // ── Row3 币种 ──
  setCell(ws, 3, 1, "币种", { fill: CLR.GRAY, bold: true });
  setCell(ws, 3, 2, "", {});
  rep.mccs.forEach((m, i) => {
    const start = C0 + i * 2;
    setCell(ws, 3, start, "美金", {});
    setCell(ws, 3, start + 1, "人民币", {});
  });
  for (let c = C0 + mccCols; c < totalCol; c++) setCell(ws, 3, c, "", {});
  setCell(ws, 3, totalCol, "美金/人民币", {});
  setCell(ws, 3, profitCol, "美金", {});
  setCell(ws, 3, enabledCol, rep.enabledCampaigns, {});
  setCell(ws, 3, remarkCol, "", {});

  // ── Row4 广告费 ──
  setCell(ws, 4, 1, "广告费", { fill: CLR.BLUE_LIGHT, bold: true });
  setCell(ws, 4, 2, "", { fill: CLR.BLUE_LIGHT });
  rep.mccs.forEach((m, i) => {
    const start = C0 + i * 2;
    if (m.currency === "CNY") {
      setCell(ws, 4, start, "", {});
      setCell(ws, 4, start + 1, nv(m.effectiveOriginal), { num: true });
    } else {
      setCell(ws, 4, start, nv(m.effectiveOriginal), { num: true });
      setCell(ws, 4, start + 1, "", {});
    }
  });
  for (let c = C0 + mccCols; c < totalCol; c++) setCell(ws, 4, c, "", {});
  setCell(ws, 4, totalCol, `$${rep.adCostTotalUsd.toFixed(2)}${rep.adCostTotalCny > 0 ? ` / ¥${rep.adCostTotalCny.toFixed(2)}` : ""}`, { fill: CLR.GREEN, bold: true });
  setCell(ws, 4, profitCol, nv(rep.profitAdCostUsd), { fill: CLR.GREEN, bold: true, num: true });
  setCell(ws, 4, enabledCol, "", {});
  setCell(ws, 4, remarkCol, "", {});

  // ── Row5 广告联盟 / Row6 账号名称 ──
  setCell(ws, 5, 1, "广告联盟", { fill: CLR.GRAY, bold: true });
  setCell(ws, 5, 2, "", { fill: CLR.GRAY });
  setCell(ws, 6, 1, "账号名称", { fill: CLR.GRAY, bold: true });
  setCell(ws, 6, 2, "", { fill: CLR.GRAY });
  rep.accounts.forEach((a, i) => {
    setCell(ws, 5, C0 + i, a.label, { fill: CLR.ORANGE, bold: true });
    setCell(ws, 6, C0 + i, a.accountName, {});
  });
  for (let c = C0 + acctCols; c < totalCol; c++) { setCell(ws, 5, c, "", {}); setCell(ws, 6, c, "", {}); }
  setCell(ws, 5, totalCol, "佣金合计", { fill: CLR.GRAY, bold: true });
  setCell(ws, 6, totalCol, "", {});
  for (const r of [5, 6]) { setCell(ws, r, profitCol, "", {}); setCell(ws, r, enabledCol, "", {}); setCell(ws, r, remarkCol, "", {}); }

  // ── 数值行辅助 ──
  type RowSpec = {
    label: string;
    sub?: string;
    get: (a: MemberMonthlyReport["accounts"][number]) => number | string;
    total: number;
    labelSpan?: number;
  };
  const rows: RowSpec[] = [
    { label: "账面佣金（美金）", get: (a) => nv(a.book), total: rep.totals.book },
    { label: "失效佣金（美金）", get: (a) => nv(a.rejected), total: rep.totals.rejected },
    { label: "应收佣金（美金）", sub: "5号", get: (a) => (a.hasPayments ? nv(a.recvH1) : ""), total: rep.totals.recvH1 },
    { label: "", sub: "15号", get: (a) => (a.hasPayments ? nv(a.recvH2) : ""), total: rep.totals.recvH2 },
    { label: "", sub: "合计", get: (a) => (a.hasPayments ? nv(a.recvH1 + a.recvH2) : ""), total: rep.totals.recvTotal },
    { label: "实收佣金（美金）", sub: "10号", get: (a) => (a.hasPayments || a.paidH1Override != null ? nv(a.paidH1Effective) : ""), total: rep.totals.paidH1 },
    { label: "", sub: "20号", get: (a) => (a.hasPayments || a.paidH2Override != null ? nv(a.paidH2Effective) : ""), total: rep.totals.paidH2 },
    { label: "", sub: "合计", get: (a) => (a.hasPayments || a.paidH1Override != null || a.paidH2Override != null ? nv(a.paidH1Effective + a.paidH2Effective) : ""), total: rep.totals.paidTotal },
  ];

  let r = 7;
  for (const spec of rows) {
    const isTotal = spec.sub === "合计";
    setCell(ws, r, 1, spec.label, { fill: CLR.GRAY, bold: !!spec.label, h: "left" });
    setCell(ws, r, 2, spec.sub || "", { fill: CLR.GRAY });
    rep.accounts.forEach((a, i) => {
      const v = spec.get(a);
      setCell(ws, r, C0 + i, v, { num: typeof v === "number", bold: isTotal });
    });
    for (let c = C0 + acctCols; c < totalCol; c++) setCell(ws, r, c, "", {});
    setCell(ws, r, totalCol, nv(spec.total), { fill: CLR.GREEN, bold: true, num: true });
    setCell(ws, r, profitCol, "", {});
    setCell(ws, r, enabledCol, "", {});
    setCell(ws, r, remarkCol, "", {});
    r++;
  }

  // ── 收款人 / 收款卡号 ──
  for (const [label, get] of [
    ["收款人", (a: MemberMonthlyReport["accounts"][number]) => a.payeeName] as const,
    ["收款卡号", (a: MemberMonthlyReport["accounts"][number]) => a.cardNo] as const,
  ]) {
    setCell(ws, r, 1, label, { fill: CLR.GRAY, bold: true, h: "left" });
    setCell(ws, r, 2, "", { fill: CLR.GRAY });
    rep.accounts.forEach((a, i) => setCell(ws, r, C0 + i, get(a), {}));
    for (let c = C0 + acctCols; c <= remarkCol; c++) setCell(ws, r, c, "", {});
    r++;
  }

  // ── 可分配利润 ──
  setCell(ws, r, 1, "可分配利润（实收佣金-广告费）", { fill: CLR.GREEN_DARK, bold: true, h: "left" });
  setCell(ws, r, 2, "", { fill: CLR.GREEN_DARK });
  ws.mergeCells(r, C0, r, totalCol - 1);
  setCell(ws, r, C0, `$${rep.profit.usd.toFixed(2)} / ¥${rep.profit.cny.toFixed(2)}`, { fill: CLR.GREEN, bold: true });
  for (let c = totalCol; c <= remarkCol; c++) setCell(ws, r, c, "", { fill: CLR.GREEN });

  ws.views = [{ state: "frozen", xSplit: 2, ySplit: 0 }];
}

/** 组长总计表 sheet */
export function buildSummarySheet(wb: ExcelJS.Workbook, sum: TeamMonthlySummary) {
  const ws = wb.addWorksheet("总计表", { views: [{ state: "frozen", ySplit: 2 }] });
  const monthNum = parseInt(sum.month.slice(5), 10);

  const HEADERS = ["平台", "账面佣金($)", "失效佣金($)", "应收·上半月", "应收·下半月", "应收合计", "实收·上半月", "实收·下半月", "实收合计"];
  ws.getColumn(1).width = 10;
  for (let c = 2; c <= HEADERS.length; c++) ws.getColumn(c).width = 13;

  ws.mergeCells(1, 1, 1, HEADERS.length);
  setCell(ws, 1, 1, `${monthNum}月 团队收支总计（全员累计）· 汇率 1USD=${sum.rate.usdToCny.toFixed(4)}CNY（${sum.rate.date}${sum.rate.locked ? " 月末锁定" : " 实时"}）`, { fill: CLR.YELLOW, bold: true });
  ws.getRow(1).height = 24;

  HEADERS.forEach((h, i) => setCell(ws, 2, 1 + i, h, { fill: CLR.GRAY, bold: true }));

  let r = 3;
  for (const p of sum.platforms) {
    setCell(ws, r, 1, p.platform, { bold: true });
    [p.book, p.rejected, p.recvH1, p.recvH2, p.recvTotal, p.paidH1, p.paidH2, p.paidTotal].forEach((v, i) =>
      setCell(ws, r, 2 + i, nv(v), { num: true }),
    );
    r++;
  }
  setCell(ws, r, 1, "合计", { fill: CLR.GREEN, bold: true });
  [sum.totals.book, sum.totals.rejected, sum.totals.recvH1, sum.totals.recvH2, sum.totals.recvTotal, sum.totals.paidH1, sum.totals.paidH2, sum.totals.paidTotal]
    .forEach((v, i) => setCell(ws, r, 2 + i, nv(v), { fill: CLR.GREEN, bold: true, num: true }));
  r += 2;

  const kv: [string, string][] = [
    ["广告费合计($)", `$${sum.adCostTotalUsd.toFixed(2)}`],
    ["广告费合计(¥)", `¥${sum.adCostTotalCny.toFixed(2)}`],
    ["用于核算利润的广告费(¥)", `¥${sum.profitAdCostCny.toFixed(2)}`],
    ["在投广告数", String(sum.enabledCampaigns)],
    ["实收佣金(USD) · 员工累计", `$${sum.paidUsdTotal.toFixed(2)}`],
    ["预估实收(CNY) · 汇率折算", `¥${sum.estimatedPaidCny.toFixed(2)}`],
    ["实际佣金(CNY) · 组长手填", sum.actualPaidCny != null ? `¥${sum.actualPaidCny.toFixed(2)}` : "未填"],
    ["可分配利润(CNY)", `¥${sum.profitCny.toFixed(2)}`],
  ];
  for (const [label, value] of kv) {
    ws.mergeCells(r, 1, r, 3);
    setCell(ws, r, 1, label, { fill: CLR.GRAY, bold: true, h: "left" });
    ws.mergeCells(r, 4, r, 6);
    setCell(ws, r, 4, value, { fill: label.startsWith("可分配") ? CLR.GREEN_DARK : CLR.WHITE, bold: label.startsWith("可分配"), h: "right" });
    r++;
  }
}
