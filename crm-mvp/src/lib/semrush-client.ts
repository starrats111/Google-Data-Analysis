/**
 * SemRush 竞品分析客户端（移植自 sem01_client.py）
 * 通过 3UE 代理获取竞品域名的关键词、广告标题、广告描述
 * 使用 curl 发送请求以绕过 TLS 指纹检测（Node.js fetch 的 JA3 指纹会被 3UE 拦截）
 *
 * 安全防护：全局请求队列限流 + 域名结果缓存 + 会话复用
 */
import { getSystemConfigsByPrefix } from "@/lib/system-config";
import { execFileSync } from "child_process";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const RPC_URL = "https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU";
const LOGIN_URL = "https://dash.3ue.co/api/account/login";
const LOGIN_ORIGIN = "https://dash.3ue.co";
const RPC_ORIGIN = "https://sem.3ue.co";

// ─── 全局安全防护：限流 + 缓存 ───

const MIN_REQUEST_INTERVAL_MS = 4000;
const RANDOM_JITTER_MAX_MS = 3000;
const DOMAIN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;

export interface SemRushKeyword {
  phrase: string;
  volume: number;
  cpc?: number | null;
  competition?: string | number | null;
  suggested_bid?: number | null;
}

export interface SemRushResult {
  domain: string;
  keywords: SemRushKeyword[];
  adsOverview: { title: string; description: string }[];
  copies: { date: string; total: number; samples: { title: string; description: string }[] };
  creativeSamples: { title: string; description: string }[];
  dedupedTitles: string[];
  dedupedDescriptions: string[];
}

interface CachedSession {
  token: string;
  cookies: Record<string, string>;
  username: string;
  expiresAt: number;
}

interface CachedDomainResult {
  data: SemRushResult;
  cachedAt: number;
}

class SemrushGuard {
  private lastRequestTime = 0;
  private queue: Array<{ resolve: () => void }> = [];
  private processing = false;
  private domainCache = new Map<string, CachedDomainResult>();
  private sessionCache: CachedSession | null = null;

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      const jitter = Math.floor(Math.random() * RANDOM_JITTER_MAX_MS);
      const requiredWait = MIN_REQUEST_INTERVAL_MS + jitter;
      if (elapsed < requiredWait) {
        await new Promise((r) => setTimeout(r, requiredWait - elapsed));
      }
      this.lastRequestTime = Date.now();
      const item = this.queue.shift();
      item?.resolve();
    }
    this.processing = false;
  }

  async waitForSlot(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ resolve });
      this.processQueue();
    });
  }

  getCachedDomain(domain: string): SemRushResult | null {
    const entry = this.domainCache.get(domain);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > DOMAIN_CACHE_TTL_MS) {
      this.domainCache.delete(domain);
      return null;
    }
    return entry.data;
  }

  setCachedDomain(domain: string, data: SemRushResult) {
    this.domainCache.set(domain, { data, cachedAt: Date.now() });
    if (this.domainCache.size > 500) {
      const oldest = [...this.domainCache.entries()]
        .sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
      if (oldest) this.domainCache.delete(oldest[0]);
    }
  }

  getCachedSession(username: string): CachedSession | null {
    if (!this.sessionCache) return null;
    if (this.sessionCache.username !== username) return null;
    if (Date.now() > this.sessionCache.expiresAt) {
      this.sessionCache = null;
      return null;
    }
    return this.sessionCache;
  }

  setCachedSession(username: string, token: string, cookies: Record<string, string>) {
    this.sessionCache = { token, cookies: { ...cookies }, username, expiresAt: Date.now() + SESSION_TTL_MS };
  }

  invalidateSession() {
    this.sessionCache = null;
  }

  getStats() {
    return {
      cacheSize: this.domainCache.size,
      queueLength: this.queue.length,
      hasSession: !!this.sessionCache,
    };
  }
}

const guard = new SemrushGuard();

// ─── curl 封装（绕过 TLS 指纹检测） ───

interface CurlResponse {
  status: number;
  body: string;
  cookies: Record<string, string>;
}

