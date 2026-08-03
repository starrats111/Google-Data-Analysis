/**
 * Google Sheet 同步服务（Node.js）
 * 从 MCC 脚本导出的 Google Sheet 读取广告数据
 * 读取方式：通过公开 CSV 导出链接（HTTP GET），无需 Sheets API
 *
 * 支持两种表格格式，保存 URL 后由 detectSheetFormat() 自动识别：
 *  - CRM 原生格式：Tab「DailyData」，列 Date/CampaignId/CampaignName/Cost(micros)/Account/...
 *  - kyads 格式：  Tab「raw_daily_report」，列 date/customer_id/campaign_id/campaign_name/cost(货币值)/...
 *    （kyads 的 googleads.gs 导出，cost/budget/cpc 已用 microsToCurrency_ 转成货币值，
 *      且为「广告(ad)级」明细，需按 (date, campaign_id) 聚合到 campaign/日级别）
 */

const CRM_TAB = "DailyData";
const KYADS_TAB = "raw_daily_report";
const SHEET_MAX_RETRIES = 3;

/**
 * 月度归档表前缀（DailyData_2026-05）。
 * DailyData 只是近 30 天滚动窗口（脚本每次整表重写），更早的历史由脚本按月归档到这些表。
 * 只有当请求区间超出该窗口时才会去读，短区间同步不会多发任何请求。
 */
const CRM_MONTHLY_TAB_PREFIX = "DailyData_";
/**
 * DailyData 的可信覆盖天数。取 25 天而非脚本的 30 天，留出边界余量：
 * 各子账号时区不同、脚本可能因超时提前退出，窗口最前面几天不保证齐全。
 * 旧版脚本（90 天窗口）尚未更新的 MCC 也安全——归档表不存在时读取直接跳过。
 */
const DAILY_TAB_COVERAGE_DAYS = 25;
/** 单次同步最多读取的月份表数量，防止误传超长区间打爆请求数 */
const MAX_MONTHLY_TABS = 36;

export type SheetFormat = "crm" | "kyads" | "unknown";

/** 从 Google Sheet URL 提取 spreadsheetId */
export function extractSheetId(url: string): string | null {
  if (!url) return null;
  if (url.includes("/d/")) {
    const part = url.split("/d/")[1];
    return part?.split("/")[0]?.trim() || null;
  }
  return null;
}

/** 通过公开 CSV 导出链接读取指定 Tab 数据（导出供 today-merchants-sheet 等复用；无需 Sheets API） */
export async function readSheetCsv(
  spreadsheetId: string,
  sheetName: string
): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;

  for (let attempt = 0; attempt < SHEET_MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });

      // 400 = 该 Tab 不存在（用于格式探测时静默返回空）
      if (resp.status === 400) return [];
      if (resp.status === 401 || resp.status === 403) {
        throw new Error("Google Sheet 权限不足，请确保 Sheet 已设为「知道链接的任何人都可以查看」");
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const text = await resp.text();
      return parseCsv(text);
    } catch (err) {
      if (err instanceof Error && err.message.includes("权限不足")) throw err;
      if (attempt < SHEET_MAX_RETRIES - 1) {
        const wait = 5 * Math.pow(2, attempt) * 1000;
        await new Promise((r) => setTimeout(r, wait));
      } else {
        throw new Error(`读取 Sheet 失败（重试 ${SHEET_MAX_RETRIES} 次后放弃）: ${err}`);
      }
    }
  }
  return [];
}

/** 简易 CSV 解析器（处理引号内的逗号和换行） */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        current.push(field);
        field = "";
      } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
        current.push(field);
        field = "";
        if (current.some((c) => c.trim())) rows.push(current);
        current = [];
        if (ch === "\r") i++;
      } else {
        field += ch;
      }
    }
  }
  if (field || current.length > 0) {
    current.push(field);
    if (current.some((c) => c.trim())) rows.push(current);
  }
  return rows;
}

