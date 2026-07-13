/**
 * 2026-07-13（第五轮）：统一 sitemap / robots.txt 抓取与解析。
 *
 * 病灶背景：
 *   - crawlViaSitemap（crawler.ts）与 autoExpandSitelinks（sitelink-auto-expand.ts）
 *     各自实现 sitemap 抓取：前者纯直连（新加坡出口，geo 限制站必失败），后者不解 gzip；
 *     同一次生成里同一 sitemap 被抓 2-3 次。
 *   - 两处解析都是裸正则 <loc>，不支持 CDATA、不解实体、无响应体上限（几十 MB 的
 *     product sitemap 直接进内存）。
 *   - robots.txt 只读 Sitemap: 指令，Disallow 完全无视——被商家明确禁抓的路径照样
 *     进 sitelink 候选；Sitemap: 相对路径也不解析。
 *
 * 本模块提供：
 *   - fetchSitemapText：代理优先+直连兜底、gzip（.gz 文件与传输压缩）解压、2MB 上限、
 *     进程内 10 分钟 TTL 缓存（同一次生成/并发生成间去重）。
 *   - parseSitemapLocs：CDATA / 实体 / 命名空间兼容的 <loc> 提取。
 *   - fetchRobotsRules / isPathDisallowed：Disallow 规则解析与判定（User-agent: * 组，
 *     支持 * 通配与 $ 锚定，遵循 Google 的最长匹配优先 + Allow 覆盖语义的简化版）。
 */
import { gunzipSync } from "zlib";
import { fetchViaProxy } from "@/lib/crawl-proxy";

// ─── 进程内 TTL 缓存 ───
const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 200;
const _cache = new Map<string, { at: number; text: string | null }>();

function cacheGet(key: string): { text: string | null } | undefined {
  const e = _cache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.at > TTL_MS) { _cache.delete(key); return undefined; }
  return e;
}
function cacheSet(key: string, text: string | null): void {
  if (_cache.size >= MAX_ENTRIES) {
    // 淘汰最老的 20 条
    const keys = [..._cache.keys()].slice(0, 20);
    for (const k of keys) _cache.delete(k);
  }
  _cache.set(key, { at: Date.now(), text });
}

const MAX_BYTES = 2 * 1024 * 1024; // 2MB：sitemap 索引/单文件足够，防几十 MB product sitemap 打爆内存
const GZ_MAGIC = (b: Buffer) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

function bufToText(buf: Buffer): string {
  let b = buf;
  if (GZ_MAGIC(b)) {
    try { b = gunzipSync(b); } catch { return ""; }
  }
  if (b.length > MAX_BYTES) b = b.subarray(0, MAX_BYTES);
  return b.toString("utf8"); // sitemap 规范要求 UTF-8
}

/**
 * 抓取 sitemap / robots 文本。代理优先（geo 限制站），直连兜底；gzip 解压；2MB 上限；
 * 进程内 TTL 缓存（含失败负缓存，避免同一次生成反复打失败 URL）。
 */
