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
      for (const cpcKey of ["cpcbid", "maxcpc", "cpc"]) {
        if (cpcKey in col && row[col[cpcKey]] && row[col[cpcKey]] !== "" && row[col[cpcKey]] !== "--") {
          cpc = safeFloat(row[col[cpcKey]]) / 1_000_000;
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
 * 从 Sheet 同步广告数据（自动识别 CRM / kyads 格式）
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
    if (crmVals.length < 2) return { success: true, rows: [], format: "crm", message: "Sheet 无数据" };
    return { success: true, rows: parseCrmDailyData(crmVals, startDate, endDate), format: "crm" };
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
