/**
 * 竞品情报引擎的域名推导工具。
 *
 * D-365：本文件原先还有三个从 kyads 搬来的导出 ——
 *   `splitFinalUrlForPublish()` / `normalizeFinalUrlSuffix()` / `buildPublishDefaultFinalUrlFields()`
 * 它们把 `final_url` 的 query 串拆出来当 `finalUrlSuffix`，是 kyads 自有发布器的做法。
 * D-233 把竞品引擎收敛成「只做生成、发布走 CRM 的 submit」之后这条路就没人走了，
 * 三个函数**只互相调用、全仓零外部引用**，已删除（01 拍板）。
 *
 * 为什么删了也不影响后缀：真正的追踪串来自联盟链巡航（submit 的 D-101 闸拿
 * `cruise.trackingLink`），不来自 `final_url` —— 领取商家时 `final_url` 存的是
 * `merchant_url`（干净落地页，见 merchants/route.ts 的 finalUrl 推导），从它拆不出追踪串。
 * 所以这几个函数即便接上也治不了 D-365，是错的修复方向。
 */

const TWO_LEVEL_PUBLIC_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "com.cn",
  "com.hk",
  "com.tw",
  "co.jp",
  "co.kr",
  "com.au",
  "co.nz",
  "co.in",
  "com.br",
  "com.sg",
  "com.my",
  "co.th",
  "com.vn",
  "co.id",
  "com.ph",
  "com.mx",
  "com.ar",
]);

const HOST_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isValidDomainHost(host: string): boolean {
  if (IPV4_PATTERN.test(host) || host.includes(":")) return false;

  const labels = host.split(".");
  return labels.length >= 2 && labels.every((label) => HOST_LABEL_PATTERN.test(label));
}

export function deriveRootDomainFromFinalUrl(rawFinalUrl: string | null | undefined): string | null {
  const finalUrl = rawFinalUrl?.trim();
  if (!finalUrl) return null;

  let host: string;
  try {
    const parsed = new URL(finalUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }

  const normalizedHost = host.startsWith("www.") ? host.slice(4) : host;
  if (!isValidDomainHost(normalizedHost)) return null;

  const labels = normalizedHost.split(".");
  const suffix = labels.slice(-2).join(".");
  if (TWO_LEVEL_PUBLIC_SUFFIXES.has(suffix)) {
    return labels.length >= 3 ? labels.slice(-3).join(".") : null;
  }

  return labels.slice(-2).join(".");
}
