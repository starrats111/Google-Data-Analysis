/**
 * 追踪链接 + 上级联盟自动巡航（主 CRM 自建，移植自 hermes-crm link-resolver）
 *
 * 把员工"在对应国家环境打开联盟追踪链接拿最终链接"自动化：
 *   1. 按投放国取代理（crawl-proxy），切换出口国
 *   2. 跟随联盟链接整条重定向链（HTTP；可选无头 Chrome 过指纹门）
 *   3. 拆分 landing_url（origin+path）/ tracking_link（query 串）
 *   4. 整条跳转链命中上级联盟识别库 → 标注 parent_network
 *   5. 命中该平台上级联盟黑名单 → forbidden_network（创建广告时硬拦截）
 *   6. 无追踪参数 → no_tracking；停在跳板域名 → resolve_failed
 *
 * 资源约束（低配生产机）：guard 路径默认仅走 HTTP 巡航（足以识别黑名单——跳板域名
 * 在跳转链里一定出现）；无头 Chrome 只在「测试巡航」等显式场景按 slot 串行启用。
 */

import * as https from "node:https";
import * as http from "node:http";
import { existsSync } from "node:fs";
import prisma from "@/lib/prisma";
import { getProxyUrlForCountry, ensureCountryEgressHttpProxy } from "@/lib/crawl-proxy";
import { acquirePuppeteerSlot } from "@/lib/puppeteer-semaphore";

export type LinkStatus = "ok" | "no_tracking" | "forbidden_network" | "resolve_failed";

export interface ResolveResult {
  status: LinkStatus;
  landingUrl: string | null;
  trackingLink: string | null; // query 串（不含前导 ?）
  finalUrl: string | null;
  parentNetwork: string | null; // 识别到的上级联盟 label
  forbiddenKeyword: string | null; // 命中黑名单的上级联盟 label
  chain: string[];
  usedProxy: boolean;
  usedBrowser: boolean;
  error?: string;
  // 内部提示：本结果来自 EV/MUI 中转域名的静态参数解包（只拿回广告主域名、缺网络追踪参数），
  // 外层应再用真实浏览器跟随一次以补全完整落地页（带追踪 query）。
  requiresBrowserEnrich?: boolean;
}

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// 跳板/中转域名：最终落地页不应停在这些域名上。停在此 → 没跟到广告主（多半国家出口不对）。
const TRACKER_HOST_PATTERNS: RegExp[] = [
  /(^|\.)flexlinkspro\.com$/i, /(^|\.)flexoffers\.com$/i,
  /(^|\.)awin1\.com$/i, /(^|\.)zenaps\.com$/i, /(^|\.)dwin1\.com$/i,
  /(^|\.)prf\.hn$/i, /\.pxf\.io$/i, /(^|\.)sjv\.io$/i, /(^|\.)ojrq\.net$/i,
  /(^|\.)linksynergy\.com$/i,
  /(^|\.)anrdoezrs\.net$/i, /(^|\.)dpbolvw\.net$/i, /(^|\.)jdoqocy\.com$/i,
  /(^|\.)kqzyfj\.com$/i, /(^|\.)tkqlhce\.com$/i, /(^|\.)qksrv\.net$/i, /(^|\.)emjcd\.com$/i,
  /(^|\.)shareasale\.com$/i, /(^|\.)shrsl\.com$/i,
  /(^|\.)pntra\.com$/i, /(^|\.)pntrac\.com$/i, /(^|\.)pntrs\.com$/i,
  /(^|\.)tradedoubler\.com$/i, /(^|\.)tradetracker\.(com|net)$/i,
  /(^|\.)webgains\.com$/i, /(^|\.)track\.webgains/i,
  /(^|\.)everflow\.io$/i, /(^|\.)viglink\.com$/i, /(^|\.)redirectingat\.com$/i,
  /(^|\.)linkhaitao\.(cn|com)$/i, /(^|\.)skimresources\.com$/i,
];

function isTrackerHost(host: string): boolean {
  return TRACKER_HOST_PATTERNS.some((re) => re.test(host));
}

