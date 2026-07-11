/**
 * C-016 country-url-resolver
 *
 * 职责：根据投放国 country，将商家 merchantUrl 解析到目标 ccTLD（若存在）。
 * 设计原则：
 *   - 不走 HTTP 层（避免 WAF/CF/proxy geo-block）
 *   - 走 DNS + TCP 443 握手（毫秒级权威判定）
 *   - 三种明确输出：cc_tld_ok / nxdomain / same_tld / tcp_timeout
 *   - LRU cache 区分 TTL（success 60m / nxdomain 30m / timeout 5m）
 *
 * 使用方：
 *   - generate-extensions/route.ts（生成广告前决定 final_url + brandRoot）
 *   - submit/route.ts（可选二次校验，当前流程信任生成阶段的 final_url）
 */

import { promises as dns } from "node:dns";
import net from "node:net";

export interface ProbeLogEntry {
  host: string;
  dns: "ok" | "nxdomain" | "err";
  tcp: "ok" | "timeout" | "err" | "skipped";
  rttMs?: number;
  error?: string;
}

export interface ResolveResult {
  finalUrl: string;
  brandRoot: string;
  switched: boolean;
  reason: "cc_tld_ok" | "same_tld" | "nxdomain" | "tcp_timeout" | "invalid_input" | "cc_tld_parked" | "cc_tld_redirects_away" | "cc_tld_challenged";
  probeLog: ProbeLogEntry[];
}

const DNS_TIMEOUT_MS = 3000;
const TCP_TIMEOUT_MS = 3000;
const PARKED_PROBE_TIMEOUT_MS = 5000;

// D-068：域名"停放/待售"页面识别。
// 真因（生产实证）：resolver 只验 DNS+TCP，把 heidi.com→heidi.uk、scarosso.com→scarosso.de
// 这类 ccTLD 切换照常放行；但很多品牌的 ccTLD 变体并不属于该品牌，而是被域名商抢注/停放的
// "待售页"（heidi.uk=Surname.uk「Surname and Forename Domains For Sale」、scarosso.de=
// 「steht zum Verkauf」）。爬虫忠实抓到"卖域名"文字 → AI 生成卖域名广告 → 文案与商家业务不符。
// 故切换前再做一次 HTTP 校验：命中停放/待售强信号则拒绝切换，保留商家真实域名。

// 已知域名停放/交易服务商域名（重定向落点命中即判停放）
const PARKING_PROVIDER_HOSTS = [
  "sedo.com", "sedoparking.com", "dan.com", "afternic.com", "hugedomains.com",
  "bodis.com", "parkingcrew.net", "above.com", "domainmarket.com", "undeveloped.com",
  "smartname.com", "voodoo.com", "name.com", "uniregistry.com", "epik.com",
  "surname.uk", "seghost", "domainnamesales.com", "buydomains.com", "godaddy.com/domainsearch",
];

// 停放/待售页强文本信号（高精度，避免误伤正常电商的 "sale"）
const PARKED_TEXT_SIGNALS: RegExp[] = [
  /\bthis domain\b[\s\S]{0,40}\b(is|may be)\b[\s\S]{0,20}\bfor sale\b/i,
  /\bdomain(s)?\b[\s\S]{0,30}\bfor sale\b/i,         // "domain for sale" / "domains for sale"
  /\bbuy this domain\b/i,
  /\bpurchase this domain\b/i,
  /\binterested in (this|the) domain\b/i,
  /\bthe domain\b[\s\S]{0,30}\bis (for sale|available)\b/i,
  /\bdomain (parking|is parked)\b/i,
  /steht zum verkauf/i,                               // 德语："正在出售"
  /diese domain (steht|kann|ist)/i,
  /\bdomain[- ]?kauf\b/i,
  /surname and forename domains for sale/i,           // heidi.uk 实测
];

