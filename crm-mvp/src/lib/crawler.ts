import { existsSync } from "fs";
import { getBackendConfig } from "@/lib/system-config";
import { getProxyUrlForCountry, fetchViaProxy } from "@/lib/crawl-proxy";

export interface PuppeteerPageData {
  html: string;
  navLinks: { url: string; text: string }[];
  images: string[];
  heroTexts: string[];
  uspTexts: string[];
  categoryNames: string[];
}

// ══════════════════════════════════════════════════════
// 浏览器路径发现
// ══════════════════════════════════════════════════════
const BROWSER_CANDIDATES = [
  // Linux 生产服务器（chromium-browser snap 安装在此路径）
  "/usr/bin/chromium-browser", "/usr/bin/chromium",
  "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome",
  "/usr/bin/microsoft-edge-stable", "/usr/bin/microsoft-edge",
  // Windows
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

function findBrowserPath(): string | null {
  for (const p of BROWSER_CANDIDATES) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return null;
}

// ══════════════════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════════════════
export interface CrawlResult {
  html: string;
  links: { url: string; text: string }[];
  images: string[];
  method: "http" | "sitemap" | "puppeteer" | "cache" | "failed";
  error?: string;
}

// ══════════════════════════════════════════════════════
// User-Agent 池（照搬后端 _FALLBACK_UAS）
// ══════════════════════════════════════════════════════
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:136.0) Gecko/20100101 Firefox/136.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1",
];

const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

function randomUA(): string {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}

function randomDesktopUA(): string {
  const desktops = UA_POOL.filter(ua => !ua.includes("Mobile") && !ua.includes("iPhone"));
  return desktops[Math.floor(Math.random() * desktops.length)];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return sleep(minMs + Math.random() * (maxMs - minMs));
}

// ══════════════════════════════════════════════════════
// 隐身请求头构建（照搬后端 _build_stealth_headers）
// ══════════════════════════════════════════════════════
const COUNTRY_ACCEPT_LANG: Record<string, string> = {
  HK: "zh-TW,zh;q=0.9,en;q=0.8", TW: "zh-TW,zh;q=0.9,en;q=0.8",
  CN: "zh-CN,zh;q=0.9,en;q=0.8", SG: "en-SG,en;q=0.9,zh;q=0.8",
  JP: "ja,en;q=0.8", KR: "ko,en;q=0.8",
  DE: "de,en;q=0.8", AT: "de-AT,de;q=0.9,en;q=0.8", CH: "de-CH,de;q=0.9,en;q=0.8",
  FR: "fr,en;q=0.8", BE: "fr-BE,fr;q=0.9,nl;q=0.8,en;q=0.7",
  ES: "es,en;q=0.8", MX: "es-MX,es;q=0.9,en;q=0.8",
  IT: "it,en;q=0.8", PT: "pt,en;q=0.8", BR: "pt-BR,pt;q=0.9,en;q=0.8",
  NL: "nl,en;q=0.8", PL: "pl,en;q=0.8", SE: "sv,en;q=0.8",
  NO: "no,en;q=0.8", DK: "da,en;q=0.8", FI: "fi,en;q=0.8",
  RU: "ru,en;q=0.8", TR: "tr,en;q=0.8", TH: "th,en;q=0.8",
  VN: "vi,en;q=0.8", ID: "id,en;q=0.8",
};

export function getAcceptLanguage(country?: string): string {
  if (country) {
    const al = COUNTRY_ACCEPT_LANG[country.toUpperCase()];
    if (al) return al;
  }
  return "en-US,en;q=0.9";
}

function buildStealthHeaders(url: string, ua?: string, country?: string): Record<string, string> {
  const chosenUa = ua || randomUA();
  const isFirefox = chosenUa.includes("Firefox");
  const isSafari = chosenUa.includes("Safari") && !chosenUa.includes("Chrome");

  const headers: Record<string, string> = {
    "User-Agent": chosenUa,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": getAcceptLanguage(country),
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Referer": "https://www.google.com/",
    "DNT": "1",
    "Connection": "keep-alive",
  };

  if (!isFirefox && !isSafari) {
    const chromeVerMatch = chosenUa.match(/Chrome\/(\d+)/);
    const chromeVer = chromeVerMatch ? chromeVerMatch[1] : "135";
    const platform = chosenUa.includes("Windows") ? '"Windows"'
      : chosenUa.includes("Macintosh") ? '"macOS"'
      : chosenUa.includes("Linux") ? '"Linux"' : '"Windows"';
    headers["Sec-Ch-Ua"] = `"Chromium";v="${chromeVer}", "Google Chrome";v="${chromeVer}", "Not-A.Brand";v="99"`;
    headers["Sec-Ch-Ua-Mobile"] = "?0";
    headers["Sec-Ch-Ua-Platform"] = platform;
    headers["Sec-Fetch-Dest"] = "document";
    headers["Sec-Fetch-Mode"] = "navigate";
    headers["Sec-Fetch-Site"] = "none";
    headers["Sec-Fetch-User"] = "?1";
  } else if (isFirefox) {
    headers["TE"] = "trailers";
  }

  return headers;
}

// ══════════════════════════════════════════════════════
// 拦截页检测（照搬后端 _is_blocked_page + 增强）
// ══════════════════════════════════════════════════════
const BLOCKED_TITLES = new Set([
  "just a moment...", "just a moment", "attention required",
  "access denied", "you have been blocked", "security check",
]);

function isBlockedPage(html: string): boolean {
  const textLower = html.toLowerCase();
  const pageLen = html.length;

  const hasMain = textLower.includes("<main");
  const hasArticle = textLower.includes("<article");
  const hasProduct = /class="[^"]*product/i.test(html);
  const imgCount = (textLower.match(/<img/g) || []).length;

  if (pageLen > 50000 && (hasMain || hasArticle || hasProduct) && imgCount >= 3) {
    return false;
  }

  const strongSignals = [
    "checking your browser", "just a moment",
    "enable javascript and cookies", "cf-browser-verification",
    "challenge-platform", "please verify you are a human",
    "please complete the security check", "are you a robot",
    "cf-challenge-running", "access denied",
    "you don't have permission", "errors.edgesuite.net",
    "request blocked", "forbidden",
  ];
  const strongHits = strongSignals.filter(s => textLower.includes(s)).length;

  if (strongHits >= 1 && pageLen < 30000 && !hasMain && !hasArticle) return true;
  if (strongHits >= 2 && pageLen < 80000) return true;

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch && BLOCKED_TITLES.has(titleMatch[1].trim().toLowerCase())) return true;

  if (pageLen < 2000 && /access\s*denied|blocked|captcha/i.test(html)) return true;

  return false;
}

function contentQualityScore(html: string): number {
  if (isBlockedPage(html)) return 0;

  const contentLen = html.length;
  if (contentLen > 80000) return 4;

  const textLower = html.toLowerCase();
  let score = 0;

  if (textLower.includes("<img") || textLower.includes("data-src") || textLower.includes("srcset")) {
    score += 1;
  }
  if (/<title>[^<]{3,}<\/title>/i.test(html)) {
    score += 1;
  }
  if (/<(?:main|article|section|div[^>]*class="[^"]*(?:product|content|hero|shop|item|card|grid|page))/i.test(html)) {
    score += 1;
  }

  const spaSignals = [
    'id="app"', 'id="root"', 'id="__next"', 'id="__nuxt"',
    "data-reactroot", "ng-app", "v-app",
    '"application/json"', "__NEXT_DATA__", "__NUXT__",
    "window.__INITIAL_STATE__", "window.__PRELOADED_STATE__",
  ];
  if (spaSignals.some(sig => html.includes(sig))) score += 1;

  if (contentLen > 30000 && score >= 1) score = Math.max(score, 2);
  if (contentLen > 50000) score = Math.max(score, 2);

  if (/<(?:script|link)[^>]*(?:chunk|bundle|vendor|app\.[a-f0-9])/i.test(html)) {
    score = Math.max(score, 2);
  }

  return score;
}

