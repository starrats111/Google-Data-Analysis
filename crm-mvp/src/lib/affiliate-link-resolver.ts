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

async function makeAgent(proxyUrl: string): Promise<unknown> {
  if (proxyUrl.startsWith("socks")) {
    const { SocksProxyAgent } = await import("socks-proxy-agent");
    return new SocksProxyAgent(proxyUrl);
  }
  const { HttpsProxyAgent } = await import("https-proxy-agent");
  return new HttpsProxyAgent(proxyUrl);
}

interface ChainResult {
  finalUrl: string;
  chain: string[];
  status: number;
  error?: string;
}

/** 通过代理（或直连）手动跟随重定向，记录整条跳转链 */
export async function fetchChain(
  startUrl: string,
  proxyUrl: string | null,
  maxRedirects = 10,
  perHopTimeoutMs = 18000,
  fp: { userAgent?: string | null; referer?: string | null } = {}
): Promise<ChainResult> {
  const agent = proxyUrl ? await makeAgent(proxyUrl) : undefined;
  const chain: string[] = [];
  const ua = fp.userAgent || BROWSER_UA;

  const doRequest = (targetUrl: string, hop: number): Promise<ChainResult> => {
    return new Promise((resolve) => {
      chain.push(targetUrl);
      let parsed: URL;
      try {
        parsed = new URL(targetUrl);
      } catch {
        return resolve({ finalUrl: targetUrl, chain, status: 0, error: "invalid_url" });
      }
      const isHttps = parsed.protocol === "https:";
      const mod = isHttps ? https : http;
      const headers: Record<string, string> = {
        "User-Agent": ua,
        Accept: "text/html,application/xhtml+xml,*/*;q=0.9",
        "Accept-Encoding": "identity",
      };
      // 仅首跳带 Referer，模拟从搜索引擎/社媒进入
      if (hop === 0 && fp.referer) headers["Referer"] = fp.referer;
      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port ? parseInt(parsed.port) : isHttps ? 443 : 80,
        path: (parsed.pathname || "/") + parsed.search,
        method: "GET",
        headers,
        agent,
        timeout: perHopTimeoutMs,
      };
      const req = (mod as typeof https).request(reqOptions as https.RequestOptions, (res) => {
        const status = res.statusCode || 0;
        const location = res.headers["location"];
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          if (hop >= maxRedirects) {
            res.resume();
            return resolve({ finalUrl: targetUrl, chain, status, error: "too_many_redirects" });
          }
          res.resume();
          let nextUrl: string;
          try {
            nextUrl = new URL(String(location), targetUrl).toString();
          } catch {
            return resolve({ finalUrl: targetUrl, chain, status, error: "bad_location" });
          }
          doRequest(nextUrl, hop + 1).then(resolve);
          return;
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
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            const next = extractClientRedirect(body, targetUrl);
            if (next && next !== targetUrl && hop < maxRedirects && !chain.includes(next)) {
              doRequest(next, hop + 1).then(resolve);
              return;
            }
            resolve({ finalUrl: targetUrl, chain, status });
          });
          res.on("error", () => resolve({ finalUrl: targetUrl, chain, status }));
        } else {
          res.resume();
          res.on("end", () => resolve({ finalUrl: targetUrl, chain, status }));
          res.on("error", () => resolve({ finalUrl: targetUrl, chain, status }));
        }
      });
      req.on("error", (e) => resolve({ finalUrl: targetUrl, chain, status: 0, error: e.message.slice(0, 120) }));
      req.on("timeout", () => {
        req.destroy();
        resolve({ finalUrl: targetUrl, chain, status: 0, error: "timeout" });
      });
      req.end();
    });
  };

  return doRequest(startUrl, 0);
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
 */