const BROWSER_UA_RESOLVER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * D-069：对已抓到的可见文本做"域名停放/待售页"高精度匹配（纯函数，无网络）。
 * 用于商家自身 URL 即停放页的场景（resolver 的 probeParkedPage 只校验 ccTLD 候选，挡不住）。
 * 复用与 ccTLD 切换同一套高精度信号，实测不误伤 engwe「e-bikes for sale」/rugsource「rugs for sale」。
 * @returns 命中的信号源（截断 40 字）或 null
 */
export function matchParkedTextSignal(text: string | null | undefined): string | null {
  if (!text) return null;
  const sample = text.length > 60000 ? text.slice(0, 60000) : text;
  for (const re of PARKED_TEXT_SIGNALS) {
    if (re.test(sample)) return re.source.slice(0, 40);
  }
  return null;
}

// 国家 → 候选 ccTLD（首个优先）
const COUNTRY_TLD_MAP: Record<string, string[]> = {
  US: ["com"],
  GB: ["co.uk", "uk"],
  AU: ["com.au", "au"],
  CA: ["ca"],
  IE: ["ie"],
  NZ: ["co.nz", "nz"],
  SG: ["com.sg", "sg"],
  IN: ["in", "co.in"],
  HK: ["com.hk", "hk"],
  DE: ["de"],
  AT: ["at"],
  CH: ["ch"],
  FR: ["fr"],
  IT: ["it"],
  ES: ["es"],
  NL: ["nl"],
  BE: ["be"],
  SE: ["se"],
  NO: ["no"],
  DK: ["dk"],
  FI: ["fi"],
  PT: ["pt"],
  PL: ["pl"],
  CZ: ["cz"],
  GR: ["gr"],
  JP: ["jp", "co.jp"],
  KR: ["kr", "co.kr"],
  CN: ["cn", "com.cn"],
  TW: ["tw", "com.tw"],
  BR: ["com.br", "br"],
  MX: ["com.mx", "mx"],
  AR: ["com.ar", "ar"],
};

// D-053：品牌通用/虚荣 TLD —— 商家刻意把这些 TLD 当作主域名（流媒体爱用 .tv，
// SaaS/科技爱用 .io/.ai/.app/.dev，音频 .fm 等）。这些不是"国家本地化写错的 ccTLD"，
// 同品牌 label 的 .com 往往是**完全不同的公司或停放页**（实证：resume.io↔resume.com、
// beautiful.ai↔beautiful.com、brain.fm↔brain.com、trybinge.tv↔trybinge.com 均非同一主体）。
// 因此：原始 host 的 TLD 命中此集合时，禁止 ccTLD 切换，保留商家自己的域名。
// 注意：真正的国家 ccTLD（de/nl/fr/co.uk/com.au…）不在此列，本地化切换仍正常工作。
// 不含 "com"（com 作为 US 目标 TLD 由 hostMatchesCountryTld 单独处理，行为不变）。
const NON_LOCALIZABLE_TLDS = new Set([
  "tv", "io", "ai", "app", "fm", "gg", "me", "tech", "xyz", "store", "shop",
  "co", "dev", "studio", "live", "stream", "so", "sh", "online", "cc",
  "net", "org", "info", "biz", "site", "website", "space", "fun", "club", "vip",
]);

function originalTldNonLocalizable(host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  const last = h.split(".").pop() || "";
  return NON_LOCALIZABLE_TLDS.has(last);
}

// 品牌名末尾的"内部国家标签"（平台命名，非真实品牌一部分）
const COUNTRY_SUFFIX_TOKENS = [
  "NL", "BE", "DE", "FR", "UK", "GB", "IT", "ES", "AT", "CH",
  "DACH", "EU", "EUR", "NA",
  "US", "USA", "CA", "AU", "NZ", "JP", "KR", "CN", "TW", "HK", "SG", "IN",
  "SE", "NO", "DK", "FI", "PL", "CZ", "PT", "BR", "MX", "AR", "GR", "IE",
];

// ─── LRU Cache ────────────────────────────────────────────
interface CacheEntry {
  result: ResolveResult;
  expiresAt: number;
}