// ══════════════════════════════════════════════════════
// 站点难度检测（照搬后端 _detect_site_difficulty）
// ══════════════════════════════════════════════════════
function detectSiteDifficulty(url: string, html: string): "easy" | "medium" | "hard" {
  const urlLower = url.toLowerCase();
  const hardPlatforms = ["shopify.com", "myshopify.com", "squarespace.com", "wix.com", "webflow.io"];
  if (hardPlatforms.some(p => urlLower.includes(p))) return "medium";

  if (!html) return "easy";
  const htmlLower = html.toLowerCase();

  if (htmlLower.includes("cf-ray") && html.length < 5000) return "hard";
  if (htmlLower.includes("cf-challenge-running")) return "hard";

  const spaHints = ['id="app"', 'id="root"', 'id="__next"', "__NEXT_DATA__", "data-reactroot"];
  if (spaHints.some(h => html.includes(h)) && !htmlLower.includes("<img")) return "hard";

  const shopifyHints = ["cdn.shopify.com", "shopify.com/s/files", "myshopify.com", 'name="shopify-', "shopify-section"];
  if (shopifyHints.some(h => html.includes(h))) return "medium";

  const wpHints = ['name="generator" content="WordPress', "wp-content/", "wp-includes/"];
  if (wpHints.some(h => html.includes(h)) && (htmlLower.match(/<img/g) || []).length >= 3) return "easy";

  const wixHints = ["wix.com", "parastorage.com", "wixstatic.com"];
  if (wixHints.some(h => htmlLower.includes(h))) return "medium";

  return "easy";
}

// ══════════════════════════════════════════════════════
// URL 变体策略（照搬后端 _try_url_variants）
// ══════════════════════════════════════════════════════
function getUrlVariants(url: string): string[] {
  const variants: string[] = [];
  try {
    const u = new URL(url);
    if (u.hostname.startsWith("www.")) {
      variants.push(url.replace("www.", ""));
    } else {
      variants.push(url.replace("://", "://www."));
    }
    if (u.protocol === "https:") {
      variants.push(url.replace("https://", "http://"));
    }
  } catch {}
  return variants;
}

// ══════════════════════════════════════════════════════
// 瞬时错误判断
// ══════════════════════════════════════════════════════
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("timeout") || msg.includes("abort") ||
    msg.includes("econnreset") || msg.includes("econnrefused") ||
    msg.includes("enotfound") || msg.includes("network") ||
    msg.includes("socket") || msg.includes("fetch failed") ||
    msg.includes("terminated") || msg.includes("econnaborted");
}

// ══════════════════════════════════════════════════════
// 策略 1: HTTP 多级反爬回退（照搬后端 _fetch_with_retry）
// ══════════════════════════════════════════════════════
async function crawlWithHttp(url: string, country?: string, proxyUrl?: string): Promise<{ html: string; difficulty: "easy" | "medium" | "hard" } | null> {
  const urlsToTry = [url, ...getUrlVariants(url)];

  let bestHtml = "";
  let bestScore = -1;
  let got403 = false;
  let difficulty: "easy" | "medium" | "hard" = "easy";

  for (const tryUrl of urlsToTry) {
    const shuffledUAs = [...UA_POOL].sort(() => Math.random() - 0.5).slice(0, 5);

    for (let i = 0; i < shuffledUAs.length; i++) {
      if (i > 0) await randomDelay(500, 1500);

      const headers = buildStealthHeaders(tryUrl, shuffledUAs[i], country);
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 20000);
        // 若配置了目标国家代理，走代理发出请求（让目标网站按 IP 地理位置返回正确 locale）
        const res = proxyUrl
          ? await fetchViaProxy(tryUrl, { headers: headers as Record<string, string>, signal: ctrl.signal }, proxyUrl)
          : await fetch(tryUrl, { signal: ctrl.signal, headers, redirect: "follow" });
        clearTimeout(t);

        if (res.status === 403) {
          got403 = true;
          console.log(`[Crawler] HTTP UA#${i} 被 403 (${tryUrl.slice(0, 60)})`);
          continue;
        }
        if (res.status >= 500) {
          console.log(`[Crawler] HTTP UA#${i} 服务端错误 ${res.status} (${tryUrl.slice(0, 60)})`);
          continue;
        }
        if (res.status >= 400) break;

        const html = await res.text();
        const score = contentQualityScore(html);

        if (score > bestScore) {
          bestScore = score;
          bestHtml = html;
        }

        if (score >= 2) {
          console.log(`[Crawler] HTTP 成功 (score=${score}, ${html.length} bytes, ${tryUrl.slice(0, 60)})`);
          return { html, difficulty: detectSiteDifficulty(tryUrl, html) };
        }

        if (score >= 1 && html.length > 10000) {
          console.log(`[Crawler] HTTP 中等质量通过 (score=${score}, ${html.length} bytes)`);
          return { html, difficulty: detectSiteDifficulty(tryUrl, html) };
        }

        difficulty = detectSiteDifficulty(tryUrl, html);
        if (difficulty === "hard") {
          console.log(`[Crawler] 检测到困难站点，跳至高级方案`);
          break;
        }
        console.log(`[Crawler] HTTP UA#${i} 质量低 (score=${score}, ${html.length} bytes)`);
        break;
      } catch (err) {
        if (isTransientError(err)) {
          console.log(`[Crawler] HTTP UA#${i} 瞬时错误: ${err instanceof Error ? err.message : err}`);
          if (i < shuffledUAs.length - 1) {
            await randomDelay(1000, 2000);
            continue;
          }
        } else {
          console.log(`[Crawler] HTTP UA#${i} 失败: ${err instanceof Error ? err.message : err}`);
        }
        break;
      }
    }

    // Googlebot UA 作为额外尝试
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(tryUrl, {
        signal: ctrl.signal,
        headers: { "User-Agent": GOOGLEBOT_UA, "Accept": "text/html,*/*;q=0.8" },
        redirect: "follow",
      });
      clearTimeout(t);
      const html = await res.text();
      const score = contentQualityScore(html);
      if (score > bestScore) {
        bestScore = score;
        bestHtml = html;
      }
      if (score >= 2 || (score >= 1 && html.length > 10000)) {
        console.log(`[Crawler] HTTP Googlebot 成功 (score=${score}, ${html.length} bytes)`);
        return { html, difficulty: detectSiteDifficulty(tryUrl, html) };
      }
    } catch {}

    if (bestScore >= 2) break;
  }

  if (got403) difficulty = "hard";

  if (bestHtml && bestScore >= 1 && bestHtml.length > 5000) {
    console.log(`[Crawler] HTTP 使用最佳可用结果 (score=${bestScore}, ${bestHtml.length} bytes)`);
    return { html: bestHtml, difficulty };
  }

  return null;
}

