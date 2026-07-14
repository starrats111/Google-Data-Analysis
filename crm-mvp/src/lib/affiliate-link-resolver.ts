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
import { acquireExchangeSlot } from "@/lib/puppeteer-semaphore";
import { probeExitIp } from "@/lib/suffix-engine/exit-ip";
import { pickMobileUserAgent } from "@/lib/mobile-user-agents";
import { registerBrowser, closeBrowserSafely, getStealthLauncher } from "@/lib/puppeteer-browser-registry";

export type LinkStatus = "ok" | "no_tracking" | "forbidden_network" | "resolve_failed";

/**
 * 剔除 URL 中「未展开的模板变量字面量」，如 `${http.request.uri.path}`（商家 Cloudflare
 * 动态重定向误配成静态文本时会原样出现在 Location 头里）或联盟宏 `${gdpr}`。
 * 这些片段一旦混进 resolved_final_url / final_url，会让后续爬取、后缀验证全部对着
 * 非法 URL 打（Alphalete 案例）。剔除后语义即商家本意（如"保留原路径跳 HTTPS"）。
 */
export function stripUnexpandedTemplateVars(url: string): string {
  if (!url || !url.includes("${")) return url;
  return url.replace(/\$\{[^}]*\}/g, "");
}

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
  /** 本次解析「实际点击」所用代理的真实出口 IP（浏览器兜底/内部自取代理路径回填；复用调用方粘性会话时为 null，
   *  由调用方用其预探测值兜底）。用于把「刷点击真实出口 IP」准确落库（suffix_pool / proxy_exit_ip_usage / click item）。 */
  exitIp: string | null;
  error?: string;
  // 内部提示：本结果来自 EV/MUI 中转域名的静态参数解包（只拿回广告主域名、缺网络追踪参数），
  // 外层应再用真实浏览器跟随一次以补全完整落地页（带追踪 query）。
  requiresBrowserEnrich?: boolean;
}

// 跟链/换链一律用「移动端」UA（安卓 Chrome + iPhone Safari，见 @/lib/mobile-user-agents），不再用 Windows 桌面：
// 移动版落地页普遍更轻量（更少大图/桌面脚本）→ 省代理流量，且与住宅代理出口更贴近真实手机用户。
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
  // D-162：生产 resolved_final_url 现存脏行里出现的 ad.doubleclick.net（Google 广告跳板）
  /(^|\.)doubleclick\.net$/i,
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
    const ident = locVar[1].replace(/\$/g, "\\$");
    // ident 赋值查找必须「词界锚定 + 大小写敏感」：旧版无锚定且带 i 标志，`location = url`（Google Ads
    // gtag_report_conversion 回调里的标准片段，Shopify 商家页普遍存在）会把 `Shopify.shopJsCdnBaseUrl =
    // "https://cdn.shopify.com/shopifycloud/shop-js"` 尾部的 Url 误当变量 url 的赋值 → 把 CDN 基址当客户端
    // 跳转跟过去，丢掉带追踪参数的真实落地页（piquelife 案例：换链接总跟不到直链的根因）。
    const v = sample.match(
      new RegExp(`(?:^|[^\\w$.])(?:var\\s+|let\\s+|const\\s+)?${ident}\\s*=\\s*["'](https?://[^"']+)["']`),
    );
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
  const ua = fp.userAgent || pickMobileUserAgent();

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
        // Location 里未展开的 ${...} 模板字面量先剔除再跟（Cloudflare 误配/联盟宏），
        // 否则脏 URL 会一路传染到 finalUrl / resolved_final_url / final_url
        nextUrl = new URL(stripUnexpandedTemplateVars(res.location), targetUrl).toString();
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
  /** 浏览器本次实际使用的 http 代理出口 IP（同会话粘性期内稳定；无代理/探活失败为 null） */
  exitIp?: string | null;
  error?: string;
}