const MAX_CACHE_ENTRIES = 2000;
const cache = new Map<string, CacheEntry>();

function cacheSet(key: string, result: ResolveResult) {
  let ttlMs: number;
  switch (result.reason) {
    case "cc_tld_ok":
    case "same_tld":
      // ccTLD 判定稳定（域名注册 / DNS 配置半年内基本不变），24h 缓存可节省每次广告创建 5-30s DNS+TCP 探测
      ttlMs = 24 * 60 * 60 * 1000; // 24h
      break;
    case "nxdomain":
      // DNS 不存在的候选 host 几乎永远不会变成存在，缓存 24h
      ttlMs = 24 * 60 * 60 * 1000; // 24h
      break;
    case "cc_tld_parked":
      // D-068：停放/待售状态较稳定，但留出"将来商家拿回域名"的余地，缓存 6h
      ttlMs = 6 * 60 * 60 * 1000; // 6h
      break;
    case "cc_tld_redirects_away":
      // D08-A：ccTLD 301 回跳 canonical 的配置很稳定（属商家长期重定向策略），缓存 24h
      ttlMs = 24 * 60 * 60 * 1000; // 24h
      break;
    case "cc_tld_challenged":
      // BUG-09：候选 ccTLD 的机器人挑战墙（CF/Incapsula）属长期防护策略，较稳定，缓存 6h
      ttlMs = 6 * 60 * 60 * 1000; // 6h
      break;
    case "tcp_timeout":
      ttlMs = 5 * 60 * 1000; // 5m（可能是临时故障，短 TTL）
      break;
    default:
      ttlMs = 5 * 60 * 1000;
  }
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
  cache.set(key, { result, expiresAt: Date.now() + ttlMs });
}

function cacheGet(key: string): ResolveResult | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.result;
}

// ─── 工具函数 ────────────────────────────────────────────

/**
 * D08-A：判断两个 host 是否同一站点（忽略 www / 子域差异）。
 * 用于"候选 ccTLD 是否 301 跳出到别的注册域"检测。
 *   sameSite("wildbounds.com", "wildbounds.co.uk") → false（跨注册域，typically 回跳 canonical）
 *   sameSite("www.x.co.uk", "x.co.uk") → true（仅 www 差异，同站）
 *   sameSite("shop.x.co.uk", "x.co.uk") → true（子域，同站）
 */
function isSameSite(a: string, b: string): boolean {
  const x = (a || "").toLowerCase().replace(/^www\./, "");
  const y = (b || "").toLowerCase().replace(/^www\./, "");
  if (!x || !y) return true; // 无法判定时按"同站"，不触发拒切（保留原有行为）
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * 从 host 里抽取 "brand root"（去 www，去 ccTLD，返回第一个 label）
 * aerosus.nl → aerosus
 * www.aerosus.co.uk → aerosus
 * shop.example.com → example
 */
export function extractHostBrandLabel(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, "");
  const parts = h.split(".");
  if (parts.length < 2) return h;
  // 常见二级 TLD
  const lastTwo = parts.slice(-2).join(".");
  const threeLevelTlds = ["co.uk", "com.au", "co.nz", "com.sg", "com.hk", "com.br", "com.mx", "com.ar", "com.cn", "com.tw", "co.jp", "co.kr", "co.in"];
  if (threeLevelTlds.includes(lastTwo) && parts.length >= 3) {
    return parts[parts.length - 3];
  }
  return parts[parts.length - 2];
}

/**
 * 提取商家"品牌根名"：剥离末尾的国家/区域标签
 * "Aerosus NL" → "Aerosus"
 * "Acme DACH" → "Acme"
 * 无后缀或剥后 < 2 字符 → 保留原名
 */
