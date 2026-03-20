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

  async login(): Promise<string> {
    const ts = Date.now();
    const url = `${LOGIN_URL}?username=${encodeURIComponent(this.creds.username)}&password=${encodeURIComponent(this.creds.password)}&ts=${ts}`;
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, origin: LOGIN_ORIGIN },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`登录失败: HTTP ${res.status}`);
    // 保存 cookies
    const setCookies = res.headers.getSetCookie?.() || [];
    for (const c of setCookies) {
      const [kv] = c.split(";");
      const [k, v] = kv.split("=");
      if (k && v) this.cookies[k.trim()] = v.trim();
    }
    const payload = await res.json();
    const token = this.extractToken(payload);
    if (!token) throw new Error(`登录成功但未找到 token`);
    this.token = token;
    this.cookies["GMITM_token"] = token;
    this.cookies["GMITM_uname"] = this.creds.username;
    this.cookies["GMITM_config"] = this.buildConfigValue();
    return token;
  }

  private async rpc(payload: unknown): Promise<unknown> {
    if (!this.token) await this.login();
    const cookieStr = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      "content-type": "application/json; charset=utf-8",
      origin: RPC_ORIGIN,
      cookie: cookieStr,
    };
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`RPC 失败: HTTP ${res.status}`);
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
