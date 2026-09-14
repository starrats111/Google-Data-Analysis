/**
 * 结算查询 — 前端导出 xlsx
 *
 * 为什么在前端做而不是新开 /export 接口：
 * 平台筛选和排序是 AntD Table 的内部状态，服务端不知道用户点了什么。走服务端就得把筛选/排序
 * 参数透传过去、再把 settlement/route.ts 那段聚合 SQL 复写一遍，两边口径极易漂。页面手里
 * 已经是全量聚合数据（该接口不分页，明确避免 take 截断），直接导等于所见即所得。
 *
 * exceljs 走动态 import，只在点按钮时加载，不进首屏包。
 */

import type { ColumnsType, ColumnType } from "antd/es/table";
import type { FilterValue, SortOrder, Key } from "antd/es/table/interface";

/** 表头筛选/排序状态。空对象 = 用户没动过表头，此时保持 dataSource 原序（接口已 ORDER BY total DESC） */
export interface TableState {
  filters?: Record<string, FilterValue | null>;
  sortKey?: Key | null;
  sortOrder?: SortOrder;
}

/** 列的匹配键：AntD 优先 key，退回 dataIndex */
const colKeyOf = <T,>(c: ColumnType<T>): string => String(c.key ?? c.dataIndex ?? "");

/**
 * 把表头的筛选和排序原样套到全量数组上，得到「屏幕上这一列的全部行」。
 * 复用列定义里现成的 onFilter / sorter，不重写比较逻辑，避免导出和页面排序规则两处漂移。
 */
export function applyTableState<T>(rows: T[], columns: ColumnsType<T>, state: TableState): T[] {
  const cols = columns as ColumnType<T>[];
  let out = [...rows];

  Object.entries(state.filters || {}).forEach(([key, selected]) => {
    if (!selected?.length) return;
    const col = cols.find((c) => colKeyOf(c) === key);
    const onFilter = col?.onFilter;
    if (!onFilter) return;
    // 多选是「或」关系，与 AntD 默认行为一致
    out = out.filter((r) => selected.some((v) => onFilter(v as Key | boolean, r)));
  });

  if (state.sortKey && state.sortOrder) {
    const col = cols.find((c) => colKeyOf(c) === String(state.sortKey));
    const cmp = col?.sorter;
    if (typeof cmp === "function") {
      const dir = state.sortOrder === "ascend" ? 1 : -1;
      out.sort((a, b) => (cmp as (a: T, b: T) => number)(a, b) * dir);
    }
  }

  return out;
}

/** 率导出值：Excel 的 0.00% 格式会自己乘 100，所以传小数；分母为 0 传 null（留空，对应页面的 "-"） */
export const rateCell = (num: number, total: number): number | null =>
  total > 0 ? num / total : null;

/** 金额列：写 number + 货币格式，不写 "$1,234.00" 字符串，否则 Excel 里没法排序和求和 */
export type CellFormat = "money" | "percent" | "int" | "text";

export interface ExportColumn<T> {
  header: string;
  /** 取值。率列返回 null 表示分母为 0，导出留空而不是写 0% */
  value: (row: T) => string | number | null;
  format: CellFormat;
  width: number;
}

const NUM_FMT: Record<CellFormat, string | undefined> = {
  money: '"$"#,##0.00',
  percent: "0.00%",
  int: "#,##0",
  text: undefined,
};

/** 文件名里不能出现的字符（Windows + macOS 并集） */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

export interface ExportSheetOptions<T> {
  fileName: string;
  sheetName: string;
  columns: ExportColumn<T>[];
  rows: T[];
  /** 合计行，与页面 Table.Summary 同口径。undefined = 不加合计行 */
  totalRow?: (string | number | null)[];
  /** 表格上方的口径说明行（如时间范围、切日口径），可多行 */
  notes?: string[];
}

export async function exportSheet<T>(opts: ExportSheetOptions<T>): Promise<void> {
  const { fileName, sheetName, columns, rows, totalRow, notes } = opts;

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = "CRM System";
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName);

  ws.columns = columns.map((c) => ({ width: c.width }));

  // 口径说明：合并整行，灰色小字。放在表头之上，避免同事拿到表后问「这是哪段时间的」
  let headerRowIdx = 1;
  if (notes?.length) {
    notes.forEach((note) => {
      const r = ws.getRow(headerRowIdx);
      r.getCell(1).value = note;
      ws.mergeCells(headerRowIdx, 1, headerRowIdx, columns.length);
      r.getCell(1).font = { size: 9, color: { argb: "FF888888" } };
      r.getCell(1).alignment = { vertical: "middle", wrapText: false };
      headerRowIdx += 1;
    });
    headerRowIdx += 1; // 空一行
  }

  const headerRow = ws.getRow(headerRowIdx);
  headerRow.values = columns.map((c) => c.header);
  headerRow.font = { bold: true, size: 10 };
  headerRow.alignment = { vertical: "middle", horizontal: "center" };
  headerRow.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F5FF" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FFD9D9D9" } } };
  });

  rows.forEach((row, i) => {
    const r = ws.getRow(headerRowIdx + 1 + i);
    columns.forEach((c, ci) => {
      const cell = r.getCell(ci + 1);
      const v = c.value(row);
      // null（率列分母为 0）留空，跟页面显示 "-" 对应
      cell.value = v === null ? null : v;
      const fmt = NUM_FMT[c.format];
      if (fmt && typeof v === "number") cell.numFmt = fmt;
      if (c.format !== "text") cell.alignment = { horizontal: "right" };
    });
  });

  if (totalRow) {
    const r = ws.getRow(headerRowIdx + 1 + rows.length);
    columns.forEach((c, ci) => {
      const cell = r.getCell(ci + 1);
      const v = totalRow[ci];
      cell.value = v === null || v === undefined ? null : v;
      const fmt = NUM_FMT[c.format];
      if (fmt && typeof v === "number") cell.numFmt = fmt;
      cell.font = { bold: true };
      if (c.format !== "text") cell.alignment = { horizontal: "right" };
      cell.border = { top: { style: "thin", color: { argb: "FFD9D9D9" } } };
    });
  }

  // 冻结表头，1932 行往下滚时列名不丢
  ws.views = [{ state: "frozen", ySplit: headerRowIdx }];
  ws.autoFilter = {
    from: { row: headerRowIdx, column: 1 },
    to: { row: headerRowIdx, column: columns.length },
  };

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFileName(fileName);
  a.click();
  URL.revokeObjectURL(url);
}
