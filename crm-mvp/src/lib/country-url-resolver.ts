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
  reason: "cc_tld_ok" | "same_tld" | "nxdomain" | "tcp_timeout" | "invalid_input";
  probeLog: ProbeLogEntry[];
}

const DNS_TIMEOUT_MS = 3000;
const TCP_TIMEOUT_MS = 3000;

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

const MAX_CACHE_ENTRIES = 500;
const cache = new Map<string, CacheEntry>();

function cacheSet(key: string, result: ResolveResult) {
  let ttlMs: number;
  switch (result.reason) {
    case "cc_tld_ok":
    case "same_tld":
      ttlMs = 60 * 60 * 1000; // 60m
      break;
    case "nxdomain":
      ttlMs = 30 * 60 * 1000; // 30m
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
 * 从 host 里抽取 "brand root"（去 www，去 ccTLD，返回第一个 label）
 * aerosus.nl → aerosus
 * www.aerosus.co.uk → aerosus
 * shop.example.com → example
 */
function extractHostBrandLabel(host: string): string {
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
 * 判定当前 host 是否已经是目标国 ccTLD
 */
function hostMatchesCountryTld(host: string, country: string): boolean {
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
  const reason: ResolveResult["reason"] = sawNxdomain && !sawTcpTimeout ? "nxdomain" : "tcp_timeout";
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
