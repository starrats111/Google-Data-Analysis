/**
 * F-CRAWLER-LOCALIZE-TLD — 多顶级域本地化探测
 *
 * 场景：商家填 `aerosus.nl`，目标国家 `BE` → 本地站真实域名是 `aerosus.be`。
 * 现有 `normalizeLocaleInUrl` 只处理路径级 locale（`/en-sg/` → `/en-us/`），
 * 对 ccTLD 级本地化（`.nl` → `.be`）完全无能为力。
 *
 * 本模块提供三层探测：
 *   L1  hreflang 标签：`<link rel="alternate" hreflang="xx-YY" href="...">`
 *   L2  页面内国家切换器：`<a>` 锚文本命中国家本地名
 *   L3  ccTLD 硬切换 + HEAD 验证：保底兜底
 *
 * 三层按顺序执行，命中即停。命中候选必须通过：
 *   ① 同主品牌主干名校验（避免跳到无关域名）
 *   ② HEAD / GET 200 状态校验
 *
 * 全部失败时返回原 URL（不阻断主流程）。
 */

import { fetchViaProxy } from "@/lib/crawl-proxy";

export interface LocalizeResult {
  /** 最终推荐使用的 URL（命中时为新 URL，未命中时与 original 相同） */
  url: string;
  /** 命中来源，便于日志追踪 */
  via: "hreflang" | "switcher" | "cctld" | "none";
  /** 原始输入 URL */
  original: string;
  /** 调试原因（hreflang 命中的 tag / 切换器锚文本 / ccTLD 模板等） */
  reason?: string;
}

// ─── 国家 → ccTLD 映射（L3 兜底 + 一致性校验） ───
const COUNTRY_TO_CCTLD: Record<string, string> = {
  US: "com", GB: "co.uk", UK: "co.uk", AU: "com.au", CA: "ca", NZ: "co.nz",
  IE: "ie", IN: "in", SG: "com.sg", HK: "com.hk", TW: "com.tw", JP: "jp",
  KR: "kr", CN: "cn", TH: "co.th", VN: "vn", ID: "co.id", MY: "com.my",
  PH: "ph", AE: "ae", SA: "com.sa", TR: "com.tr",
  DE: "de", AT: "at", CH: "ch", FR: "fr", IT: "it", ES: "es", PT: "pt",
  NL: "nl", BE: "be", SE: "se", NO: "no", DK: "dk", FI: "fi", PL: "pl",
  BR: "com.br", MX: "com.mx", AR: "com.ar",
};

// ─── 国家 → 页面切换器关键字（L2 用） ───
// 值为该国家在多语言网站中可能出现的本地名（含英文、原生文、常用别名）
const COUNTRY_ALIASES: Record<string, string[]> = {
  BE: ["België", "Belgium", "Belgique", "Belgien"],
  NL: ["Nederland", "Netherlands", "Holland"],
  DE: ["Deutschland", "Germany", "Allemagne"],
  AT: ["Österreich", "Austria", "Autriche"],
  CH: ["Schweiz", "Switzerland", "Suisse", "Svizzera"],
  FR: ["France", "Frankreich"],
  IT: ["Italia", "Italy", "Italien"],
  ES: ["España", "Spain", "Espagne"],
  PT: ["Portugal"],
  NO: ["Norge", "Norway", "Norwegen"],
  SE: ["Sverige", "Sweden", "Schweden"],
  DK: ["Danmark", "Denmark", "Dänemark"],
  FI: ["Suomi", "Finland", "Finnland"],
  PL: ["Polska", "Poland", "Polen"],
  GB: ["United Kingdom", "Great Britain", "UK", "England"],
  UK: ["United Kingdom", "Great Britain", "UK", "England"],
  IE: ["Ireland", "Éire", "Irland"],
  US: ["United States", "USA", "America"],
  CA: ["Canada", "Kanada"],
  AU: ["Australia", "Australien"],
  NZ: ["New Zealand", "Neuseeland"],
  JP: ["日本", "Japan"],
  KR: ["한국", "Korea", "South Korea"],
  CN: ["中国", "China"],
  TW: ["台灣", "Taiwan"],
  HK: ["香港", "Hong Kong"],
  SG: ["Singapore", "Singapur"],
  IN: ["India", "Indien"],
  BR: ["Brasil", "Brazil", "Brasilien"],
  MX: ["México", "Mexico", "Mexiko"],
  AR: ["Argentina", "Argentinien"],
  TR: ["Türkiye", "Turkey"],
  AE: ["الإمارات", "UAE", "United Arab Emirates"],
  SA: ["السعودية", "Saudi Arabia"],
  TH: ["ประเทศไทย", "Thailand"],
  VN: ["Việt Nam", "Vietnam"],
  ID: ["Indonesia"],
  MY: ["Malaysia"],
  PH: ["Philippines", "Pilipinas"],
};

