/**
 * 商家黑名单 & 推荐商家 — Google Sheets 同步服务
 * 从同一个 Google Sheets 链接读取：
 *   - 黑名单 (gid=0) → 违规商家
 *   - 推荐商家表 (第二个 sheet) → 推荐商家
 * 匹配逻辑：按商家名称 + 域名跨平台匹配
 */

// ── 平台名映射（表格中的全称 → 系统内部代码）──
const PLATFORM_NAME_MAP: Record<string, string> = {
  partnermatic: "PM", pm: "PM",
  rewardoo: "RW", rw: "RW",
  linkbux: "LB", lb: "LB",
  linkhaitao: "LH", lh: "LH",
  "link haitao": "LH",
  collabglow: "CG", cg: "CG",
  brandsparkhub: "BSH", bsh: "BSH",
  creatorflare: "CF", cf: "CF",
};

export function normalizePlatform(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return PLATFORM_NAME_MAP[lower] || raw.trim().toUpperCase();
}

// 2位 ISO 国家代码集合（常见的）
const COUNTRY_CODES = new Set([
  "US", "UK", "GB", "DE", "FR", "IT", "ES", "NL", "BE", "AT", "CH", "AU", "CA",
  "JP", "KR", "CN", "HK", "TW", "SG", "MY", "TH", "PH", "ID", "VN", "IN",
  "BR", "MX", "AR", "CL", "CO", "PE", "SE", "NO", "DK", "FI", "PL", "CZ",
  "PT", "IE", "NZ", "ZA", "AE", "SA", "IL", "RU", "TR", "GR", "RO", "HU",
]);

/**
 * 从商家名中剥离尾部国家代码后缀，返回基础名称
 * "bofrost DE" → "bofrost"
 * "Crocs FR" → "Crocs"
 * "Into the Blue" → "Into the Blue"（无变化）
 */
export function stripCountrySuffix(name: string): string {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1].toUpperCase();
    if (COUNTRY_CODES.has(last) && last.length === 2) {
      return parts.slice(0, -1).join(" ").trim();
    }
    // 也处理括号形式: "Merchant (DE)"
    const parenMatch = trimmed.match(/^(.+?)\s*\(([A-Z]{2})\)\s*$/i);
    if (parenMatch && COUNTRY_CODES.has(parenMatch[2].toUpperCase())) {
      return parenMatch[1].trim();
    }
  }
  return trimmed;
}

// ── 工具函数 ──