// EngageVantage / UltraInfluence「发布者点击中转」域名（pub.* 等）。
// 这些域名靠 JS/服务端跳转把用户最终带到广告主落地页（典型再经 Rakuten 等网络挂上追踪参数）：
//   完整广告主落地页 = 广告主域名 + 追踪 query，例：
//   https://www.legalwills.ca/?ranMID=...&utm_source=rakuten&utm_campaign=EngageVantage
// 纯 HTTP 巡航跟不动其 JS 跳转、会停在中转域名上 → 必须靠真实浏览器跟随才能拿到「完整」落地页；
// 浏览器不可用时退而解其 url=/destination= 参数里的静态广告主 URL（至少拿回正确的广告主域名）。
// ⚠️ 仅匹配「主机名」：绝不误伤把 engagevantage/ultrainfluence 写进 utm_campaign 等参数值的正常落地页。
const NETWORK_CLICK_HOST_PATTERNS: RegExp[] = [
  /(^|\.)engagevantage\.com$/i, /(^|\.)ultrainfluence\.com$/i,
];

function isNetworkClickHost(host: string): boolean {
  return NETWORK_CLICK_HOST_PATTERNS.some((re) => re.test(host));
}

/**
 * host 是否为「不应作为广告主落地页」的中转域名（联盟跳板 / 发布者点击中转 / App 深链）。
 * 供调用方（如建广告缓存复用）校验：缓存的 resolved_final_url 若落在这些域名上，即视为脏数据，
 * 应丢弃缓存重新现场巡航，避免把联盟追踪/中转链接当成商家落地页。
 */
export function isNonLandingHost(host: string): boolean {
  return isTrackerHost(host) || isNetworkClickHost(host) || isDeeplinkHost(host);
}

// App 深链 / 移动归因中转域名：这些不是网页落地页，真正的 web 落地 URL 被塞在它们的
// 回退参数里（靠 App 端逻辑跳转，不是 HTTP 3xx），纯 HTTP 巡航会误停在这里。
const DEEPLINK_HOST_PATTERNS: RegExp[] = [
  /(^|\.)adj\.st$/i, /(^|\.)adjust\.com$/i, // Adjust
  /(^|\.)onelink\.me$/i, /(^|\.)appsflyer\.com$/i, // AppsFlyer
  /(^|\.)app\.link$/i, /(^|\.)bnc\.lt$/i, // Branch
];

function isDeeplinkHost(host: string): boolean {
  return DEEPLINK_HOST_PATTERNS.some((re) => re.test(host));
}