/** 安全读取数值 */
function safeFloat(val: string | undefined | null): number {
  if (!val || val === "" || val === "--") return 0;
  const n = parseFloat(val.replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}

/** 表头 → 列索引（大小写不敏感、去首尾空格） */
function buildColIndex(headers: string[]): Record<string, number> {
  const col: Record<string, number> = {};
  headers.forEach((h, i) => {
    const key = (h || "").trim().toLowerCase();
    if (key && !(key in col)) col[key] = i;
  });
  return col;
}

/** 状态映射 */
const STATUS_MAP: Record<string, string> = {
  ENABLED: "ENABLED",
  PAUSED: "PAUSED",
  REMOVED: "REMOVED",
  "2": "ENABLED",
  "3": "PAUSED",
  "4": "REMOVED",
};

function normalizeStatus(raw: string | undefined): string {
  if (!raw) return "ENABLED";
  const u = raw.trim().toUpperCase();
  return STATUS_MAP[u] || STATUS_MAP[u.replace(/\s/g, "")] || "ENABLED";
}

export interface SheetRow {
  date: string;           // YYYY-MM-DD
  campaign_id: string;
  campaign_name: string;
  customer_id: string;    // CID
  cost: number;           // 账户币种金额（非 micros）；汇率换算由调用方按 mcc.currency 处理
  budget: number;         // 账户币种金额
  clicks: number;
  impressions: number;
  cpc: number;            // 账户币种金额
  /**
   * D-202：Sheet 里明确的出价列（CpcBid/MaxCpc）才有值，0 表示该表没有出价列。
   * 与 cpc 的区别：cpc 在缺列时会退化成 cost/clicks 的平均值，只能用于展示，
   * 不能当 max_cpc_limit 写库。
   */
  cpc_bid: number;
  status: string;         // ENABLED / PAUSED / REMOVED
}

/** CRM 原生格式必备列（小写） */
const CRM_REQUIRED = ["date", "campaignid", "campaignname", "cost", "impressions", "clicks"];
/** kyads 格式必备列（小写） */
const KYADS_REQUIRED = ["date", "campaign_id", "campaign_name", "cost", "impressions", "clicks"];

function hasAll(col: Record<string, number>, keys: string[]): boolean {
  return keys.every((k) => k in col);
}

export interface DetectResult {
  format: SheetFormat;
  tab: string | null;
  columns: string[];
  row_count: number;
  last_date?: string;
  message?: string;
}

/**
 * 探测 Sheet 格式：先看 CRM 原生 Tab（DailyData），再看 kyads Tab（raw_daily_report）。
 * 保存 URL 后调用，用于回显「识别为 X 格式」。
 */
export async function detectSheetFormat(sheetUrl: string): Promise<DetectResult> {
  const sid = extractSheetId(sheetUrl);
  if (!sid) return { format: "unknown", tab: null, columns: [], row_count: 0, message: "无效的 Sheet URL" };

  // 1) CRM 原生格式
  try {
    const crmVals = await readSheetCsv(sid, CRM_TAB);
    if (crmVals.length > 0) {
      const col = buildColIndex(crmVals[0]);
      if (hasAll(col, CRM_REQUIRED)) {
        return {
          format: "crm",
          tab: CRM_TAB,
          columns: crmVals[0].map((h) => h.trim()),
          row_count: Math.max(0, crmVals.length - 1),
          last_date: lastDateOf(crmVals, col["date"]),
        };
      }
    }
  } catch (err) {
    return { format: "unknown", tab: null, columns: [], row_count: 0, message: String(err) };
  }

  // 2) kyads 格式
  try {
    const kyVals = await readSheetCsv(sid, KYADS_TAB);
    if (kyVals.length > 0) {
      const col = buildColIndex(kyVals[0]);
      if (hasAll(col, KYADS_REQUIRED)) {
        return {
          format: "kyads",
          tab: KYADS_TAB,
          columns: kyVals[0].map((h) => h.trim()),
          row_count: Math.max(0, kyVals.length - 1),
          last_date: lastDateOf(kyVals, col["date"]),
        };
      }
    }
  } catch (err) {
    return { format: "unknown", tab: null, columns: [], row_count: 0, message: String(err) };
  }

  return {
    format: "unknown",
    tab: null,
    columns: [],
    row_count: 0,
    message: `未识别的表格结构：需要 CRM 格式（Tab「${CRM_TAB}」）或 kyads 格式（Tab「${KYADS_TAB}」）`,
  };
}

function lastDateOf(values: string[][], dateCol: number | undefined): string | undefined {
  if (dateCol === undefined || dateCol < 0) return undefined;
  let max: Date | undefined;
  for (let i = 1; i < values.length; i++) {
    const raw = (values[i][dateCol] || "").slice(0, 10);
    if (!raw) continue;
    const d = new Date(raw);
    if (!isNaN(d.getTime()) && (!max || d > max)) max = d;
  }
  return max ? max.toISOString().split("T")[0] : undefined;
}

/** 解析 CRM 原生格式（DailyData）→ SheetRow[]（Cost 为 micros，需 /1e6） */
function parseCrmDailyData(values: string[][], startDate: string, endDate: string): SheetRow[] {
  const col = buildColIndex(values[0]);
  const start = new Date(startDate);
  const end = new Date(endDate);
  const results: SheetRow[] = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    try {
      const dateStr = (row[col["date"]] || "").trim();
      const campaignId = (row[col["campaignid"]] || "").trim();
      const campaignName = (row[col["campaignname"]] || "").trim();
      if (!dateStr || !campaignId || !campaignName) continue;

      const rowDate = new Date(dateStr.slice(0, 10));
      if (rowDate < start || rowDate > end) continue;

      const cost = safeFloat(row[col["cost"]]) / 1_000_000; // micros → currency
      const clicks = safeFloat(row[col["clicks"]]);
      const impressions = safeFloat(row[col["impressions"]]);

      let budget = 0;
      if ("budget" in col && row[col["budget"]]) {
        budget = safeFloat(row[col["budget"]]) / 1_000_000;
      }

      let cpc = clicks > 0 ? cost / clicks : 0;
      let cpcBid = 0;
      for (const cpcKey of ["cpcbid", "maxcpc", "cpc"]) {
        if (cpcKey in col && row[col[cpcKey]] && row[col[cpcKey]] !== "" && row[col[cpcKey]] !== "--") {
          cpc = safeFloat(row[col[cpcKey]]) / 1_000_000;
          // "cpc" 列语义含糊（可能是平均 CPC），只有明确的出价列才算真实出价
          if (cpcKey === "cpcbid" || cpcKey === "maxcpc") cpcBid = cpc;
          break;
        }
      }

      let customerId = "";
      if ("account" in col && row[col["account"]]) {
        customerId = row[col["account"]].trim().replace(/-/g, "");
      }

      results.push({
        date: dateStr.slice(0, 10),
        campaign_id: campaignId,
        campaign_name: campaignName,
        customer_id: customerId,
        cost,
        budget,
        clicks,
        impressions,
        cpc,
        cpc_bid: cpcBid,
        status: normalizeStatus(row[col["status"]]),
      });
    } catch {
      continue;
    }
  }
  return results;
}