// 浏览器兜底流量优化：只保留「跟到广告主落地页」所必需的请求，砍掉与联盟跳转无关的大头。
// kookeey 按流量计费，浏览器整页加载是纯 HTTP 的几十倍——这里两级拦截把落地页大头（第三方 JS SDK /
// 追踪像素 / 广告交易 / 心跳）挡在代理出口之外，同时放行 document + 联盟/广告主域名的 script / XHR，
// 保证 JS 跳转链仍能跟到带追踪参数的最终落地页。
// 1) 重资源类型直接拦（图片/媒体/字体/CSS/预取/推送/心跳等，均不参与跳转判定）。
const BROWSER_BLOCK_RESOURCE_TYPES = new Set([
  "image", "media", "font", "stylesheet", "texttrack",
  "eventsource", "websocket", "manifest", "prefetch", "ping",
  "cspviolationreport", "signedexchange",
]);
// 2) 第三方分析/广告/追踪域名整类拦（GA/GTM/Pixel/热图/广告交易/错误上报等）。联盟跳转经由联盟自身及
//    广告主域名完成，从不依赖这些域名，故整类 abort 不影响跟链成功率，却能砍掉落地页流量的最大头。
const BROWSER_BLOCK_HOST_RE =
  /(google-analytics|googletagmanager|googlesyndication|googleadservices|doubleclick|adservice\.google|connect\.facebook|facebook\.com|fbcdn\.net|hotjar|clarity\.ms|fullstory|mouseflow|luckyorange|cdn\.segment|api\.segment|mixpanel|amplitude|heapanalytics|analytics\.tiktok|analytics\.twitter|static\.ads-twitter|bat\.bing|criteo|taboola|outbrain|scorecardresearch|quantserve|adroll|mc\.yandex|newrelic|nr-data|sentry\.io|datadoghq|bugsnag|optimizely|onetrust|cookielaw|adnxs|pubmatic|rubiconproject|casalemedia|openx|3lift|33across|ct\.pinterest|klaviyo|cloudflareinsights|hs-analytics|matomo|piwik|tr\.snapchat|sc-static\.net|adsrvr\.org|bidswitch|smartadserver|teads|moatads|adsafeprotected|branch\.io|appsflyer|kochava|adjust\.com)/i;

