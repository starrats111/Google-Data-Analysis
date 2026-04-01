/**
 * Google Sheet 同步服务（Node.js 重写）
 * 从 MCC 脚本导出的 Google Sheet 读取广告数据
 * 读取方式：通过公开 CSV 导出链接（HTTP GET），无需 Sheets API
 */

const SHEET_NAME = "DailyData";
const SHEET_MAX_RETRIES = 3;

/** 从 Google Sheet URL 提取 spreadsheetId */
export function extractSheetId(url: string): string | null {
  if (!url) return null;
  if (url.includes("/d/")) {
    const part = url.split("/d/")[1];
    return part?.split("/")[0]?.trim() || null;
  }
  return null;
}

/** 通过公开 CSV 导出链接读取 Sheet 数据 */
async function readSheetCsv(
  spreadsheetId: string,
  sheetName: string = SHEET_NAME
): Promise<string[][]> {
  const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;

  for (let attempt = 0; attempt < SHEET_MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });

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
  // 最后一行
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

/** 状态映射 */
const STATUS_MAP: Record<string, string> = {
  ENABLED: "ENABLED",
  PAUSED: "PAUSED",
  REMOVED: "REMOVED",
  "2": "ENABLED",
  "3": "PAUSED",
  "4": "REMOVED",
};

export interface SheetRow {
  date: string;           // YYYY-MM-DD
  campaign_id: string;
  campaign_name: string;
  customer_id: string;    // CID
  cost: number;           // USD
  budget: number;         // USD
  clicks: number;
  impressions: number;
  cpc: number;            // USD
  status: string;         // ENABLED / PAUSED
}

/**
 * 从 Sheet 同步广告数据
 * @param sheetUrl Google Sheet URL
 * @param startDate 开始日期 YYYY-MM-DD
 * @param endDate 结束日期 YYYY-MM-DD
 */
export async function syncFromSheet(
  sheetUrl: string,
  startDate: string,
  endDate: string
): Promise<{ success: boolean; rows: SheetRow[]; message?: string }> {
  const sid = extractSheetId(sheetUrl);
  if (!sid) return { success: false, rows: [], message: "无效的 Sheet URL" };

  let values: string[][];
  try {
    values = await readSheetCsv(sid, SHEET_NAME);
  } catch (err) {
    return { success: false, rows: [], message: String(err) };
  }

  if (!values || values.length < 2) {
    return { success: true, rows: [], message: "Sheet 无数据" };
  }

  // 解析表头
  const headers = values[0].map((h) => h.trim());
  const col: Record<string, number> = {};
  headers.forEach((h, i) => { col[h] = i; });

  // 必须列检查
  for (const key of ["Date", "CampaignId", "CampaignName", "Cost", "Impressions", "Clicks"]) {
    if (!(key in col)) {
      return { success: false, rows: [], message: `Sheet 缺少列: ${key}` };
    }
  }

  const start = new Date(startDate);
  const end = new Date(endDate);
  const results: SheetRow[] = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    try {
      const dateStr = (row[col["Date"]] || "").trim();
      const campaignId = (row[col["CampaignId"]] || "").trim();
      const campaignName = (row[col["CampaignName"]] || "").trim();
      if (!dateStr || !campaignId || !campaignName) continue;

      const rowDate = new Date(dateStr.slice(0, 10));
      if (rowDate < start || rowDate > end) continue;

      // Cost 是 micros
      const costMicros = safeFloat(row[col["Cost"]]);
      const cost = costMicros / 1_000_000;

      const clicks = safeFloat(row[col["Clicks"]]);
      const impressions = safeFloat(row[col["Impressions"]]);

      // Budget (micros)
      let budget = 0;
      if ("Budget" in col && row[col["Budget"]]) {
        budget = safeFloat(row[col["Budget"]]) / 1_000_000;
      }

      // CPC
      let cpc = clicks > 0 ? cost / clicks : 0;
      for (const cpcKey of ["CpcBid", "MaxCpc", "Cpc"]) {
        if (cpcKey in col && row[col[cpcKey]] && row[col[cpcKey]] !== "" && row[col[cpcKey]] !== "--") {
          cpc = safeFloat(row[col[cpcKey]]) / 1_000_000;
          break;
        }
      }

      // Status
      let status = "ENABLED";
      if ("Status" in col && row[col["Status"]]) {
        const raw = row[col["Status"]].trim().toUpperCase();
        status = STATUS_MAP[raw] || STATUS_MAP[raw.replace(/\s/g, "")] || "ENABLED";
      }

      // CID (Account column)
      let customerId = "";
      if ("Account" in col && row[col["Account"]]) {
        customerId = row[col["Account"]].trim().replace(/-/g, "");
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
        status,
      });
    } catch {
      continue;
    }
  }

  return { success: true, rows: results };
}

/**
 * 测试 Sheet 连接
 */
export async function testSheetConnection(
  sheetUrl: string
): Promise<{ status: string; row_count?: number; last_date?: string; columns?: string[]; message?: string }> {
  const sid = extractSheetId(sheetUrl);
  if (!sid) return { status: "error", message: "无效的 Sheet URL" };

  try {
    const values = await readSheetCsv(sid, SHEET_NAME);
    if (!values || values.length === 0) {
      return { status: "ok", row_count: 0, message: "Sheet 中 DailyData 标签页为空" };
    }

    const headers = values[0].map((h) => h.trim());
    const dateCol = headers.indexOf("Date");
    let lastDate: string | undefined;

    if (dateCol >= 0) {
      const dates: Date[] = [];
      for (let i = 1; i < values.length; i++) {
        if (values[i][dateCol]) {
          const d = new Date(values[i][dateCol].slice(0, 10));
          if (!isNaN(d.getTime())) dates.push(d);
        }
      }
      if (dates.length > 0) {
        lastDate = dates.sort((a, b) => b.getTime() - a.getTime())[0].toISOString().split("T")[0];
      }
    }

    return {
      status: "ok",
      row_count: values.length - 1,
      last_date: lastDate,
      columns: headers,
    };
  } catch (err) {
    return { status: "error", message: String(err) };
  }
}