export function extractSheetId(url: string): string | null {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

export function extractGid(url: string): string {
  const m = url.match(/[#&?]gid=(\d+)/);
  return m ? m[1] : "0";
}

function extractDomain(raw: string): string {
  if (!raw) return "";
  let s = raw.trim().toLowerCase();
  if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
  try {
    const u = new URL(s);
    let host = u.hostname;
    if (host.startsWith("www.")) host = host.slice(4);
    return host;
  } catch {
    return raw.trim().toLowerCase();
  }
}

// ── Sheet 数据读取（优先 Service Account API，回退公开 CSV） ──

async function fetchSheetCsv(sheetUrl: string, gid?: string): Promise<string[][]> {
  const sheetId = extractSheetId(sheetUrl);
  if (!sheetId) throw new Error("无法从链接中提取 Google Sheets ID");
  const g = gid ?? extractGid(sheetUrl);

  // 优先通过 Service Account 认证访问 Google Sheets API
  try {
    const { getSheetsAccessToken } = await import("./google-sheets-auth");
    const token = await getSheetsAccessToken();
    if (token) {
      return await fetchSheetViaApi(sheetId, g, token);
    }
  } catch (e: any) {
    console.warn("[MerchantSheetSync] Service Account API 访问失败, 回退公开 CSV:", e?.message || e);
  }

  return await fetchSheetPublicCsv(sheetId, g);
}

async function fetchSheetViaApi(sheetId: string, gid: string, accessToken: string): Promise<string[][]> {
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`;
  const metaResp = await fetch(metaUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!metaResp.ok) {
    const body = await metaResp.text().catch(() => "");
    throw new Error(`Sheets API 元数据请求失败: HTTP ${metaResp.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  const meta = await metaResp.json();
  const sheet = (meta.sheets as any[])?.find((s) => String(s.properties?.sheetId) === gid);
  const sheetName = sheet?.properties?.title || "Sheet1";

  const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(sheetName)}?valueRenderOption=FORMATTED_VALUE`;
  const valuesResp = await fetch(valuesUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!valuesResp.ok) {
    const body = await valuesResp.text().catch(() => "");
    throw new Error(`Sheets API 数据请求失败: HTTP ${valuesResp.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
  }
  const data = await valuesResp.json();
  const rows: string[][] = data.values || [];
  if (rows.length === 0) throw new Error("Google Sheets API 返回空数据");
  return rows;
}

async function fetchSheetPublicCsv(sheetId: string, gid: string): Promise<string[][]> {
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(csvUrl, { redirect: "follow", signal: controller.signal });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Google Sheets CSV 请求失败: HTTP ${resp.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    const text = await resp.text();
    if (!text.trim()) throw new Error("Google Sheets 返回空内容");
    const rows = parseCsv(text);
    if (rows.length === 0) throw new Error("CSV 解析后无任何行");
    return rows;
  } catch (e: any) {
    if (e.name === "AbortError") throw new Error("Google Sheets 请求超时（30秒），请检查服务器是否能访问 Google");
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cell += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
        row.push(cell); cell = ""; rows.push(row); row = [];
        if (ch === "\r") i++;
      } else cell += ch;
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ── 按工作表名定位推荐商家表 ──
// 不用 gid：gid 是随机值，无法预测；也不用 gviz 的 sheet= 参数，它在表名不存在时
// 会静默返回第一个工作表（即黑名单），且会因列类型推断丢掉部分表头。
// 整本 xlsx 导出是唯一既能按名字精确定位、又能拿到完整表头的公开通道。

const RECOMMENDATION_SHEET_PATTERNS: RegExp[] = [
  /^\s*白名单\s*$/,
  /^\s*推荐商家表?\s*$/,
  /白名单|whitelist/i,
  /推荐商家|recommend/i,
];

async function fetchWorkbookSheet(
  sheetId: string,
  patterns: RegExp[],
): Promise<{ title: string; rows: string[][] } | null> {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
  const resp = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60000) });
  if (!resp.ok) {
    throw new Error(`Google Sheets 工作簿导出失败: HTTP ${resp.status}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const XLSX = await import("xlsx");
  const wb = XLSX.read(buf, { type: "buffer" });

  let title: string | undefined;
  for (const p of patterns) {
    title = wb.SheetNames.find((n) => p.test(n));
    if (title) break;
  }
  if (!title) {
    console.warn(`[MerchantSheetSync] 工作簿中未找到推荐商家表，现有工作表: ${wb.SheetNames.join(" / ")}`);
    return null;
  }

  const raw = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[title], {
    header: 1,
    raw: false,
    defval: "",
  });
  const rows = raw.map((r) => (r || []).map((c) => (c == null ? "" : String(c))));
  return { title, rows };
}

// ── 解析黑名单 ──
// 注意：Google Sheet 中黑名单在 A-F 列，推荐商家在 G-M 列，都在 gid=0 同一个 sheet
// 解析黑名单时只取 A-F 列（前6列），避免把推荐商家误读为违规商家

export interface ViolationRecord {
  name: string;
  platform: string;
  domain: string;
  time: string;
  reason: string;
  source: string;
}

export function parseViolationRows(rows: string[][]): ViolationRecord[] {
  if (rows.length < 2) throw new Error(`违规商家 Sheet 数据不足: 仅 ${rows.length} 行（至少需要表头+数据行）`);
  let headerIdx = -1;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const text = rows[i].slice(0, 6).join(" ").toLowerCase();
    if (text.includes("商家名称") || text.includes("merchant")) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    const sample = rows.slice(0, 3).map(r => r.slice(0, 6).join(", ")).join(" | ");
    throw new Error(`无法找到违规商家表头行（前3行A-F列: ${sample}）`);
  }
  const headers = rows[headerIdx].slice(0, 6).map((h) => (h || "").trim().toLowerCase());
  const col: Record<string, number> = {};
  headers.forEach((h, i) => {
    if (["商家名称", "merchant_name", "商家名"].includes(h)) col.name = i;
    else if (["商家平台", "platform", "平台"].includes(h)) col.platform = i;
    else if (["商家域名", "domain", "域名", "网址"].includes(h)) col.domain = i;
    else if (["下架时间", "violation_time", "违规时间"].includes(h)) col.time = i;
    else if (["备注原因", "reason", "违规原因", "原因"].includes(h)) col.reason = i;
    else if (["名单来源", "source", "来源"].includes(h)) col.source = i;
  });
  if (col.name === undefined) throw new Error(`违规商家表头中未找到"商家名称"列（表头: ${headers.join(", ")}）`);

  const records: ViolationRecord[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.slice(0, 6).every((c) => !c.trim())) continue;
    const g = (k: string) => (col[k] !== undefined && col[k] < row.length ? row[col[k]].trim() : "");
    const name = g("name");
    if (!name) continue;
    records.push({
      name,
      platform: normalizePlatform(g("platform")),
      domain: extractDomain(g("domain")),
      time: g("time"),
      reason: g("reason") || "有被查记录",
      source: g("source"),
    });
  }
  return records;
}

// ── 解析推荐商家表 ──
// 支持两种版式，由 offset 决定读哪几列：
//   offset=0 → 独立的「白名单」工作表，A-G 列
//   offset=6 → 旧版式，与黑名单同处 gid=0，推荐商家占 G-M 列
// 列序均为：商家名称, ROI参考, 佣金率, 结算率, 标记, 分享时间, 备注

const REC_BLOCK_WIDTH = 7;

export interface RecommendationRecord {
  name: string;
  roi: string;
  commission: string;
  settlement: string;
  remark: string;
  time: string;
}

export function parseRecommendationRows(rows: string[][], offset = 6): RecommendationRecord[] {
  if (rows.length < 2) throw new Error(`推荐商家 Sheet 数据不足: 仅 ${rows.length} 行（至少需要表头+数据行）`);
  const end = offset + REC_BLOCK_WIDTH;
  const colLabel = `${String.fromCharCode(65 + offset)}-${String.fromCharCode(64 + end)}`;

  let headerIdx = -1;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const text = (rows[i].slice(offset, end) || []).join(" ").toLowerCase();
    if (text.includes("商家名称") || text.includes("roi")) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    const sample = rows.slice(0, 3).map(r => (r.slice(offset, end) || []).join(", ")).join(" | ");
    throw new Error(`无法找到推荐商家表头行（前3行${colLabel}列: ${sample}）`);
  }
  const recHeaders = rows[headerIdx].slice(offset, end).map((h) => (h || "").trim().toLowerCase());
  const col: Record<string, number> = {};
  recHeaders.forEach((h, i) => {
    const absIdx = i + offset;
    if (["商家名称", "merchant_name", "商家名"].includes(h)) col.name = absIdx;
    else if (h.includes("roi")) col.roi = absIdx;
    else if (["佣金率", "commission_rate", "佣金"].includes(h)) col.commission = absIdx;
    else if (["结算率", "settlement_rate", "结算"].includes(h)) col.settlement = absIdx;
    else if (["标记", "tag", "mark"].includes(h)) col.remark = absIdx;
    else if (["分享时间", "share_time", "时间"].includes(h)) col.time = absIdx;
    else if (["备注", "note", "notes"].includes(h) && col.remark === undefined) col.remark = absIdx;
  });
  if (col.name === undefined) {
    throw new Error(`推荐商家表头中未找到"商家名称"列（${colLabel}列表头: ${recHeaders.join(", ")}）`);
  }
  // 黑名单表头同样以「商家名称」开头，只靠这一列无法区分。要求至少命中一个推荐表专属列，
  // 否则说明定位到了错误的工作表，宁可报错也不要把黑名单当成推荐商家写进库。
  if (col.roi === undefined && col.time === undefined && col.settlement === undefined) {
    throw new Error(
      `推荐商家表头缺少 ROI参考/分享时间/结算率 列，疑似读到了非推荐商家的工作表（${colLabel}列表头: ${recHeaders.join(", ")}）`,
    );
  }

  const records: RecommendationRecord[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length <= offset) continue;
    if (row.slice(offset, end).every((c) => !c.trim())) continue;
    const g = (k: string) => (col[k] !== undefined && col[k] < row.length ? row[col[k]].trim() : "");
    const name = g("name");
    if (!name) continue;
    records.push({ name, roi: g("roi"), commission: g("commission"), settlement: g("settlement"), remark: g("remark"), time: g("time") });
  }
  return records;
}

/** 版式未知时（如管理员手工粘贴的 CSV）依次尝试独立表和旧版式 */
export function parseRecommendationRowsAuto(rows: string[][]): RecommendationRecord[] {
  const tried: string[] = [];
  for (const offset of [0, 6]) {
    try {
      const records = parseRecommendationRows(rows, offset);
      if (records.length > 0) return records;
      tried.push(`offset=${offset} 解析出 0 条`);
    } catch (e: unknown) {
      tried.push(`offset=${offset} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`推荐商家解析失败（已尝试两种版式）：${tried.join("；")}`);
}

// ── 公开同步函数 ──

export async function fetchViolations(sheetUrl: string): Promise<ViolationRecord[]> {
  const rows = await fetchSheetCsv(sheetUrl, "0");
  return parseViolationRows(rows);
}

export async function fetchRecommendations(sheetUrl: string): Promise<RecommendationRecord[]> {
  const sheetId = extractSheetId(sheetUrl);
  if (!sheetId) throw new Error("无法从链接中提取 Google Sheets ID");

  // 首选：独立的「白名单」工作表（A-G 列）
  let records: RecommendationRecord[] | null = null;
  let via = "";
  try {
    const sheet = await fetchWorkbookSheet(sheetId, RECOMMENDATION_SHEET_PATTERNS);
    if (sheet) {
      records = parseRecommendationRows(sheet.rows, 0);
      via = `工作表「${sheet.title}」`;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[MerchantSheetSync] 读取独立推荐商家工作表失败，回退旧版式: ${msg}`);
  }

  // 回退：旧版式，与黑名单同处 gid=0 的 G-M 列
  if (!records || records.length === 0) {
    const rows = await fetchSheetCsv(sheetUrl, "0");
    records = parseRecommendationRowsAuto(rows);
    via = "gid=0";
  }

  // 解析成功但一条都没有，几乎只可能是表结构变了而读取逻辑没跟上。
  // 这种情况必须报错：静默返回空数组会让每日同步一直显示成功，问题可以埋几个月不被发现。
  if (records.length === 0) {
    throw new Error(
      "推荐商家读取结果为 0 条。请确认表格中「白名单」工作表是否存在、表头是否为" +
        "「商家名称 / ROI参考 / 佣金率 / 结算率 / 标记 / 分享时间 / 备注」",
    );
  }

  console.log(`[MerchantSheetSync] 推荐商家读取成功: ${records.length} 条，来源 ${via}`);
  return records;
}
