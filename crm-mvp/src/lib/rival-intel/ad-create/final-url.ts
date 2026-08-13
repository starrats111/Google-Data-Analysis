export function splitFinalUrlForPublish(
  rawFinalUrl: string | null | undefined,
  rawFinalUrlSuffix: string | null | undefined = "",
): { finalUrl: string; finalUrlSuffix: string } {
  const finalUrl = rawFinalUrl?.trim() ?? "";
  const existingSuffix = normalizeFinalUrlSuffix(rawFinalUrlSuffix);
  const queryIndex = finalUrl.indexOf("?");

  if (queryIndex < 0) {
    return { finalUrl, finalUrlSuffix: existingSuffix };
  }

  const baseFinalUrl = finalUrl.slice(0, queryIndex);
  const extractedSuffix = normalizeFinalUrlSuffix(finalUrl.slice(queryIndex + 1));
  const finalUrlSuffix = [extractedSuffix, existingSuffix].filter(Boolean).join("&");

  return { finalUrl: baseFinalUrl, finalUrlSuffix };
}

export function normalizeFinalUrlSuffix(rawFinalUrlSuffix: string | null | undefined): string {
  return (rawFinalUrlSuffix ?? "").trim().replace(/^[?&]+/, "");
}

export function buildPublishDefaultFinalUrlFields(
  domain: string,
  landingPageUrl?: string | null,
): { finalUrl: string; finalUrlSuffix: string } {
  const verifiedUrl = landingPageUrl?.trim();
  if (verifiedUrl) return splitFinalUrlForPublish(verifiedUrl);

  const bare = domain.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return splitFinalUrlForPublish(`https://www.${bare}`);
}

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
