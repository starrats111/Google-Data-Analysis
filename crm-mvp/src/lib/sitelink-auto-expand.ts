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
  isSitelinkLocaleCompatible,
  titleFromUrlPath,
  sanitizeAdText,
  smartTruncate,
  decodeHtmlEntities,
} from "@/lib/crawl-pipeline";
import { isLowValueSitelink } from "@/lib/sitelink-filter";
import {
  fetchSitemapText,
  parseSitemapLocs,
  fetchRobotsRules,
  isPathDisallowed,
  type RobotsRules,
} from "@/lib/sitemap-fetcher";

export interface SitelinkItem {
  title: string;
  url: string;
  description?: string;
}

// D-031b (C-091)：彻底删除 COMMON_PATHS 编造 fallback。
// 旧逻辑（D-028 v3 引入的 BUG）：
//   sitemap + robots 都拿不到 → 拼接 merchantUrl + /shop, /products 等 → challenged host
//   还跳过 HEAD 验证 → 6 条编造的 URL 直接提交 Google Ads → 拒登「目标网址广告客户无效」
//   实证：wj10 temu.com 广告 681-LH1-temucom-US-0526-160992 6 条 sitelinks 全部拒登。
// 新逻辑：sitemap+robots 都失败时返回空列表，上层 sitelink-ai-writer 不生成 sitelinks，
//   广告主体（headlines/descriptions）仍可正常投放。宁缺毋滥，绝不编造假 URL。

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

// 非页面扩展名（sitemap / 静态资源 / 压缩包）
const NON_PAGE_EXT_RE = /\.(xml|xml\.gz|txt|gz|pdf|jpe?g|png|gif|webp|svg|ico|css|js|zip|tar|mp4|mp3|woff2?)$/i;

/** 嵌套 sitemap 索引展开（共享 fetchSitemapText：代理+gzip+CDATA+缓存+2MB 上限） */
async function expandSitemap(sm: string, proxyUrl: string | null): Promise<string[]> {
  const locs = parseSitemapLocs(sm, 200);
  if (locs.length === 0) return [];
  // 判定嵌套：<sitemapindex> 标签 or 所有 loc 都指向 .xml
  const isNested =
    /<sitemapindex[\s>]/i.test(sm) ||
    locs.every((u) => /\.xml(\.gz)?(\?|$)/i.test(u));
  if (!isNested) return locs;
  const pageUrls: string[] = [];
  // 展开前 3 个子 sitemap，每个最多取 40 条页面 URL
  for (const child of locs.slice(0, 3)) {
    const childSm = await fetchSitemapText(child, proxyUrl).catch(() => null);
    if (!childSm) continue;
    pageUrls.push(...parseSitemapLocs(childSm, 40));
    if (pageUrls.length >= 100) break;
  }
  return pageUrls;
}

/**
 * 抽取 sitemap 下的页面 URL。
 * 2026-07-13（第五轮）：抓取/解析统一走 sitemap-fetcher（代理优先、gzip、CDATA、
 * 大小上限、进程内缓存——同一次生成不再重复抓同一 sitemap）。
 */
async function extractFromSitemap(merchantUrl: string, proxyUrl: string | null): Promise<string[]> {
  for (const path of SITEMAP_URLS) {
    let sm: string | null;
    try {
      sm = await fetchSitemapText(new URL(path, merchantUrl).toString(), proxyUrl);
    } catch {
      continue;
    }
    if (!sm) continue;

    let pageUrls = await expandSitemap(sm, proxyUrl);
    // 过滤所有非页面扩展名
    pageUrls = pageUrls.filter((u) => {
      try { return !NON_PAGE_EXT_RE.test(new URL(u, merchantUrl).pathname); } catch { return false; }
    });
    if (pageUrls.length > 0) return pageUrls;
  }
  return [];
}