// 解 JavaScript unicode 转义（\u003D→= \u0026→& 等）。Adjust 等深链页面把跳转 URL 藏在
// JS/JSON 里，分隔符常是 \u003D / \u0026，不解码则 searchParams 无法切分出回退参数。
function decodeJsUnicode(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// 各深链平台「真实 web 落地」回退参数（按优先级），外加通用兜底
const DEEPLINK_FALLBACK_PARAMS = [
  "adjust_redirect", "redirect", "fallback", // Adjust
  "af_web_dp", "af_r", // AppsFlyer
  "$desktop_url", "$fallback_url", "$web_only_url", // Branch
  "url", "destination", // 通用兜底
];

/**
 * 从 App 深链 URL 的回退参数里解出真实 web 落地 URL。
 * 参数值可能被多层 URL-encode，做有限次解码后取首个合法 http(s) 且非深链/跳板的域名。
 * 解不出返回 null（交由调用方判 resolve_failed）。
 */
function unwrapDeeplink(deeplinkUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(decodeJsUnicode(deeplinkUrl));
  } catch {
    return null;
  }
  for (const key of DEEPLINK_FALLBACK_PARAMS) {
    const raw = parsed.searchParams.get(key);
    if (!raw) continue;
    let candidate = raw.trim();
    // 多层解码：最多 3 次，直到出现 http(s):// 开头
    for (let i = 0; i < 3 && !/^https?:\/\//i.test(candidate); i++) {
      try {
        const decoded = decodeURIComponent(candidate);
        if (decoded === candidate) break;
        candidate = decoded;
      } catch {
        break;
      }
    }
    if (!/^https?:\/\//i.test(candidate)) continue;
    let cand: URL;
    try {
      cand = new URL(candidate);
    } catch {
      continue;
    }
    // 真实落地不应仍是深链 / 跳板域名
    if (isDeeplinkHost(cand.hostname) || isTrackerHost(cand.hostname)) continue;
    return cand.toString();
  }
  return null;
}

// ───────── 上级联盟库 / 黑名单（Prisma，5 分钟内存缓存）─────────
interface ParentNet {
  label: string;
  keywords: string[];
}
let rulesCache: { at: number; parents: ParentNet[] } | null = null;
const RULES_TTL_MS = 5 * 60 * 1000;

async function getParentNetworks(): Promise<ParentNet[]> {
  if (rulesCache && Date.now() - rulesCache.at < RULES_TTL_MS) return rulesCache.parents;
  const rows = await prisma.parent_networks.findMany({
    where: { status: "active" },
    select: { label: true, match_keywords: true },
  });
  const parents: ParentNet[] = rows
    .map((r) => {
      let kws: string[] = [];
      const v = r.match_keywords as unknown;
      if (Array.isArray(v)) kws = v.map((x) => String(x).toLowerCase().trim()).filter(Boolean);
      const label = (r.label || "").toLowerCase().trim();
      if (label && !kws.includes(label)) kws.unshift(label);
      return { label, keywords: kws };
    })
    .filter((n) => n.label && n.keywords.length);
  rulesCache = { at: Date.now(), parents };
  return parents;
}

/** 该平台（含 * 全平台）禁跑的上级联盟 label 集合 */
async function getPlatformBlacklist(platform: string | null): Promise<Set<string>> {
  const rows = await prisma.platform_blacklist.findMany({
    where: {
      status: "active",
      OR: [{ platform: (platform || "").toUpperCase() }, { platform: "*" }],
    },
    select: { parent_label: true },
  });
  return new Set(rows.map((r) => (r.parent_label || "").toLowerCase().trim()).filter(Boolean));
}

async function detectParentNetwork(haystack: string): Promise<string | null> {
  for (const n of await getParentNetworks()) {
    if (n.keywords.some((kw) => haystack.includes(kw))) return n.label;
  }
  return null;
}

/** 清空规则缓存（后台增删上级联盟/黑名单后调用） */
export function clearAffiliateRulesCache() {
  rulesCache = null;
}

/**
 * 离线识别上级联盟：仅用一段已知文本（如从 Google 反向回填的 final_url_suffix /
 * 落地后缀）匹配识别库 + 平台黑名单，**不发起任何网络巡航**。
 * 用于批量回填的「零成本快路径」：final_url_suffix 里常已含 pzevent/irclickid/ranMID
 * 等上级联盟铁证，命中即可直接回填，省去巡航（尤其对 rewardoo 等 JS 跳转跟不动的链接）。
 * 命中返回 parentNetwork（识别库 label）；未命中返回 null，由调用方决定是否再走巡航。
 */
export async function detectParentNetworkFromText(
  text: string | null | undefined,
  platform: string | null,
): Promise<{ parentNetwork: string | null; blacklisted: boolean }> {
  const haystack = (text || "").toLowerCase();
  if (!haystack.trim()) return { parentNetwork: null, blacklisted: false };
  const parentNetwork = await detectParentNetwork(haystack);
  const blacklisted = !!parentNetwork && (await getPlatformBlacklist(platform)).has(parentNetwork);
  return { parentNetwork, blacklisted };
}

// ───────── 客户端跳转提取（meta refresh / location= 等）─────────
export function extractClientRedirect(body: string, baseUrl: string): string | null {
  const sample = body.length > 100000 ? body.slice(0, 100000) : body;
  const abs = (u: string): string | null => {
    const cleaned = decodeJsUnicode(u.replace(/&amp;/g, "&")).trim();
    if (!/^https?:\/\//i.test(cleaned)) return null;
    try {
      return new URL(cleaned, baseUrl).toString();
    } catch {
      return null;
    }
  };
  const meta = sample.match(/http-equiv=["']?refresh["']?[^>]*content=["'][^"']*?url=([^"']+)/i);
  if (meta) {
    const m = abs(meta[1]);
    if (m) return m;
  }
  const loc = sample.match(/location(?:\.href|\.assign\(|\.replace\(|\s*=)\s*=?\s*["'](https?:\/\/[^"']+)["']/i);
  if (loc) return abs(loc[1]);
  const locVar =
    sample.match(/location(?:\.href)?\s*=\s*([A-Za-z_$][\w$]*)\s*[;\n]/i) ||
    sample.match(/location\.(?:replace|assign)\(\s*([A-Za-z_$][\w$]*)\s*\)/i);
  if (locVar) {
    const ident = locVar[1];
    const v = sample.match(new RegExp(`(?:var|let|const)?\\s*${ident}\\s*=\\s*["'](https?://[^"']+)["']`, "i"));
    if (v) return abs(v[1]);
  }
  return null;
}

// 创建代理 Agent（移植自 kylink：SOCKS/HTTPS 全部禁用 TLS 证书校验）。
// 住宅代理出口节点常给自签/过时 TLS，或网关在隧道里回明文，导致
// `EPROTO wrong version number` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE`，
// 这类是握手层问题、与链接好坏无关，禁用校验即可正常巡航。
async function makeAgent(proxyUrl: string): Promise<unknown> {
  if (proxyUrl.startsWith("socks")) {
    const { SocksProxyAgent } = await import("socks-proxy-agent");
    const agent = new SocksProxyAgent(proxyUrl, { timeout: 18000 });
    // SocksProxyAgent 不支持 rejectUnauthorized 构造参数，monkey-patch connect 在 TLS 握手前注入
    const origConnect = agent.connect.bind(agent);
    (agent as unknown as { connect: unknown }).connect = ((req: never, opts: never) => {
      (opts as Record<string, unknown>).rejectUnauthorized = false;
      return (origConnect as (a: never, b: never) => unknown)(req, opts);
    }) as never;
    return agent;
  }
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  return new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false });
}

interface ChainResult {
  finalUrl: string;
  chain: string[];
  status: number;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// 可重试的瞬态网络/TLS 错误（移植自 kylink）：换一次出口（重拨）多半就好
const RETRYABLE_NET_ERRORS = [
  "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "EPROTO",
  "wrong version number", "socket hang up", "Client network socket disconnected",
  "timeout", "SSL", "decryption failed", "tlsv1",
];
function isRetryableNetErr(msg?: string): boolean {
  if (!msg) return false;
  const m = msg.toLowerCase();
  return RETRYABLE_NET_ERRORS.some((p) => m.includes(p.toLowerCase()));
}

// 联盟跳板/广告追踪域名常把真实目标塞在 url=/dest=/new= 等参数里（移植自 kylink）。
// 仅在该跳「失败/4xx」后作为兜底：从参数解出目标继续跟，避免停在跳板域名误判。
const EMBED_URL_PARAMS = ["url", "dest", "redirect", "landing", "goto", "target", "redir", "new", "u"];
function extractEmbeddedTarget(rawUrl: string): string | null {
  let o: URL;
  try {
    o = new URL(rawUrl);
  } catch {
    return null;
  }
  for (const p of EMBED_URL_PARAMS) {
    const v = o.searchParams.get(p);
    if (!v) continue;
    const candidates = [v];
    try {
      candidates.push(decodeURIComponent(v));
    } catch {
      /* ignore */
    }
    for (const c of candidates) {
      if (/^https?:\/\//i.test(c)) {
        try {
          new URL(c);
          return c;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null;
}

/**
 * 通过代理（或直连）手动跟随重定向，记录整条跳转链。
 * 移植 kylink 健壮性：单跳失败按可重试错误「重拨换出口」重试，禁用 TLS 校验，
 * 失败/4xx 时尝试从 URL 参数提取嵌入目标继续跟（联盟跳板封 IP 兜底）。
 */
export async function fetchChain(
  startUrl: string,
  proxyUrl: string | null,
  maxRedirects = 10,
  perHopTimeoutMs = 18000,
  fp: { userAgent?: string | null; referer?: string | null } = {},
  retryCount = 2,
): Promise<ChainResult> {
  let agent = proxyUrl ? await makeAgent(proxyUrl) : undefined;
  // 重拨：轮换住宅网关每次连接换出口 IP，重建 agent 即换节点
  const redial = async () => {
    if (proxyUrl) agent = await makeAgent(proxyUrl);
  };
  const chain: string[] = [];
  const ua = fp.userAgent || BROWSER_UA;

  type HopResult =
    | { type: "redirect"; location: string; status: number }
    | { type: "body"; body: string; status: number }
    | { type: "final"; status: number };

  // 单跳一次网络请求（成功 resolve，网络层失败 reject）
  const requestOnce = (targetUrl: string, hop: number): Promise<HopResult> => {
    return new Promise((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(targetUrl);
      } catch {
        return reject(new Error("invalid_url"));
      }
      const isHttps = parsed.protocol === "https:";
      const mod = isHttps ? https : http;
      const headers: Record<string, string> = {
        "User-Agent": ua,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.9",
        "Accept-Encoding": "identity",
      };
      if (hop === 0 && fp.referer) headers["Referer"] = fp.referer;
      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port) : isHttps ? 443 : 80,
        path: (parsed.pathname || "/") + parsed.search,
        method: "GET",
        headers,
        agent,
        timeout: perHopTimeoutMs,
        rejectUnauthorized: false,
      };
      const req = (mod as typeof https).request(reqOptions as https.RequestOptions, (res) => {
        const status = res.statusCode || 0;
        const location = res.headers["location"];
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          res.resume();
          return resolve({ type: "redirect", location: String(location), status });
        }
        const ctype = String(res.headers["content-type"] || "").toLowerCase();
        if (status >= 200 && status < 300 && (ctype.includes("html") || ctype === "")) {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (c: Buffer) => {
            if (total < 120000) {
              chunks.push(c);
              total += c.length;
            }
          });
          res.on("end", () => resolve({ type: "body", body: Buffer.concat(chunks).toString("utf8"), status }));
          res.on("error", () => resolve({ type: "final", status }));
        } else {
          res.resume();
          res.on("end", () => resolve({ type: "final", status }));
          res.on("error", () => resolve({ type: "final", status }));
        }
      });
      req.on("error", (e) => reject(e));
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("timeout"));
      });
      req.end();
    });
  };

  let targetUrl = startUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    chain.push(targetUrl);

    // 单跳带重试+重拨
    let res: HopResult | null = null;
    let lastErr: string | undefined;
    for (let attempt = 0; attempt <= retryCount; attempt++) {
      try {
        res = await requestOnce(targetUrl, hop);
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = (e instanceof Error ? e.message : String(e)).slice(0, 120);
        if (!isRetryableNetErr(lastErr) || attempt === retryCount) break;
        await redial();
        await sleep(150 * (attempt + 1));
      }
    }

    // 网络层彻底失败：尝试联盟跳板兜底（从参数提取目标继续），否则结束
    if (!res) {
      const embed = extractEmbeddedTarget(targetUrl);
      if (embed && !chain.includes(embed) && hop < maxRedirects) {
        targetUrl = embed;
        continue;
      }
      return { finalUrl: targetUrl, chain, status: 0, error: lastErr || "request_failed" };
    }

    if (res.type === "redirect") {
      if (hop >= maxRedirects) return { finalUrl: targetUrl, chain, status: res.status, error: "too_many_redirects" };
      let nextUrl: string;
      try {
        nextUrl = new URL(res.location, targetUrl).toString();
      } catch {
        return { finalUrl: targetUrl, chain, status: res.status, error: "bad_location" };
      }
      targetUrl = nextUrl;
      continue;
    }

    if (res.type === "body") {
      const next = extractClientRedirect(res.body, targetUrl);
      if (next && next !== targetUrl && hop < maxRedirects && !chain.includes(next)) {
        targetUrl = next;
        continue;
      }
      return { finalUrl: targetUrl, chain, status: res.status };
    }

    // type === final：4xx/5xx 时尝试联盟跳板兜底
    if (res.status >= 400) {
      const embed = extractEmbeddedTarget(targetUrl);
      if (embed && !chain.includes(embed) && hop < maxRedirects) {
        targetUrl = embed;
        continue;
      }
    }
    return { finalUrl: targetUrl, chain, status: res.status };
  }

  return { finalUrl: targetUrl, chain, status: 0, error: "max_redirects" };
}