export async function fetchSitemapText(
  url: string,
  proxyUrl?: string | null,
  timeoutMs = 10000,
): Promise<string | null> {
  const key = url;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit.text;

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Accept": "text/xml,application/xml,text/plain,text/html,*/*;q=0.8",
  };

  const attempt = async (useProxy: boolean): Promise<string | null> => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        if (useProxy && proxyUrl) {
          const res = await fetchViaProxy(url, { headers, signal: ctrl.signal }, proxyUrl);
          if (!res.ok) return null;
          const buf = await res.buffer();
          if (buf.length > MAX_BYTES * 2) return null; // 离谱大直接放弃
          const text = bufToText(buf);
          return text.length >= 20 ? text : null;
        }
        const res = await fetch(url, { signal: ctrl.signal, headers, redirect: "follow" });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_BYTES * 2) return null;
        const text = bufToText(buf);
        return text.length >= 20 ? text : null;
      } finally {
        clearTimeout(t);
      }
    } catch {
      return null;
    }
  };

  let text: string | null = null;
  if (proxyUrl) text = await attempt(true);
  if (!text) text = await attempt(false);
  cacheSet(key, text);
  return text;
}

/**
 * 提取 sitemap 的 <loc>。兼容：
 *   - CDATA：<loc><![CDATA[https://…]]></loc>
 *   - XML 实体：&amp; 等
 *   - 命名空间前缀：<sm:loc>（部分生成器）
 * 注意：<image:loc> 是图片、不是页面，排除。
 */
export function parseSitemapLocs(xml: string, limit: number): string[] {
  const out: string[] = [];
  const locRe = /<(?:[a-z0-9]+:)?loc(?:\s[^>]*)?>([\s\S]*?)<\/(?:[a-z0-9]+:)?loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = locRe.exec(xml)) !== null) {
    // 排除 <image:loc>（前缀是 image）
    if (/^<image:/i.test(m[0])) continue;
    let u = m[1].trim();
    const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(u);
    if (cdata) u = cdata[1].trim();
    u = u
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
    if (u && /^https?:\/\//i.test(u)) out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}

export interface RobotsRules {
  /** Sitemap: 指令列出的绝对 URL（相对路径已按 robots.txt 所在 origin 解析） */
  sitemaps: string[];
  /** User-agent: * 组的 Disallow 规则（原始 pattern） */
  disallows: string[];
  /** User-agent: * 组的 Allow 规则 */
  allows: string[];
}

/**
 * 解析 robots.txt。只取 User-agent: * 组的 Allow/Disallow（我们的 UA 没有专属组）；
 * Sitemap: 指令是全局的，全部收集并把相对路径解析为绝对 URL（此前相对路径被直接丢弃）。
 */
export function parseRobotsTxt(text: string, baseUrl: string): RobotsRules {
  const sitemaps: string[] = [];
  const disallows: string[] = [];
  const allows: string[] = [];
  // 标准分组语义：连续的 User-agent 行组成一组的选择器；遇到规则行后再出现
  // User-agent 行则开启新组。只收集选择器含 * 的组的规则。
  let currentAgents: string[] = [];
  let groupClosed = true; // 当前是否处于「规则行已出现、等待新组」状态

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();

    if (field === "sitemap") {
      // Sitemap 是全局指令，与分组无关；相对路径按 robots.txt origin 解析
      if (value) { try { sitemaps.push(new URL(value, baseUrl).toString()); } catch { /* 丢弃非法 URL */ } }
      continue;
    }
    if (field === "user-agent") {
      if (groupClosed) { currentAgents = []; groupClosed = false; }
      currentAgents.push(value.toLowerCase());
      continue;
    }
    if (field === "disallow" || field === "allow") {
      groupClosed = true;
      if (!currentAgents.includes("*")) continue;
      if (!value) continue; // 空 Disallow = 允许全部
      if (field === "disallow") disallows.push(value);
      else allows.push(value);
    }
  }
  return { sitemaps, disallows, allows };
}

/** robots pattern → 正则（支持 * 通配与结尾 $ 锚定） */
function robotsPatternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/**
 * 判定 URL 路径是否被 robots Disallow（最长匹配优先，Allow 平长胜出——Google 语义简化版）。
 */
export function isPathDisallowed(url: string, rules: RobotsRules | null | undefined): boolean {
  if (!rules || rules.disallows.length === 0) return false;
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return false;
  }
  let bestDisallow = -1;
  let bestAllow = -1;
  for (const d of rules.disallows) {
    try { if (robotsPatternToRegex(d).test(path) && d.length > bestDisallow) bestDisallow = d.length; } catch { /* 非法 pattern 忽略 */ }
  }
  if (bestDisallow < 0) return false;
  for (const a of rules.allows) {
    try { if (robotsPatternToRegex(a).test(path) && a.length > bestAllow) bestAllow = a.length; } catch { /* ignore */ }
  }
  return bestDisallow > bestAllow;
}

/** 抓取并解析 robots.txt（走同一 TTL 缓存）。失败返回 null（fail-open：无 robots 不拦）。 */
export async function fetchRobotsRules(
  merchantUrl: string,
  proxyUrl?: string | null,
): Promise<RobotsRules | null> {
  let robotsUrl: string;
  try { robotsUrl = new URL("/robots.txt", merchantUrl).toString(); } catch { return null; }
  const text = await fetchSitemapText(robotsUrl, proxyUrl, 6000);
  if (!text) return null;
  // 有些站 robots.txt 404 后返回 HTML 错误页：粗判排除
  if (/^\s*</.test(text) && !/user-agent|sitemap/i.test(text.slice(0, 500))) return null;
  return parseRobotsTxt(text, robotsUrl);
}
