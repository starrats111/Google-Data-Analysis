/**
 * R-02/R-04 月度收支报表 — xlsx 生成（复用 monthly-report 视图模型）
 *
 * buildMemberSheet：组员单月表（R-04.3：MCC 段竖排，一行一 MCC，与网页一致）
 * buildSummarySheet：组长总计表（R-04.5：对齐「总收支统计」模板——平台占2列，
 *   账面/失效/应收行合并；实收3行拆左$（支付数据）右¥（组长手填）；
 *   收款人按人分开、多卡同格）
 * buildAnnualSheet：年度报表（R-04.2 新口径整年 12 个月）
 */

import ExcelJS from "exceljs";
import type { MemberMonthlyReport, TeamMonthlySummary, TeamAnnualReport, MemberAnnualReport } from "@/lib/monthly-report";

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

/** 组员单月表 sheet（R-04.3：MCC 竖排；R-05：账号占 2 列，实收拆 USD/CNY 双列） */
export function buildMemberSheet(wb: ExcelJS.Workbook, rep: MemberMonthlyReport, sheetName?: string) {
  const ws = wb.addWorksheet(sheetName || `${rep.displayName}`);
  const monthNum = parseInt(rep.month.slice(5), 10);

  const acctCols = rep.accounts.length;
  const C0 = 3; // 佣金区数据列起点（A=标签 B=子标签），每账号占 2 列
  const acctCol = (i: number) => C0 + i * 2;
  const totalCol = C0 + Math.max(acctCols, 1) * 2; // 佣金合计列
  const lastCol = Math.max(totalCol, 6);

  ws.getColumn(1).width = 24;
  ws.getColumn(2).width = 12;
  for (let c = C0; c <= lastCol; c++) ws.getColumn(c).width = 12;
  ws.getColumn(totalCol).width = 16;

  // ── Row1 月份 + 汇率 ──
  setCell(ws, 1, 1, "月份", { fill: CLR.GRAY, bold: true });
  ws.mergeCells(1, 2, 1, 3);
  setCell(ws, 1, 2, `${monthNum}月（${rep.displayName} / ${rep.username}）`, { fill: CLR.YELLOW, bold: true });
  ws.mergeCells(1, 4, 1, lastCol);
  setCell(ws, 1, 4, `汇率 1USD=${rep.rate.usdToCny.toFixed(4)}CNY（${rep.rate.date}${rep.rate.locked ? " 月末锁定" : " 实时"}）· 生成 ${rep.generatedAt}`, { fill: CLR.YELLOW });

  // ── MCC 段（竖排：一行一 MCC） ──
  let r = 2;
  const mccHeaders = ["MCC", "币种", "库内广告费(原币)", "补差额($)", "广告费(原币)", "折美金($)"];
  mccHeaders.forEach((h, i) => setCell(ws, r, 1 + i, h, { fill: CLR.GRAY, bold: true, wrap: true }));
  for (let c = mccHeaders.length + 1; c <= lastCol; c++) setCell(ws, r, c, "", {});
  r++;

  if (rep.mccs.length === 0) {
    ws.mergeCells(r, 1, r, mccHeaders.length);
    setCell(ws, r, 1, "本月无 MCC 账户", { h: "center" });
    for (let c = mccHeaders.length + 1; c <= lastCol; c++) setCell(ws, r, c, "", {});
    r++;
  } else {
    for (const m of rep.mccs) {
      setCell(ws, r, 1, `${m.mccName} (${m.mccId})`, { fill: CLR.ORANGE, h: "left", wrap: true });
      setCell(ws, r, 2, m.currency === "CNY" ? "人民币" : "美金", {});
      setCell(ws, r, 3, nv(m.costOriginal), { num: true });
      setCell(ws, r, 4, m.adjustment !== 0 ? nv(m.adjustment) : "", { num: m.adjustment !== 0 });
      setCell(ws, r, 5, nv(m.effectiveOriginal), { num: true, fill: m.override != null ? CLR.BLUE_LIGHT : undefined });
      setCell(ws, r, 6, nv(m.effectiveUsd), { num: true });
      for (let c = mccHeaders.length + 1; c <= lastCol; c++) setCell(ws, r, c, "", {});
      r++;
    }
  }

  // 广告费合计行
  ws.mergeCells(r, 1, r, 2);
  setCell(ws, r, 1, "广告费合计", { fill: CLR.GREEN_DARK, bold: true, h: "left" });
  ws.mergeCells(r, 3, r, 4);
  setCell(ws, r, 3, `$${rep.adCostTotalUsd.toFixed(2)}${rep.adCostTotalCny > 0 ? ` ｜ ¥${rep.adCostTotalCny.toFixed(2)}` : ""}`, { fill: CLR.GREEN, bold: true });
  setCell(ws, r, 5, `核算广告费 $${rep.profitAdCostUsd.toFixed(2)}`, { fill: CLR.GREEN, bold: true, wrap: true });
  setCell(ws, r, 6, `在投广告数 ${rep.enabledCampaigns}`, { fill: CLR.GREEN, bold: true, wrap: true });
  for (let c = 7; c <= lastCol; c++) setCell(ws, r, c, "", {});
  r += 2; // 空一行

  // ── 佣金区（动态账号列，每账号占 2 列） ──
  const acctStart = r;
  setCell(ws, r, 1, "广告联盟", { fill: CLR.GRAY, bold: true });
  setCell(ws, r, 2, "", { fill: CLR.GRAY });
  setCell(ws, r + 1, 1, "账号名称", { fill: CLR.GRAY, bold: true });
  setCell(ws, r + 1, 2, "", { fill: CLR.GRAY });
  rep.accounts.forEach((a, i) => {
    ws.mergeCells(acctStart, acctCol(i), acctStart, acctCol(i) + 1);
    setCell(ws, acctStart, acctCol(i), a.label, { fill: CLR.ORANGE, bold: true });
    ws.mergeCells(acctStart + 1, acctCol(i), acctStart + 1, acctCol(i) + 1);
    setCell(ws, acctStart + 1, acctCol(i), a.accountName, {});
  });
  setCell(ws, acctStart, totalCol, "佣金合计", { fill: CLR.GRAY, bold: true });
  setCell(ws, acctStart + 1, totalCol, "", {});
  r = acctStart + 2;

  // 账面/失效/应收（账号 2 列合并）
  type RowSpec = {
    label: string;
    sub?: string;
    get: (a: MemberMonthlyReport["accounts"][number]) => number | string;
    total: number;
  };
  const mergedRows: RowSpec[] = [
    { label: "账面佣金（美金）", get: (a) => nv(a.book), total: rep.totals.book },
    { label: "失效佣金（美金）", get: (a) => nv(a.rejected), total: rep.totals.rejected },
    { label: "应收佣金（美金）", sub: "5号", get: (a) => (a.hasPayments ? nv(a.recvH1) : ""), total: rep.totals.recvH1 },
    { label: "", sub: "15号", get: (a) => (a.hasPayments ? nv(a.recvH2) : ""), total: rep.totals.recvH2 },
    { label: "", sub: "合计", get: (a) => (a.hasPayments ? nv(a.recvH1 + a.recvH2) : ""), total: rep.totals.recvTotal },
  ];
  for (const spec of mergedRows) {
    const isTotal = spec.sub === "合计";
    setCell(ws, r, 1, spec.label, { fill: CLR.GRAY, bold: !!spec.label, h: "left" });
    setCell(ws, r, 2, spec.sub || "", { fill: CLR.GRAY });
    rep.accounts.forEach((a, i) => {
      const v = spec.get(a);
      ws.mergeCells(r, acctCol(i), r, acctCol(i) + 1);
      setCell(ws, r, acctCol(i), v, { num: typeof v === "number", bold: isTotal });
    });
    setCell(ws, r, totalCol, nv(spec.total), { fill: CLR.GREEN, bold: true, num: true });
    r++;
  }

  // 实收佣金：每账号拆 USD/CNY 双列（CNY 默认逐笔按打款日汇率，手填蓝底）
  setCell(ws, r, 1, "实收佣金", { fill: CLR.GRAY, bold: true, h: "left" });
  setCell(ws, r, 2, "", { fill: CLR.GRAY });
  rep.accounts.forEach((_, i) => {
    setCell(ws, r, acctCol(i), "实收佣金(USD)", { fill: CLR.GRAY, bold: true, wrap: true });
    setCell(ws, r, acctCol(i) + 1, "实收佣金(CNY)", { fill: CLR.GRAY, bold: true, wrap: true });
  });
  setCell(ws, r, totalCol, "$ / ¥", { fill: CLR.GRAY, bold: true });
  r++;

  const paidSpecs: {
    sub: string;
    usd: (a: MemberMonthlyReport["accounts"][number]) => number | string;
    cny: (a: MemberMonthlyReport["accounts"][number]) => { v: number | string; manual: boolean };
    totalUsd: number;
    totalCny: number;
  }[] = [
    {
      sub: "10号",
      usd: (a) => (a.hasPayments || a.paidH1Override != null ? nv(a.paidH1Effective) : ""),
      cny: (a) => ({ v: a.hasPayments || a.paidCnyH1Override != null ? nv(a.paidCnyH1Effective) : "", manual: a.paidCnyH1Override != null }),
      totalUsd: rep.totals.paidH1,
      totalCny: rep.totals.paidCnyH1,
    },
    {
      sub: "20号",
      usd: (a) => (a.hasPayments || a.paidH2Override != null ? nv(a.paidH2Effective) : ""),
      cny: (a) => ({ v: a.hasPayments || a.paidCnyH2Override != null ? nv(a.paidCnyH2Effective) : "", manual: a.paidCnyH2Override != null }),
      totalUsd: rep.totals.paidH2,
      totalCny: rep.totals.paidCnyH2,
    },
    {
      sub: "合计",
      usd: (a) => (a.hasPayments || a.paidH1Override != null || a.paidH2Override != null ? nv(a.paidH1Effective + a.paidH2Effective) : ""),
      cny: (a) => ({
        v: a.hasPayments || a.paidCnyH1Override != null || a.paidCnyH2Override != null ? nv(a.paidCnyH1Effective + a.paidCnyH2Effective) : "",
        manual: a.paidCnyH1Override != null || a.paidCnyH2Override != null,
      }),
      totalUsd: rep.totals.paidTotal,
      totalCny: rep.totals.paidCnyTotal,
    },
  ];
  for (const spec of paidSpecs) {
    const isTotal = spec.sub === "合计";
    setCell(ws, r, 1, "", { fill: CLR.GRAY });
    setCell(ws, r, 2, spec.sub, { fill: CLR.GRAY });
    rep.accounts.forEach((a, i) => {
      const usd = spec.usd(a);
      const cny = spec.cny(a);
      setCell(ws, r, acctCol(i), usd, { numFmt: typeof usd === "number" ? USD_FMT : undefined, bold: isTotal });
      setCell(ws, r, acctCol(i) + 1, cny.v, {
        numFmt: typeof cny.v === "number" ? CNY_FMT : undefined,
        bold: isTotal,
        fill: cny.manual ? CLR.BLUE_LIGHT : undefined,
      });
    });
    setCell(ws, r, totalCol, `$${spec.totalUsd.toFixed(2)} / ¥${spec.totalCny.toFixed(2)}`, { fill: CLR.GREEN, bold: true, wrap: true });
    r++;
  }

  // ── 收款人 / 收款卡号 ──
  for (const [label, get] of [
    ["收款人", (a: MemberMonthlyReport["accounts"][number]) => a.payeeName] as const,
    ["收款卡号", (a: MemberMonthlyReport["accounts"][number]) => a.cardNo] as const,
  ]) {
    setCell(ws, r, 1, label, { fill: CLR.GRAY, bold: true, h: "left" });
    setCell(ws, r, 2, "", { fill: CLR.GRAY });
    rep.accounts.forEach((a, i) => {
      ws.mergeCells(r, acctCol(i), r, acctCol(i) + 1);
      setCell(ws, r, acctCol(i), get(a), {});
    });
    setCell(ws, r, totalCol, "", {});
    r++;
  }

  // ── 可分配利润 ──
  ws.mergeCells(r, 1, r, 2);
  setCell(ws, r, 1, "可分配利润（实收佣金-广告费）", { fill: CLR.GREEN_DARK, bold: true, h: "left" });
  ws.mergeCells(r, C0, r, totalCol);
  setCell(ws, r, C0, `$${rep.profit.usd.toFixed(2)} / ¥${rep.profit.cny.toFixed(2)}`, { fill: CLR.GREEN, bold: true });

  ws.views = [{ state: "frozen", xSplit: 2, ySplit: 0 }];
}