export function extractBrandRoot(merchantName: string): string {
  if (!merchantName) return "";
  const name = merchantName.trim();
  const re = new RegExp(`\\s*[-_·|]?\\s*(${COUNTRY_SUFFIX_TOKENS.join("|")})\\s*$`, "i");
  const stripped = name.replace(re, "").trim();
  if (stripped.length >= 2 && stripped.length < name.length) {
    return stripped;
  }
  return name;
}

/**
 * 品牌自有站推定：商家品牌名与落地页注册域名主体一致 → 广告落在该品牌自己的官网上。
 * 联盟场景下给品牌官网导流用品牌词是常态（Google 只在商标持有人主动投诉限制时才按商标拒登），
 * 此时不应把品牌词当「蹭别人商标」拦截（Wellfit 实证：AI 画像默认 unauthorized 导致品牌词被误杀）。
 *
 * 归一化：小写 + 去除非字母数字（"Well-Fit US" → "wellfit"），互相包含即判定匹配：
 *   isBrandOwnDomain("Wellfit", "https://www.wellfit.com/en") → true
 *   isBrandOwnDomain("Rad Power Bikes", "https://www.rad.eu/en") → true（rad ⊆ radpowerbikes）
 *   isBrandOwnDomain("Wellfit", "https://nike.com") → false
 * 双方 token 均要求 ≥3 字符，避免过短词误配。
 */
export function isBrandOwnDomain(merchantName: string, finalUrl: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const brand = norm(extractBrandRoot(merchantName || ""));
  if (brand.length < 3) return false;
  let host = "";
  try {
    host = new URL((finalUrl || "").trim()).hostname;
  } catch {
    return false;
  }
  const hostLabel = norm(extractHostBrandLabel(host));
  if (hostLabel.length < 3) return false;
  return hostLabel === brand || hostLabel.includes(brand) || brand.includes(hostLabel);
}

/**
 * 构造候选 host：保持同品牌 label，把 TLD 换成目标国 ccTLD
 */
function buildCandidateHosts(originalHost: string, country: string): string[] {
  const up = country.toUpperCase();
  const tlds = COUNTRY_TLD_MAP[up];
  if (!tlds || tlds.length === 0) return [];
  const brand = extractHostBrandLabel(originalHost);
  if (!brand) return [];
  return tlds.map((tld) => `${brand}.${tld}`);
}

/**
 * 判定当前 host 是否已经是目标国 ccTLD（已导出供 crawl-pipeline 使用）
 *
 * 例：host="camplify.es" + country="ES" → true（.es 是西班牙 ccTLD）
 *     host="aerosus.com" + country="ES" → false（.com 是通用 TLD）
 *
 * 用途：抓取阶段决定是否需要再追加 /es/ 或 /es-es/ 子路径。
 * 已是国家 ccTLD 的站，根路径就是本地化首页，强加 /es/ 反而 404。
 */
export function hostMatchesCountryTld(host: string, country: string): boolean {
  const up = country.toUpperCase();
  const tlds = COUNTRY_TLD_MAP[up];
  if (!tlds) return false;
  const lower = host.toLowerCase().replace(/^www\./, "");
  return tlds.some((tld) => lower.endsWith(`.${tld}`));
}

// ─── DNS 探测 ────────────────────────────────────────────
async function probeDns(host: string): Promise<"ok" | "nxdomain" | "err"> {
  try {
    const ips = await Promise.race([
      dns.resolve4(host),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("dns_timeout")), DNS_TIMEOUT_MS)
      ),
    ]);
    return ips && ips.length > 0 ? "ok" : "nxdomain";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code || "";
    if (code === "ENOTFOUND" || code === "NXDOMAIN" || code === "EAI_NODATA") {
      return "nxdomain";
    }
    return "err";
  }
}