/**
 * 解析 kyads 格式（raw_daily_report）→ SheetRow[]
 * 注意：
 *  - cost / campaign_budget / average_cpc 已是货币值（googleads.gs microsToCurrency_），不再 /1e6
 *  - 该表为「广告(ad)级」明细，一个 campaign/日有多行，需按 (date, campaign_id) 聚合求和
 */
function parseKyadsReport(values: string[][], startDate: string, endDate: string): SheetRow[] {
  const col = buildColIndex(values[0]);
  const start = new Date(startDate);
  const end = new Date(endDate);

  const agg = new Map<string, SheetRow>();

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    try {
      const dateStr = (row[col["date"]] || "").trim().slice(0, 10);
      const campaignId = (row[col["campaign_id"]] || "").trim();
      const campaignName = (row[col["campaign_name"]] || "").trim();
      if (!dateStr || !campaignId) continue;

      const rowDate = new Date(dateStr);
      if (isNaN(rowDate.getTime()) || rowDate < start || rowDate > end) continue;

      const cost = safeFloat(row[col["cost"]]);               // 已是货币值
      const clicks = safeFloat(row[col["clicks"]]);
      const impressions = safeFloat(row[col["impressions"]]);
      const budget = "campaign_budget" in col ? safeFloat(row[col["campaign_budget"]]) : 0;
      const customerId = "customer_id" in col ? (row[col["customer_id"]] || "").trim().replace(/-/g, "") : "";
      const status = normalizeStatus("campaign_status" in col ? row[col["campaign_status"]] : undefined);

      const key = `${dateStr}|${campaignId}`;
      const existing = agg.get(key);
      if (existing) {
        existing.cost += cost;
        existing.clicks += clicks;
        existing.impressions += impressions;
        if (budget > existing.budget) existing.budget = budget;
        if (!existing.campaign_name && campaignName) existing.campaign_name = campaignName;
      } else {
        agg.set(key, {
          date: dateStr,
          campaign_id: campaignId,
          campaign_name: campaignName,
          customer_id: customerId,
          cost,
          budget,
          clicks,
          impressions,
          cpc: 0,
          cpc_bid: 0, // kyads 表是广告级明细，无 campaign 出价列
          status,
        });
      }
    } catch {
      continue;
    }
  }

  // 聚合后重算 CPC（按 campaign/日的 cost/clicks）
  const results = [...agg.values()];
  for (const r of results) {
    r.cost = Math.round(r.cost * 1_000_000) / 1_000_000;
    r.cpc = r.clicks > 0 ? r.cost / r.clicks : 0;
  }
  return results;
}