// ══════════════════════════════════════════════════════
// 策略 2: Sitemap 提取（增强版 - 不受 Cloudflare 影响）
// ══════════════════════════════════════════════════════
async function crawlViaSitemap(url: string): Promise<{ links: { url: string; text: string }[]; images: string[] } | null> {
  const domain = (() => { try { return new URL(url).origin; } catch { return ""; } })();
  if (!domain) return null;

  const fetchXml = async (u: string): Promise<string | null> => {
    for (const ua of [GOOGLEBOT_UA, randomUA()]) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10000);
        const res = await fetch(u, {
          signal: ctrl.signal,
          headers: { "User-Agent": ua, "Accept": "text/xml,application/xml,text/html,*/*" },
          redirect: "follow",
        });
        clearTimeout(t);
        if (!res.ok) continue;
        const txt = await res.text();
        if (isBlockedPage(txt)) continue;
        if (txt.length > 100) return txt;
      } catch {}
    }
    return null;
  };

  let sitemapUrls: string[] = [];
  const robotsTxt = await fetchXml(`${domain}/robots.txt`);
  if (robotsTxt) {
    const matches = robotsTxt.match(/Sitemap:\s*(\S+)/gi) || [];
    sitemapUrls = matches.map(m => m.replace(/^Sitemap:\s*/i, "").trim());
  }
  if (sitemapUrls.length === 0) {
    sitemapUrls = [`${domain}/sitemap.xml`, `${domain}/sitemap_index.xml`];
  }

  const allUrls: string[] = [];
  const visited = new Set<string>();
  const sitemapImages: string[] = [];

  const processSitemap = async (smUrl: string, depth = 0) => {
    if (depth > 3 || visited.has(smUrl) || allUrls.length >= 200) return;
    visited.add(smUrl);
    const xml = await fetchXml(smUrl);
    if (!xml) return;

    const subs = Array.from(xml.matchAll(/<sitemap>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/sitemap>/g))
      .map(m => m[1].replace(/&amp;/g, "&"));
    if (subs.length > 0) {
      // 优先处理含 product/image 关键词的 sitemap
      const prioritized = [
        ...subs.filter(s => /product|image|img|photo|media/i.test(s)),
        ...subs.filter(s => !/product|image|img|photo|media/i.test(s)),
      ];
      const unique = [...new Set(prioritized)];
      for (const sub of unique.slice(0, 12)) {
        await processSitemap(sub, depth + 1);
      }
      return;
    }

    const urls = Array.from(xml.matchAll(/<url>[\s\S]*?<loc>([^<]+)<\/loc>[\s\S]*?<\/url>/g))
      .map(m => m[1].replace(/&amp;/g, "&"));
    for (const u of urls) {
      if (allUrls.length >= 200) break;
      if (/\/(account|cart|checkout|login|register|search|api|wishlist|password|privacy|terms|imprint|impressum|datenschutz|agb|cookie)\b/i.test(u)) continue;
      allUrls.push(u);
    }

    const imgLocs = Array.from(xml.matchAll(/<image:loc>([^<]+)<\/image:loc>/g))
      .map(m => m[1].replace(/&amp;/g, "&"));
    if (imgLocs.length > 0) {
      sitemapImages.push(...imgLocs.slice(0, 30));
    }
  };

  for (const s of sitemapUrls) {
    await processSitemap(s);
  }

  if (allUrls.length === 0) {
    console.log("[Crawler] Sitemap: 未找到 sitemap 或无 URL");
    return null;
  }

  console.log(`[Crawler] Sitemap: 获取到 ${allUrls.length} 个 URL, ${sitemapImages.length} 个 sitemap 图片`);

  const hasNumericId = (u: string) => {
    try {
      const p = new URL(u).pathname;
      if (/\/\d{4,}(\/|\.html?|$)/i.test(p)) return true;
      if (/[-_]\d{5,}\.(html?|php|aspx?)$/i.test(p)) return true;
      return false;
    } catch { return false; }
  };

  const jsRedirectPatterns = [
    /\/httpservice\//i, /\/enablejs/i, /\/cdn-cgi\//i,
    /\/captcha/i, /\/turnstile\//i, /\/bot-check/i,
    /\/challenge[\/\?]/i, /[\?&]__cf_chl/i,
    /\/human-verification/i, /\/verify\?/i,
    /\/consent\//i, /\/cookie-consent/i,
  ];

  const isGoodSitelinkUrl = (u: string) => {
    try {
      const p = new URL(u).pathname;
      if (p === "/" || p === "") return false;
      if (u === url || u === url + "/" || u === domain || u === domain + "/") return false;
      const segs = p.split("/").filter(Boolean);
      if (segs.length > 4) return false;
      if (hasNumericId(u)) return false;
      if (jsRedirectPatterns.some((pat) => pat.test(u))) return false;
      return true;
    } catch { return false; }
  };

  const slugUrls = allUrls.filter(isGoodSitelinkUrl);
  const productUrls = allUrls.filter(u => !isGoodSitelinkUrl(u) && u !== url && u !== domain);

  const links: { url: string; text: string }[] = [];
  const usedPaths = new Set<string>();
  for (const u of slugUrls) {
    if (links.length >= 30) break;
    const path = (() => { try { return new URL(u).pathname; } catch { return ""; } })();
    if (!path || path === "/" || usedPaths.has(path)) continue;
    usedPaths.add(path);
    const text = path
      .replace(/\.(html?|php|aspx?)$/i, "")
      .split("/").filter(Boolean).pop() || "";
    const readable = text.replace(/[-_]/g, " ").replace(/\b\w/g, c => c.toUpperCase()).slice(0, 60);
    if (readable.length >= 2) links.push({ url: u, text: readable });
  }

  const images: string[] = [];
  const seenImgs = new Set<string>();
  const addImg = (raw: string, baseDomain: string) => {
    let src = raw.trim();
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return;
    if (src.startsWith("//")) src = "https:" + src;
    if (src.startsWith("/")) src = baseDomain + src;
    if (!src.startsWith("http")) return;
    if (!isQualityImageUrl(src)) return;
    if (!seenImgs.has(src)) { seenImgs.add(src); images.push(src); }
  };

  for (const imgUrl of sitemapImages) {
    if (images.length >= 60) break;
    addImg(imgUrl, domain);
  }

  // 扩大页面抓取范围以获取更多图片
  const pagesToFetch = [url, ...productUrls.slice(0, 6), ...slugUrls.slice(0, 5)];
  const uniquePages = Array.from(new Set(pagesToFetch)).slice(0, 10);
  for (const pageUrl of uniquePages) {
    if (images.length >= 60) break;
    await randomDelay(200, 600);
    const pageImgs = await fetchPageImages(pageUrl);
    const pd = (() => { try { return new URL(pageUrl).origin; } catch { return domain; } })();
    for (const img of pageImgs) {
      if (images.length >= 60) break;
      addImg(img, pd);
    }
  }

  console.log(`[Crawler] Sitemap 提取: ${links.length} 链接, ${images.length} 图片`);
  return { links: links.slice(0, 30), images: images.slice(0, 60) };
}

// ══════════════════════════════════════════════════════
// 图片质量过滤（照搬后端 _is_quality_image + FILTERED_IMG_KEYWORDS）
// ══════════════════════════════════════════════════════
const JUNK_IMG_PATTERN = /(?:\.gif(?:\?|$)|\.svg(?:\?|$)|\/(?:pixel|spacer|blank|1x1|clear)\.|(?:_|-)(?:16|24|32|48|64|72)x|\/(?:icon|logo|badge|flag)s?[/_\-.]|\/emoji\/|gravatar\.com|\.ico(?:\?|$))/i;

const FILTERED_IMG_KEYWORDS = [
  "icon", "logo", "svg+xml", "pixel", "spacer", "blank", "1x1",
  "avatar", "favicon", "sprite", "arrow", "btn-", "button-icon",
  "social-icon", "facebook-icon", "twitter-icon", "instagram-icon",
  "linkedin-icon", "youtube-icon", "pinterest-icon", "tiktok-icon",
  "payment-icon", "visa-icon", "mastercard-icon", "paypal-icon",
  "flag-icon", "star-rating", "review-star",
  "shutterstock.com", "istockphoto.com", "gettyimages.com",
  "dreamstime.com", "stock-photo", "stock_photo",
  "ad-banner", "advertisement", "tracking-pixel", "analytics",
  "doubleclick", "googlesyndication", "facebook.com/tr",
];

export function isQualityImageUrl(url: string): boolean {
  if (JUNK_IMG_PATTERN.test(url)) return false;
  const lower = url.toLowerCase().split("?")[0];
  const validExts = [".jpg", ".jpeg", ".png", ".webp", ".avif"];
  if (!validExts.some(ext => lower.endsWith(ext))) {
    const cdnPatterns = [
      // 主流电商/建站平台 CDN
      "cdn.shopify", "cloudinary", "imgix", "cloudfront",
      "squarespace", "wixstatic", "bigcommerce",
      // 图库
      "pexels.com", "unsplash.com", "images.unsplash",
      // CMS/无头内容平台
      "ctfassets.net", "contentful.com", "prismic.io",
      "graphassets.com", "sanity.io", "dato-cms",
      // 企业 CDN
      "akamaized.net", "akamai.net", "azureedge.net",
      "fastly.net", "r2.cloudflarestorage.com",
      // 品牌图片子域通配（images.xxx.com / media.xxx.com / cdn.xxx.com / assets.xxx.com）
      "images.", "media.", "/media/", "/assets/products", "/products/images",
    ];
    if (!cdnPatterns.some(p => lower.includes(p))) return false;
  }
  if (FILTERED_IMG_KEYWORDS.some(kw => lower.includes(kw))) return false;
  return true;
}

// ══════════════════════════════════════════════════════
// CDN 去重 & 缩略图升级（照搬后端）
// ══════════════════════════════════════════════════════
function deduplicateCdnImages(images: string[]): string[] {
  const FORMAT_PRIORITY: Record<string, number> = { jpg: 0, jpeg: 0, pjpg: 0, png: 1, webp: 2, webply: 2 };
  const baseMap = new Map<string, { priority: [number, number]; url: string }>();
  const result: string[] = [];

  for (const imgUrl of images) {
    try {
      const u = new URL(imgUrl);
      const params = u.searchParams;
      const hasCdnParams = ["width", "format", "w", "h", "quality", "optimize", "fit", "crop"]
        .some(k => params.has(k));

      if (!hasCdnParams) {
        result.push(imgUrl);
        continue;
      }

      const basePath = u.origin + u.pathname;
      const fmt = (params.get("format") || "").toLowerCase();
      const width = parseInt(params.get("width") || params.get("w") || "0", 10) || 0;
      const fmtScore = FORMAT_PRIORITY[fmt] ?? 1;
      const priority: [number, number] = [fmtScore, -width];

      const existing = baseMap.get(basePath);
      if (!existing || priority[0] < existing.priority[0] ||
        (priority[0] === existing.priority[0] && priority[1] < existing.priority[1])) {
        baseMap.set(basePath, { priority, url: imgUrl });
      }
    } catch {
      result.push(imgUrl);
    }
  }

  baseMap.forEach(({ url }) => result.push(url));

  return Array.from(new Set(result));
}