// ─── TCP 443 握手探测 ────────────────────────────────────────────
async function probeTcp(host: string): Promise<{ ok: boolean; rttMs: number; reason: "ok" | "timeout" | "err" }> {
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (reason: "ok" | "timeout" | "err") => {
      if (settled) return;
      settled = true;
      const rttMs = Date.now() - start;
      try {
        socket.destroy();
      } catch { /* ignore */ }
      resolve({ ok: reason === "ok", rttMs, reason });
    };
    socket.setTimeout(TCP_TIMEOUT_MS);
    socket.once("connect", () => finish("ok"));
    socket.once("timeout", () => finish("timeout"));
    socket.once("error", () => finish("err"));
    try {
      socket.connect(443, host);
    } catch {
      finish("err");
    }
  });
}

// ─── D-068 停放/待售页探测 ────────────────────────────────────────────
/**
 * 轻量 HTTP 校验候选 ccTLD 是否为"域名停放/待售页"。
 * 只在候选已通过 DNS+TCP（即将被切换）时调用，命中则拒绝切换。
 *
 * 判定（任一即停放）：
 *   - 最终重定向落点 host 命中已知停放/交易服务商；
 *   - 页面 <title> 或正文前 ~30KB 命中停放/待售强文本信号。
 * 任何 fetch 失败/超时 → 返回 false（无法确认 → 不阻断切换，保留原有行为）。
 */
async function probeParkedPage(host: string): Promise<{ parked: boolean; signal?: string; redirectsAway?: boolean; finalHost?: string; challenged?: boolean }> {
  // 先 https，失败（含证书过期/连接错误）回退 http —— 停放域名常证书过期且只在 http 才暴露
  // 到停放商的 302（实测 heidi.uk：https=CERT_HAS_EXPIRED，http→302 https://surname.uk/...）。
  const schemes = [`https://${host}/`, `http://${host}/`];
  let lastResp: Response | null = null;
  for (const url of schemes) {
    try {
      const resp = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(PARKED_PROBE_TIMEOUT_MS),
        headers: { "User-Agent": BROWSER_UA_RESOLVER, Accept: "text/html,application/xhtml+xml" },
      });
      lastResp = resp;

      // 1. 重定向落点命中停放/交易服务商
      const finalHost = (() => {
        try { return new URL(resp.url).hostname.toLowerCase(); } catch { return ""; }
      })();
      const providerHit = PARKING_PROVIDER_HOSTS.find(
        (p) => finalHost.includes(p) || resp.url.toLowerCase().includes(p),
      );
      if (providerHit) return { parked: true, signal: `provider:${providerHit}` };

      // D08-A：候选 ccTLD 跟随重定向后落到"非自身站点"（典型：301 回跳 canonical，如
      // wildbounds.co.uk → wildbounds.com）→ 该 ccTLD 不是独立本地店，只是转址壳。
      // 切到它会：① 落地页多一跳重定向；② SemRush/sitelinks 查转址站取不到数据。
      // 故判定"非本地店"，由调用方拒绝切换、保留商家原域名。
      if (finalHost && !isSameSite(finalHost, host)) {
        return { parked: false, redirectsAway: true, finalHost };
      }

      // 读取 body 一次（供「机器人挑战墙检测」+「停放文本检测」复用）
      const cfMitig = (resp.headers.get("cf-mitigated") || "").toLowerCase();
      let raw = "";
      try { raw = (await resp.text()).slice(0, 30000); } catch { raw = ""; }

      // BUG-09：候选 ccTLD 处于「主动机器人挑战墙」（Cloudflare cf-mitigated:challenge /
      // Incapsula JS 挑战）→ 连隐身 Puppeteer 也过不去，切到它必然爬空（pageText=0 → L2 上下文
      // 不足 → 文案全无）。实证 ukbreakaways.uk=CF 403 challenge、www.ukbreakaways.com=Incapsula。
      // 这类候选不是「可用的本地站」，拒绝切换、保留商家原域名（原域名至少不是更差，常更可爬）。
      // 注意：仅命中「主动挑战」信号才拒切；普通 403 WAF（无挑战）仍按原逻辑视为站点真实、允许切换。
      const challenged =
        cfMitig.includes("challenge") ||
        /_Incapsula_Resource|Incapsula incident|\/_Incapsula_/i.test(raw) ||
        /cf-browser-verification|challenge-platform|__cf_chl_|cf_chl_opt|Just a moment\b/i.test(raw);
      if (challenged) {
        return { parked: false, challenged: true };
      }

      if (!resp.ok && resp.status !== 403 && resp.status !== 406) {
        continue; // 该 scheme 不可用，试下一个
      }

      // 2. 文本信号（只读前 ~30KB，足够覆盖 title + 首屏）
      for (const re of PARKED_TEXT_SIGNALS) {
        if (re.test(raw)) return { parked: true, signal: re.source.slice(0, 40) };
      }
      return { parked: false }; // 成功取到正常页面 → 非停放
    } catch {
      // 本 scheme 失败（证书过期/连接/超时）→ 试下一个 scheme
      continue;
    }
  }
  void lastResp;
  // 两种 scheme 都没拿到可判定内容 → 无法确认，不阻断切换
  return { parked: false };
}