/** 组长总计表 sheet（R-04.5：对齐「总收支统计」模板） */
export function buildSummarySheet(wb: ExcelJS.Workbook, sum: TeamMonthlySummary) {
  const ws = wb.addWorksheet("总计表");
  const monthNum = parseInt(sum.month.slice(5), 10);

  const plats = sum.platforms;
  const C0 = 3; // 平台列起点（A=标签 B=子标签），每平台占 2 列
  const platCol = (i: number) => C0 + i * 2;
  const totalCol = C0 + plats.length * 2; // 佣金合计
  const adUsdCol = totalCol + 1;
  const adCnyCol = totalCol + 2;
  const profitAdCol = totalCol + 3;
  const enabledCol = totalCol + 4;

  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 8;
  for (let c = C0; c < totalCol; c++) ws.getColumn(c).width = 11;
  for (const c of [totalCol, adUsdCol, adCnyCol, profitAdCol, enabledCol]) ws.getColumn(c).width = 14;

  // ── Row1 月份 ──
  setCell(ws, 1, 1, "月份", { fill: CLR.GRAY, bold: true });
  ws.mergeCells(1, 2, 1, enabledCol);
  setCell(ws, 1, 2, `${monthNum}月 团队收支总计（全员累计）· 汇率 1USD=${sum.rate.usdToCny.toFixed(4)}CNY（${sum.rate.date}${sum.rate.locked ? " 月末锁定" : " 实时"}）`, { fill: CLR.YELLOW, bold: true });
  ws.getRow(1).height = 22;

  // ── Row2 广告联盟表头（平台占2列合并） + 右侧广告费头 ──
  setCell(ws, 2, 1, "广告联盟", { fill: CLR.GRAY, bold: true });
  setCell(ws, 2, 2, "", { fill: CLR.GRAY });
  plats.forEach((p, i) => {
    ws.mergeCells(2, platCol(i), 2, platCol(i) + 1);
    setCell(ws, 2, platCol(i), p.platform, { fill: CLR.ORANGE, bold: true });
  });
  setCell(ws, 2, totalCol, "佣金合计", { fill: CLR.GRAY, bold: true });
  setCell(ws, 2, adUsdCol, "广告费合计($)", { fill: CLR.GRAY, bold: true, wrap: true });
  setCell(ws, 2, adCnyCol, "广告费合计(¥)", { fill: CLR.GRAY, bold: true, wrap: true });
  setCell(ws, 2, profitAdCol, "用于核算利润的广告费(¥)", { fill: CLR.GRAY, bold: true, wrap: true });
  setCell(ws, 2, enabledCol, "在投广告数", { fill: CLR.GRAY, bold: true, wrap: true });
  ws.getRow(2).height = 28;

  // ── Row3 广告费行 ──
  setCell(ws, 3, 1, "广告费", { fill: CLR.BLUE_LIGHT, bold: true });
  setCell(ws, 3, 2, "", { fill: CLR.BLUE_LIGHT });
  plats.forEach((_, i) => {
    ws.mergeCells(3, platCol(i), 3, platCol(i) + 1);
    setCell(ws, 3, platCol(i), "", {});
  });
  setCell(ws, 3, totalCol, "", {});
  setCell(ws, 3, adUsdCol, nv(sum.adCostTotalUsd), { numFmt: USD_FMT, bold: true });
  setCell(ws, 3, adCnyCol, nv(sum.adCostTotalCny), { numFmt: CNY_FMT, bold: true });
  setCell(ws, 3, profitAdCol, nv(sum.profitAdCostCny), { numFmt: CNY_FMT, bold: true });
  setCell(ws, 3, enabledCol, sum.enabledCampaigns, {});

  // ── 数值行：账面/失效/应收（平台2列合并）──
  let r = 4;
  type MergedRow = { label: string; sub?: string; get: (p: TeamMonthlySummary["platforms"][number]) => number; total: number };
  const mergedRows: MergedRow[] = [
    { label: "账面佣金（美金）", get: (p) => p.book, total: sum.totals.book },
    { label: "失效佣金（美金）", get: (p) => p.rejected, total: sum.totals.rejected },
    { label: "应收佣金（美金）", sub: "5号", get: (p) => p.recvH1, total: sum.totals.recvH1 },
    { label: "", sub: "15号", get: (p) => p.recvH2, total: sum.totals.recvH2 },
    { label: "", sub: "合计", get: (p) => p.recvTotal, total: sum.totals.recvTotal },
  ];
  for (const spec of mergedRows) {
    const isTotal = spec.sub === "合计";
    setCell(ws, r, 1, spec.label, { fill: CLR.GRAY, bold: !!spec.label, h: "left" });
    setCell(ws, r, 2, spec.sub || "", { fill: CLR.GRAY });
    plats.forEach((p, i) => {
      ws.mergeCells(r, platCol(i), r, platCol(i) + 1);
      setCell(ws, r, platCol(i), nv(spec.get(p)), { numFmt: USD_FMT, bold: isTotal });
    });
    setCell(ws, r, totalCol, nv(spec.total), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
    for (const c of [adUsdCol, adCnyCol, profitAdCol, enabledCol]) setCell(ws, r, c, "", {});
    r++;
  }

  // ── 实收佣金 3 行：平台拆 左$（支付数据）右¥（组长手填，未填=成员实收CNY默认值）──
  const paidRows: {
    sub: string;
    usd: (p: TeamMonthlySummary["platforms"][number]) => number;
    cny: (p: TeamMonthlySummary["platforms"][number]) => { v: number; manual: boolean };
    totalUsd: number;
  }[] = [
    {
      sub: "10号",
      usd: (p) => p.paidH1,
      cny: (p) => (p.paidCnyH1 != null ? { v: p.paidCnyH1, manual: true } : { v: p.memberCnyH1, manual: false }),
      totalUsd: sum.totals.paidH1,
    },
    {
      sub: "20号",
      usd: (p) => p.paidH2,
      cny: (p) => (p.paidCnyH2 != null ? { v: p.paidCnyH2, manual: true } : { v: p.memberCnyH2, manual: false }),
      totalUsd: sum.totals.paidH2,
    },
    {
      sub: "合计",
      usd: (p) => p.paidTotal,
      cny: (p) => {
        const v = (p.paidCnyH1 ?? p.memberCnyH1) + (p.paidCnyH2 ?? p.memberCnyH2);
        return { v: +v.toFixed(2), manual: p.paidCnyH1 != null || p.paidCnyH2 != null };
      },
      totalUsd: sum.totals.paidTotal,
    },
  ];
  const paidLabel = ["实收佣金", "左$=支付数据", "右¥=手填(默认打款日汇率折算)"];
  paidRows.forEach((spec, idx) => {
    const isTotal = spec.sub === "合计";
    setCell(ws, r, 1, idx === 0 ? paidLabel.join("\n") : "", { fill: CLR.GRAY, bold: idx === 0, h: "left", wrap: true });
    setCell(ws, r, 2, spec.sub, { fill: CLR.GRAY });
    plats.forEach((p, i) => {
      const cny = spec.cny(p);
      setCell(ws, r, platCol(i), nv(spec.usd(p)), { numFmt: USD_FMT, bold: isTotal });
      setCell(ws, r, platCol(i) + 1, cny.v !== 0 || cny.manual ? +cny.v.toFixed(2) : "", {
        numFmt: CNY_FMT,
        bold: isTotal,
        fill: cny.manual ? CLR.BLUE_LIGHT : undefined,
      });
    });
    setCell(ws, r, totalCol, nv(spec.totalUsd), { fill: CLR.GREEN, bold: true, numFmt: USD_FMT });
    for (const c of [adUsdCol, adCnyCol, profitAdCol, enabledCol]) setCell(ws, r, c, "", {});
    r++;
  });

  // ── 收款人 / 收款卡号（按人分开一行一人；多卡同格顿号分隔）──
  setCell(ws, r, 1, "收款人", { fill: CLR.GRAY, bold: true, h: "left" });
  setCell(ws, r, 2, "", { fill: CLR.GRAY });
  setCell(ws, r + 1, 1, "收款卡号", { fill: CLR.GRAY, bold: true, h: "left" });
  setCell(ws, r + 1, 2, "", { fill: CLR.GRAY });
  let maxPayeeLines = 1;
  plats.forEach((p, i) => {
    const names = p.payees.map((pe) => pe.name).join("\n");
    const cards = p.payees.map((pe) => pe.cards.join("、") || "—").join("\n");
    maxPayeeLines = Math.max(maxPayeeLines, p.payees.length);
    ws.mergeCells(r, platCol(i), r, platCol(i) + 1);
    setCell(ws, r, platCol(i), names, { wrap: true });
    ws.mergeCells(r + 1, platCol(i), r + 1, platCol(i) + 1);
    setCell(ws, r + 1, platCol(i), cards, { wrap: true });
  });
  for (const c of [totalCol, adUsdCol, adCnyCol, profitAdCol, enabledCol]) {
    setCell(ws, r, c, "", {});
    setCell(ws, r + 1, c, "", {});
  }
  ws.getRow(r).height = Math.max(18, maxPayeeLines * 14);
  ws.getRow(r + 1).height = Math.max(18, maxPayeeLines * 14);
  r += 2;

  // ── 实收3列 + 可分配利润 ──
  ws.mergeCells(r, 1, r, 2);
  setCell(ws, r, 1, "实收佣金(USD)·员工累计", { fill: CLR.GRAY, bold: true, h: "left" });
  ws.mergeCells(r, C0, r, C0 + 1);
  setCell(ws, r, C0, nv(sum.paidUsdTotal), { numFmt: USD_FMT, bold: true });
  ws.mergeCells(r, C0 + 2, r, C0 + 3);
  setCell(ws, r, C0 + 2, "默认实收(CNY)·打款日汇率", { fill: CLR.GRAY, bold: true });
  ws.mergeCells(r, C0 + 4, r, C0 + 5);
  setCell(ws, r, C0 + 4, nv(sum.estimatedPaidCny), { numFmt: CNY_FMT, bold: true });
  ws.mergeCells(r, C0 + 6, r, C0 + 7);
  setCell(ws, r, C0 + 6, "实际佣金(CNY)", { fill: CLR.GRAY, bold: true });
  ws.mergeCells(r, C0 + 8, r, C0 + 9);
  setCell(ws, r, C0 + 8, sum.actualPaidCny != null ? nv(sum.actualPaidCny) : "未填", { numFmt: sum.actualPaidCny != null ? CNY_FMT : undefined, bold: true });
  r++;

  ws.mergeCells(r, 1, r, 2);
  setCell(ws, r, 1, "可分配利润（实收佣金-核算广告费）", { fill: CLR.GREEN_DARK, bold: true, h: "left" });
  ws.mergeCells(r, C0, r, enabledCol);
  setCell(ws, r, C0, `¥${sum.profitCny.toFixed(2)}（${sum.actualPaidCny != null ? "实际佣金" : "预估实收"} − 核算广告费 ¥${sum.profitAdCostCny.toFixed(2)}）`, { fill: CLR.GREEN, bold: true, h: "left" });

  ws.views = [{ state: "frozen", xSplit: 2, ySplit: 2 }];
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