/** 从一个主机名中提取"主品牌主干名"（去 www，去已知 ccTLD）。
 *  用来校验跨域切换时没有跳到无关品牌（如 aerosus.nl → aerosus.be ✅；aerosus.nl → random.be ❌）。
 */
function extractBrandRoot(hostname: string): string {
  const host = hostname.replace(/^www\./i, "").toLowerCase();
  // 已知多段 ccTLD 列表（co.uk、com.au、com.br、com.sg、com.hk、com.tw、co.nz、co.th、co.id、com.my、com.sa、com.tr、com.mx、com.ar）
  const MULTI_PART_TLDS = [
    "co.uk", "com.au", "com.br", "com.sg", "com.hk", "com.tw",
    "co.nz", "co.th", "co.id", "com.my", "com.sa", "com.tr",
    "com.mx", "com.ar",
  ];
  for (const tld of MULTI_PART_TLDS) {
    if (host.endsWith("." + tld)) {
      const base = host.slice(0, -(tld.length + 1));
      return base.split(".").slice(-1)[0];
    }
  }
  // 单段 TLD：aerosus.nl → aerosus；shop.aerosus.nl → aerosus
  const parts = host.split(".");
  if (parts.length >= 2) return parts[parts.length - 2];
  return host;
}

/** 判断两个 URL 是否属于同一"主品牌" —— 同主干名即认可。 */
function isSameBrand(aUrl: string, bUrl: string): boolean {
  try {
    const a = extractBrandRoot(new URL(aUrl).hostname);
    const b = extractBrandRoot(new URL(bUrl).hostname);
    return a.length >= 3 && a === b;
  } catch {
    return false;
  }
}

/** 用代理或直连发起 GET，最多 12s；用于抓主页 HTML（L1/L2）。 */
async function fetchMainHtml(url: string, proxyUrl?: string): Promise<string | null> {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
    "Accept-Language": "en-US,en;q=0.9",
  };
  try {
    if (proxyUrl) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetchViaProxy(url, { headers, signal: ctrl.signal }, proxyUrl);
      clearTimeout(t);
      if (!res.ok) return null;
      const html = await res.text();
      return html && html.length > 500 ? html : null;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    if (!res.ok) return null;
    const html = await res.text();
    return html && html.length > 500 ? html : null;
  } catch {
    return null;
  }
}

/** HEAD 请求验证候选 URL 存在且返回 HTML；不支持 HEAD 时退回 GET 前 1KB。 */
async function verifyUrlReachable(url: string): Promise<boolean> {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
  };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { method: "HEAD", headers, signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    if (res.status >= 200 && res.status < 400) {
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      // 允许 text/html、application/xhtml、空（部分站 HEAD 不返 CT）
      return !ct || ct.includes("html") || ct.includes("xhtml");
    }
  } catch {
    // 某些站禁 HEAD，退回 GET 前 1KB
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(url, { method: "GET", headers, signal: ctrl.signal, redirect: "follow" });
    clearTimeout(t);
    if (res.status < 200 || res.status >= 400) return false;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    return !ct || ct.includes("html") || ct.includes("xhtml");
  } catch {
    return false;
  }
}

// ══════════════════════════════════════════════════════
// L1: hreflang
// ══════════════════════════════════════════════════════

