import { NextRequest, NextResponse } from "next/server";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import ExcelJS from "exceljs";

export const dynamic = "force-dynamic";

// ────────── 颜色常量（对齐原始丰度报表） ──────────────────────────────────────
const CLR = {
  YELLOW:       "FFFF00",  // 月份标题行
  GREEN:        "92D050",  // 平台表头 / 有效佣金行
  GREEN_DARK:   "70AD47",  // 小计/合计列
  RED_LIGHT:    "FFCCCC",  // 拒付佣金行
  BLUE_LIGHT:   "DAEEF3",  // 广告费行
  GOLD:         "FFD966",  // 净收益行
  GRAY_HEAD:    "D9D9D9",  // 合计组列头
  WHITE:        "FFFFFF",  // 普通数据行
  // 成员列头依次循环
  MEM_COLORS:   ["BDD7EE","FCE4D6","E2EFDA","F4B8C1","D9E1F2","FFF2CC","E2EFDA","DAEEF3","EAD1DC","D5E8D4"],
};

type ArgbFill = { type: "pattern"; pattern: "solid"; fgColor: { argb: string } };
function fill(hex: string): ArgbFill { return { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + hex } }; }
function font(bold = false, sz = 10, color = "000000"): Partial<ExcelJS.Font> { return { bold, size: sz, color: { argb: "FF" + color }, name: "Arial" }; }
function align(h: "left"|"center"|"right" = "center", wrap = false): Partial<ExcelJS.Alignment> { return { horizontal: h, vertical: "middle", wrapText: wrap }; }

const thinBorder: Partial<ExcelJS.Borders> = {
  top:    { style: "thin", color: { argb: "FFB0B0B0" } },
  left:   { style: "thin", color: { argb: "FFB0B0B0" } },
  bottom: { style: "thin", color: { argb: "FFB0B0B0" } },
  right:  { style: "thin", color: { argb: "FFB0B0B0" } },
};
const thickBorder: Partial<ExcelJS.Borders> = {
  top:    { style: "medium", color: { argb: "FF595959" } },
  left:   { style: "medium", color: { argb: "FF595959" } },
  bottom: { style: "medium", color: { argb: "FF595959" } },
  right:  { style: "medium", color: { argb: "FF595959" } },
};

// ────────── 数据类型 ─────────────────────────────────────────────────────────
interface MemberInfo { id: string; username: string; display_name: string }
type PlatStat = { total: number; rejected: number; active: number };
type MonthData = Record<string, Record<string, Record<string, PlatStat>>>;
type SpendData = Record<string, Record<string, number>>;

// ────────── 汇总计算 ─────────────────────────────────────────────────────────
function sumStat(
  key: "total"|"rejected"|"active"|"adSpend"|"net",
  months: string[], userIds: string[], platform: string|null,
  data: MonthData, spend: SpendData
): number {
  if (key === "net") {
    return sumStat("active", months, userIds, platform, data, spend)
         - (platform === null ? sumStat("adSpend", months, userIds, null, data, spend) : 0);
  }
  let acc = 0;
  for (const m of months) {
    for (const uid of userIds) {
      if (key === "adSpend") {
        if (platform !== null) continue; // 广告费无平台维度
        acc += spend[m]?.[uid] || 0;
        continue;
      }
      const ud = data[m]?.[uid];
      if (!ud) continue;
      const plats = platform ? [platform] : Object.keys(ud);
      for (const p of plats) {
        if (key === "total")    acc += ud[p]?.total    || 0;
        if (key === "rejected") acc += ud[p]?.rejected || 0;
        if (key === "active")   acc += ud[p]?.active   || 0;
      }
    }
  }
  return acc;
}

// ────────── 样式化单元格写入辅助 ─────────────────────────────────────────────
function setCell(
  ws: ExcelJS.Worksheet,
  row: number, col: number,
  value: ExcelJS.CellValue,
  fillHex: string,
  fnt: Partial<ExcelJS.Font>,
  aln: Partial<ExcelJS.Alignment> = align(),
  borders: Partial<ExcelJS.Borders> = thinBorder,
  numFmt = ""
) {
  const cell = ws.getCell(row, col);
  cell.value = value;
  cell.fill  = fill(fillHex) as ExcelJS.Fill;
  cell.font  = fnt;
  cell.alignment = aln;
  cell.border = borders;
  if (numFmt) cell.numFmt = numFmt;
}

function numVal(n: number): number | string { return n !== 0 ? +n.toFixed(2) : ""; }