/**
 * 算出需要额外读取的月度归档表。
 *
 * DailyData 只覆盖最近 ~90 天，比这更早的部分只能从 DailyData_YYYY-MM 取。
 * 返回空数组表示请求区间完全落在 DailyData 覆盖范围内，无需多发请求。
 */
function monthsToFetch(startDate: string, endDate: string): string[] {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DAILY_TAB_COVERAGE_DAYS);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  const upper = endDate < cutoff ? endDate : cutoff;
  if (startDate > upper) return [];

  const months: string[] = [];
  let year = parseInt(startDate.slice(0, 4), 10);
  let month = parseInt(startDate.slice(5, 7), 10);
  const upperYear = parseInt(upper.slice(0, 4), 10);
  const upperMonth = parseInt(upper.slice(5, 7), 10);

  while ((year < upperYear || (year === upperYear && month <= upperMonth)) && months.length < MAX_MONTHLY_TABS) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/** 逐月读取归档表；Tab 不存在时 readSheetCsv 返回空数组，无需额外判断 */
async function readMonthlyArchives(
  spreadsheetId: string,
  startDate: string,
  endDate: string
): Promise<SheetRow[]> {
  const months = monthsToFetch(startDate, endDate);
  if (months.length === 0) return [];

  const collected: SheetRow[] = [];
  for (const month of months) {
    try {
      const values = await readSheetCsv(spreadsheetId, `${CRM_MONTHLY_TAB_PREFIX}${month}`);
      if (values.length < 2) continue;
      if (!hasAll(buildColIndex(values[0]), CRM_REQUIRED)) continue;
      collected.push(...parseCrmDailyData(values, startDate, endDate));
    } catch {
      // 单个月份读取失败不应让整次同步失败，跳过继续
      continue;
    }
  }
  return collected;
}

/** 合并归档与 DailyData；同一 (日期, 系列) 以 DailyData 为准，因为它每天重写、数据更新 */
function mergeRows(archived: SheetRow[], daily: SheetRow[]): SheetRow[] {
  if (archived.length === 0) return daily;
  const merged = new Map<string, SheetRow>();
  for (const row of archived) merged.set(`${row.date}|${row.campaign_id}`, row);
  for (const row of daily) merged.set(`${row.date}|${row.campaign_id}`, row);
  return [...merged.values()];
}

