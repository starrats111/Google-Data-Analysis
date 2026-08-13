/**
 * 品牌词抽取：从一个 domain / URL / 显示链接里拿"主品牌 token"。
 *
 * 规则（和 Python `extract_brand_name` 对齐）：
 *   1. 剥 protocol（`https?://`）和可能的前置空白
 *   2. 剥 path / query / fragment（只留 host）
 *   3. 剥前缀 `www.`
 *   4. 去掉 TLD 后缀（含常见 2 级 TLD 如 `.co.uk`, `.com.br` 等）
 *   5. 取剩下最后一个 label
 *   6. 小写
 *
 * 典型用法：`_isBrandOwnUrl` 用它做两侧比对，避免把
 * `macys.com/nike` 误判成 brand 自己的广告。
 */

const MULTI_LEVEL_TLDS: readonly string[] = [
  ".co.uk",
  ".org.uk",
  ".ac.uk",
  ".com.br",
  ".com.au",
  ".com.mx",
  ".com.ar",
  ".com.cn",
  ".com.hk",
  ".com.tw",
  ".co.jp",
  ".ne.jp",
  ".or.jp",
  ".co.in",
  ".co.nz",
  ".co.kr",
];

const SINGLE_LEVEL_TLDS: readonly string[] = [
  ".com",
  ".net",
  ".org",
  ".io",
  ".co",
  ".us",
  ".uk",
  ".ca",
  ".au",
  ".de",
  ".fr",
  ".it",
  ".es",
  ".jp",
  ".br",
  ".mx",
  ".in",
  ".app",
  ".shop",
  ".store",
  ".biz",
  ".info",
  ".tv",
  ".xyz",
  ".dev",
  ".ai",
];

function stripSuffix(host: string): string {
  for (const tld of MULTI_LEVEL_TLDS) {
    if (host.endsWith(tld)) {
      return host.slice(0, -tld.length);
    }
  }
  for (const tld of SINGLE_LEVEL_TLDS) {
    if (host.endsWith(tld)) {
      return host.slice(0, -tld.length);
    }
  }
  const lastDot = host.lastIndexOf(".");
  return lastDot > 0 ? host.slice(0, lastDot) : host;
}

export function extractBrandName(input: string): string {
  if (!input) return "";
  let s = String(input).trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.split("/")[0] ?? "";
  s = s.split("?")[0] ?? "";
  s = s.split("#")[0] ?? "";
  s = s.split(" ")[0] ?? "";
  s = s.replace(/^www\./, "");
  if (!s) return "";

  const withoutSuffix = stripSuffix(s);
  if (!withoutSuffix) return "";

  const labels = withoutSuffix.split(".").filter(Boolean);
  return labels.length > 0 ? labels[labels.length - 1]! : "";
}

/**
 * 判断一个展示 URL 是否就是品牌自家的（用于区分 brand_own_ads vs non_brand_ads）。
 * 两侧都用 `extractBrandName` 拿 token 做精确比对。
 */
export function isBrandOwnUrl(
  displayedUrl: string | null | undefined,
  brandDomain: string,
): boolean {
  if (!displayedUrl) return false;
  const a = extractBrandName(displayedUrl);
  const b = extractBrandName(brandDomain);
  if (!a || !b) return false;
  return a === b;
}