export function curlFetch(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; followRedirects?: boolean } = {},
): CurlResponse {
  const args: string[] = ["-s", "-i", "--max-time", String(Math.ceil((opts.timeoutMs || 30000) / 1000))];
  if (opts.followRedirects) args.push("-L");
  if (opts.method) args.push("-X", opts.method);
  for (const [k, v] of Object.entries(opts.headers || {})) {
    args.push("-H", `${k}: ${v}`);
  }
  if (opts.body) args.push("-d", opts.body);
  args.push(url);

  const raw = execFileSync("curl", args, {
    timeout: (opts.timeoutMs || 30000) + 5000,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  // 跳过 100 Continue 等中间响应（curl -i 会依次输出所有中间响应）
  let remaining = raw;
  while (true) {
    const sepIdx = remaining.indexOf("\r\n\r\n");
    if (sepIdx < 0) break;
    const headerPart = remaining.slice(0, sepIdx);
    if (/^HTTP\/[\d.]+ 1\d{2}\b/.test(headerPart.trim())) {
      remaining = remaining.slice(sepIdx + 4);
      continue;
    }
    break;
  }

  // 解析 HTTP 响应：头部 + 空行 + body（兼容 \r\n\r\n 和 \n\n）
  let headerEndIdx = remaining.indexOf("\r\n\r\n");
  let sepLen = 4;
  if (headerEndIdx < 0) {
    headerEndIdx = remaining.indexOf("\n\n");
    sepLen = 2;
  }
  const headerSection = headerEndIdx > 0 ? remaining.slice(0, headerEndIdx) : "";
  const body = headerEndIdx > 0 ? remaining.slice(headerEndIdx + sepLen) : remaining;

  // 解析状态码（取最后一个 HTTP 状态行，处理重定向链）
  let status = 200;
  const statusLines = headerSection.match(/HTTP\/[\d.]+ (\d+)/g) || [];
  if (statusLines.length > 0) {
    const lastStatus = statusLines[statusLines.length - 1].match(/(\d+)$/);
    if (lastStatus) status = parseInt(lastStatus[1]);
  }

  // 解析 Set-Cookie
  const cookies: Record<string, string> = {};
  const cookieMatches = headerSection.match(/^set-cookie:\s*(.+)$/gim) || [];
  for (const line of cookieMatches) {
    const val = line.replace(/^set-cookie:\s*/i, "");
    const [kv] = val.split(";");
    const eqIdx = kv.indexOf("=");
    if (eqIdx > 0) {
      const k = kv.slice(0, eqIdx).trim();
      const v = kv.slice(eqIdx + 1).trim();
      if (k && v) cookies[k] = v;
    }
  }

  return { status, body, cookies };
}

// ─── 工具函数 ───

export function normalizeDomain(value: string): string {
  const candidate = value.trim();
  if (!candidate) return "";
  let hostname: string;
  if (candidate.includes("://")) {
    try {
      hostname = new URL(candidate).hostname;
    } catch {
      hostname = candidate.split("/")[0];
    }
  } else {
    hostname = candidate.split("/")[0];
  }
  hostname = hostname.trim().toLowerCase();
  if (hostname.startsWith("www.")) hostname = hostname.slice(4);
  return hostname;
}

export function dedupeAdTitles(titles: string[]): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const title of titles) {
    const parts = title.includes(" - ") ? title.split(" - ") : [title];
    for (const part of parts) {
      const cleaned = part.trim();
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned);
        items.push(cleaned);
      }
    }
  }
  return items;
}

export function dedupeAdDescriptions(descriptions: string[]): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const description of descriptions) {
    const parts = description.includes(".") ? description.split(".") : [description];
    for (const part of parts) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      const sentence = `${cleaned}.`;
      if (!seen.has(sentence)) {
        seen.add(sentence);
        items.push(sentence);
      }
    }
  }
  return items;
}

function parseKeywordRow(r: any): SemRushKeyword {
  return {
    phrase: String(r.phrase || r.keyword || ""),
    volume: Number(r.volume || r.search_volume || 0),
    cpc: r.cpc != null ? Number(r.cpc) : null,
    competition: r.competition ?? r.competition_level ?? null,
    suggested_bid: r.suggested_bid != null
      ? Number(r.suggested_bid)
      : r.suggestedBid != null
        ? Number(r.suggestedBid)
        : r.cpc != null
          ? Number(r.cpc)
          : null,
  };
}

