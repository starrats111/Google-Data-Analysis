/**
 * C-016 sitelink-auto-expand
 *
 * 职责：主流程 sitelink candidates < 2 时自动扩源。
 * 优先级：sitemap.xml → robots.txt Sitemap → 常见路径 probe
 *
 * 流畅性设计：不阻塞主响应。调用方在 background 里跑，完成后用 SSE 推送增量。
 */

import { getProxyUrlForCountry, fetchViaProxy } from "@/lib/crawl-proxy";
import { fetchUrlMeta } from "@/lib/crawler";
import {
  isBadSitelinkUrl,
  titleFromUrlPath,
  sanitizeAdText,
  smartTruncate,
  decodeHtmlEntities,
} from "@/lib/crawl-pipeline";

export interface SitelinkItem {
  title: string;
  url: string;
  description?: string;
}

const COMMON_PATHS = [
  "/shop", "/products", "/collections",
  "/deals", "/sale", "/offers",
  "/about", "/about-us",
  "/contact", "/contact-us",
  "/faq", "/support", "/help",
  "/blog", "/news",
];

const SITEMAP_URLS = [
  "/sitemap.xml",
  "/sitemap_index.xml",
  "/sitemap-main.xml",
  "/sitemaps/sitemap.xml",
];

async function fetchText(url: string, proxyUrl: string | null | undefined, timeoutMs = 8000): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const headers = {
      "User-Agent": "Mozilla/5.0 (compatible; SitelinkExpander/1.0)",
      "Accept": "text/html,application/xml,text/xml,*/*;q=0.8",
    };
    const res = proxyUrl
      ? await fetchViaProxy(url, { headers, signal: ctrl.signal }, proxyUrl)
      : await fetch(url, { signal: ctrl.signal, headers, redirect: "follow" });
    clearTimeout(t);
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length < 20) return null;
    return text;
  } catch {
    return null;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const hostA = ua.hostname.replace(/^www\./, "").toLowerCase();
    const hostB = ub.hostname.replace(/^www\./, "").toLowerCase();
    // 允许子域（如 shop.brand.com 对 brand.com）
    return hostA === hostB || hostA.endsWith(`.${hostB}`) || hostB.endsWith(`.${hostA}`);
  } catch {
    return false;
  }
}

function isTopLevelPath(u: string): boolean {
  try {
    const parsed = new URL(u);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.length <= 2;
  } catch {
    return false;
  }
}

