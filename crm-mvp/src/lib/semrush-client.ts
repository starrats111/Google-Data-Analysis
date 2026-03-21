/**
 * SemRush 竞品分析客户端（移植自 sem01_client.py）
 * 通过 3UE 代理获取竞品域名的关键词、广告标题、广告描述
 */
import { getSystemConfigsByPrefix } from "@/lib/system-config";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const RPC_URL = "https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU";
const LOGIN_URL = "https://dash.3ue.co/api/account/login";
const LOGIN_ORIGIN = "https://dash.3ue.co";
const RPC_ORIGIN = "https://sem.3ue.co";

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

const COUNTRY_MAP: Record<string, string> = {
  US: "us", UK: "uk", CA: "ca", AU: "au",
  DE: "de", FR: "fr", JP: "jp", BR: "br",
};

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

export interface SemRushResult {
  domain: string;
  keywords: { phrase: string; volume: number }[];
  adsOverview: { title: string; description: string }[];
  copies: { date: string; total: number; samples: { title: string; description: string }[] };
  creativeSamples: { title: string; description: string }[];
  dedupedTitles: string[];
  dedupedDescriptions: string[];
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
    const db = country ? (COUNTRY_MAP[country.toUpperCase()] || configs["semrush_database"] || "us") : (configs["semrush_database"] || "us");
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

  private collectCookies(res: Response) {
    const setCookies = res.headers.getSetCookie?.() || [];
    for (const c of setCookies) {
      const [kv] = c.split(";");
      const eqIdx = kv.indexOf("=");
      if (eqIdx > 0) {
        const k = kv.slice(0, eqIdx).trim();
        const v = kv.slice(eqIdx + 1).trim();
        if (k && v) this.cookies[k] = v;
      }
    }
  }

  async login(): Promise<string> {
    const ts = Date.now();
    const url = `${LOGIN_URL}?username=${encodeURIComponent(this.creds.username)}&password=${encodeURIComponent(this.creds.password)}&ts=${ts}`;
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, origin: LOGIN_ORIGIN },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("3UE 登录失败：用户名或密码错误，请在管理后台检查 SemRush 配置");
      }
      throw new Error(`3UE 登录失败（HTTP ${res.status}），请稍后再试或联系管理员`);
    }
    this.collectCookies(res);
    const payload = await res.json();
    const token = this.extractToken(payload);
    if (!token) throw new Error(`登录成功但未找到 token`);
    this.token = token;
    this.cookies["GMITM_token"] = token;
    this.cookies["GMITM_uname"] = this.creds.username;
    this.cookies["GMITM_config"] = this.buildConfigValue();

    // 访问分析页面获取完整 session cookies（3UE 可能依赖页面加载时设置的额外 cookies）
    try {
      const pageRes = await fetch("https://sem.3ue.co/analytics/overview/", {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; "),
        },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      });
      this.collectCookies(pageRes);
      await pageRes.text();
    } catch {
      // 页面访问失败不阻塞流程
    }

    return token;
  }

  private async rpc(payload: unknown): Promise<unknown> {
    if (!this.token) await this.login();
    const cookieStr = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      "content-type": "application/json; charset=utf-8",
      origin: RPC_ORIGIN,
      referer: "https://sem.3ue.co/analytics/overview/",
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      cookie: cookieStr,
    };
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const statusMessages: Record<number, string> = {
        401: "3UE 账户认证失败，请检查用户名和密码是否正确",
        403: "3UE 账户访问被拒绝，可能是账户已过期或 API Key 无效，请联系管理员检查 SemRush 配置",
        429: "3UE 请求过于频繁，请稍后再试",
        500: "3UE 服务器内部错误，请稍后再试",
        502: "3UE 服务暂时不可用，请稍后再试",
        503: "3UE 服务暂时不可用，请稍后再试",
      };
      throw new Error(statusMessages[res.status] || `3UE 服务请求失败 (HTTP ${res.status})，请稍后再试`);
    }
    return res.json();
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

  async keywords(domain: string, limit = 5): Promise<{ phrase: string; volume: number }[]> {
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
    return rows.slice(0, limit).map((r: any) => ({ phrase: r.phrase || "", volume: r.volume || 0 }));
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
  async fetchFromPageUrl(pageUrl: string): Promise<{ phrase: string; volume: number }[]> {
    if (!this.token) await this.login();
    const cookieStr = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(pageUrl, {
      headers: {
        "user-agent": USER_AGENT,
        cookie: cookieStr,
        accept: "text/html,application/xhtml+xml,*/*",
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return [];
    const html = await res.text();
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

  private extractKeywordsFromEmbeddedData(data: any, depth = 0): { phrase: string; volume: number }[] {
    if (depth > 5 || !data || typeof data !== "object") return [];
    if (Array.isArray(data)) {
      if (data.length > 0 && data[0]?.phrase) {
        return data.filter((r) => r.phrase).map((r) => ({ phrase: String(r.phrase), volume: Number(r.volume || 0) }));
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

  /** 一站式查询：关键词 + 竞品广告标题/描述（去重） */
  async queryDomain(domainOrUrl: string): Promise<SemRushResult> {
    const domain = normalizeDomain(domainOrUrl);
    if (!domain) throw new Error("无效的域名");

    await this.login();

    const [kws, ads] = await Promise.all([
      this.keywords(domain, 10),
      this.adsOverview(domain, 20),
    ]);

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

    return {
      domain,
      keywords: kws,
      adsOverview: ads,
      copies: copiesData,
      creativeSamples,
      dedupedTitles: dedupeAdTitles(titlePool),
      dedupedDescriptions: dedupeAdDescriptions(descPool),
    };
  }
}