function normalizeReportDate(value: string | number): string {
  const text = String(value).trim();
  if (text.length === 8 && /^\d+$/.test(text)) return text;
  if (text.length === 10 && /^\d+$/.test(text)) {
    const d = new Date(parseInt(text) * 1000);
    return d.toISOString().slice(0, 10).replace(/-/g, "");
  }
  throw new Error(`不支持的报告日期格式: ${value}`);
}

function selectCreativeSamples(
  adsOverview: { title: string; description: string }[],
  copiesSamples: { title: string; description: string }[],
) {
  return copiesSamples.length > 0 ? copiesSamples : adsOverview;
}

const COUNTRY_EXCEPTIONS: Record<string, string> = {
  GB: "uk",
  UK: "uk",
};

function countryToDatabase(country: string): string {
  const upper = country.toUpperCase();
  return COUNTRY_EXCEPTIONS[upper] || upper.toLowerCase();
}

/** 从 3UE SemRush 页面 URL 中提取被查询的域名 */
export function parseDomainFromSemrushUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("3ue.co") && !parsed.hostname.includes("semrush")) return "";
    const q = parsed.searchParams.get("q") || parsed.searchParams.get("searchItem") || "";
    if (q) return normalizeDomain(q);
    const pathMatch = parsed.pathname.match(/\/(?:analytics|overview)\/.*?([a-z0-9][-a-z0-9]*\.[a-z]{2,})/i);
    if (pathMatch) return normalizeDomain(pathMatch[1]);
  } catch {}
  return "";
}

// ─── 客户端类 ───

interface NodeConfig {
  chatNode: string;
  chatLang: string;
  semrushNode: string;
  semrushLang: string;
}

interface SemRushCredentials {
  username: string;
  password: string;
  userId: string;
  apiKey: string;
  database: string;
  nodeConfig: NodeConfig;
}

export class SemRushClient {
  private creds: SemRushCredentials;
  private token: string | null = null;
  private cookies: Record<string, string> = {};

  constructor(creds: SemRushCredentials) {
    this.creds = creds;
  }

  /** 从 system_configs 读取凭据并创建客户端 */
  static async fromConfig(country?: string): Promise<SemRushClient> {
    const configs = await getSystemConfigsByPrefix("semrush_");
    const username = configs["semrush_username"];
    const password = configs["semrush_password"];
    const userId = configs["semrush_user_id"];
    const apiKey = configs["semrush_api_key"];
    if (!username || !password || !userId || !apiKey) {
      throw new Error("SemRush 凭据未配置，请在管理后台 SemRush 配置中设置");
    }
    const db = country ? countryToDatabase(country) : (configs["semrush_database"] || "us");
    return new SemRushClient({
      username,
      password,
      userId,
      apiKey,
      database: db,
      nodeConfig: {
        chatNode: configs["semrush_node"] || "3",
        chatLang: "zh_CN",
        semrushNode: configs["semrush_node"] || "3",
        semrushLang: "zh",
      },
    });
  }

  private buildConfigValue(): string {
    return JSON.stringify({
      chat: { node: this.creds.nodeConfig.chatNode, lang: this.creds.nodeConfig.chatLang },
      semrush: { node: this.creds.nodeConfig.semrushNode, lang: this.creds.nodeConfig.semrushLang },
    });
  }

  private buildCookieHeader(token: string): string {
    return `GMITM_token=${token}; GMITM_uname=${this.creds.username}; GMITM_config=${this.buildConfigValue()}`;
  }

