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

// ── CSV 读取 ──

async function fetchSheetCsv(sheetUrl: string, gid?: string): Promise<string[][]> {
  const sheetId = extractSheetId(sheetUrl);
  if (!sheetId) throw new Error("无法从链接中提取 Google Sheets ID");
  const g = gid ?? extractGid(sheetUrl);
  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${g}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const resp = await fetch(csvUrl, { redirect: "follow", signal: controller.signal });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Google Sheets 请求失败: HTTP ${resp.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
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

function parseCsv(text: string): string[][] {
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

// ── 检测推荐商家表 gid ──

async function detectRecommendationGid(sheetUrl: string): Promise<string> {
  const sheetId = extractSheetId(sheetUrl);
  if (!sheetId) return "1";
  try {
    const htmlUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/edit`;
    const resp = await fetch(htmlUrl, { redirect: "follow" });
    const html = await resp.text();
    const gidMatches = [...html.matchAll(/"gid"\s*:\s*(\d+)/g)].map((m) => m[1]);
    const nameMatches = [...html.matchAll(/"name"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
    for (let i = 0; i < nameMatches.length; i++) {
      const name = nameMatches[i].toLowerCase();
      if (name.includes("推荐") || name.includes("recommend")) return gidMatches[i] || "1";
    }
    if (gidMatches.length >= 2) return gidMatches[1];
  } catch { /* fallback */ }
  return "1";
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

function parseViolationRows(rows: string[][]): ViolationRecord[] {
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
// 推荐商家在 gid=0 同一个 sheet 的 G-M 列（第7-13列）
// G=商家名称, H=ROI参考, I=佣金率, J=结算率, K=标记, L=分享时间, M=备注

export interface RecommendationRecord {
  name: string;
  roi: string;
  commission: string;
  settlement: string;
  remark: string;
  time: string;
}

function parseRecommendationRows(rows: string[][]): RecommendationRecord[] {
  if (rows.length < 2) throw new Error(`推荐商家 Sheet 数据不足: 仅 ${rows.length} 行（至少需要表头+数据行）`);
  let headerIdx = -1;
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    const text = (rows[i].slice(6) || []).join(" ").toLowerCase();
    if (text.includes("商家名称") || text.includes("roi")) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    const sample = rows.slice(0, 3).map(r => (r.slice(6, 13) || []).join(", ")).join(" | ");
    throw new Error(`无法找到推荐商家表头行（前3行G-M列: ${sample}）`);
  }
  const recHeaders = rows[headerIdx].slice(6, 13).map((h) => (h || "").trim().toLowerCase());
  const col: Record<string, number> = {};
  recHeaders.forEach((h, i) => {
    const absIdx = i + 6;
    if (["商家名称", "merchant_name", "商家名"].includes(h)) col.name = absIdx;
    else if (h.includes("roi")) col.roi = absIdx;
    else if (["佣金率", "commission_rate", "佣金"].includes(h)) col.commission = absIdx;
    else if (["结算率", "settlement_rate", "结算"].includes(h)) col.settlement = absIdx;
    else if (["标记", "tag", "mark"].includes(h)) col.remark = absIdx;
    else if (["分享时间", "share_time", "时间"].includes(h)) col.time = absIdx;
    else if (["备注", "note", "notes"].includes(h) && col.remark === undefined) col.remark = absIdx;
  });
  if (col.name === undefined) {
    throw new Error(`推荐商家表头中未找到"商家名称"列（G-M列表头: ${recHeaders.join(", ")}）`);
  }

  const records: RecommendationRecord[] = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length <= 6) continue;
    // 检查 G-M 列是否全空
    if (row.slice(6, 13).every((c) => !c.trim())) continue;
    const g = (k: string) => (col[k] !== undefined && col[k] < row.length ? row[col[k]].trim() : "");
    const name = g("name");
    if (!name) continue;
    records.push({ name, roi: g("roi"), commission: g("commission"), settlement: g("settlement"), remark: g("remark"), time: g("time") });
  }
  return records;
}

// ── 公开同步函数 ──

export async function fetchViolations(sheetUrl: string): Promise<ViolationRecord[]> {
  const rows = await fetchSheetCsv(sheetUrl, "0");
  return parseViolationRows(rows);
}

export async function fetchRecommendations(sheetUrl: string): Promise<RecommendationRecord[]> {
  // 推荐商家在 gid=0 同一个 sheet 的 G-M 列
  const rows = await fetchSheetCsv(sheetUrl, "0");
  return parseRecommendationRows(rows);
}