// ────────── 生成一个月的 Sheet ────────────────────────────────────────────────
function buildMonthSheet(
  wb: ExcelJS.Workbook,
  sheetName: string,
  monthTitle: string,
  monthKeys: string[],         // 单月=[month], 全年=all months
  year: number,
  members: MemberInfo[],
  platforms: string[],
  data: MonthData,
  spend: SpendData
) {
  const ws = wb.addWorksheet(sheetName);
  const NP = platforms.length;               // 平台数
  const GRP_COLS = NP + 1;                  // 每个组的列数（各平台 + 小计）
  const LABEL_COL = 1;                       // A列：行标签
  const DATA_START = 2;                      // B列开始：合计组
  const totalCols = 1 + GRP_COLS * (1 + members.length); // A + 合计组 + 各成员组

  // ── 列宽 ─────────────────────────────────────────────────────────────
  ws.getColumn(1).width = 16;
  for (let c = 2; c <= totalCols; c++) {
    const relC = (c - DATA_START) % GRP_COLS;
    ws.getColumn(c).width = relC === NP ? 11 : 9; // 小计列宽一点
  }

  // ── 行高 ─────────────────────────────────────────────────────────────
  ws.getRow(1).height = 28;
  for (let r = 2; r <= 8; r++) ws.getRow(r).height = 22;

  // ─────────────────── Row 1：月份标题 ───────────────────────────────
  ws.mergeCells(1, 1, 1, totalCols);
  setCell(ws, 1, 1, monthTitle, CLR.YELLOW, font(true, 14), align("center"), thickBorder);

  // ─────────────────── Row 2：MCC 组头 ───────────────────────────────
  // A2 = "MCC"
  setCell(ws, 2, 1, "MCC", CLR.GRAY_HEAD, font(true, 10), align("center"), thickBorder);
  // 合计组（B2 : B+NP+1）
  const totalGroupEnd = DATA_START + NP; // inclusive
  ws.mergeCells(2, DATA_START, 2, totalGroupEnd);
  setCell(ws, 2, DATA_START, "合计", CLR.GRAY_HEAD, font(true, 10), align("center"), thickBorder);
  for (let c = DATA_START + 1; c <= totalGroupEnd; c++) {
    ws.getCell(2, c).fill = fill(CLR.GRAY_HEAD) as ExcelJS.Fill;
    ws.getCell(2, c).border = thickBorder;
  }
  // 各成员组
  members.forEach((mem, idx) => {
    const start = DATA_START + GRP_COLS * (idx + 1);
    const end   = start + NP;
    const clr   = CLR.MEM_COLORS[idx % CLR.MEM_COLORS.length];
    ws.mergeCells(2, start, 2, end);
    setCell(ws, 2, start, mem.display_name, clr, font(true, 10), align("center"), thickBorder);
    for (let c = start + 1; c <= end; c++) {
      ws.getCell(2, c).fill = fill(clr) as ExcelJS.Fill;
      ws.getCell(2, c).border = thickBorder;
    }
  });

  // ─────────────────── Row 3：平台列头 ────────────────────────────────
  setCell(ws, 3, 1, "指标", CLR.GREEN, font(true, 10), align("center"), thickBorder);
  // 合计组平台列
  platforms.forEach((p, i) => setCell(ws, 3, DATA_START + i, p, CLR.GREEN, font(false, 10), align("center"), thinBorder));
  setCell(ws, 3, DATA_START + NP, "合计", CLR.GREEN_DARK, font(true, 10), align("center"), thickBorder);
  // 各成员组平台列
  members.forEach((_, idx) => {
    const start = DATA_START + GRP_COLS * (idx + 1);
    platforms.forEach((p, i) => setCell(ws, 3, start + i, p, CLR.GREEN, font(false, 10), align("center"), thinBorder));
    setCell(ws, 3, start + NP, "小计", CLR.GREEN_DARK, font(true, 10), align("center"), thickBorder);
  });

  // ─────────────────── 数据行定义 ──────────────────────────────────────
  const allUserIds = members.map((m) => m.id);
  const NUM_FMT   = '#,##0.00';

  const ROWS: {
    label: string;
    key: "adSpend"|"total"|"rejected"|"active"|"net";
    fillHex: string;
    bold: boolean;
  }[] = [
    { label: "广告费",    key: "adSpend",  fillHex: CLR.BLUE_LIGHT, bold: false },
    { label: "总佣金收入", key: "total",    fillHex: CLR.WHITE,      bold: false },
    { label: "失效佣金",  key: "rejected", fillHex: CLR.RED_LIGHT,  bold: false },
    { label: "有效佣金",  key: "active",   fillHex: CLR.GREEN,      bold: true  },
    { label: "净收益",    key: "net",      fillHex: CLR.GOLD,       bold: true  },
  ];

  ROWS.forEach(({ label, key, fillHex, bold }, ri) => {
    const r = 4 + ri;
    // 行标签
    setCell(ws, r, 1, label, fillHex, font(true, 10), align("center"), thickBorder);

    // 合计组
    platforms.forEach((p, pi) => {
      const v = key === "adSpend" ? "" : numVal(sumStat(key, monthKeys, allUserIds, p, data, spend));
      setCell(ws, r, DATA_START + pi, v, fillHex, font(bold, 10), align("right"), thinBorder, v !== "" ? NUM_FMT : "");
    });
    // 合计组 小计（用 thickBorder 区分）
    const totalVal = numVal(sumStat(key, monthKeys, allUserIds, null, data, spend));
    setCell(ws, r, DATA_START + NP, totalVal, fillHex, font(true, 10), align("right"), thickBorder, totalVal !== "" ? NUM_FMT : "");

    // 各成员组
    members.forEach((mem, idx) => {
      const memMonths = monthKeys;
      const start = DATA_START + GRP_COLS * (idx + 1);
      const clr = CLR.MEM_COLORS[idx % CLR.MEM_COLORS.length];
      const rowFill = fillHex === CLR.WHITE ? "FAFAFA" : fillHex;
      platforms.forEach((p, pi) => {
        const v = key === "adSpend" ? "" : numVal(sumStat(key, memMonths, [mem.id], p, data, spend));
        setCell(ws, r, start + pi, v, rowFill, font(bold, 10), align("right"), thinBorder, v !== "" ? NUM_FMT : "");
      });
      // 小计
      const subVal = numVal(sumStat(key, memMonths, [mem.id], null, data, spend));
      setCell(ws, r, start + NP, subVal, rowFill, font(true, 10), align("right"), thickBorder, subVal !== "" ? NUM_FMT : "");
    });
  });

  // ── 冻结首行和首列 ───────────────────────────────────────────────────
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 3 }];
}