  private buildHeaders(token: string, includeCookie = true): Record<string, string> {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      "content-type": "application/json; charset=utf-8",
      origin: RPC_ORIGIN,
    };
    if (includeCookie) headers["cookie"] = this.buildCookieHeader(token);
    return headers;
  }

  private extractToken(payload: unknown): string | null {
    if (typeof payload === "object" && payload !== null) {
      if (Array.isArray(payload)) {
        for (const item of payload) {
          const t = this.extractToken(item);
          if (t) return t;
        }
      } else {
        const obj = payload as Record<string, unknown>;
        if (typeof obj.token === "string" && obj.token) return obj.token;
        for (const v of Object.values(obj)) {
          const t = this.extractToken(v);
          if (t) return t;
        }
      }
    }
    return null;
  }

  async login(): Promise<string> {
    const cached = guard.getCachedSession(this.creds.username);
    if (cached) {
      this.token = cached.token;
      this.cookies = { ...cached.cookies };
      console.log("[SemRush] 复用缓存会话，跳过登录");
      return cached.token;
    }

    await guard.waitForSlot();
    const ts = Date.now();
    const url = `${LOGIN_URL}?username=${encodeURIComponent(this.creds.username)}&password=${encodeURIComponent(this.creds.password)}&ts=${ts}`;
    const res = curlFetch(url, {
      headers: { "user-agent": USER_AGENT, origin: LOGIN_ORIGIN },
      timeoutMs: 20000,
    });
    if (res.status >= 400) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("3UE 登录失败：用户名或密码错误，请在管理后台检查 SemRush 配置");
      }
      throw new Error(`3UE 登录失败（HTTP ${res.status}），请稍后再试或联系管理员`);
    }
    Object.assign(this.cookies, res.cookies);
    const payload = JSON.parse(res.body);
    const token = this.extractToken(payload);
    if (!token) throw new Error(`登录成功但未找到 token`);
    this.token = token;
    this.cookies["GMITM_token"] = token;
    this.cookies["GMITM_uname"] = this.creds.username;
    this.cookies["GMITM_config"] = this.buildConfigValue();

    await guard.waitForSlot();
    try {
      const cookieStr = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      const pageRes = curlFetch("https://sem.3ue.co/analytics/overview/", {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          cookie: cookieStr,
        },
        followRedirects: true,
        timeoutMs: 15000,
      });
      Object.assign(this.cookies, pageRes.cookies);
    } catch {
      // 页面访问失败不阻塞流程
    }

    guard.setCachedSession(this.creds.username, token, this.cookies);
    console.log("[SemRush] 登录成功，会话已缓存");
    return token;
  }

  private async rpc(payload: unknown, retryCount = 0, sessionRefreshed = false): Promise<unknown> {
    const MAX_RPC_RETRIES = 2;
    if (!this.token) await this.login();
    await guard.waitForSlot();
    const cookieStr = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const res = curlFetch(RPC_URL, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        "content-type": "application/json; charset=utf-8",
        origin: RPC_ORIGIN,
        referer: "https://sem.3ue.co/analytics/overview/",
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        cookie: cookieStr,
      },
      body: JSON.stringify(payload),
      timeoutMs: 30000,
    });
    if (res.status >= 400) {
      if (res.status === 401 || res.status === 403) {
        guard.invalidateSession();
      }
      const statusMessages: Record<number, string> = {
        401: "3UE 账户认证失败，请检查用户名和密码是否正确",
        403: "3UE 账户访问被拒绝，可能是账户已过期或 API Key 无效，请联系管理员检查 SemRush 配置",
        429: "3UE 请求过于频繁，请稍后再试（系统已自动限流，建议等待几分钟后重试）",
        500: "3UE 服务器内部错误，请稍后再试",
        502: "3UE 服务暂时不可用，请稍后再试",
        503: "3UE 服务暂时不可用，请稍后再试",
      };
      throw new Error(statusMessages[res.status] || `3UE 服务请求失败 (HTTP ${res.status})，请稍后再试`);
    }

    let body = res.body.trim();

    // 如果 body 以 HTTP/ 开头，说明 curlFetch 解析时包含了嵌套的响应头（100 Continue 残留）
    if (body.startsWith("HTTP/")) {
      const innerSep = body.indexOf("\r\n\r\n");
      const innerSep2 = body.indexOf("\n\n");
      const sep = innerSep >= 0 ? innerSep : innerSep2;
      const sepLen = innerSep >= 0 ? 4 : 2;
      if (sep > 0) {
        body = body.slice(sep + sepLen).trim();
      }
    }

    // 如果 body 以 < 开头，说明返回了 HTML（可能是会话过期被重定向到登录页）
    if (body.startsWith("<") && !sessionRefreshed) {
      console.warn("[SemRush] RPC 返回 HTML 而非 JSON，会话可能已过期，刷新会话后重试");
      guard.invalidateSession();
      this.token = null;
      await this.login();
      return this.rpc(payload, 0, true);
    }

    if (!body) {
      if (!sessionRefreshed) {
        console.warn("[SemRush] RPC 返回空 body，刷新会话后重试");
        guard.invalidateSession();
        this.token = null;
        await this.login();
        return this.rpc(payload, 0, true);
      }
      throw new Error("3UE 返回空响应，请检查 3UE 账户状态");
    }

    try {
      return JSON.parse(body);
    } catch (parseErr) {
      const safePreview = body.slice(0, 200).replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

      if (!sessionRefreshed && retryCount === 0) {
        console.warn(`[SemRush] JSON 解析失败，刷新会话后重试。body 前200字符: ${safePreview}`);
        guard.invalidateSession();
        this.token = null;
        await this.login();
        return this.rpc(payload, 0, true);
      }

      if (retryCount < MAX_RPC_RETRIES) {
        const wait = (retryCount + 1) * 3000 + Math.floor(Math.random() * 2000);
        console.warn(`[SemRush] JSON 解析失败 (${retryCount + 1}/${MAX_RPC_RETRIES})，${wait}ms 后重试。body 前200字符: ${safePreview}`);
        await new Promise((r) => setTimeout(r, wait));
        return this.rpc(payload, retryCount + 1, sessionRefreshed);
      }
      const preview = body.slice(0, 300).replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
      console.error(`[SemRush] JSON 解析最终失败 (已重试${MAX_RPC_RETRIES}次)。body 前300字符: ${preview}`);
      throw new Error("3UE 服务返回了不完整的数据，请稍后重试");
    }
  }

  async getRatesDate(domain: string): Promise<string> {
    const payload = [
      { id: 1, jsonrpc: "2.0", method: "user.Databases", params: { userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey } },
      { id: 2, jsonrpc: "2.0", method: "adwords.SnapshotDates", params: { database: this.creds.database, userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey } },
      { id: 3, jsonrpc: "2.0", method: "currency.Rates", params: { date: Date.now(), userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey } },
    ];
    const response = (await this.rpc(payload)) as any[];
    return String(response[1]?.result?.daily?.[0] || "");
  }

  async getReportToken(domain: string): Promise<string> {
    const payload = {
      id: 11, jsonrpc: "2.0", method: "token.Get",
      params: {
        reportType: "adwords.copies", database: this.creds.database,
        date: Date.now(), dateType: "daily", searchItem: domain,
        page: 1, pageSize: 100,
        userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey,
      },
    };
    const response = (await this.rpc(payload)) as any;
    return String(response?.result?.token || "");
  }

  async keywords(domain: string, limit = 5): Promise<SemRushKeyword[]> {
    const payload = {
      id: 13, jsonrpc: "2.0", method: "organic.PositionsOverview",
      params: {
        request_id: crypto.randomUUID(), report: "domain.overview",
        args: { database: this.creds.database, dateType: "daily", dateFormat: "date", searchItem: domain, searchType: "domain", positionsType: "all" },
        userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey,
      },
    };
    const response = (await this.rpc(payload)) as any;
    const rows = response?.result || [];
    return rows.slice(0, limit).map((r: any) => parseKeywordRow(r));
  }

  /**
   * 获取域名的完整有机搜索关键词列表（对应 SemRush organic positions 页面）。
   * 使用 token + 分页，可获取数百个关键词而非概览的 5-10 个。
   */
  async organicPositions(domain: string, pageSize = 200): Promise<SemRushKeyword[]> {
    const tokenPayload = {
      id: 20, jsonrpc: "2.0", method: "token.Get",
      params: {
        reportType: "organic.positions", database: this.creds.database,
        date: Date.now(), dateType: "daily", searchItem: domain,
        page: 1, pageSize,
        userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey,
      },
    };
    const tokenResp = (await this.rpc(tokenPayload)) as any;
    const token = String(tokenResp?.result?.token || "");
    if (!token) {
      console.warn("[SemRush] organic.positions token 获取失败，回退到 overview");
      return this.keywords(domain, 20);
    }

    const dateStr = normalizeReportDate(await this.getOrganicDate(domain));

    const dataPayload = [
      {
        id: 21, jsonrpc: "2.0", method: "organic.Positions",
        params: {
          token, database: this.creds.database, searchItem: domain, searchType: "domain",
          date: dateStr, dateType: "daily", filter: {},
          display: { order: { field: "traffic", direction: "desc" }, page: 1, pageSize },
          userId: parseInt(this.creds.userId),
        },
      },
      {
        id: 22, jsonrpc: "2.0", method: "organic.PositionsTotal",
        params: {
          token, database: this.creds.database, searchItem: domain, searchType: "domain",
          date: dateStr, dateType: "daily", filter: {},
          display: { order: { field: "traffic", direction: "desc" }, page: 1, pageSize },
          userId: parseInt(this.creds.userId),
        },
      },
    ];
    const response = (await this.rpc(dataPayload)) as any[];
    const rows = response[0]?.result || [];
    const total = response[1]?.result || 0;
    console.log(`[SemRush] organic.Positions: ${rows.length} rows / ${total} total for ${domain} (db=${this.creds.database})`);
    return rows.map((r: any) => parseKeywordRow(r));
  }

  private async getOrganicDate(domain: string): Promise<string> {
    try {
      const payload = [
        { id: 1, jsonrpc: "2.0", method: "user.Databases", params: { userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey } },
        { id: 2, jsonrpc: "2.0", method: "organic.SnapshotDates", params: { database: this.creds.database, userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey } },
      ];
      const response = (await this.rpc(payload)) as any[];
      const dateVal = response[1]?.result?.daily?.[0];
      if (dateVal) return String(dateVal);
    } catch (err) {
      console.warn("[SemRush] organic.SnapshotDates 失败，回退到 adwords 日期:", err);
    }
    return await this.getRatesDate(domain);
  }

  async adsOverview(domain: string, limit = 10): Promise<{ title: string; description: string }[]> {
    const payload = {
      id: 14, jsonrpc: "2.0", method: "adwords.PositionsOverview",
      params: {
        request_id: crypto.randomUUID(), report: "domain.overview",
        args: { database: this.creds.database, dateType: "daily", dateFormat: "date", searchItem: domain, searchType: "domain", positionsType: "all" },
        userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey,
      },
    };
    const response = (await this.rpc(payload)) as any;
    const rows = response?.result || [];
    return rows.slice(0, limit).map((r: any) => ({ title: r.title || "", description: r.description || "" }));
  }

  async copies(domain: string, reportToken: string, limit = 100): Promise<{ date: string; total: number; samples: { title: string; description: string }[] }> {
    const dateStr = normalizeReportDate(await this.getRatesDate(domain));
    const payload = [
      {
        id: 5, jsonrpc: "2.0", method: "adwords.Copies",
        params: {
          token: reportToken, database: this.creds.database, searchItem: domain, searchType: "domain",
          date: dateStr, dateType: "daily", filter: {},
          display: { order: { field: "copy_positions", direction: "desc" }, page: 1, pageSize: 100 },
          userId: parseInt(this.creds.userId),
        },
      },
      {
        id: 6, jsonrpc: "2.0", method: "adwords.CopiesTotal",
        params: {
          token: reportToken, database: this.creds.database, searchItem: domain, searchType: "domain",
          date: dateStr, dateType: "daily", filter: {},
          display: { order: { field: "copy_positions", direction: "desc" }, page: 1, pageSize: 100 },
          userId: parseInt(this.creds.userId),
        },
      },
    ];
    const response = (await this.rpc(payload)) as any[];
    const rows = response[0]?.result || [];
    const total = response[1]?.result || 0;
    const samples = rows.slice(0, limit).map((r: any) => ({ title: r.title || "", description: r.description || "" }));
    return { date: dateStr, total, samples };
  }

  /** 尝试通过 3UE 页面 URL 抓取嵌入数据 */
  async fetchFromPageUrl(pageUrl: string): Promise<SemRushKeyword[]> {
    if (!this.token) await this.login();
    await guard.waitForSlot();
    const cookieStr = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const res = curlFetch(pageUrl, {
      headers: {
        "user-agent": USER_AGENT,
        cookie: cookieStr,
        accept: "text/html,application/xhtml+xml,*/*",
      },
      timeoutMs: 20000,
    });
    if (res.status >= 400) return [];
    const html = res.body;
    const patterns = [
      /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/,
      /window\.__data\s*=\s*(\{[\s\S]*?\});/,
      /__NEXT_DATA__[^>]*>(\{[\s\S]*?\})\s*<\/script>/,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        try {
          const data = JSON.parse(match[1]);
          const keywords = this.extractKeywordsFromEmbeddedData(data);
          if (keywords.length > 0) return keywords;
        } catch {}
      }
    }
    return [];
  }

  private extractKeywordsFromEmbeddedData(data: any, depth = 0): SemRushKeyword[] {
    if (depth > 5 || !data || typeof data !== "object") return [];
    if (Array.isArray(data)) {
      if (data.length > 0 && data[0]?.phrase) {
        return data
          .filter((r) => r.phrase)
          .map((r) => ({
            phrase: String(r.phrase),
            volume: Number(r.volume || 0),
            cpc: r.cpc != null ? Number(r.cpc) : null,
            competition: r.competition ?? r.competition_level ?? null,
            suggested_bid: r.suggested_bid != null
              ? Number(r.suggested_bid)
              : r.suggestedBid != null
                ? Number(r.suggestedBid)
                : r.cpc != null
                  ? Number(r.cpc)
                  : null,
          }));
      }
      for (const item of data) {
        const result = this.extractKeywordsFromEmbeddedData(item, depth + 1);
        if (result.length > 0) return result;
      }
    } else {
      for (const value of Object.values(data)) {
        const result = this.extractKeywordsFromEmbeddedData(value, depth + 1);
        if (result.length > 0) return result;
      }
    }
    return [];
  }

  /** 一站式查询：关键词 + 竞品广告标题/描述（去重）。自动使用缓存和限流。 */
  async queryDomain(domainOrUrl: string): Promise<SemRushResult> {
    const domain = normalizeDomain(domainOrUrl);
    if (!domain) throw new Error("无效的域名");

    const cacheKey = `${domain}:${this.creds.database}`;
    const cached = guard.getCachedDomain(cacheKey);
    if (cached) {
      console.log(`[SemRush] 命中缓存: ${domain} (db=${this.creds.database}, ${cached.keywords.length} 关键词)`);
      return cached;
    }

    console.log(`[SemRush] 开始查询: ${domain} (db=${this.creds.database})（队列状态: ${JSON.stringify(guard.getStats())}）`);
    await this.login();

    let kws: SemRushKeyword[];
    try {
      kws = await this.organicPositions(domain, 200);
    } catch (err) {
      console.warn("[SemRush] organicPositions 失败，回退到 overview:", err);
      kws = await this.keywords(domain, 20);
    }
    const ads = await this.adsOverview(domain, 20);

    let copiesData: { date: string; total: number; samples: { title: string; description: string }[] } = { date: "", total: 0, samples: [] };
    try {
      const reportToken = await this.getReportToken(domain);
      if (reportToken) {
        copiesData = await this.copies(domain, reportToken);
      }
    } catch (err) {
      console.warn("[SemRush] copies 查询失败，使用 ads_overview 数据:", err);
    }

    const creativeSamples = selectCreativeSamples(ads, copiesData.samples);
    const titlePool = creativeSamples.filter((s) => s.title).map((s) => s.title);
    const descPool = creativeSamples.filter((s) => s.description).map((s) => s.description);

    const result: SemRushResult = {
      domain,
      keywords: kws,
      adsOverview: ads,
      copies: copiesData,
      creativeSamples,
      dedupedTitles: dedupeAdTitles(titlePool),
      dedupedDescriptions: dedupeAdDescriptions(descPool),
    };

    guard.setCachedDomain(cacheKey, result);
    console.log(`[SemRush] 查询完成并缓存: ${domain} (db=${this.creds.database}, ${kws.length} 关键词, ${ads.length} 广告)`);
    return result;
  }

  /** 获取缓存统计信息 */
  static getGuardStats() {
    return guard.getStats();
  }
}