function absolutize(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

// 非页面扩展名（sitemap / 静态资源 / 压缩包）
const NON_PAGE_EXT_RE = /\.(xml|xml\.gz|txt|gz|pdf|jpe?g|png|gif|webp|svg|ico|css|js|zip|tar|mp4|mp3|woff2?)$/i;

function parseSitemapLocs(xml: string, limit: number): string[] {
  const out: string[] = [];
  const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(xml)) !== null) {
    const u = m[1].trim();
    if (u) out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 抽取 sitemap 下的页面 URL。
 * 关键：自动识别 sitemap-of-sitemaps（嵌套索引），递归一层展开；
 * 最终结果过滤所有非页面扩展名（.xml/.txt/.gz/.pdf/媒体文件等）。
 */
async function extractFromSitemap(merchantUrl: string, proxyUrl: string | null): Promise<string[]> {
  for (const path of SITEMAP_URLS) {
    let sm: string | null;
    try {
      sm = await fetchText(new URL(path, merchantUrl).toString(), proxyUrl);
    } catch {
      continue;
    }
    if (!sm) continue;

    const locs = parseSitemapLocs(sm, 200);
    if (locs.length === 0) continue;

    // 判定嵌套：<sitemapindex> 标签 or 所有 loc 都指向 .xml
    const isNested =
      /<sitemapindex[\s>]/i.test(sm) ||
      locs.every((u) => /\.xml(\.gz)?(\?|$)/i.test(u));

    let pageUrls: string[] = [];
    if (isNested) {
      // 展开前 3 个子 sitemap，每个最多取 40 条页面 URL
      for (const child of locs.slice(0, 3)) {
        const childSm = await fetchText(child, proxyUrl).catch(() => null);
        if (!childSm) continue;
        const childLocs = parseSitemapLocs(childSm, 40);
        pageUrls.push(...childLocs);
        if (pageUrls.length >= 100) break;
      }
    } else {
      pageUrls = locs;
    }

    // 过滤所有非页面扩展名
    pageUrls = pageUrls.filter((u) => !NON_PAGE_EXT_RE.test(new URL(u, merchantUrl).pathname));

    if (pageUrls.length > 0) return pageUrls;
  }
  return [];
}

async function extractFromRobots(merchantUrl: string, proxyUrl: string | null): Promise<string[]> {
  try {
    const robotsUrl = new URL("/robots.txt", merchantUrl).toString();
    const text = await fetchText(robotsUrl, proxyUrl, 5000);
    if (!text) return [];
    const urls: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) {
        const sm = await fetchText(m[1], proxyUrl);
        if (sm) {
          const locs = parseSitemapLocs(sm, 60);
          const isNested =
            /<sitemapindex[\s>]/i.test(sm) ||
            locs.every((u) => /\.xml(\.gz)?(\?|$)/i.test(u));
          if (isNested) {
            for (const child of locs.slice(0, 3)) {
              const childSm = await fetchText(child, proxyUrl).catch(() => null);
              if (!childSm) continue;
              urls.push(...parseSitemapLocs(childSm, 40));
              if (urls.length >= 60) break;
            }
          } else {
            urls.push(...locs);
          }
        }
      }
      if (urls.length >= 60) break;
    }
    return urls.filter((u) => {
      try {
        return !NON_PAGE_EXT_RE.test(new URL(u, merchantUrl).pathname);
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

function probeCommonPaths(merchantUrl: string): string[] {
  const out: string[] = [];
  for (const p of COMMON_PATHS) {
    const u = absolutize(merchantUrl, p);
    if (u) out.push(u);
  }
  return out;
}

async function headIsOk(url: string, proxyUrl: string | null): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const headers = { "User-Agent": "Mozilla/5.0 (compatible; SitelinkExpander/1.0)" };
    const res = proxyUrl
      ? await fetchViaProxy(url, { method: "HEAD", headers, signal: ctrl.signal }, proxyUrl)
      : await fetch(url, { method: "HEAD", signal: ctrl.signal, headers, redirect: "follow" });
    clearTimeout(t);
    return res.ok || res.status < 400;
  } catch {
    return false;
  }
}

function toSitelinkItem(url: string, fallbackTitle: string, meta?: { title?: string; description?: string }): SitelinkItem {
  let title = "";
  if (meta?.title) {
    title = sanitizeAdText(smartTruncate(decodeHtmlEntities(meta.title), 25));
  }
  if (!title || title.length < 2) title = titleFromUrlPath(url);
  if (!title || title.length < 2) title = fallbackTitle;
  title = title.slice(0, 25);
  let description = "";
  if (meta?.description) {
    description = sanitizeAdText(smartTruncate(decodeHtmlEntities(meta.description), 35), { allowExclamation: true });
  }
  return { title, url, description };
}

/**
 * 扩源主入口
 * @param opts.existing 现有候选（不会被剔除）
 * @param opts.targetCount 目标数量（默认 4）
 */
export async function autoExpandSitelinks(opts: {
  merchantUrl: string;
  country?: string;
  existing: SitelinkItem[];
  targetCount?: number;
}): Promise<SitelinkItem[]> {
  const { merchantUrl, country, existing } = opts;
  const targetCount = opts.targetCount ?? 4;
  if (!merchantUrl) return existing;
  if (existing.length >= targetCount) return existing;

  const proxyUrl = country ? await getProxyUrlForCountry(country).catch(() => null) : null;
  const usedUrls = new Set(existing.map((s) => s.url));

  // 候选采集（三层）
  const candidates = new Set<string>();
  try {
    const fromSitemap = await extractFromSitemap(merchantUrl, proxyUrl);
    for (const u of fromSitemap) {
      if (sameOrigin(u, merchantUrl) && isTopLevelPath(u) && !isBadSitelinkUrl(u)) {
        candidates.add(u);
      }
    }
  } catch (e) {
    console.warn("[SitelinkExpand] sitemap 抽取失败:", e instanceof Error ? e.message : e);
  }

  if (candidates.size + existing.length < targetCount) {
    try {
      const fromRobots = await extractFromRobots(merchantUrl, proxyUrl);
      for (const u of fromRobots) {
        if (sameOrigin(u, merchantUrl) && isTopLevelPath(u) && !isBadSitelinkUrl(u)) {
          candidates.add(u);
        }
      }
    } catch (e) {
      console.warn("[SitelinkExpand] robots 抽取失败:", e instanceof Error ? e.message : e);
    }
  }

  if (candidates.size + existing.length < targetCount) {
    for (const u of probeCommonPaths(merchantUrl)) {
      if (!isBadSitelinkUrl(u)) candidates.add(u);
    }
  }

  // 过滤 + HEAD 验证
  const toVerify = [...candidates].filter((u) => !usedUrls.has(u)).slice(0, 20);
  const verified: string[] = [];
  for (const u of toVerify) {
    if (verified.length + existing.length >= targetCount + 2) break;
    const ok = await headIsOk(u, proxyUrl);
    if (ok) verified.push(u);
  }

  // 拉 meta 构造 SitelinkItem
  const results: SitelinkItem[] = [];
  for (const u of verified) {
    if (results.length + existing.length >= targetCount) break;
    try {
      const meta = await fetchUrlMeta(u, proxyUrl ?? undefined, country);
      const item = toSitelinkItem(u, titleFromUrlPath(u), meta.ok ? { title: meta.title, description: meta.description } : undefined);
      if (item.title && item.title.length >= 2) {
        results.push(item);
      }
    } catch {
      const item = toSitelinkItem(u, titleFromUrlPath(u));
      if (item.title && item.title.length >= 2) results.push(item);
    }
  }

  console.warn(`[SitelinkExpand] 扩源完成：从 ${existing.length} → ${existing.length + results.length}（目标 ${targetCount}）`);
  return [...existing, ...results];
}