// ────────── 生成年度汇总 Sheet（列=月份） ─────────────────────────────────────
function buildAnnualSheet(
  wb: ExcelJS.Workbook,
  year: number,
  months: string[],
  members: MemberInfo[],
  platforms: string[],
  data: MonthData,
  spend: SpendData
) {
  const ws = wb.addWorksheet("全年汇总");
  const allUserIds = members.map((m) => m.id);
  const totalCols = 1 + 12 + 1; // 指标 + 12月 + 年合计

  ws.getColumn(1).width = 16;
  for (let c = 2; c <= totalCols; c++) ws.getColumn(c).width = c === totalCols ? 13 : 10;
  ws.getRow(1).height = 28;
  for (let r = 2; r <= 8; r++) ws.getRow(r).height = 22;

  // Row1：标题
  ws.mergeCells(1, 1, 1, totalCols);
  setCell(ws, 1, 1, `${year}年 全年收支汇总`, CLR.YELLOW, font(true, 14), align("center"), thickBorder);

  // Row2：月份头
  setCell(ws, 2, 1, "指标", CLR.GRAY_HEAD, font(true, 10), align("center"), thickBorder);
  months.forEach((m, i) => {
    const label = m.slice(5).replace(/^0/, "") + "月";
    setCell(ws, 2, 2 + i, label, CLR.GREEN, font(false, 10), align("center"), thinBorder);
  });
  setCell(ws, 2, 14, "年合计", CLR.GREEN_DARK, font(true, 10), align("center"), thickBorder);

  const ROWS = [
    { label: "广告费",    key: "adSpend"  as const, fillHex: CLR.BLUE_LIGHT, bold: false },
    { label: "总佣金收入", key: "total"    as const, fillHex: CLR.WHITE,      bold: false },
    { label: "失效佣金",  key: "rejected" as const, fillHex: CLR.RED_LIGHT,  bold: false },
    { label: "有效佣金",  key: "active"   as const, fillHex: CLR.GREEN,      bold: true  },
    { label: "净收益",    key: "net"      as const, fillHex: CLR.GOLD,       bold: true  },
  ];

  const NUM_FMT = '#,##0.00';
  ROWS.forEach(({ label, key, fillHex, bold }, ri) => {
    const r = 3 + ri;
    setCell(ws, r, 1, label, fillHex, font(true, 10), align("center"), thickBorder);
    let yearTotal = 0;
    months.forEach((m, i) => {
      const v = sumStat(key, [m], allUserIds, null, data, spend);
      setCell(ws, r, 2 + i, v !== 0 ? +v.toFixed(2) : "", fillHex, font(bold, 10), align("right"), thinBorder, v !== 0 ? NUM_FMT : "");
      yearTotal += v;
    });
    // 年合计（net用加总近似；严格算法只差浮点）
    const yrVal = key === "net"
      ? +(sumStat("active", months, allUserIds, null, data, spend) - sumStat("adSpend", months, allUserIds, null, data, spend)).toFixed(2)
      : +yearTotal.toFixed(2);
    setCell(ws, r, 14, yrVal !== 0 ? yrVal : "", fillHex, font(true, 10), align("right"), thickBorder, yrVal !== 0 ? NUM_FMT : "");
  });

  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 2 }];
}