/**
 * 解析 HTML 中所有 `<link rel="alternate" hreflang="..." href="...">` 标签，
 * 返回命中目标国家的候选 URL（如多条则取首个有效的）。
 *
 * 匹配规则（优先级）：
 *   1. hreflang="xx-YY"  其中 YY 等于 targetCountry
 *   2. hreflang="YY"     两字母，等于 targetCountry
 */
function findHreflangUrl(html: string, targetCountry: string, originalUrl: string): { url: string; reason: string } | null {
  const country = targetCountry.toUpperCase();
  const LINK_RE = /<link\b[^>]*rel=["']?alternate["']?[^>]*>/gi;
  const HREF_RE = /\bhref=["']([^"']+)["']/i;
  const HREFLANG_RE = /\bhreflang=["']([^"']+)["']/i;

  const candidates: { url: string; hreflang: string; rank: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = LINK_RE.exec(html)) !== null) {
    const tag = m[0];
    const hrefMatch = tag.match(HREF_RE);
    const hreflangMatch = tag.match(HREFLANG_RE);
    if (!hrefMatch || !hreflangMatch) continue;
    const href = hrefMatch[1].trim();
    const hreflang = hreflangMatch[1].trim();
    if (!href || !hreflang) continue;

    const hl = hreflang.toLowerCase();
    // xx-YY 格式，取后两位
    const twoPartMatch = hl.match(/^([a-z]{2,3})[-_]([a-z]{2})$/);
    if (twoPartMatch && twoPartMatch[2].toUpperCase() === country) {
      candidates.push({ url: href, hreflang, rank: 1 });
      continue;
    }
    // 纯 2 字母格式（少见但存在）
    if (/^[a-z]{2}$/.test(hl) && hl.toUpperCase() === country) {
      candidates.push({ url: href, hreflang, rank: 2 });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.rank - b.rank);
  for (const c of candidates) {
    // 转绝对 URL
    let abs = c.url;
    try {
      abs = new URL(c.url, originalUrl).toString();
    } catch {
      continue;
    }
    if (!abs.startsWith("http")) continue;
    if (!isSameBrand(abs, originalUrl)) continue;
    return { url: abs, reason: `hreflang="${c.hreflang}"` };
  }
  return null;
}

// ══════════════════════════════════════════════════════
// L2: 页面切换器
// ══════════════════════════════════════════════════════

/**
 * 扫 HTML 中的 `<a>` 标签，找锚文本与目标国家本地名（`België`/`Belgium`/...）
 * 匹配的链接；要求 href 与 originalUrl 同主品牌主干名。
 */
function findSwitcherUrl(html: string, targetCountry: string, originalUrl: string): { url: string; reason: string } | null {
  const aliases = COUNTRY_ALIASES[targetCountry.toUpperCase()] || [];
  if (aliases.length === 0) return null;

  const A_RE = /<a\b([^>]*)>([\s\S]{1,300}?)<\/a>/gi;
  const HREF_RE = /\bhref=["']([^"']+)["']/i;
  let m: RegExpExecArray | null;
  while ((m = A_RE.exec(html)) !== null) {
    const attrs = m[1];
    const inner = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (!inner) continue;
    // 锚文本必须恰好是国家名（或被标点/空白包围），避免误命中正文
    const matched = aliases.some(a => {
      const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(^|[\\s\\|·,/>])${escaped}($|[\\s\\|·,/<])`, "i");
      return re.test(inner);
    });
    if (!matched) continue;
    const hrefMatch = attrs.match(HREF_RE);
    if (!hrefMatch) continue;
    let abs: string;
    try {
      abs = new URL(hrefMatch[1].trim(), originalUrl).toString();
    } catch {
      continue;
    }
    if (!abs.startsWith("http")) continue;
    if (!isSameBrand(abs, originalUrl)) continue;
    // 排除指回同一域名（点了也没意义）
    try {
      const a = new URL(abs).hostname.replace(/^www\./, "").toLowerCase();
      const b = new URL(originalUrl).hostname.replace(/^www\./, "").toLowerCase();
      if (a === b) continue;
    } catch {
      continue;
    }
    return { url: abs, reason: `switcher anchor "${inner.slice(0, 40)}"` };
  }
  return null;
}

// ══════════════════════════════════════════════════════
// L3: ccTLD 硬切换
// ══════════════════════════════════════════════════════

/**
 * 把 origin 的 ccTLD 替换为目标国家的 ccTLD，对结果 HEAD 验证。
 * 保留路径和 query（例如 aerosus.nl/foo → aerosus.be/foo）。
 */
async function tryCcTldSwitch(originalUrl: string, targetCountry: string): Promise<{ url: string; reason: string } | null> {
  const tld = COUNTRY_TO_CCTLD[targetCountry.toUpperCase()];
  if (!tld) return null;

  let u: URL;
  try { u = new URL(originalUrl); } catch { return null; }
  const host = u.hostname.replace(/^www\./i, "");

  const brand = extractBrandRoot(host);
  if (!brand || brand.length < 3) return null;
  const newHost = `${brand}.${tld}`;

  // 同名保护：已在目标 TLD 上，不必切
  if (host === newHost) return null;

  // 组装候选 URL（保留 path + search；但重置 port/auth/hash）
  const candidate = `${u.protocol}//${newHost}${u.pathname === "/" ? "/" : u.pathname}${u.search}`;
  const reachable = await verifyUrlReachable(candidate);
  if (!reachable) return null;
  return { url: candidate, reason: `cctld "${tld}" HEAD-verified` };
}

// ══════════════════════════════════════════════════════
// 主入口
// ══════════════════════════════════════════════════════

/**
 * 三层本地化探测：命中即停，全部失败则返回原 URL。
 *
 * 性能要点：
 *   - L1+L2 共用一次主页 fetch（12s 超时）
 *   - L3 最多 1 次 HEAD（5s）
 *   - 失败不抛错，保证主流程不被打断
 */
export async function resolveLocalizedUrl(
  merchantUrl: string,
  targetCountry: string,
  proxyUrl?: string,
): Promise<LocalizeResult> {
  const original = merchantUrl;
  if (!merchantUrl || !targetCountry) {
    return { url: original, via: "none", original };
  }

  // 同 ccTLD 短路：商家本身就在目标国家 TLD 上，直接返回
  try {
    const host = new URL(merchantUrl).hostname.replace(/^www\./i, "").toLowerCase();
    const targetTld = COUNTRY_TO_CCTLD[targetCountry.toUpperCase()];
    if (targetTld && host.endsWith("." + targetTld)) {
      return { url: original, via: "none", original, reason: "already-on-target-cctld" };
    }
  } catch {
    // URL 非法，直接返回
    return { url: original, via: "none", original };
  }

  // L1+L2：取一次主页 HTML
  const html = await fetchMainHtml(merchantUrl, proxyUrl);
  if (html) {
    // L1
    const l1 = findHreflangUrl(html, targetCountry, merchantUrl);
    if (l1) {
      const ok = await verifyUrlReachable(l1.url);
      if (ok) {
        console.log(`[Localize] L1 hreflang 命中: ${original} → ${l1.url} (${l1.reason})`);
        return { url: l1.url, via: "hreflang", original, reason: l1.reason };
      }
      console.log(`[Localize] L1 候选 ${l1.url} HEAD 校验失败，降级`);
    }
    // L2
    const l2 = findSwitcherUrl(html, targetCountry, merchantUrl);
    if (l2) {
      const ok = await verifyUrlReachable(l2.url);
      if (ok) {
        console.log(`[Localize] L2 switcher 命中: ${original} → ${l2.url} (${l2.reason})`);
        return { url: l2.url, via: "switcher", original, reason: l2.reason };
      }
      console.log(`[Localize] L2 候选 ${l2.url} HEAD 校验失败，降级`);
    }
  } else {
    console.log(`[Localize] 主页 fetch 失败，跳过 L1/L2，直接 L3`);
  }

  // L3
  const l3 = await tryCcTldSwitch(merchantUrl, targetCountry);
  if (l3) {
    console.log(`[Localize] L3 ccTLD 命中: ${original} → ${l3.url} (${l3.reason})`);
    return { url: l3.url, via: "cctld", original, reason: l3.reason };
  }

  console.log(`[Localize] 三层均未命中 (country=${targetCountry})，保留原 URL: ${original}`);
  return { url: original, via: "none", original };
}