async function resolveViaBrowser(
  startUrl: string,
  country: string,
  userId?: bigint | null,
): Promise<BrowserChainResult> {
  const chain: string[] = [];
  const browserPath = findBrowserPath();
  if (!browserPath) {
    console.warn(`[AffiliateResolver] 浏览器兜底失败：未找到可用 Chrome/Edge（no_browser） url=${startUrl.slice(0, 120)}`);
    return { finalUrl: "", chain, error: "no_browser" };
  }

  // Chrome 只支持 http 代理 + 账号认证，用按出口国校验的 http 代理。
  // 本函数只服务换链接（resolveAffiliateLink 的所有调用方均为换链接场景）→ 强制 exchange:true，
  // 一律走 kookeey 的 http 代理（1000 端口双协议），绝不借用 AI 出口(arxlabs)；userId 仅用于选该用户分配的供应商。
  const httpProxy = await ensureCountryEgressHttpProxy(country, { userId, exchange: true }).catch((e) => {
    // 无代理仍会继续（直连出口国不对，多半跟不到目标国落地页）→ 必须留痕，否则兜底静默失败无从排查
    console.warn(
      `[AffiliateResolver] 浏览器兜底取 ${country} http 代理失败，将无代理直连: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`,
    );
    return null;
  });
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

  // D-172：换链接专用快车道（可借主爬预留余量、唤醒优先于 normal 队列），
  // 不再与 sitelinks 兜底/图片代理的长批量同挤 normal 池被饿死。
  let slotErr = "";
  const release = await acquireExchangeSlot(30000).catch((e) => {
    slotErr = e instanceof Error ? e.message : String(e);
    return null;
  });
  if (!release) {
    // 错误信息带信号量瞬时状态（active/mainQ/exchangeQ/normalQ），用于区分「池满」vs「exchange 自排队（cap=1）」
    console.warn(`[AffiliateResolver] 浏览器兜底失败：30s 内未抢到 puppeteer 槽位（no_puppeteer_slot）${slotErr ? ` [${slotErr}]` : ""} url=${startUrl.slice(0, 120)}`);
    return { finalUrl: "", chain, error: "no_puppeteer_slot" };
  }

  // 动态加载的 puppeteer 类型用 any（与 crawler.ts 一致），避免 puppeteer-extra/core 类型分叉
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let launcher: any;
    try {
      // 2026-07-13：改用全局单例，避免每次调用都往 puppeteer-extra 追加一个 Stealth 插件实例
      launcher = await getStealthLauncher();
    } catch {
      const puppeteerCore = await import("puppeteer-core");
      launcher = puppeteerCore.default || puppeteerCore;
    }
    browser = await launcher.launch({ executablePath: browserPath, headless: "new", args });
    registerBrowser(browser, "affiliateResolver");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page: any = await browser.newPage();
    if (proxyAuth) {
      await page.authenticate({ username: proxyAuth.username, password: proxyAuth.password });
    }
    // 移动端 UA + 匹配的移动端视口（避免「手机 UA + 桌面分辨率」的指纹矛盾），并请求移动版轻量落地页。
    await page.setUserAgent(pickMobileUserAgent());
    await page.setViewport({ width: 393, height: 852, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    // 分阶段拦截（省 kookeey 流量大头）：换链接只需要拿到「广告主落地页 URL + 追踪 query」，
    // 一旦主框架离开入口/跳板/中转域名、抵达真正的广告主落地页，URL 就已确定——此后落地页自身的
    // script/xhr/图片等整页资源对「拿后缀」毫无价值，却是浏览器兜底流量最大的隐形放大器。故：
    //   ① 跳转阶段（仍在入口/跳板/联盟点击中转/深链域名）：放行 script/xhr/fetch，保证 JS 跳转能触发
    //      （MUI/PM/CG 等联盟靠 JS 执行点击注册才跳转，拦了会掉跟链成功率）；只拦重资源 + 第三方追踪。
    //   ② 落地阶段（已到广告主域名）：非导航请求一律拦，仅保留主跳转链，砍掉落地页整页加载。
    // 副作用红利：落地后资源被拦，后续 waitForNetworkIdle 会因无请求在飞而快速返回，兜底更快。
    let startHost = "";
    try {
      startHost = new URL(startUrl).hostname;
    } catch {
      /* ignore */
    }
    let reachedLanding = false;
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
      const isNav = r.isNavigationRequest() && r.frame() === page.mainFrame();
      // 导航请求（document 主跳转链）永不拦，否则会中断跟链。
      if (isNav) {
        chain.push(r.url());
        r.continue().catch(() => {});
        return;
      }
      // 落地判定：主框架 host 已离开入口/跳板/中转/深链域名 → 视为已抵达广告主落地页（latch，不回退）。
      // about:blank / chrome-error 等 hostname 为空，视为未落地；与 startHost 相同也视为未落地（还在入口页）。
      if (!reachedLanding) {
        try {
          const mfHost = new URL(page.mainFrame().url()).hostname;
          if (
            mfHost &&
            mfHost !== startHost &&
            !isTrackerHost(mfHost) &&
            !isNetworkClickHost(mfHost) &&
            !isDeeplinkHost(mfHost)
          ) {
            reachedLanding = true;
          }
        } catch {
          /* 未落地 */
        }
      }
      if (reachedLanding) {
        // 已到广告主落地页：URL 已定，落地页资源全拦，省整页加载流量。
        r.abort().catch(() => {});
        return;
      }
      // 跳转阶段：重资源类型 + 第三方分析/广告/追踪域名整类拦；script/xhr/fetch 放行以保证 JS 跳转成功。
      let host = "";
      try {
        host = new URL(r.url()).hostname;
      } catch {
        /* 非法 URL：交给类型判定 */
      }
      if (BROWSER_BLOCK_RESOURCE_TYPES.has(t) || (host && BROWSER_BLOCK_HOST_RE.test(host))) {
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
    // D-172：导航落在 chrome-error://（代理隧道断连/网关瞬时故障最常见）→ 同会话立即重导航一次。
    // 轮换住宅网关下新建连接即换出口节点，实测这类瞬时故障重试一次多半即恢复；
    // 复用已启动的 browser + slot，重试成本仅一次 goto，远低于整条生成失败后等下轮 cron。
    if (String(page.url()).startsWith("chrome-error://")) {
      console.warn(`[AffiliateResolver] 浏览器兜底导航落在 chrome-error（代理/网络瞬时故障），同会话重试一次 url=${startUrl.slice(0, 120)}`);
      try {
        await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      } catch {
        /* 跳转中断属正常 */
      }
    }
    // 跳板/中转页（LH lhdeal、awin、webgains 等）常靠「延迟 JS 跳转」把用户带到广告主落地页：
    // 单纯 waitForNetworkIdle 会在 JS 跳转触发前（跳板页此刻已网络空闲）提前返回，把 page.url() 快照在
    // 跳板域名上 → 误判 resolve_failed 并丢弃浏览器结果（这正是 LH 商家被大量误报 no_tracking 的根因）。
    // 故：先短等空闲；若仍停在跳板/中转域名，再主动轮询等它 JS 跳离，跳离后再等落地页网络稳定。
    try {
      await page.waitForNetworkIdle({ idleTime: 1200, timeout: 12000 });
    } catch {
      /* 超时无妨 */
    }
    const onJumpHost = (): boolean => {
      try {
        const h = new URL(page.url()).hostname;
        return isTrackerHost(h) || isNetworkClickHost(h);
      } catch {
        return false;
      }
    };
    if (onJumpHost()) {
      const deadline = Date.now() + 18000;
      while (onJumpHost() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 700));
      }
      // 已跳离跳板域名 → 再等落地页网络稳定，确保拿到完整追踪 query（clickref/ranMID/utm 等）
      if (!onJumpHost()) {
        try {
          await page.waitForNetworkIdle({ idleTime: 1200, timeout: 10000 });
        } catch {
          /* 超时无妨 */
        }
      }
    }
    const finalUrl = page.url();
    chain.push(finalUrl);
    const dedup = chain.filter((u, i) => i === 0 || u !== chain[i - 1]);
    // D-172：终态仍是非 http(s)（chrome-error:// / about:blank 等）= 导航彻底失败，
    // 必须按错误返回而不是把 chrome-error 当 finalUrl 交给上层——旧行为会被 evaluate 判成
    // no_tracking「伪结果」，既污染判定又掩盖真实失败原因。
    if (!/^https?:\/\//i.test(finalUrl)) {
      console.warn(`[AffiliateResolver] 浏览器兜底重试后终态仍非 http（${finalUrl.slice(0, 60)}），按导航失败返回 url=${startUrl.slice(0, 120)}`);
      return { finalUrl: "", chain: dedup, error: `browser_nav_error: ${finalUrl.slice(0, 80)}` };
    }
    // 探本次浏览器出口 IP：复用同一 http 代理 URL（会话粘性期内出口 IP 稳定），即为浏览器实际点击出口。
    // 失败/无代理返回 null（不阻断换链）。让上层把「真实点击出口 IP」准确落库，修复浏览器兜底路径 exit_ip 丢失。
    const exitIp = httpProxy ? await probeExitIp(httpProxy) : null;
    return { finalUrl, chain: dedup, exitIp };
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 200) : String(e);
    console.warn(`[AffiliateResolver] 浏览器兜底异常: ${msg} url=${startUrl.slice(0, 120)} chainLen=${chain.length}`);
    return { finalUrl: "", chain, error: msg };
  } finally {
    // 裸 browser.close() 在 swap 颠簸时可能永久挂起 → release() 永不执行、槽位泄漏。
    // 换用带 8s 超时 + SIGKILL 的安全关闭，保证槽位一定归还。
    await closeBrowserSafely(browser);
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
    exitIp: null,
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
      exitIp: null,
    };

    // App 深链解包：finalUrl 若停在 Adjust/AppsFlyer/Branch 等深链域名，真实 web 落地藏在其回退参数里。
    let stuckOnDeeplink = false;
    // 浏览器兜底路径的 page.url() 也可能带未展开的 ${...} 字面量（浏览器会照样导航过去），统一在此清洗
    let finalUrl = res.finalUrl ? stripUnexpandedTemplateVars(res.finalUrl) : res.finalUrl;
    let chain = res.chain;
    // D-172 防御：非 http(s) 终态（chrome-error:// 等浏览器内部页）一律判解析失败，
    // 绝不能流进 landingUrl/trackingLink 判定被误判成 no_tracking「伪结果」。
    if (finalUrl && !/^https?:\/\//i.test(finalUrl)) {
      r.status = "resolve_failed";
      r.error = `导航终态非 http 页面：${finalUrl.slice(0, 80)}`;
      r.finalUrl = null;
      return r;
    }
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

    // D-162：停在跳板/深链/点击中转域名 = 没跟到广告主落地页。除了判失败，还必须把
    // landingUrl / trackingLink / finalUrl 全部清空 —— 旧逻辑只改 status，脏 URL 原样
    // 返回，5 个落库点把跳板链接写进 resolved_final_url（clk.tradedoubler / ojrq.net /
    // click.linksynergy / ad.doubleclick 共 16 行现存），7 天缓存期内被当落地页复用。
    // 跳转链保留在 chain 里供排障，数据字段绝不带跳板 URL。
    const failAtNonLanding = (error: string): ResolveResult => {
      r.status = "resolve_failed";
      r.error = error;
      r.landingUrl = null;
      r.trackingLink = null;
      r.finalUrl = null;
      return r;
    };
    // 停在 App 深链域名且解不出真实 web 落地 → 判失败
    if (stuckOnDeeplink || isDeeplinkHost(finalParsed.hostname)) {
      return failAtNonLanding(`停在 App 深链域名 ${finalParsed.hostname}，未解出真实网页落地页`);
    }
    // 停在跳板/中转域名 → 没跟到广告主落地页
    if (isTrackerHost(finalParsed.hostname)) {
      return failAtNonLanding(`停在跳板域名 ${finalParsed.hostname}，未跟到广告主落地页（通常需配置对应国家代理）`);
    }
    // 停在联盟发布者点击中转域名，且 url= 参数也解不出广告主 URL → 没跟到广告主，需真实浏览器跟随其 JS 跳转
    if (isNetworkClickHost(finalParsed.hostname)) {
      return failAtNonLanding(`停在联盟点击中转域名 ${finalParsed.hostname}，未跟到广告主落地页（该网络靠 JS 跳转，需真实浏览器跟随）`);
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
  // exchange:true —— 换链接引擎一律只用换链接供应商池(kookeey)，绝不兜底到 AI 出口(arxlabs)。
  const acquireProxy = async (): Promise<string | null> =>
    opts.proxyUrl != null ? opts.proxyUrl : await getProxyUrlForCountry(cc, { userId: opts.userId, exchange: true }).catch(() => null);

  // ── 第一遍抓取 ──
  // 记录「胜出结果」实际使用的代理出口，供末尾回填 result.exitIp（让上层准确记录真实点击出口 IP）：
  //   httpProxyUsed = 纯 HTTP 路径实际用的代理 URL；browserExitIp = 浏览器路径探到的出口 IP。
  let result: ResolveResult;
  let httpProxyUsed: string | null = null;
  let browserExitIp: string | null = null;
  if (opts.useBrowser) {
    const br = await resolveViaBrowser(affiliateUrl, cc, opts.userId);
    if (br.finalUrl) {
      browserExitIp = br.exitIp ?? null;
      result = await evaluate(br, false, true);
    } else {
      const proxyUrl = await acquireProxy();
      httpProxyUsed = proxyUrl;
      const r0 = await fetchChain(affiliateUrl, proxyUrl, 10, 18000, { userAgent: opts.userAgent, referer: opts.referer });
      result = await evaluate(r0, !!proxyUrl, false);
    }
  } else {
    const proxyUrl = await acquireProxy();
    httpProxyUsed = proxyUrl;
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
    const br = await resolveViaBrowser(affiliateUrl, cc, opts.userId).catch(
      (e) =>
        ({
          finalUrl: "",
          chain: [] as string[],
          exitIp: null,
          error: `fallback_rejected: ${e instanceof Error ? e.message.slice(0, 150) : String(e)}`,
        }) as BrowserChainResult,
    );
    if (br.finalUrl) {
      const r2 = await evaluate(br, false, true);
      // 仅当浏览器结果更优（拿到 ok / 命中黑名单）才采用，否则保留首次结果
      if (r2.status === "ok" || r2.status === "forbidden_network") {
        result = r2;
        browserExitIp = br.exitIp ?? null;
      } else {
        console.warn(
          `[AffiliateResolver] 浏览器兜底结果未被采用（status=${r2.status} err=${r2.error ?? "-"} finalUrl=${(br.finalUrl || "").slice(0, 120)}），保留首次 HTTP 结果（status=${result.status}）`,
        );
      }
    } else {
      console.warn(
        `[AffiliateResolver] 浏览器兜底未产出最终 URL（err=${br.error ?? "-"}），保留首次 HTTP 结果（status=${result.status} err=${result.error ?? "-"}） url=${affiliateUrl.slice(0, 120)}`,
      );
    }
  }

  // ── 出口 IP 回填 ──
  // 目标：让上层（generateOneSuffix）记录「实际点击出口 IP」而非仅预探测值，修复浏览器兜底/内部自取代理
  // 路径的 exit_ip 丢失（success 无 IP）问题。仅对成功结果回填：
  //   - 浏览器路径：用浏览器 http 代理探到的出口 IP；
  //   - 纯 HTTP 且 resolver 内部自取代理（未传 opts.proxyUrl）：探该内部代理出口 IP；
  //   - 纯 HTTP 且复用调用方粘性会话（opts.proxyUrl 已传）：保持 null，调用方的预探测 IP 即为准（同会话一致）。
  if (result.status === "ok") {
    if (result.usedBrowser) {
      result.exitIp = browserExitIp;
    } else if (opts.proxyUrl == null && httpProxyUsed) {
      result.exitIp = await probeExitIp(httpProxyUsed);
    }
  }

  return result;
}