function upgradeCdnThumbnails(images: string[]): string[] {
  const upgraded: string[] = [];
  for (const imgUrl of images) {
    const lower = imgUrl.toLowerCase();

    if (lower.includes("cdn.shopify") || lower.includes("/cdn/shop/")) {
      let newUrl = imgUrl.replace(/_\d+x\d+\./, ".");
      try {
        const u = new URL(newUrl);
        let changed = false;
        for (const key of ["width", "height", "w", "h"]) {
          const val = parseInt(u.searchParams.get(key) || "999", 10);
          if (val < 400) { u.searchParams.delete(key); changed = true; }
        }
        if (u.searchParams.has("crop")) { u.searchParams.delete("crop"); changed = true; }
        if (changed && !u.searchParams.has("width") && !u.searchParams.has("height")) {
          u.searchParams.set("width", "800");
        }
        newUrl = u.toString();
      } catch {}
      upgraded.push(newUrl);
    } else if (["squarespace", "wixstatic", "imgix"].some(cdn => lower.includes(cdn))) {
      const newUrl = imgUrl.replace(/[?&](?:w|h|width|height)=\d{1,3}(?=&|$)/g, "").replace(/[?&]$/, "");
      upgraded.push(newUrl || imgUrl);
    } else {
      upgraded.push(imgUrl);
    }
  }
  return Array.from(new Set(upgraded));
}

// ══════════════════════════════════════════════════════
// 从单个页面抓取图片（多 UA + 重试）
// ══════════════════════════════════════════════════════
export async function fetchPageImages(pageUrl: string): Promise<string[]> {
  const imgs: string[] = [];
  const uas = [GOOGLEBOT_UA, randomUA(), randomUA()];

  for (const ua of uas) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const headers = buildStealthHeaders(pageUrl, ua);
      const res = await fetch(pageUrl, { signal: ctrl.signal, headers, redirect: "follow" });
      clearTimeout(t);
      if (!res.ok && res.status !== 403) continue;
      const html = await res.text();
      if (isBlockedPage(html) || html.length < 800) continue;

      const baseDomain = (() => { try { return new URL(pageUrl).origin; } catch { return ""; } })();
      const resolve = (raw: string) => {
        let s = raw.trim();
        if (!s || s.startsWith("data:") || s.startsWith("blob:")) return "";
        if (s.startsWith("//")) s = "https:" + s;
        if (s.startsWith("/")) s = baseDomain + s;
        return s.startsWith("http") ? s : "";
      };

      // og:image / twitter:image
      for (const prop of ["og:image", "twitter:image"]) {
        const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i");
        const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i");
        const m = html.match(re1) || html.match(re2);
        const resolved = m?.[1] ? resolve(m[1]) : "";
        if (resolved) imgs.push(resolved);
      }

      // <img> tags (enhanced: more lazy-load attributes)
      const imgTagRe = /<img[^>]+(?:src|data-src|data-lazy-src|data-original|data-hi-res-src|data-full-src|data-zoom-image)=["']([^"']+)["'][^>]*>/gi;
      let im;
      while ((im = imgTagRe.exec(html)) !== null && imgs.length < 30) {
        const resolved = resolve(im[1]);
        if (resolved) imgs.push(resolved);
      }

      // srcset 提取最大图
      const srcsetRe = /<img[^>]+srcset=["']([^"']+)["'][^>]*>/gi;
      let sm;
      while ((sm = srcsetRe.exec(html)) !== null && imgs.length < 30) {
        const last = sm[1].split(",").map(s => s.trim().split(/\s+/)[0]).filter(Boolean).pop();
        if (last) { const r = resolve(last); if (r) imgs.push(r); }
      }

      // JSON-LD
      const jsonLdRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
      let jm;
      while ((jm = jsonLdRe.exec(html)) !== null && imgs.length < 30) {
        try {
          const data = JSON.parse(jm[1]);
          const extract = (obj: any) => {
            if (!obj || typeof obj !== "object") return;
            if (typeof obj.image === "string") { const r = resolve(obj.image); if (r) imgs.push(r); }
            if (Array.isArray(obj.image)) obj.image.forEach((i: any) => { if (typeof i === "string") { const r = resolve(i); if (r) imgs.push(r); } });
            if (obj.image?.url) { const r = resolve(obj.image.url); if (r) imgs.push(r); }
            if (obj["@graph"]) extract(obj["@graph"]);
            if (Array.isArray(obj)) obj.forEach(extract);
          };
          extract(data);
        } catch {}
      }

      // CSS background-image
      const bgRe = /url\(["']?(https?:\/\/[^"')\s]+)["']?\)/gi;
      let bgm;
      while ((bgm = bgRe.exec(html)) !== null && imgs.length < 30) {
        const resolved = resolve(bgm[1]);
        if (resolved) imgs.push(resolved);
      }

      // 内联 JS 中的图片 URL（SPA 常见）
      const jsImgRe = /(?:src|image|img|photo|poster|thumbnail|hero|banner|background|cover|media)["'\s]*[:=]\s*["'](https?:\/\/[^"'<>\s]{20,}\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"'<>\s]*)?)/gi;
      let jsm;
      while ((jsm = jsImgRe.exec(html)) !== null && imgs.length < 40) {
        const resolved = resolve(jsm[1]);
        if (resolved) imgs.push(resolved);
      }

      // React/Next.js/SFCC PWA：图片 URL 以 Unicode 转义方式内嵌于 JSON 数据中
      // 形如 "url":"https:\u002F\u002Fassets.contentsvc.com\u002F...\u002FLoafers.jpg"
      // 直接正则匹配原始字符串无效，需单独提取后 decode
      const unicodeImgRe = /https?:\\u002[Ff]\\u002[Ff]([^"'\\<>\s]{8,}\\u002[Ff][^"'\\<>\s]*\.(?:jpg|jpeg|png|webp|avif))(?:[\\u0022"']|$)/gi;
      let um;
      while ((um = unicodeImgRe.exec(html)) !== null && imgs.length < 50) {
        try {
          const decoded = ("https://" + um[1])
            .replace(/\\u002[Ff]/gi, "/")
            .replace(/\\u003[Aa]/gi, ":")
            .replace(/\\u0026/gi, "&")
            .replace(/\\u0020/gi, " ");
          const resolved = resolve(decoded);
          if (resolved) imgs.push(resolved);
        } catch {}
      }

      if (imgs.length > 0) break;
    } catch {}
  }
  return imgs;
}

// ══════════════════════════════════════════════════════
// 策略 3: Puppeteer + Stealth（大幅增强反检测）
// ══════════════════════════════════════════════════════
const PUPPETEER_ANTI_DETECT_SCRIPT = `
  // --- Webdriver & automation detection ---
  Object.defineProperty(navigator,'webdriver',{get:()=>undefined});
  delete navigator.__proto__.webdriver;
  Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});
  Object.defineProperty(navigator,'plugins',{get:()=>[
      {name:'Chrome PDF Plugin',filename:'internal-pdf-viewer'},
      {name:'Chrome PDF Viewer',filename:'mhjfbmdgcfjbbpaeojofohoefgiehjai'},
      {name:'Native Client',filename:'internal-nacl-plugin'},
  ]});
  Object.defineProperty(navigator,'maxTouchPoints',{get:()=>0});
  Object.defineProperty(navigator,'hardwareConcurrency',{get:()=>8});
  Object.defineProperty(navigator,'deviceMemory',{get:()=>8});
  Object.defineProperty(navigator,'platform',{get:()=>'Win32'});

  // --- Chrome runtime ---
  window.chrome = {runtime: {}, loadTimes: function(){return{}}, csi: function(){return{}}};

  // --- Permissions API ---
  const origQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (params) =>
      params.name === 'notifications'
          ? Promise.resolve({state: Notification.permission})
          : origQuery(params);

  // --- WebGL vendor ---
  const getParam = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return getParam.call(this, p);
  };

  // --- iframe contentWindow ---
  const origAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function(init) {
      return origAttachShadow.call(this, {...init, mode: 'open'});
  };
`;

export async function crawlPageWithPuppeteer(url: string, timeoutMs = 35000): Promise<string | null> {
  return crawlWithPuppeteer(url, timeoutMs);
}

// 包装器：向后兼容，内部调用 crawlWithPuppeteerFull 后只返回 html
async function crawlWithPuppeteer(url: string, timeoutMs = 30000): Promise<string | null> {
  const result = await crawlWithPuppeteerFull(url, timeoutMs);
  return result?.html ?? null;
}