/** robots.txt 的 Sitemap: 指令扩源（相对路径已由 sitemap-fetcher 解析为绝对 URL） */
async function extractFromRobots(merchantUrl: string, proxyUrl: string | null, rules: RobotsRules | null): Promise<string[]> {
  try {
    if (!rules || rules.sitemaps.length === 0) return [];
    const urls: string[] = [];
    for (const smUrl of rules.sitemaps.slice(0, 5)) {
      const sm = await fetchSitemapText(smUrl, proxyUrl);
      if (!sm) continue;
      urls.push(...(await expandSitemap(sm, proxyUrl)));
      if (urls.length >= 60) break;
    }
    return urls.slice(0, 60).filter((u) => {
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

// D-031b (C-091)：probeCommonPaths 已废弃 — 编造的 URL 必然导致 Google Ads 拒登。

async function headIsOk(url: string, proxyUrl: string | null): Promise<boolean> {
  const doHead = async (useProxy: boolean): Promise<boolean> => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const headers = { "User-Agent": "Mozilla/5.0 (compatible; SitelinkExpander/1.0)" };
      const res = useProxy && proxyUrl
        ? await fetchViaProxy(url, { method: "HEAD", headers, signal: ctrl.signal }, proxyUrl)
        : await fetch(url, { method: "HEAD", signal: ctrl.signal, headers, redirect: "follow" });
      clearTimeout(t);
      return res.ok || res.status < 400;
    } catch {
      return false;
    }
  };
  if (proxyUrl) {
    // 先代理；代理失败再直连（代理 IP 被封但服务器直连可达的情况）
    const viaProxy = await doHead(true);
    if (viaProxy) return true;
    return doHead(false);
  }
  return doHead(false);
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
  // C-016: Google Ads 允许最多 6 条 sitelinks，默认扩到 6
  const targetCount = opts.targetCount ?? 6;
  if (!merchantUrl) return existing;
  if (existing.length >= targetCount) return existing;

  const proxyUrl = country ? await getProxyUrlForCountry(country).catch(() => null) : null;
  const usedUrls = new Set(existing.map((s) => s.url));

  // 2026-07-13（第五轮）：先取 robots 规则——Disallow 路径不得进 sitelink 候选
  // （被商家明确禁抓的路径投进广告，既是合规问题也常是死链/内部页）。robots 取不到时 fail-open。
  const robotsRules = await fetchRobotsRules(merchantUrl, proxyUrl).catch(() => null);

  // 候选统一闸口：同源 + 顶层路径 + 黑名单 + locale + robots Disallow + 低价值
  const passGate = (u: string): boolean =>
    sameOrigin(u, merchantUrl) &&
    isTopLevelPath(u) &&
    !isBadSitelinkUrl(u) &&
    isSitelinkLocaleCompatible(u, merchantUrl) &&
    !isPathDisallowed(u, robotsRules) &&
    !isLowValueSitelink(u, titleFromUrlPath(u) || "");

  // 候选采集（三层）
  const candidates = new Set<string>();
  try {
    const fromSitemap = await extractFromSitemap(merchantUrl, proxyUrl);
    for (const u of fromSitemap) {
      // isSitelinkLocaleCompatible：sitemap 常含全部语言版本 URL（/fr /nl /de…），
      // 只保留与落地页语言一致的，避免 rad.eu「落地页 /en 配 /fr /nl 站内链接」类错配
      if (passGate(u)) candidates.add(u);
    }
  } catch (e) {
    console.warn("[SitelinkExpand] sitemap 抽取失败:", e instanceof Error ? e.message : e);
  }

  if (candidates.size + existing.length < targetCount) {
    try {
      const fromRobots = await extractFromRobots(merchantUrl, proxyUrl, robotsRules);
      for (const u of fromRobots) {
        if (passGate(u)) candidates.add(u);
      }
    } catch (e) {
      console.warn("[SitelinkExpand] robots 抽取失败:", e instanceof Error ? e.message : e);
    }
  }

  // D-031b (C-091)：移除 COMMON_PATHS 兜底分支。
  // 当 sitemap + robots 都拿不到候选时，直接放弃 sitelinks，
  // 不再编造 /shop /products 等通用路径 — 这些路径在 Google Ads 校验时
  // 会因 "广告客户无效" 拒登整个广告（详见 设计方案.md D-031b）。
  if (candidates.size + existing.length < targetCount) {
    console.warn(`[SitelinkExpand] sitemap+robots 均未抽到候选，merchantUrl=${merchantUrl} → 放弃 sitelinks（不再用 COMMON_PATHS 编造，避免 Google Ads 拒登）`);
  }

  // D-038b（方案 G）：删除 D-028 v3 引入的 challenged host 跳过 HEAD 验证短路。
  // 原 D-028 v3 设计：跳过 HEAD 信任候选 url，5s 内出 6 条 — 但导致编造路径被采纳
  // （D-031b/C-091 已修复 COMMON_PATHS 编造问题，但 sitemap+robots 抽到的真候选
  // 也被无脑信任，CF temporary challenge 时整批不验证就发布，Google Ads 拒登）。
  // 现在统一所有 host 走 Promise.all 并行 HEAD 验证（D-028 v3 真改进：并行 5s 上限保留）。
  const toVerify = [...candidates].filter((u) => !usedUrls.has(u)).slice(0, 20);
  const headResults = await Promise.all(
    toVerify.map(async (u) => ({ u, ok: await headIsOk(u, proxyUrl) })),
  );
  const verified: string[] = headResults.filter((r) => r.ok).map((r) => r.u).slice(0, targetCount + 2);

  // 拉 meta 构造 SitelinkItem，同时记录同源子域名重定向目标
  const results: SitelinkItem[] = [];
  const discoveredSubdomainRoots = new Set<string>(); // e.g. "https://knowledge.carolina.com"
  const origHostBase = (() => { try { return new URL(merchantUrl).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } })();

  // D-038b（方案 G）：删除 D-028 v3 引入的 challenged host 跳过 fetchUrlMeta 短路。
  // 保留 D-028 v3 的 Promise.all 并行优化（顺序 await → 并行真改进）。
  // 现行为：所有 host 一律走 fetchUrlMeta 真实抓 meta，让 sitelinks title/description
  // 来自页面真实内容而非 url path 拼凑，质量与 Google Ads 通过率都更高。
  const verifiedToFetch = verified.slice(0, targetCount + 2);
  const fetchResults = await Promise.all(
    verifiedToFetch.map(async (u) => {
      try {
        const meta = await fetchUrlMeta(u, proxyUrl ?? undefined, country);
        // 2026-07-13（第五轮）：sitelink 落 URL 对齐重定向后的 finalUrl——
        // 此前用 sitemap 原始 URL 建 item，301 落到 /cart、跨 locale 或 Disallow 页时
        // 全部闸口都被绕过（闸口只查过跳转前的 URL）。
        let landUrl = u;
        if (meta.ok && meta.finalUrl && meta.finalUrl !== u) {
          try {
            const fu = new URL(meta.finalUrl).toString();
            if (sameOrigin(fu, merchantUrl)) {
              // finalUrl 需重新过闸；不过闸则整条丢弃（不能退回原 URL——用户点击后仍会跳到坏页）
              if (isBadSitelinkUrl(fu) || !isSitelinkLocaleCompatible(fu, merchantUrl) || isPathDisallowed(fu, robotsRules) || isLowValueSitelink(fu, titleFromUrlPath(fu) || "")) {
                return { u, item: null, meta };
              }
              landUrl = fu;
            }
            // 跨域重定向（子域除外，下方单独处理）：保留原 URL 行为交给 meta 记录
          } catch { /* finalUrl 非法则沿用原 URL */ }
        }
        const item = toSitelinkItem(landUrl, titleFromUrlPath(landUrl), meta.ok ? { title: meta.title, description: meta.description } : undefined);
        return { u, item, meta };
      } catch {
        return { u, item: toSitelinkItem(u, titleFromUrlPath(u)), meta: null };
      }
    }),
  );

  const seenLandUrls = new Set<string>(existing.map((s) => s.url));
  for (const { u: _u, item, meta } of fetchResults) {
    if (results.length + existing.length >= targetCount) break;
    // 若目标 URL 301 到同源子域名，记录以便后续扩展
    if (meta && meta.ok && meta.finalUrl && meta.finalUrl !== _u) {
      try {
        const finalHost = new URL(meta.finalUrl).hostname.replace(/^www\./, "").toLowerCase();
        const finalOrigin = new URL(meta.finalUrl).origin;
        if (finalHost !== origHostBase && finalHost.endsWith(`.${origHostBase}`)) {
          discoveredSubdomainRoots.add(finalOrigin);
        }
      } catch {}
    }
    if (item && item.title && item.title.length >= 2 && !seenLandUrls.has(item.url)) {
      seenLandUrls.add(item.url); // 多个原始 URL 301 到同一 finalUrl 时去重
      results.push(item);
    }
  }

  // ── 子域名扩展：当发现候选 URL 重定向到同源子域（如 knowledge.carolina.com）时，
  //    抓取该子域首页的导航链接作为额外候选，弥补主域被 WAF 封锁的问题
  if (results.length + existing.length < targetCount && discoveredSubdomainRoots.size > 0) {
    for (const subRoot of discoveredSubdomainRoots) {
      if (results.length + existing.length >= targetCount) break;
      try {
        const subHtml = await fetchText(subRoot + "/", proxyUrl, 10000);
        if (!subHtml) continue;
        // 提取 href 中的路径，补全为绝对 URL，过滤同源 top-level 路径
        const hrefRe = /href="((?:https?:\/\/[^"]+|\/[^"?#<> ]+))"/gi;
        const subCandidates: string[] = [];
        let hm: RegExpExecArray | null;
        while ((hm = hrefRe.exec(subHtml)) !== null) {
          try {
            const abs = new URL(hm[1], subRoot).toString();
            if (passGate(abs) && !usedUrls.has(abs)) {
              subCandidates.push(abs);
            }
          } catch {}
          if (subCandidates.length >= 20) break;
        }
        // HEAD 验证 + 拉 meta
        for (const u of subCandidates) {
          if (results.length + existing.length >= targetCount) break;
          const ok = await headIsOk(u, proxyUrl);
          if (!ok) continue;
          usedUrls.add(u);
          try {
            const meta = await fetchUrlMeta(u, proxyUrl ?? undefined, country);
            const item = toSitelinkItem(u, titleFromUrlPath(u), meta.ok ? { title: meta.title, description: meta.description } : undefined);
            if (item.title && item.title.length >= 2) results.push(item);
          } catch {
            const item = toSitelinkItem(u, titleFromUrlPath(u));
            if (item.title && item.title.length >= 2) results.push(item);
          }
        }
        console.warn(`[SitelinkExpand] 子域名 ${subRoot} 扩源，新增 ${results.length} 条`);
      } catch (e) {
        console.warn(`[SitelinkExpand] 子域名 ${subRoot} 扩源失败:`, e instanceof Error ? e.message : e);
      }
    }
  }

  console.warn(`[SitelinkExpand] 扩源完成：从 ${existing.length} → ${existing.length + results.length}（目标 ${targetCount}）`);
  return [...existing, ...results];
}