/**
 * 从 Sheet 同步广告数据（自动识别 CRM / kyads 格式）
 *
 * CRM 格式下，若请求区间早于 DailyData 的 90 天窗口，会自动补读 DailyData_YYYY-MM
 * 月度归档表，使全量同步能拿到 MCC 创建至今的完整历史。
 *
 * @param sheetUrl Google Sheet URL
 * @param startDate 开始日期 YYYY-MM-DD
 * @param endDate 结束日期 YYYY-MM-DD
 */
export async function syncFromSheet(
  sheetUrl: string,
  startDate: string,
  endDate: string
): Promise<{ success: boolean; rows: SheetRow[]; format?: SheetFormat; message?: string }> {
  const sid = extractSheetId(sheetUrl);
  if (!sid) return { success: false, rows: [], message: "无效的 Sheet URL" };

  // 先尝试 CRM 原生格式
  let crmVals: string[][];
  try {
    crmVals = await readSheetCsv(sid, CRM_TAB);
  } catch (err) {
    return { success: false, rows: [], message: String(err) };
  }
  if (crmVals.length >= 1 && hasAll(buildColIndex(crmVals[0]), CRM_REQUIRED)) {
    const dailyRows = crmVals.length < 2 ? [] : parseCrmDailyData(crmVals, startDate, endDate);
    const archivedRows = await readMonthlyArchives(sid, startDate, endDate);
    const rows = mergeRows(archivedRows, dailyRows);
    if (rows.length === 0) return { success: true, rows: [], format: "crm", message: "Sheet 无数据" };
    return { success: true, rows, format: "crm" };
  }

  // 再尝试 kyads 格式
  let kyVals: string[][];
  try {
    kyVals = await readSheetCsv(sid, KYADS_TAB);
  } catch (err) {
    return { success: false, rows: [], message: String(err) };
  }
  if (kyVals.length >= 1 && hasAll(buildColIndex(kyVals[0]), KYADS_REQUIRED)) {
    if (kyVals.length < 2) return { success: true, rows: [], format: "kyads", message: "Sheet 无数据" };
    return { success: true, rows: parseKyadsReport(kyVals, startDate, endDate), format: "kyads" };
  }

  // DailyData 可能因脚本中断只剩表头（clearContents 后写入失败），
  // 此时月度归档表仍是完好的，兜底从归档表取数，避免整次同步白跑
  const archivedOnly = await readMonthlyArchives(sid, startDate, endDate);
  if (archivedOnly.length > 0) {
    return { success: true, rows: archivedOnly, format: "crm", message: "DailyData 不可用，已从月度归档表读取" };
  }

  return {
    success: false,
    rows: [],
    message: `未识别的表格结构：需要 CRM 格式（Tab「${CRM_TAB}」）或 kyads 格式（Tab「${KYADS_TAB}」）`,
  };
}

/**
 * 测试 Sheet 连接 + 识别格式（保存 URL 时调用，用于回显表格结构）
 */
export async function testSheetConnection(
  sheetUrl: string
): Promise<{
  status: string;
  format?: SheetFormat;
  tab?: string | null;
  row_count?: number;
  last_date?: string;
  columns?: string[];
  message?: string;
}> {
  const sid = extractSheetId(sheetUrl);
  if (!sid) return { status: "error", message: "无效的 Sheet URL" };

  try {
    const det = await detectSheetFormat(sheetUrl);
    if (det.format === "unknown") {
      return { status: "error", format: "unknown", message: det.message, columns: det.columns };
    }
    return {
      status: "ok",
      format: det.format,
      tab: det.tab,
      row_count: det.row_count,
      last_date: det.last_date,
      columns: det.columns,
      message:
        det.format === "kyads"
          ? `识别为 kyads 格式（Tab「${det.tab}」），将自动按广告级明细聚合到广告系列/日`
          : `识别为 CRM 原生格式（Tab「${det.tab}」）`,
    };
  } catch (err) {
    return { status: "error", message: String(err) };
  }
}