export async function resolveAffiliateLink(
  affiliateUrl: string,
  country: string,
  platform: string | null,
  opts: { useBrowser?: boolean; userId?: bigint | null; userAgent?: string | null; referer?: string | null } = {}
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
  let res: { finalUrl: string; chain: string[]; error?: string };

  if (opts.useBrowser) {
    base.usedBrowser = true;
    const br = await resolveViaBrowser(affiliateUrl, cc);
    if (br.finalUrl) {
      res = br;
    } else {
      const proxyUrl = await getProxyUrlForCountry(cc, { userId: opts.userId }).catch(() => null);
      base.usedProxy = !!proxyUrl;
      res = await fetchChain(affiliateUrl, proxyUrl, 10, 18000, { userAgent: opts.userAgent, referer: opts.referer });
    }
  } else {
    const proxyUrl = await getProxyUrlForCountry(cc, { userId: opts.userId }).catch(() => null);
    base.usedProxy = !!proxyUrl;
    res = await fetchChain(affiliateUrl, proxyUrl, 10, 18000, { userAgent: opts.userAgent, referer: opts.referer });
  }

  base.chain = res.chain;
  base.finalUrl = res.finalUrl;

  // App 深链解包：finalUrl 若停在 Adjust/AppsFlyer/Branch 等深链域名，真实 web 落地藏在
  // 其回退参数里。解出真实 URL → 继续跟随其余跳转；解不出 → 后续按 deeplink 兜底判失败。
  let stuckOnDeeplink = false;
  if (res.finalUrl) {
    try {
      const fHost = new URL(res.finalUrl).hostname;
      if (isDeeplinkHost(fHost)) {
        const real = unwrapDeeplink(res.finalUrl);
        if (real) {
          // 解出的真实 URL 已带联盟追踪后缀（clickref 等），不再续跟广告主自身跳转，
          // 否则会丢掉这些必须保留的追踪参数。直接作为最终落地 URL。
          res = { finalUrl: real, chain: [...res.chain, real], error: undefined };
          base.chain = res.chain;
          base.finalUrl = res.finalUrl;
        } else {
          stuckOnDeeplink = true;
        }
      }
    } catch {
      /* finalUrl 解析失败走原有 resolve_failed 分支 */
    }
  }

  // 上级联盟识别 + 平台黑名单：先用整条跳转链判（即便没跟到最终落地页也能识别）
  const haystack = (res.chain.join(" ") + " " + (res.finalUrl || "")).toLowerCase();
  const parentNetwork = await detectParentNetwork(haystack);
  const blacklisted = !!parentNetwork && (await getPlatformBlacklist(platform)).has(parentNetwork);
  base.parentNetwork = parentNetwork;
  base.forbiddenKeyword = blacklisted ? parentNetwork : null;

  // 命中黑名单 → 拦截（最高优先级）
  if (blacklisted) {
    return { ...base, status: "forbidden_network" };
  }

  if (!res.finalUrl) {
    return { ...base, status: "resolve_failed", error: res.error || "无最终链接" };
  }

  let finalParsed: URL;
  try {
    finalParsed = new URL(res.finalUrl);
  } catch {
    return { ...base, status: "resolve_failed", error: "最终链接解析失败" };
  }

  base.landingUrl = `${finalParsed.origin}${finalParsed.pathname}`;
  base.trackingLink = finalParsed.search.replace(/^\?/, "").trim() || null;

  // 停在 App 深链域名且解不出真实 web 落地 → 判失败，绝不当成正常落地页（否则会把
  // bxfd.adj.st 这种空壳域名当落地页，加后缀后 404）
  if (stuckOnDeeplink || isDeeplinkHost(finalParsed.hostname)) {
    return {
      ...base,
      status: "resolve_failed",
      error: `停在 App 深链域名 ${finalParsed.hostname}，未解出真实网页落地页`,
    };
  }

  // 停在跳板/中转域名 → 没跟到广告主落地页（多半国家出口不对，需配/换代理）
  if (isTrackerHost(finalParsed.hostname)) {
    return {
      ...base,
      status: "resolve_failed",
      error: `停在跳板域名 ${finalParsed.hostname}，未跟到广告主落地页（通常需配置对应国家代理）`,
    };
  }

  // 此处 finalUrl 已是真实广告主域名（非跳板/深链）。即便最后一跳页面加载报错
  // （超时/被墙，常见于从服务器直连广告主站），落地 URL 与追踪后缀也已解析出来，照常采用；
  // 仅当根本没产生跳转（仍停在起始联盟链接）时才判失败。
  let startHost = "";
  try {
    startHost = new URL(affiliateUrl).hostname;
  } catch {
    /* ignore */
  }
  if (res.error && finalParsed.hostname === startHost) {
    return { ...base, status: "resolve_failed", error: res.error };
  }

  if (!base.trackingLink) {
    return { ...base, status: "no_tracking" };
  }
  return { ...base, status: "ok" };
}
