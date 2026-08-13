import { truncateToGoogleAdsLength } from "./text-length";

export const MAX_SITELINK_LINK_TEXT = 25;
export const MAX_SITELINK_DESCRIPTION = 35;
export const MAX_SITELINK_COUNT = 6;

export interface DraftSitelink {
  linkText: string;
  finalUrl: string;
  description1?: string;
  description2?: string;
  sourceType?: string;
  sourceTitle?: string;
}

export interface SitelinkCandidate {
  finalUrl: string;
  sourceTitle?: string;
  sourceType?: string;
}

const BLACKLIST_KEYWORDS = [
  "about",
  "privacy",
  "terms",
  "login",
  "sign in",
  "sign-in",
  "register",
  "cart",
  "checkout",
  "account",
  "policy",
];

function normalizeAllCapsLatinText(text: string): string {
  const letters = text.match(/[A-Za-z]/g) ?? [];
  if (letters.length < 4) return text;
  if (/[a-z]/.test(text)) return text;
  return text.toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

function cleanSitelinkText(text: string): string {
  return normalizeAllCapsLatinText(
    text
      .replace(/[!！]+/g, "")
      .replace(/[?？]{2,}/g, "?")
      .replace(/[-=]+>/g, " ")
      .replace(/[→⇒➜➔➝↗↘↙↖]/g, " ")
      .replace(/([?.,;:])\1+/g, "$1")
      .replace(/\s+/g, " ")
      .replace(/\s+([?.,;:])/g, "$1")
      .trim()
      .replace(/[?.,;:，。；：、-]+$/g, "")
      .trim(),
  );
}

function truncate(text: string | undefined, limit: number): string | undefined {
  const clean = (text || "").trim();
  if (!clean) return undefined;
  // 使用 Google Ads 长度规则（CJK/全角按 2）截断，避免 sitelink 中含
  // 韩/中/日文时被 "Too long" 拒登。
  const editorialClean = cleanSitelinkText(clean);
  if (!editorialClean) return undefined;
  return cleanSitelinkText(truncateToGoogleAdsLength(editorialClean, limit, true));
}

export function normalizeSitelinkUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return rawUrl.trim().replace(/\/$/, "");
  }
}

function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

function isBlacklisted(text: string): boolean {
  const normalized = text.toLowerCase();
  return BLACKLIST_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function sameRootHost(domainOrUrl: string, finalUrl: string): boolean {
  try {
    const rootHost = canonicalHost(
      new URL(domainOrUrl.startsWith("http") ? domainOrUrl : `https://${domainOrUrl}`).host,
    );
    const urlHost = canonicalHost(new URL(finalUrl).host);
    return rootHost === urlHost;
  } catch {
    return false;
  }
}

export interface EnforceSitelinkUrlPoolOptions {
  domainOrUrl: string;
  validUrlPool?: Array<string | { url?: string; finalUrl?: string }>;
  requirePoolMembership?: boolean;
}

/**
 * 强制 sitelink URL 只能落在当前站点和已验证 URL 池内。
 * AI 生成模式把 `requirePoolMembership` 设为 true，避免模型编造 404 URL。
 */
export function enforceSitelinkUrlPool<T extends DraftSitelink>(
  items: T[],
  options: EnforceSitelinkUrlPoolOptions,
): T[] {
  const pool = new Set(
    (options.validUrlPool ?? [])
      .map((item) => {
        if (typeof item === "string") return item;
        return item.finalUrl || item.url || "";
      })
      .map(normalizeSitelinkUrl)
      .filter(Boolean),
  );

  const filtered: T[] = [];
  for (const item of items) {
    const finalUrl = normalizeSitelinkUrl(item.finalUrl);
    if (!finalUrl || !sameRootHost(options.domainOrUrl, finalUrl)) continue;
    if (options.requirePoolMembership && !pool.has(finalUrl)) continue;
    filtered.push({ ...item, finalUrl });
  }

  return filtered;
}

export function sanitizeSitelinks(items: DraftSitelink[]): DraftSitelink[] {
  const seenUrls = new Set<string>();
  const sanitized: DraftSitelink[] = [];

  for (const item of items) {
    const finalUrl = normalizeSitelinkUrl(item.finalUrl);
    const linkText = truncate(item.linkText, MAX_SITELINK_LINK_TEXT);
    if (!finalUrl || !linkText || seenUrls.has(finalUrl)) continue;

    const description1 = truncate(item.description1, MAX_SITELINK_DESCRIPTION);
    const description2 = truncate(item.description2, MAX_SITELINK_DESCRIPTION);
    const hasDescriptionPair = !!description1 && !!description2;

    seenUrls.add(finalUrl);
    sanitized.push({
      linkText,
      finalUrl,
      description1: hasDescriptionPair ? description1 : undefined,
      description2: hasDescriptionPair ? description2 : undefined,
      sourceType: item.sourceType?.trim() || undefined,
      sourceTitle: item.sourceTitle?.trim() || undefined,
    });

    if (sanitized.length >= MAX_SITELINK_COUNT) break;
  }

  return sanitized;
}

export function filterSitelinkCandidates(
  domainOrUrl: string,
  candidates: SitelinkCandidate[],
): SitelinkCandidate[] {
  let rootHost = "";
  try {
    rootHost = canonicalHost(new URL(domainOrUrl.startsWith("http") ? domainOrUrl : `https://${domainOrUrl}`).host);
  } catch {
    return [];
  }

  const seenUrls = new Set<string>();
  const filtered: SitelinkCandidate[] = [];

  for (const candidate of candidates) {
    const finalUrl = normalizeSitelinkUrl(candidate.finalUrl);
    if (!finalUrl || seenUrls.has(finalUrl)) continue;

    let host = "";
    let path = "";
    try {
      const url = new URL(finalUrl);
      host = canonicalHost(url.host);
      path = `${url.pathname}${url.search}`.toLowerCase();
    } catch {
      continue;
    }

    const sourceTitle = candidate.sourceTitle?.trim() || "";
    if (host !== rootHost) continue;
    if (isBlacklisted(path) || isBlacklisted(sourceTitle)) continue;

    seenUrls.add(finalUrl);
    filtered.push({
      finalUrl,
      sourceTitle: sourceTitle || undefined,
      sourceType: candidate.sourceType?.trim() || undefined,
    });
  }

  return filtered;
}