// ───────── 无头 Chrome 巡航（过 FlexOffers/Impact 等指纹门）─────────
const BROWSER_CANDIDATES = [
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser", "/usr/bin/chromium",
  "/usr/bin/microsoft-edge-stable", "/usr/bin/microsoft-edge",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

function findBrowserPath(): string | null {
  for (const p of BROWSER_CANDIDATES) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

interface BrowserChainResult {
  finalUrl: string;
  chain: string[];
  error?: string;
}

async function resolveViaBrowser(startUrl: string, country: string): Promise<BrowserChainResult> {
  const chain: string[] = [];
  const browserPath = findBrowserPath();
  if (!browserPath) return { finalUrl: "", chain, error: "no_browser" };

  // Chrome 只支持 http 代理 + 账号认证，用按出口国校验的 http 代理
  const httpProxy = await ensureCountryEgressHttpProxy(country).catch(() => null);
  let proxyAuth: { server: string; username: string; password: string } | null = null;
  if (httpProxy) {
    try {
      const u = new URL(httpProxy);
      proxyAuth = {
        server: `http://${u.hostname}:${u.port}`,
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      };
    } catch {
      proxyAuth = null;
    }
  }

  const args = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-zygote",
    "--disable-blink-features=AutomationControlled",
  ];
  if (proxyAuth) args.push(`--proxy-server=${proxyAuth.server}`);

  const release = await acquirePuppeteerSlot(30000).catch(() => null);
  if (!release) return { finalUrl: "", chain, error: "no_puppeteer_slot" };

  // 动态加载的 puppeteer 类型用 any（与 crawler.ts 一致），避免 puppeteer-extra/core 类型分叉
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let launcher: any;
    try {
      const puppeteerExtra = await import("puppeteer-extra");
      const StealthPlugin = await import("puppeteer-extra-plugin-stealth");
      const stealthMod = StealthPlugin as unknown as { default?: () => unknown };
      const stealthFn = stealthMod.default || (StealthPlugin as unknown as () => unknown);
      (puppeteerExtra.default as unknown as { use: (p: unknown) => void }).use(stealthFn());
      launcher = puppeteerExtra.default;
    } catch {
      const puppeteerCore = await import("puppeteer-core");
      launcher = puppeteerCore.default || puppeteerCore;
    }
    browser = await launcher.launch({ executablePath: browserPath, headless: "new", args });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any = await browser.newPage();
    if (proxyAuth) {
      await page.authenticate({ username: proxyAuth.username, password: proxyAuth.password });
    }
    await page.setUserAgent(BROWSER_UA);
    await page.setViewport({ width: 1366, height: 768 });
    await page.setRequestInterception(true);
    page.on("request", (reqUnknown: unknown) => {
      const r = reqUnknown as {
        resourceType: () => string;
        isNavigationRequest: () => boolean;
        frame: () => unknown;
        url: () => string;
        abort: () => Promise<void>;
        continue: () => Promise<void>;
      };
      const t = r.resourceType();
      if (r.isNavigationRequest() && r.frame() === page.mainFrame()) {
        chain.push(r.url());
      }
      if (t === "image" || t === "media" || t === "font" || t === "stylesheet") {
        r.abort().catch(() => {});
      } else {
        r.continue().catch(() => {});
      }
    });
    try {
      await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
    } catch {
      /* 跳转中断属正常 */
    }
    try {
      await page.waitForNetworkIdle({ idleTime: 1500, timeout: 18000 });
    } catch {
      /* 超时无妨 */
    }
    const finalUrl = page.url();
    chain.push(finalUrl);
    const dedup = chain.filter((u, i) => i === 0 || u !== chain[i - 1]);
    return { finalUrl, chain: dedup };
  } catch (e) {
    return { finalUrl: "", chain, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  } finally {
    if (browser) await browser.close().catch(() => {});
    release();
  }
}

/**
 * 解析联盟追踪链接 → 落地页 + 追踪参数 + 上级联盟判定 + 黑名单拦截
 * @param affiliateUrl 联盟追踪链接
 * @param country 投放国（切换代理出口国）
 * @param platform 联盟平台代号（查该平台禁跑上级联盟）
 * @param opts.useBrowser 是否启用无头 Chrome（默认 false；guard 走纯 HTTP，测试巡航开 true）
 * @param opts.browserFallback 轻量抓取拿不到追踪参数(no_tracking)/停在跳板域名时，自动用无头浏览器重试一次
 *        （pepperjam/impact/ultrainfluence 等联盟需真实浏览器执行 JS 才注册点击并附加 clickId/utm 参数）
 */
export async function resolveAffiliateLink(
  affiliateUrl: string,
  country: string,
  platform: string | null,
  opts: {
    useBrowser?: boolean
    browserFallback?: boolean
    userId?: bigint | null
    userAgent?: string | null
    referer?: string | null
    /** 预先取好的粘性代理 URL（出口 IP 去重场景：探 IP 与生成复用同一会话）。传入时跳过内部取代理 */
    proxyUrl?: string | null
  } = {}
): Promise<ResolveResult> {
  const base: ResolveResult = {
    status: "resolve_failed",
    landingUrl: null,
    trackingLink: null,
    finalUrl: null,
    parentNetwork: null,
    forbiddenKeyword: null,
    chain: [],
    usedProxy: false,
    usedBrowser: false,
  };

  if (!affiliateUrl || !/^https?:\/\//i.test(affiliateUrl)) {
    return { ...base, error: "联盟链接为空或格式不合法" };
  }

  const cc = (country || "US").toUpperCase();

  // 把「一次抓取结果」评估成 ResolveResult（深链解包/上级联盟+黑名单/落地页/跳板/追踪后缀判定）
  const evaluate = async (
    res: { finalUrl: string; chain: string[]; error?: string },
    usedProxy: boolean,
    usedBrowser: boolean,
  ): Promise<ResolveResult> => {
    const r: ResolveResult = {
      status: "resolve_failed",
      landingUrl: null,
      trackingLink: null,
      finalUrl: res.finalUrl,
      parentNetwork: null,
      forbiddenKeyword: null,
      chain: res.chain,
      usedProxy,
      usedBrowser,
    };

    // App 深链解包：finalUrl 若停在 Adjust/AppsFlyer/Branch 等深链域名，真实 web 落地藏在其回退参数里。
    let stuckOnDeeplink = false;
    let finalUrl = res.finalUrl;
    let chain = res.chain;
    if (finalUrl) {
      try {
        const fHost = new URL(finalUrl).hostname;
        if (isDeeplinkHost(fHost)) {
          const real = unwrapDeeplink(finalUrl);
          if (real) {
            finalUrl = real;
            chain = [...chain, real];
          } else {
            stuckOnDeeplink = true;
          }
        }
      } catch {
        /* finalUrl 解析失败走原有 resolve_failed 分支 */
      }
    }

    // EngageVantage/UltraInfluence 发布者点击中转域名：停在此说明纯 HTTP 没跟动其 JS 跳转、还没到广告主。
    // 退而解其 url=/destination= 参数里的「静态广告主 URL」，至少拿回正确的广告主域名（避免把中转链接当落地页）。
    // 这种静态解包缺网络追踪参数（如 Rakuten 的 ranMID/utm）；若本轮没用浏览器 → 标记 needBrowserEnrich，
    // 交外层再用真实浏览器跟随一次，拿到「广告主域名 + 完整追踪 query」的完整落地页。
    let unwrappedNetworkClick = false;
    let needBrowserEnrich = false;
    if (finalUrl) {
      try {
        if (isNetworkClickHost(new URL(finalUrl).hostname)) {
          const real = unwrapDeeplink(finalUrl);
          if (real) {
            finalUrl = real;
            chain = [...chain, real];
            unwrappedNetworkClick = true;
            needBrowserEnrich = !usedBrowser;
          }
          // 解不出 → 保留在中转域名上，下方按「未跟到广告主」判 resolve_failed（触发浏览器兜底）
        }
      } catch {
        /* 解析失败交由后续 resolve_failed 判定 */
      }
    }
    r.finalUrl = finalUrl;
    r.chain = chain;

    // 上级联盟识别 + 平台黑名单：用整条跳转链判（即便没跟到最终落地页也能识别）
    const haystack = (chain.join(" ") + " " + (finalUrl || "")).toLowerCase();
    const parentNetwork = await detectParentNetwork(haystack);
    const blacklisted = !!parentNetwork && (await getPlatformBlacklist(platform)).has(parentNetwork);
    r.parentNetwork = parentNetwork;
    r.forbiddenKeyword = blacklisted ? parentNetwork : null;
    if (blacklisted) {
      r.status = "forbidden_network";
      return r;
    }

    if (!finalUrl) {
      r.status = "resolve_failed";
      r.error = res.error || "无最终链接";
      return r;
    }

    let finalParsed: URL;
    try {
      finalParsed = new URL(finalUrl);
    } catch {
      r.status = "resolve_failed";
      r.error = "最终链接解析失败";
      return r;
    }

    r.landingUrl = `${finalParsed.origin}${finalParsed.pathname}`;
    r.trackingLink = finalParsed.search.replace(/^\?/, "").trim() || null;

    // 停在 App 深链域名且解不出真实 web 落地 → 判失败
    if (stuckOnDeeplink || isDeeplinkHost(finalParsed.hostname)) {
      r.status = "resolve_failed";
      r.error = `停在 App 深链域名 ${finalParsed.hostname}，未解出真实网页落地页`;
      return r;
    }
    // 停在跳板/中转域名 → 没跟到广告主落地页
    if (isTrackerHost(finalParsed.hostname)) {
      r.status = "resolve_failed";
      r.error = `停在跳板域名 ${finalParsed.hostname}，未跟到广告主落地页（通常需配置对应国家代理）`;
      return r;
    }
    // 停在联盟发布者点击中转域名，且 url= 参数也解不出广告主 URL → 没跟到广告主，需真实浏览器跟随其 JS 跳转
    if (isNetworkClickHost(finalParsed.hostname)) {
      r.status = "resolve_failed";
      r.error = `停在联盟点击中转域名 ${finalParsed.hostname}，未跟到广告主落地页（该网络靠 JS 跳转，需真实浏览器跟随）`;
      return r;
    }

    let startHost = "";
    try {
      startHost = new URL(affiliateUrl).hostname;
    } catch {
      /* ignore */
    }
    if (res.error && finalParsed.hostname === startHost) {
      r.status = "resolve_failed";
      r.error = res.error;
      return r;
    }

    // 静态解包只拿到广告主域名、缺网络追踪参数 → 标记交外层用浏览器补全完整落地页。
    if (needBrowserEnrich) r.requiresBrowserEnrich = true;

    if (!r.trackingLink) {
      // 从 EV/MUI 中转链接静态解出的广告主落地页本身不带 query 参数属正常（追踪发生在中转跳转那一步，
      // CRM 实际追踪走 final_url_suffix 后缀交换系统）→ 视为解析成功，不误判 no_tracking（避免前端显示无效）。
      r.status = unwrappedNetworkClick ? "ok" : "no_tracking";
      return r;
    }
    r.status = "ok";
    return r;
  };

  // 取代理：调用方预取了粘性会话（出口 IP 去重）则直接复用，否则内部按国取。
  const acquireProxy = async (): Promise<string | null> =>
    opts.proxyUrl != null ? opts.proxyUrl : await getProxyUrlForCountry(cc, { userId: opts.userId }).catch(() => null);

  // ── 第一遍抓取 ──
  let result: ResolveResult;
  if (opts.useBrowser) {
    const br = await resolveViaBrowser(affiliateUrl, cc);
    if (br.finalUrl) {
      result = await evaluate(br, false, true);
    } else {
      const proxyUrl = await acquireProxy();
      const r0 = await fetchChain(affiliateUrl, proxyUrl, 10, 18000, { userAgent: opts.userAgent, referer: opts.referer });
      result = await evaluate(r0, !!proxyUrl, false);
    }
  } else {
    const proxyUrl = await acquireProxy();
    const r0 = await fetchChain(affiliateUrl, proxyUrl, 10, 18000, { userAgent: opts.userAgent, referer: opts.referer });
    result = await evaluate(r0, !!proxyUrl, false);
  }

  // ── 无头浏览器兜底 ──
  // 轻量抓取拿不到追踪参数(no_tracking)、停在跳板/联盟点击中转域名，或只从 EV/MUI 中转链接静态解出广告主
  // 域名（requiresBrowserEnrich，缺网络追踪参数）时——这类联盟（pepperjam/impact/EngageVantage/UltraInfluence 等）
  // 多半要真实浏览器执行 JS 才会跟到广告主落地页并附加 clickId/utm。用 puppeteer+stealth 重试一次（受信号量限并发）。
  if (
    opts.browserFallback &&
    !result.usedBrowser &&
    (result.status === "no_tracking" ||
      result.requiresBrowserEnrich === true ||
      (result.status === "resolve_failed" &&
        !!result.error &&
        (result.error.startsWith("停在跳板域名") || result.error.startsWith("停在联盟点击中转域名"))))
  ) {
    const br = await resolveViaBrowser(affiliateUrl, cc).catch(() => ({ finalUrl: "", chain: [] as string[] }));
    if (br.finalUrl) {
      const r2 = await evaluate(br, false, true);
      // 仅当浏览器结果更优（拿到 ok / 命中黑名单）才采用，否则保留首次结果
      if (r2.status === "ok" || r2.status === "forbidden_network") {
        result = r2;
      }
    }
  }

  return result;
}