// ────────── 主路由 ────────────────────────────────────────────────────────────
export const GET = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return new NextResponse("未关联小组", { status: 400 });
  const { searchParams } = new URL(req.url);
  const year = parseInt(searchParams.get("year") || String(new Date().getFullYear()), 10);
  if (isNaN(year)) return new NextResponse("无效年份", { status: 400 });

  const teamId = BigInt(user.teamId);
  const members = await prisma.users.findMany({
    where: { team_id: teamId, is_deleted: 0, role: "user" },
    select: { id: true, username: true, display_name: true },
    orderBy: { username: "asc" },
  });
  if (members.length === 0) return new NextResponse("暂无成员", { status: 404 });

  const memberInfos: MemberInfo[] = members.map((m) => ({
    id: String(m.id),
    username: m.username,
    display_name: m.display_name || m.username,
  }));
  const memberIds = members.map((m) => m.id);
  const yearStart = `${year}-01-01`;
  const yearEnd   = `${year + 1}-01-01`;

  const commRows = await prisma.$queryRawUnsafe<{
    user_id: bigint; month: string; platform: string;
    total_commission: number; rejected_commission: number;
  }[]>(`
    SELECT user_id, DATE_FORMAT(CONVERT_TZ(transaction_time, '+00:00', '+08:00'),'%Y-%m') AS month, platform,
      SUM(CAST(commission_amount AS DECIMAL(14,4))) AS total_commission,
      SUM(CASE WHEN status='rejected' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS rejected_commission
    FROM affiliate_transactions
    WHERE user_id IN (${memberIds.map(() => "?").join(",")})
      AND is_deleted=0 AND transaction_time>=? AND transaction_time<?
    GROUP BY user_id, month, platform
  `, ...memberIds, yearStart, yearEnd);

  const spendRows = await prisma.$queryRawUnsafe<{
    user_id: bigint; month: string; cost: number;
  }[]>(`
    SELECT user_id, DATE_FORMAT(date,'%Y-%m') AS month, SUM(CAST(cost AS DECIMAL(14,4))) AS cost
    FROM ads_daily_stats
    WHERE user_id IN (${memberIds.map(() => "?").join(",")}) AND date>=? AND date<?
    GROUP BY user_id, month
  `, ...memberIds, yearStart, yearEnd);

  const PLATFORM_ORDER = ["RW","LH","CG","LB","PM","CF","BSH","MUI","EV"];
  const platformSet = new Set(commRows.map((r) => r.platform));
  const platforms = PLATFORM_ORDER.filter((p) => platformSet.has(p));
  for (const p of platformSet) { if (!platforms.includes(p)) platforms.push(p); }

  const data: MonthData = {};
  for (const row of commRows) {
    const uid = String(row.user_id), m = row.month, p = row.platform;
    const total = Number(row.total_commission || 0), rej = Number(row.rejected_commission || 0);
    if (!data[m]) data[m] = {};
    if (!data[m][uid]) data[m][uid] = {};
    data[m][uid][p] = { total, rejected: rej, active: total - rej };
  }
  const spend: SpendData = {};
  for (const row of spendRows) {
    const uid = String(row.user_id), m = row.month;
    if (!spend[m]) spend[m] = {};
    spend[m][uid] = Number(row.cost || 0);
  }

  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

  // ── 生成 Workbook ────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM System";
  wb.created  = new Date();

  // 全年汇总（第一个 sheet）
  buildAnnualSheet(wb, year, months, memberInfos, platforms, data, spend);

  // 各月 sheet
  months.forEach((m, i) => {
    const label = (i + 1) + "月";
    buildMonthSheet(wb, label, `${year}年${label}`, [m], year, memberInfos, platforms, data, spend);
  });

  // ── 序列化并返回 ─────────────────────────────────────────────────────
  const buffer = await wb.xlsx.writeBuffer();
  const filename = encodeURIComponent(`${year}年度收支报表.xlsx`);
  return new NextResponse(buffer as Buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${filename}`,
      "Cache-Control": "no-store",
    },
  });
});