// ─── 主入口 ────────────────────────────────────────────

/**
 * 根据投放国解析最终落地页 URL + 品牌根名
 *
 * 规则：
 * 1. 当前 URL 已是目标国 ccTLD → same_tld（不切）
 * 2. 候选 ccTLD DNS + TCP 都通 → cc_tld_ok（切）
 * 3. 候选 ccTLD DNS NXDOMAIN → nxdomain（不切，保留原 URL）
 * 4. DNS 通但 TCP 超时 → tcp_timeout（不切，短 TTL 下次重试）
 */
export async function resolveCountryUrl(merchantUrl: string, country: string): Promise<ResolveResult> {
  // 兜底：无效输入直接返回
  if (!merchantUrl || !country) {
    return {
      finalUrl: merchantUrl || "",
      brandRoot: "",
      switched: false,
      reason: "invalid_input",
      probeLog: [],
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(merchantUrl);
  } catch {
    return {
      finalUrl: merchantUrl,
      brandRoot: "",
      switched: false,
      reason: "invalid_input",
      probeLog: [],
    };
  }

  const originalHost = parsed.hostname;
  const brandRoot = extractHostBrandLabel(originalHost);

  const cacheKey = `${originalHost}|${country.toUpperCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const probeLog: ProbeLogEntry[] = [];

  // 1. 已是目标国 ccTLD → same_tld
  if (hostMatchesCountryTld(originalHost, country)) {
    const result: ResolveResult = {
      finalUrl: merchantUrl,
      brandRoot,
      switched: false,
      reason: "same_tld",
      probeLog: [{ host: originalHost, dns: "ok", tcp: "skipped" }],
    };
    cacheSet(cacheKey, result);
    return result;
  }

  // 1.5 D-053：原站使用品牌通用/虚荣 TLD（.tv/.io/.ai/.app/.fm…）→ 视为品牌主域名，禁止切换。
  // 修复 trybinge.tv→trybinge.com、resume.io→resume.com 等把落地页改成无关 .com 站的系统性误切。
  if (originalTldNonLocalizable(originalHost)) {
    const result: ResolveResult = {
      finalUrl: merchantUrl,
      brandRoot,
      switched: false,
      reason: "same_tld",
      probeLog: [{ host: originalHost, dns: "skipped" as "ok", tcp: "skipped" }],
    };
    cacheSet(cacheKey, result);
    return result;
  }

  // 2. 构造候选 host
  const candidates = buildCandidateHosts(originalHost, country);
  if (candidates.length === 0) {
    const result: ResolveResult = {
      finalUrl: merchantUrl,
      brandRoot,
      switched: false,
      reason: "same_tld",
      probeLog: [{ host: originalHost, dns: "skipped" as "ok", tcp: "skipped" }],
    };
    cacheSet(cacheKey, result);
    return result;
  }

  // 3. 逐个候选探测
  let sawNxdomain = false;
  let sawTcpTimeout = false;
  let sawParked = false;
  let sawRedirectAway = false;
  let sawChallenged = false;
  for (const candidateHost of candidates) {
    const dnsResult = await probeDns(candidateHost);
    if (dnsResult === "nxdomain" || dnsResult === "err") {
      probeLog.push({ host: candidateHost, dns: dnsResult, tcp: "skipped" });
      if (dnsResult === "nxdomain") sawNxdomain = true;
      continue;
    }
    const tcpResult = await probeTcp(candidateHost);
    probeLog.push({
      host: candidateHost,
      dns: "ok",
      tcp: tcpResult.reason,
      rttMs: tcpResult.rttMs,
    });
    if (tcpResult.ok) {
      // D-068：切换前校验候选是否为停放/待售页。命中则**拒绝切换**，保留商家真实域名。
      const parkedCheck = await probeParkedPage(candidateHost);
      if (parkedCheck.parked) {
        sawParked = true;
        console.warn(
          `[CountryUrlResolver] D-068 候选 ${candidateHost} 疑似域名停放/待售页（信号=${parkedCheck.signal}），拒绝 ccTLD 切换，保留 ${originalHost}`,
        );
        probeLog.push({ host: candidateHost, dns: "ok", tcp: "ok", error: `parked:${parkedCheck.signal}` });
        continue; // 试下一个候选；都停放则不切换
      }
      // D08-A：候选 301 跳出到非自身站点（典型回跳 canonical .com）→ 非独立本地店，拒绝切换。
      if (parkedCheck.redirectsAway) {
        sawRedirectAway = true;
        console.warn(
          `[CountryUrlResolver] D08-A 候选 ${candidateHost} 跟随重定向落到 ${parkedCheck.finalHost}（非独立本地站，疑似回跳 canonical），拒绝 ccTLD 切换，保留 ${originalHost}`,
        );
        probeLog.push({ host: candidateHost, dns: "ok", tcp: "ok", error: `redirects_away:${parkedCheck.finalHost}` });
        continue; // 试下一个候选；都回跳则不切换
      }
      // BUG-09：候选处于「主动机器人挑战墙」(Cloudflare cf-mitigated:challenge / Incapsula JS 挑战)
      //   → 连隐身 Puppeteer 也过不去，切到它必然爬空（pageText=0 → 文案全无）。拒绝切换，保留商家原域名。
      if (parkedCheck.challenged) {
        sawChallenged = true;
        console.warn(
          `[CountryUrlResolver] BUG-09 候选 ${candidateHost} 命中主动机器人挑战墙（Cloudflare/Incapsula challenge），切过去必爬空，拒绝 ccTLD 切换，保留 ${originalHost}`,
        );
        probeLog.push({ host: candidateHost, dns: "ok", tcp: "ok", error: "challenged" });
        continue; // 试下一个候选；都被挑战则不切换
      }
      // 切 URL：保留 path/query/hash，只换 host
      const newUrl = new URL(merchantUrl);
      newUrl.hostname = candidateHost;
      const result: ResolveResult = {
        finalUrl: newUrl.toString(),
        brandRoot,
        switched: newUrl.toString() !== merchantUrl,
        reason: "cc_tld_ok",
        probeLog,
      };
      cacheSet(cacheKey, result);
      return result;
    }
    if (tcpResult.reason === "timeout") sawTcpTimeout = true;
  }

  // 4. 全部候选都没通
  const reason: ResolveResult["reason"] = sawChallenged
    ? "cc_tld_challenged"
    : sawRedirectAway
    ? "cc_tld_redirects_away"
    : sawParked
    ? "cc_tld_parked"
    : sawNxdomain && !sawTcpTimeout ? "nxdomain" : "tcp_timeout";
  const result: ResolveResult = {
    finalUrl: merchantUrl,
    brandRoot,
    switched: false,
    reason,
    probeLog,
  };
  cacheSet(cacheKey, result);
  return result;
}

/**
 * 测试用：清空 LRU cache
 */
export function clearResolverCache() {
  cache.clear();
}