export async function crawlWithPuppeteerFull(url: string, timeoutMs = 30000): Promise<PuppeteerPageData | null> {
  const browserPath = findBrowserPath();
  if (!browserPath) {
    console.log("[Crawler] Puppeteer: 未找到浏览器");
    return null;
  }

  const launchArgs = [
    "--no-sandbox", "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1920,1080",
    "--disable-dev-shm-usage",         // 必须：服务器 /dev/shm 通常很小
    "--disable-web-security",
    "--disable-features=VizDisplayCompositor",
    "--disable-infobars",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-gpu",                   // 无头服务器无 GPU
    "--disable-software-rasterizer",
    "--ignore-certificate-errors",     // 部分站点证书问题
  ];

  let browser: any = null;
  try {
    try {
      const puppeteerExtra = await import("puppeteer-extra");
      const StealthPlugin = await import("puppeteer-extra-plugin-stealth");
      const stealthMod = StealthPlugin as any;
      const stealthFn = stealthMod.default || stealthMod;
      puppeteerExtra.default.use(stealthFn());
      browser = await puppeteerExtra.default.launch({
        executablePath: browserPath,
        headless: "new" as any,
        args: launchArgs,
      });
    } catch (stealthErr) {
      console.log(`[Crawler] puppeteer-extra 加载失败 (${stealthErr instanceof Error ? stealthErr.message : stealthErr})，回退到 puppeteer-core`);
      const puppeteerCore = await import("puppeteer-core");
      const launcher = puppeteerCore.default || puppeteerCore;
      browser = await launcher.launch({
        executablePath: browserPath,
        headless: "new" as any,
        args: launchArgs,
      });
    }

    const page = await browser.newPage();
    const ua = randomDesktopUA();
    await page.setUserAgent(ua);
    await page.setViewport({ width: 1920, height: 1080 });

    await page.evaluateOnNewDocument(PUPPETEER_ANTI_DETECT_SCRIPT);

    // 拦截常见追踪/分析脚本加速加载
    await page.setRequestInterception(true);
    page.on("request", (req: any) => {
      const reqUrl = req.url().toLowerCase();
      if (/analytics|gtag|fbevents|hotjar|segment|mixpanel|doubleclick|googlesyndication/.test(reqUrl)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: timeoutMs });
    } catch {
      // goto timeout 不致命，页面可能有部分内容
    }

    await randomDelay(1500, 3000);

    // --- Cloudflare Turnstile / challenge 等待 ---
    const bodyText: string = await page.evaluate(() => document.body?.innerText || "");
    const bodyLower = bodyText.toLowerCase();
    if (["checking your browser", "just a moment", "verify you are human"].some(s => bodyLower.includes(s))) {
      console.log("[Crawler] Puppeteer: 检测到 Cloudflare 挑战页，等待...");
      for (let i = 0; i < 12; i++) {
        await sleep(1500);
        const bt: string = await page.evaluate(() => document.body?.innerText?.toLowerCase() || "");
        if (!["checking your browser", "just a moment", "verify you are human"].some(s => bt.includes(s))) break;

        // 尝试点击 Turnstile checkbox
        try {
          const frames = page.frames();
          for (const frame of frames) {
            if (frame.url().includes("challenges.cloudflare.com")) {
              const checkbox = await frame.$('input[type="checkbox"], .cb-i');
              if (checkbox) {
                await checkbox.click();
                await sleep(2000);
              }
            }
          }
        } catch {}
      }
    }

    // --- 关闭 Cookie/同意弹窗 ---
    const consentSelectors = [
      'button:has-text("Accept")', 'button:has-text("I agree")',
      'button:has-text("Got it")', 'button:has-text("OK")',
      'button:has-text("Accept All")', 'button:has-text("Accept Cookies")',
      'button:has-text("Allow")', 'button:has-text("Agree")',
      'button:has-text("Continue")',
      '[id*="accept"]', '[class*="accept"]',
      '[id*="consent"] button', '[class*="consent"] button',
      '[id*="cookie"] button', '[class*="cookie"] button',
    ];
    for (const sel of consentSelectors) {
      try {
        // puppeteer 不支持 :has-text，改用 XPath 或普通选择器
        if (sel.includes(":has-text")) {
          const textMatch = sel.match(/:has-text\("([^"]+)"\)/);
          if (textMatch) {
            const btns = await page.$$("button");
            for (const btn of btns) {
              const text: string = await page.evaluate((el: any) => el.innerText?.trim() || "", btn);
              if (text.toLowerCase().includes(textMatch[1].toLowerCase())) {
                const visible = await page.evaluate((el: any) => {
                  const rect = el.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0;
                }, btn);
                if (visible) {
                  await btn.click();
                  await sleep(300);
                  break;
                }
              }
            }
          }
        } else {
          const el = await page.$(sel);
          if (el) {
            const visible = await page.evaluate((el: any) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }, el);
            if (visible) {
              await el.click();
              await sleep(300);
              break;
            }
          }
        }
      } catch {}
    }

    // --- 等待内容加载（通用 + 价格/促销关键元素）---
    try {
      await page.waitForSelector(
        "img, main, article, .product, [class*='product'], [class*='hero'], [class*='collection']",
        { timeout: 8000 },
      );
    } catch {}
    // 额外等待价格/促销/LD+JSON 元素，提升数据提取成功率
    try {
      await page.waitForSelector(
        'script[type="application/ld+json"], [class*="price"], [class*="promo"], [class*="banner"], [class*="announcement"]',
        { timeout: 5000 },
      );
    } catch {}

    // --- 滚动触发懒加载图片 ---
    try {
      const totalHeight: number = await page.evaluate(() => document.body?.scrollHeight || 3000);
      const step = Math.max(Math.floor(totalHeight / 6), 300);
      for (let y = 0; y <= totalHeight + step; y += step) {
        await page.evaluate((scrollY: number) => window.scrollTo(0, scrollY), y);
        await randomDelay(300, 600);
      }
      await randomDelay(800, 1500);
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(300);
    } catch {}

    const html = await page.content();
    if (isBlockedPage(html) || html.length < 3000) {
      console.log(`[Crawler] Puppeteer: 仍被拦截或内容过少 (${html.length} bytes)`);
      return null;
    }

    // DOM 结构化提取（独立 catch，失败不丢 html）
    let domData: Omit<PuppeteerPageData, "html"> = {
      navLinks: [], images: [], heroTexts: [], uspTexts: [], categoryNames: [],
    };
    try {
      domData = await page.evaluate(() => {
        const navLinks = Array.from(document.querySelectorAll("nav a, header a, [role=navigation] a"))
          .map(a => ({ url: (a as HTMLAnchorElement).href, text: (a as HTMLElement).innerText.trim() }))
          .filter(l => l.url && l.text.length >= 2 && l.text.length <= 40);
        const imgSrcs = new Set<string>();
        document.querySelectorAll("img[src], img[data-src]").forEach(img => {
          const src = (img as HTMLImageElement).dataset.src || (img as HTMLImageElement).src;
          if (src && src.startsWith("http")) imgSrcs.add(src);
        });
        const heroTexts = Array.from(document.querySelectorAll("h1, [class*=hero] p, [class*=banner] p, [class*=headline]"))
          .map(el => (el as HTMLElement).innerText.trim()).filter(t => t.length >= 5 && t.length <= 200);
        const uspTexts = Array.from(document.querySelectorAll("[class*=usp], [class*=trust], [class*=benefit], [class*=feature]"))
          .map(el => (el as HTMLElement).innerText.trim()).filter(t => t.length >= 5 && t.length <= 200);
        const categoryNames = Array.from(document.querySelectorAll("nav a, [class*=category] a"))
          .map(a => (a as HTMLElement).innerText.trim()).filter(t => t.length >= 2 && t.length <= 30);
        return { navLinks, images: [...imgSrcs].slice(0, 100), heroTexts, uspTexts, categoryNames };
      });
    } catch (evalErr) {
      console.warn("[Crawler] page.evaluate() DOM extraction failed:", evalErr instanceof Error ? evalErr.message : evalErr);
    }

    console.log(`[Crawler] Puppeteer 成功: ${html.length} bytes, navLinks: ${domData.navLinks.length}, images: ${domData.images.length}`);
    return { html, ...domData };
  } catch (err) {
    console.log(`[Crawler] Puppeteer 失败: ${err instanceof Error ? err.message : err}`);
    return null;
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

// ══════════════════════════════════════════════════════
// 策略 4: Wayback Machine 缓存（Google Cache 已于2024年3月永久关停，仅保留 Wayback）
// ══════════════════════════════════════════════════════
async function crawlViaCache(url: string): Promise<string | null> {
  const currentYear = new Date().getFullYear();

  // 注意：webcache.googleusercontent.com 已于 2024 年 3 月永久停服，不再使用
  const cacheUrls = [
    `https://web.archive.org/web/${currentYear}/${url}`,
    `https://web.archive.org/web/${currentYear - 1}/${url}`,
  ];

  for (const cacheUrl of cacheUrls) {
    try {
      const headers = buildStealthHeaders(cacheUrl);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(cacheUrl, { signal: ctrl.signal, headers, redirect: "follow" });
      clearTimeout(t);

      if (!res.ok) continue;
      const html = await res.text();
      if (html.length < 3000 || isBlockedPage(html)) continue;

      const htmlLower = html.toLowerCase();
      if (htmlLower.includes("wayback machine") && html.length < 10000) continue;

      console.log(`[Crawler] Wayback Machine 命中 (${html.length} bytes): ${cacheUrl.slice(0, 60)}`);
      return html;
    } catch {}
  }

  console.log("[Crawler] Wayback Machine 未命中");
  return null;
}

// ══════════════════════════════════════════════════════
// 策略 5: 调用后端 Python 爬虫 API
// ══════════════════════════════════════════════════════
async function crawlViaBackendApi(url: string): Promise<CrawlResult | null> {
  let backendUrl = process.env.BACKEND_API_URL || "";
  let apiToken = "";

  if (!backendUrl) {
    try {
      const config = await getBackendConfig();
      backendUrl = config.apiUrl;
      apiToken = config.apiToken;
    } catch (err) {
      console.log("[Crawler] 读取后端配置失败:", err instanceof Error ? err.message : err);
    }
  }

  if (!backendUrl) {
    console.log("[Crawler] 未配置后端爬虫 API 地址，跳过后端爬虫");
    return null;
  }

  try {
    console.log(`[Crawler] 调用后端爬虫 API: ${backendUrl}/api/article-gen/crawl`);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60000);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;
    const res = await fetch(`${backendUrl}/api/article-gen/crawl`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url, language: "en" }),
      signal: ctrl.signal,
    });
    clearTimeout(t);

    if (!res.ok) {
      console.log(`[Crawler] 后端 API 返回 ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (data.crawl_failed && !data.partial) return null;

    const pages: { images?: string[]; links?: { url: string; text: string }[] }[] = data.pages || [];
    const allImages: string[] = [];
    const allLinks: { url: string; text: string }[] = [];
    const seenImgs = new Set<string>();

    for (const page of pages) {
      if (page.images) {
        for (const img of page.images) {
          if (!seenImgs.has(img)) { seenImgs.add(img); allImages.push(img); }
        }
      }
      if (page.links) allLinks.push(...page.links);
    }

    const subPages: { url: string; images?: string[] }[] = data.sub_pages || [];
    for (const sp of subPages) {
      if (sp.images) {
        for (const img of sp.images) {
          if (!seenImgs.has(img)) { seenImgs.add(img); allImages.push(img); }
        }
      }
    }

    if (allImages.length > 0 || allLinks.length > 0) {
      console.log(`[Crawler] 后端 API 成功: ${allLinks.length} 链接, ${allImages.length} 图片`);
      return {
        html: "",
        links: allLinks.slice(0, 30),
        images: allImages.slice(0, 60),
        method: "http",
      };
    }
  } catch (err) {
    console.log(`[Crawler] 后端 API 失败: ${err instanceof Error ? err.message : err}`);
  }
  return null;
}

// ══════════════════════════════════════════════════════
// HTML 解析工具（增强版：更多图片提取源 + 质量过滤）
// ══════════════════════════════════════════════════════
export function extractLinksAndImages(
  html: string,
  pageUrl: string,
): { links: { url: string; text: string }[]; images: string[] } {
  let baseDomain = "";
  try { baseDomain = new URL(pageUrl).origin; } catch {}
  const finalDom = (() => { try { return new URL(pageUrl).hostname.replace(/^www\./, ""); } catch { return ""; } })();

  // --- 链接提取 ---
  const linkRegex = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const linksMap = new Map<string, string>();
  let match;
  while ((match = linkRegex.exec(html)) !== null) {
    let href = match[1].trim();
    const rawText = match[2].replace(/<[^>]*>/g, "").trim().replace(/\s+/g, " ");
    if (!href || /^(javascript|mailto|tel):/.test(href)) continue;
    if (href.startsWith("/")) href = baseDomain + href;
    if (!href.startsWith("http")) continue;
    try {
      const hrefDomain = new URL(href).hostname.replace(/^www\./, "");
      if (finalDom && !hrefDomain.includes(finalDom) && !finalDom.includes(hrefDomain)) continue;
    } catch { continue; }
    if (/login|signup|register|cart|checkout|account/i.test(href)) continue;
    if (/\/httpservice\/|\/enablejs|\/cdn-cgi\/|\/captcha|\/turnstile\/|\/bot-check|\/challenge[\/\?]|[\?&]__cf_chl/i.test(href)) continue;
    if (/\/search\?q=cache:|webcache\.googleusercontent\.com|google\.\w+\/search|bing\.com\/search/i.test(href)) continue;
    if (href === pageUrl || href === pageUrl + "/") continue;
    const text = rawText.length > 0 ? rawText : (() => {
      const t = match[0].match(/title=["']([^"']+)["']/i);
      const a = match[0].match(/aria-label=["']([^"']+)["']/i);
      return (t?.[1] || a?.[1] || "").trim();
    })();
    if (text.length >= 2 && text.length <= 60) linksMap.set(href, text);
  }

  // --- 图片提取（全方位，照搬后端 _extract_page） ---
  const candidates: { score: number; url: string }[] = [];
  const seenImgs = new Set<string>();

  const resolveImgUrl = (raw: string): string => {
    let src = raw.trim();
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return "";
    if (src.startsWith("//")) src = "https:" + src;
    if (src.startsWith("/")) src = baseDomain + src;
    if (!src.startsWith("http")) return "";
    return src;
  };

  const addCandidate = (rawUrl: string, score: number) => {
    const resolved = resolveImgUrl(rawUrl);
    if (!resolved || seenImgs.has(resolved)) return;
    if (!isQualityImageUrl(resolved)) return;
    seenImgs.add(resolved);
    candidates.push({ score, url: resolved });
  };

  // 1. og:image / twitter:image（高优先级）
  for (const prop of ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i");
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, "i");
    const m = html.match(re) || html.match(re2);
    if (m?.[1]) addCandidate(m[1], 50);
  }

  // 2. JSON-LD 结构化数据
  const jsonLdRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const extractLd = (obj: any) => {
        if (!obj || typeof obj !== "object") return;
        for (const key of ["image", "images", "photo", "thumbnail", "contentUrl"]) {
          const val = obj[key];
          if (typeof val === "string") addCandidate(val, 25);
          if (Array.isArray(val)) val.forEach((i: any) => {
            if (typeof i === "string") addCandidate(i, 25);
            else if (i?.url) addCandidate(i.url, 25);
          });
          if (val?.url) addCandidate(val.url, 25);
        }
        if (obj["@graph"]) extractLd(obj["@graph"]);
        if (Array.isArray(obj)) obj.forEach(extractLd);
      };
      extractLd(data);
    } catch {}
  }

  // 3. <img> 标签（带评分）
  const imgTagRegex = /<img[^>]*>/gi;
  while ((match = imgTagRegex.exec(html)) !== null && candidates.length < 100) {
    const tag = match[0];
    let imgSrc = "";

    for (const attr of ["src", "data-src", "data-lazy-src", "data-original",
      "data-hi-res-src", "data-full-src", "data-zoom-image",
      "data-bg-src", "data-image", "data-poster", "data-large-file"]) {
      const am = tag.match(new RegExp(`${attr}=["']([^"']+)["']`, "i"));
      if (am?.[1] && !am[1].startsWith("data:")) { imgSrc = am[1]; break; }
    }

    if (!imgSrc) {
      for (const sa of ["srcset", "data-srcset"]) {
        const sm = tag.match(new RegExp(`${sa}=["']([^"']+)["']`, "i"));
        if (sm?.[1]) {
          const last = sm[1].split(",").map(s => s.trim().split(/\s+/)[0]).filter(Boolean).pop();
          if (last) { imgSrc = last; break; }
        }
      }
    }

    if (!imgSrc) continue;

    let score = 0;
    const imgUrlLower = imgSrc.toLowerCase();
    const altText = (tag.match(/alt=["']([^"']*)/i)?.[1] || "").toLowerCase();

    // 检查是否在 press/testimonial/social 区域（通过上下文 HTML 近似判断）
    const contextStart = Math.max(0, match.index! - 500);
    const context = html.slice(contextStart, match.index!).toLowerCase();
    if (["press-logo", "media-logo", "as-seen", "seen-on", "trusted-by",
      "testimonial", "review-section", "social-proof", "instagram-feed"].some(kw => context.includes(kw))) {
      continue;
    }

    // 同域名加分
    const resolvedUrl = resolveImgUrl(imgSrc);
    if (resolvedUrl) {
      try {
        const imgHost = new URL(resolvedUrl).hostname;
        const pageHost = new URL(pageUrl).hostname;
        const imgRoot = imgHost.split(".").slice(-2).join(".");
        const pageRoot = pageHost.split(".").slice(-2).join(".");
        if (imgRoot === pageRoot) score += 15;
        else {
          const cdnHosts = ["cdn.shopify", "cloudinary", "imgix", "cloudfront", "akamai", "fastly",
            "squarespace", "wixstatic", "bigcommerce"];
          if (!cdnHosts.some(h => imgHost.includes(h))) score -= 10;
        }
      } catch {}
    }

    // 尺寸评分
    const wMatch = tag.match(/width=["']?(\d+)/i);
    const hMatch = tag.match(/height=["']?(\d+)/i);
    if (wMatch && hMatch) {
      const w = parseInt(wMatch[1]), h = parseInt(hMatch[1]);
      if (w >= 400 && h >= 300) score += 30;
      else if (w >= 200 && h >= 200) score += 15;
      else if (w < 100 || h < 100) continue;
    } else {
      score += 3;
    }

    // 产品图关键词加分
    const productKws = ["product", "item", "hero", "banner", "feature", "main", "gallery",
      "collection", "shop", "catalog", "lifestyle", "photo", "img-large"];
    if (productKws.some(kw => imgUrlLower.includes(kw) || altText.includes(kw))) score += 20;

    // srcset 加分
    if (tag.includes("srcset")) score += 10;

    // 主内容区域检测（通过上下文近似判断）
    const nearContext = html.slice(Math.max(0, match.index! - 300), match.index!).toLowerCase();
    if (["<main", "<article", '<section', 'class="product', 'class="hero', 'class="gallery',
      'class="content', 'class="shop', 'class="collection'].some(kw => nearContext.includes(kw))) {
      score += 15;
    }
    if (["<nav", "<footer", "<header"].some(kw => nearContext.slice(-200).includes(kw))) {
      score -= 30;
    }

    addCandidate(imgSrc, score);
  }

  // 4. <picture><source> 中的图片
  const sourceRegex = /<source[^>]+(?:srcset|data-srcset)=["']([^"']+)["'][^>]*>/gi;
  while ((match = sourceRegex.exec(html)) !== null && candidates.length < 120) {
    const last = match[1].split(",").map(s => s.trim().split(/\s+/)[0]).filter(Boolean).pop();
    if (last) addCandidate(last, 10);
  }

  // 5. <noscript> 中的图片（lazy-load fallback）
  const noscriptRegex = /<noscript>([\s\S]*?)<\/noscript>/gi;
  while ((match = noscriptRegex.exec(html)) !== null) {
    const nsImgRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    let nsm;
    while ((nsm = nsImgRe.exec(match[1])) !== null && candidates.length < 130) {
      addCandidate(nsm[1], 20);
    }
  }

  // 6. CSS background-image
  const bgRegex = /url\(["']?(https?:\/\/[^"')\s]+)["']?\)/gi;
  while ((match = bgRegex.exec(html)) !== null && candidates.length < 140) {
    addCandidate(match[1], 8);
  }

  // 7. 内联 JS/JSON 中的图片 URL（SPA/现代网站常见）
  const jsImgRe = /(?:src|image|img|photo|poster|thumbnail|hero|banner|background|cover|media)["'\s]*[:=]\s*["'](https?:\/\/[^"'<>\s]{20,}\.(?:jpg|jpeg|png|webp|avif)(?:\?[^"'<>\s]*)?)/gi;
  while ((match = jsImgRe.exec(html)) !== null && candidates.length < 160) {
    addCandidate(match[1], 12);
  }

  // 按评分排序后提取
  candidates.sort((a, b) => b.score - a.score);
  let images = candidates.map(c => c.url).slice(0, 100);
  images = deduplicateCdnImages(images);
  images = upgradeCdnThumbnails(images);

  return {
    links: Array.from(linksMap.entries()).map(([url, text]) => ({ url, text })).slice(0, 30),
    images: images.slice(0, 60),
  };
}

export function extractPageMeta(html: string): { title: string; description: string } {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)
    || html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']description["']/i);
  const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i)
    || html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']og:description["']/i);
  const desc = (descMatch?.[1] || ogDescMatch?.[1] || "").trim();
  return { title: (titleMatch?.[1] || "").trim(), description: desc };
}

// ══════════════════════════════════════════════════════
// 主爬虫入口（优化策略顺序 + 难度自适应）
// ══════════════════════════════════════════════════════
export async function crawlPage(url: string, country?: string): Promise<CrawlResult> {
  const proxyUrl = country ? await getProxyUrlForCountry(country) : null;
  if (proxyUrl) console.log(`[Crawler] 使用 ${country} 代理爬取: ${url}`);
  else console.log(`[Crawler] 开始爬取: ${url}${country ? ` (country: ${country})` : ""}`);

  // 1. HTTP 多 UA 隐身爬取（带内容质量评分 + 难度检测）
  const httpResult = await crawlWithHttp(url, country, proxyUrl ?? undefined);
  if (httpResult) {
    let { links, images } = extractLinksAndImages(httpResult.html, url);

    // 如果有链接但图片不足，尝试从子页面补充图片
    if (links.length > 0 && images.length < 3) {
      console.log(`[Crawler] HTTP 链接够但图片不足 (${images.length})，尝试子页面补图...`);
      const subPages = links.slice(0, 5).map((l) => l.url);
      for (const subUrl of subPages) {
        if (images.length >= 10) break;
        await randomDelay(200, 500);
        const subImgs = await fetchPageImages(subUrl);
        const subDomain = (() => { try { return new URL(subUrl).origin; } catch { return ""; } })();
        for (const img of subImgs) {
          let src = img.trim();
          if (!src || src.startsWith("data:")) continue;
          if (src.startsWith("//")) src = "https:" + src;
          if (src.startsWith("/")) src = subDomain + src;
          if (!src.startsWith("http") || !isQualityImageUrl(src)) continue;
          if (!images.includes(src)) images.push(src);
        }
      }
    }

    if (links.length > 0 || images.length > 0) {
      console.log(`[Crawler] HTTP 直接成功: ${links.length} 链接, ${images.length} 图片`);
      return { html: httpResult.html.slice(0, 150000), links, images, method: "http" };
    }
  }

  // 2. Sitemap（不受 Cloudflare 影响，多 UA 获取）
  const sitemapResult = await crawlViaSitemap(url);
  if (sitemapResult && (sitemapResult.links.length > 0 || sitemapResult.images.length > 0)) {
    console.log(`[Crawler] Sitemap 成功: ${sitemapResult.links.length} 链接, ${sitemapResult.images.length} 图片`);
    return { html: "", links: sitemapResult.links, images: sitemapResult.images, method: "sitemap" };
  }

  // 3. 根据难度选择下一步策略
  const difficulty = httpResult?.difficulty || "medium";
  console.log(`[Crawler] 站点难度: ${difficulty}，启用高级爬取策略`);

  if (difficulty === "hard") {
    // 困难站点：先 Puppeteer（渲染 JS），再后端 API
    const puppeteerHtml = await crawlWithPuppeteer(url, 35000);
    if (puppeteerHtml) {
      const { links, images } = extractLinksAndImages(puppeteerHtml, url);
      if (links.length > 0 || images.length > 0) {
        console.log(`[Crawler] Puppeteer 成功 (困难站点): ${links.length} 链接, ${images.length} 图片`);
        return { html: puppeteerHtml.slice(0, 150000), links, images, method: "puppeteer" };
      }
    }

    // Puppeteer 重试一次（增加超时）
    console.log("[Crawler] Puppeteer 首次失败，增加超时重试...");
    const retryHtml = await crawlWithPuppeteer(url, 50000);
    if (retryHtml) {
      const { links, images } = extractLinksAndImages(retryHtml, url);
      if (links.length > 0 || images.length > 0) {
        console.log(`[Crawler] Puppeteer 重试成功: ${links.length} 链接, ${images.length} 图片`);
        return { html: retryHtml.slice(0, 150000), links, images, method: "puppeteer" };
      }
    }

    // 后端 API
    const backendResult = await crawlViaBackendApi(url);
    if (backendResult) return backendResult;
  } else {
    // 标准/中等站点：先后端 API，再 Puppeteer
    const backendResult = await crawlViaBackendApi(url);
    if (backendResult) return backendResult;

    const puppeteerHtml = await crawlWithPuppeteer(url);
    if (puppeteerHtml) {
      const { links, images } = extractLinksAndImages(puppeteerHtml, url);
      if (links.length > 0 || images.length > 0) {
        console.log(`[Crawler] Puppeteer 成功: ${links.length} 链接, ${images.length} 图片`);
        return { html: puppeteerHtml.slice(0, 150000), links, images, method: "puppeteer" };
      }
    }
  }

  // 4. Google Cache / Wayback Machine（最终回退）
  console.log("[Crawler] 所有直接方案失败，尝试缓存源...");
  const cacheHtml = await crawlViaCache(url);
  if (cacheHtml) {
    const { links, images } = extractLinksAndImages(cacheHtml, url);
    if (links.length > 0 || images.length > 0) {
      console.log(`[Crawler] 缓存源成功: ${links.length} 链接, ${images.length} 图片`);
      return { html: cacheHtml.slice(0, 150000), links, images, method: "cache" };
    }
  }

  // 5. 全部失败：如果 HTTP 有低质量结果，尝试提取
  if (httpResult?.html) {
    const { links, images } = extractLinksAndImages(httpResult.html, url);
    if (links.length > 0 || images.length > 0) {
      console.log(`[Crawler] 使用低质量 HTTP 结果: ${links.length} 链接, ${images.length} 图片`);
      return { html: httpResult.html.slice(0, 150000), links, images, method: "http" };
    }
  }

  console.log(`[Crawler] 所有策略均失败: ${url}`);
  return {
    html: "", links: [], images: [], method: "failed",
    error: "无法爬取商家网站（该网站可能有企业级反爬保护），请手动输入链接和图片",
  };
}

/**
 * 爬取单个 URL 的标题、描述和最终真实 URL
 * 跟踪重定向获取真实落地页 URL，检测软 404
 */
export async function fetchUrlMeta(url: string, proxyUrl?: string): Promise<{ title: string; description: string; ok: boolean; finalUrl: string; isSoft404: boolean }> {
  const uas = [GOOGLEBOT_UA, ...UA_POOL.sort(() => Math.random() - 0.5).slice(0, 3)];

  const SOFT_404_SIGNALS = [
    "page not found", "page introuvable", "seite nicht gefunden",
    "página no encontrada", "pagina non trovata",
    "404", "not found", "does not exist", "n'existe pas",
    "nichts gefunden", "no results", "aucun résultat",
  ];

  let lastFinalUrl = url;
  let wasBlocked = false;

  for (const ua of uas) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const headers = buildStealthHeaders(url, ua);
      const res = proxyUrl
        ? await fetchViaProxy(url, { headers: headers as Record<string, string>, signal: ctrl.signal }, proxyUrl)
        : await fetch(url, { signal: ctrl.signal, headers, redirect: "follow" });
      clearTimeout(t);

      const finalUrl = res.url || url;
      lastFinalUrl = finalUrl;

      if (res.ok || res.status < 400) {
        const html = await res.text();
        if (isBlockedPage(html) || html.length < 500) {
          wasBlocked = true;
          continue;
        }

        const meta = extractPageMeta(html);

        // 软 404 检测：标题或内容包含"not found"等
        const titleLower = (meta.title || "").toLowerCase();
        const isSoft404 = SOFT_404_SIGNALS.some((s) => titleLower.includes(s))
          || (html.length < 5000 && SOFT_404_SIGNALS.some((s) => html.toLowerCase().includes(s)));

        if (meta.title) {
          return { ...meta, ok: true, finalUrl, isSoft404 };
        }
      }
    } catch {}
  }

  // 所有 UA 被拦截（如 Cloudflare）→ Google Ads 审核也会被拦截 → 标记为不可用
  if (wasBlocked) {
    return { title: "", description: "", ok: false, finalUrl: lastFinalUrl, isSoft404: false };
  }

  return { title: "", description: "", ok: false, finalUrl: lastFinalUrl, isSoft404: false };
}

/**
 * 批量验证链接可访问性
 */
export async function verifyLinks(urls: string[]): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += 5) {
    chunks.push(urls.slice(i, i + 5));
  }
  for (const chunk of chunks) {
    const promises = chunk.map(async (url) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const headers = buildStealthHeaders(url);
        const res = await fetch(url, { method: "HEAD", signal: ctrl.signal, headers, redirect: "follow" });
        clearTimeout(t);
        if (res.ok || res.status === 403) {
          results.set(url, true);
        } else {
          const getRes = await fetch(url, { signal: new AbortController().signal, headers, redirect: "follow" });
          results.set(url, getRes.ok || getRes.status === 403);
        }
      } catch {
        results.set(url, false);
      }
    });
    await Promise.all(promises);
    await randomDelay(200, 500);
  }
  return results;
}

// ══════════════════════════════════════════════════════
// 搜索引擎图片回退：当直接爬取全部失败时，通过搜索引擎获取商家产品图片
// ══════════════════════════════════════════════════════

export async function searchMerchantImages(merchantUrl: string, merchantName: string): Promise<string[]> {
  let domain = "";
  try { domain = new URL(merchantUrl).hostname; } catch { return []; }

  const images: string[] = [];
  const seen = new Set<string>();

  // 只接受来自商家自身域名的图片，避免混入无关第三方图片
  const addImg = (url: string) => {
    if (!url || seen.has(url) || url.startsWith("data:")) return;
    const lower = url.toLowerCase();
    if (/icon|logo|favicon|badge|pixel|spacer|1x1|emoji|avatar/i.test(lower)) return;
    if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(lower) && !/\/dw\/image\//i.test(lower)) return;
    // 严格过滤：只接受来自商家域名或其 CDN 的图片
    try {
      const imgHost = new URL(url).hostname.toLowerCase();
      const merchantHost = domain.replace(/^www\./, "");
      // 允许：同域 / 子域 / 常见电商CDN（shopify/cloudinary 等必须包含商家域特征时放开，否则不放宽）
      const isSameDomain = imgHost === domain || imgHost === merchantHost || imgHost.endsWith("." + merchantHost);
      if (!isSameDomain) return; // 搜索引擎回退场景严格同域
    } catch { return; }
    seen.add(url);
    images.push(url);
  };

  // 只用 site: 严格搜索，禁用品牌名宽泛搜索（会拉取无关图片）
  const searchQueries = [
    `site:${domain} product`,
    `site:${domain}`,
  ];

  for (const query of searchQueries) {
    if (images.length >= 15) break;

    // Google Images (tbm=isch)
    try {
      const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&tbm=isch&hl=en`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(googleUrl, {
        signal: ctrl.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
          "Accept": "text/html,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });
      clearTimeout(t);
      if (res.ok) {
        const html = await res.text();
        // Google Images 在 HTML 中嵌入图片 URL（多种格式）
        const patterns = [
          /\["(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)",\s*\d+,\s*\d+\]/gi,
          /\\"ou\\":\s*\\"(https?:\/\/[^"\\]+)\\"/gi,
          /\["(https?:\/\/[^"]*(?:cdn|images?|media|static|product|upload)[^"]*\.(?:jpg|jpeg|png|webp)[^"]*)"/gi,
        ];
        for (const pattern of patterns) {
          let m;
          while ((m = pattern.exec(html)) !== null && images.length < 20) {
            const imgUrl = m[1].replace(/\\u003d/g, "=").replace(/\\u0026/g, "&").replace(/\\\//g, "/");
            if (imgUrl.includes("gstatic.com") || imgUrl.includes("google.com")) continue;
            addImg(imgUrl);
          }
        }
        if (images.length > 0) {
          console.log(`[Images] Google Images 搜索获取到 ${images.length} 张图片 (query: ${query})`);
        }
      }
    } catch (e) {
      console.log(`[Images] Google Images 搜索失败:`, e instanceof Error ? e.message : e);
    }

    if (images.length >= 10) break;

    // Bing Images
    try {
      const bingUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC2`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(bingUrl, {
        signal: ctrl.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
          "Accept": "text/html,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
      });
      clearTimeout(t);
      if (res.ok) {
        const html = await res.text();
        // Bing 图片结果中的 murl（media URL）
        const murlRe = /murl&quot;:&quot;(https?:\/\/[^&]+)&quot;/gi;
        let m;
        while ((m = murlRe.exec(html)) !== null && images.length < 20) {
          const imgUrl = decodeURIComponent(m[1]);
          addImg(imgUrl);
        }
        // Bing 备用模式
        const srcRe = /src2?="(https?:\/\/(?:tse|th)\d*\.mm\.bing\.net\/th[^"]+)"/gi;
        while ((m = srcRe.exec(html)) !== null && images.length < 20) {
          const pidMatch = m[1].match(/[?&]r=(https?[^&]+)/);
          if (pidMatch) {
            addImg(decodeURIComponent(pidMatch[1]));
          }
        }
        if (images.length > 0) {
          console.log(`[Images] Bing Images 搜索获取到 ${images.length} 张图片 (query: ${query})`);
        }
      }
    } catch (e) {
      console.log(`[Images] Bing Images 搜索失败:`, e instanceof Error ? e.message : e);
    }
  }

  console.log(`[Images] 搜索引擎图片回退总计: ${images.length} 张`);
  return images;
}
