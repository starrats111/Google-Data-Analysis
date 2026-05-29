/**
 * D-039 H3 — Google Ads 政策本地后置校验器
 *
 * 用于 generate-extensions 拿到 AI 输出后立即做正则后置校验：
 *   1. 检测不公平优势字词、惊悚/不当内容、电话号码、过度大写、品牌名泄漏
 *   2. 按行业 IndustryProfile.extraBannedTerms 叠加额外检测
 *   3. 输出结构化 violations[] 给 AI 重写循环（H3）或提交前 final gate（H4）
 *   4. 严重违规 (critical) → block；轻微 (minor) → warn 仅记录
 *
 * 与既有 ai-rule-profile.collectGooglePolicyViolations 并存：
 *   - 既有函数主要查 ABSOLUTE_CLAIM / FORMAT_VIOLATION（已部署）
 *   - 本函数补充 H1/H2 新增的字词级 + 行业级规则
 */

import { getIndustryBannedTerms, type IndustryProfile } from "@/lib/industry-profile";

export type ViolationSeverity = "critical" | "minor";

export interface ComplianceViolation {
  field: "headline" | "description" | "callout";
  index: number;
  text: string;
  rule: string;
  severity: ViolationSeverity;
  hint: string;
  matchedTerm?: string;
}

export interface ComplianceCheckOptions {
  industryProfile?: IndustryProfile | null;
  merchantName?: string | null;
}

export interface ComplianceCheckResult {
  valid: boolean;
  violations: ComplianceViolation[];
  criticalCount: number;
  minorCount: number;
}

// Rule 9 不公平优势字词（D-039 H1 NON-NEGOTIABLE RULES 9 落地检测）
// 注意：这里只保留「无论是否有出处都不该出现」的硬违规词。
// 「最高级/奖项」类（best / bestseller / awarded / #1 / award-winning ...）已迁移到
// 下方 SUPERLATIVE_AWARD_TERMS 做「证据感知」判定（C-118）—— 有具体年份/出处可降级放行。
const UNFAIR_ADVANTAGE_TERMS: Array<{ term: string; severity: ViolationSeverity }> = [
  { term: "trusted by millions", severity: "critical" },
  { term: "guaranteed results", severity: "critical" },
  { term: "guarantee results", severity: "critical" },
  { term: "100% effective", severity: "critical" },
  { term: "100% safe", severity: "critical" },
  { term: "never fail", severity: "critical" },
  { term: "stops all", severity: "critical" },
  { term: "stops every", severity: "critical" },
  { term: "stops forever", severity: "critical" },
  { term: "stop all", severity: "critical" },
  { term: "industry leader", severity: "critical" },
  { term: "skip other apps", severity: "critical" },
  { term: "skip juggling", severity: "critical" },
  { term: "better than competitors", severity: "critical" },
  { term: "better than other", severity: "critical" },
  { term: "sick of other", severity: "critical" },
  { term: "tired of other", severity: "critical" },
  { term: "beat every other", severity: "critical" },
  { term: "guaranteed", severity: "minor" },
];

// C-118 证据感知「最高级 / 奖项」声明检测：
//   - 这些词若【裸用】(无具体年份/出处) → critical（Google Ads 判 unverifiable unfair advantage，必须重写）
//   - 若同句含具体年份(19xx/20xx) 视为有第三方出处线索 → 降为 minor（放行，例 "2025 Beauty Shortlist Winner"）
// 07 铁律：真实有依据的奖项要保留（有文采），无依据的裸最高级要避障。
const SUPERLATIVE_AWARD_TERMS = [
  "best seller",
  "best-seller",
  "bestseller",
  "best brand",
  "best natural",
  "best in class",
  "best-in-class",
  "award-winning",
  "award winning",
  "award winner",
  "awarded",
  "awards won",
  "voted #1",
  "voted no",
  "top-rated",
  "top rated",
  "#1",
  "no.1",
  "no. 1",
  "number one",
  "ranked #1",
  "world's best",
  "worlds best",
  "world's #1",
];

// 含 4 位年份视为「有具体出处线索」(奖项年份)，最高级声明可由 critical 降为 minor 放行
const YEAR_HINT_RE = /\b(19|20)\d{2}\b/;

// 词级匹配：字母首/尾自动加 \b 词边界，避免 "awarded" 误伤 "rewarded"；含符号词(#1)用裸匹配
function matchesTerm(text: string, term: string): boolean {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = /^[a-z0-9]/i.test(term) ? "\\b" : "";
  const tail = /[a-z0-9]$/i.test(term) ? "\\b" : "";
  try {
    return new RegExp(`${head}${esc}${tail}`, "i").test(text);
  } catch {
    return text.toLowerCase().includes(term.toLowerCase());
  }
}

// Rule 11 不当内容字词（critical 全部）
const INAPPROPRIATE_TERMS = [
  "spooky", "scary", "demon", "demonic", "blood", "bloody",
  "horror", "nightmare", "creepy", "sinister",
  "kill", "killing", "dead", "death", "violence", "violent",
  "hacked", "hacking", "hacker",
  "phone hacked", "iphone hacked", "device hacked",
  "sick of", "tired of",
];

// Rule 12 电话号码模式（critical 全部）
const PHONE_PATTERNS: RegExp[] = [
  /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/,
  /\b\(\s*\d{3}\s*\)\s*\d{3}[-.\s]?\d{4}\b/,
  /\b1[-\s]?8(?:00|33|44|55|66|77|88)[-\s]?\d{3}[-\s]?\d{4}\b/,
  /\+\d{1,3}[\s-]\d{2,4}[\s-]\d{3,4}[\s-]\d{3,4}/,
];

// Rule 8 大写白名单（≤4 字母的常见 acronym + 部分较长的通用 acronym）
const ACRONYM_WHITELIST = new Set([
  "USA", "UK", "US", "MX", "MXN", "USD", "EUR", "GBP", "AUD", "CAD", "NZD", "JPY", "KRW",
  "VPN", "AI", "ML", "SEO", "HQ", "OEM", "GPS", "LED", "USB", "PDF", "HTML", "CSS", "JS", "AWS",
  "CEO", "CFO", "CTO", "COO", "HR", "API", "FAQ", "CTA", "CRM", "ERP", "TV", "DVD", "DJ", "MC",
  "DIY", "UV", "LCD", "OLED", "ATM", "PIN", "VIP", "ID", "OK", "TL", "DR",
]);

function detectAllCapsOveruse(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const allCaps = words.filter((w) => {
    const cleaned = w.replace(/[^A-Za-z]/g, "");
    if (cleaned.length < 2) return false;
    if (ACRONYM_WHITELIST.has(cleaned.toUpperCase())) return false;
    return cleaned === cleaned.toUpperCase() && cleaned.length >= 2;
  });
  return allCaps.length / words.length > 0.3;
}

function brandRootToken(merchantName: string): string | null {
  if (!merchantName) return null;
  const lower = merchantName.toLowerCase();
  const cleaned = lower
    .replace(/[-—–.,!?'"&/\\]+/g, " ")
    .replace(/\b(inc|llc|ltd|gmbh|s\.a\.|co|co\.|corp|corporation|group|store|shop|online|com|net|org)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter((t) => t.length >= 3);
  return tokens[0] ?? null;
}

function checkOne(
  text: string,
  field: ComplianceViolation["field"],
  idx: number,
  options: ComplianceCheckOptions,
  industryBanned: string[],
  brandToken: string | null,
): ComplianceViolation[] {
  const out: ComplianceViolation[] = [];
  if (!text || text.trim().length < 2) return out;
  const lower = text.toLowerCase();

  // C-118: 证据感知最高级/奖项检测（优先于通用 unfair-advantage 检测）
  const hasYearHint = YEAR_HINT_RE.test(text);
  for (const term of SUPERLATIVE_AWARD_TERMS) {
    if (matchesTerm(text, term)) {
      out.push({
        field,
        index: idx,
        text,
        rule: `superlative_award:${term}`,
        severity: hasYearHint ? "minor" : "critical",
        matchedTerm: term,
        hint: hasYearHint
          ? `Superlative/award "${term}" appears with a year — only keep it if it cites a SPECIFIC named award/issuer (e.g. "2025 Beauty Shortlist Winner"). Otherwise replace with a concrete product benefit.`
          : `Bare superlative/award claim "${term}" is unverifiable and triggers Google Ads "unfair advantage" disapproval. Replace it: if evidence has a real named award/cert, cite it specifically with issuer/year (e.g. "2025 Beauty Shortlist Winner", "Demeter Certified Organic"); otherwise use a concrete, verifiable product fact.`,
      });
      return out;
    }
  }

  for (const { term, severity } of UNFAIR_ADVANTAGE_TERMS) {
    if (lower.includes(term)) {
      out.push({
        field,
        index: idx,
        text,
        rule: `unfair_advantage:${term.trim()}`,
        severity,
        matchedTerm: term.trim(),
        hint: `Replace unfair-advantage phrase "${term.trim()}" with a specific, verifiable benefit (e.g. "Loved by 2,700+ verified buyers" instead of "Trusted by Millions"). If you cannot verify it from the merchant website, drop the claim entirely.`,
      });
      return out;
    }
  }

  for (const term of INAPPROPRIATE_TERMS) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) {
      out.push({
        field,
        index: idx,
        text,
        rule: `inappropriate:${term}`,
        severity: "critical",
        matchedTerm: term,
        hint: `Replace inappropriate-content term "${term}" with a neutral alternative (Themed/Decorative for Halloween; Device Protection/Privacy Tools for Security). NEVER use scare/shock language even for horror/security merchants.`,
      });
      return out;
    }
  }

  for (const term of industryBanned) {
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(text)) {
      out.push({
        field,
        index: idx,
        text,
        rule: `industry_banned:${term}`,
        severity: "critical",
        matchedTerm: term,
        hint: `Industry "${options.industryProfile?.label ?? "high-sensitive"}" bans the term "${term}". Use the neutral alternative provided in the industry profile.`,
      });
      return out;
    }
  }

  for (const re of PHONE_PATTERNS) {
    if (re.test(text)) {
      out.push({
        field,
        index: idx,
        text,
        rule: "phone_number",
        severity: "critical",
        hint: "Remove the phone number from headline/description. Phone numbers belong in Call Extensions only.",
      });
      return out;
    }
  }

  if (field === "headline" && detectAllCapsOveruse(text)) {
    out.push({
      field,
      index: idx,
      text,
      rule: "excessive_caps",
      severity: "minor",
      hint: "Reduce ALL-CAPS words to ≤30% of headline. Only short acronyms (USA, VPN, MXN, USD) may remain ALL CAPS; other words must be Title Case.",
    });
    return out;
  }

  if (brandToken && lower.includes(brandToken)) {
    out.push({
      field,
      index: idx,
      text,
      rule: "trademark_leak",
      severity: "critical",
      matchedTerm: brandToken,
      hint: `Remove the merchant brand name "${options.merchantName ?? brandToken}". This system runs in an affiliate marketing context — using the merchant's trademark violates Google Ads trademark policy. Use functional/category language instead.`,
    });
    return out;
  }

  return out;
}

/** 主 API：检测一组 headlines + descriptions（可选 callouts） */
export function checkAdCompliance(
  headlines: string[],
  descriptions: string[],
  options: ComplianceCheckOptions = {},
  callouts: string[] = [],
): ComplianceCheckResult {
  const industryBanned = getIndustryBannedTerms(options.industryProfile ?? null);
  const brandToken = brandRootToken(options.merchantName ?? "");
  const violations: ComplianceViolation[] = [];

  headlines.forEach((h, i) => {
    violations.push(...checkOne(h, "headline", i, options, industryBanned, brandToken));
  });
  descriptions.forEach((d, i) => {
    violations.push(...checkOne(d, "description", i, options, industryBanned, brandToken));
  });
  callouts.forEach((c, i) => {
    violations.push(...checkOne(c, "callout", i, options, industryBanned, brandToken));
  });

  const criticalCount = violations.filter((v) => v.severity === "critical").length;
  const minorCount = violations.filter((v) => v.severity === "minor").length;
  return {
    valid: criticalCount === 0 && minorCount === 0,
    violations,
    criticalCount,
    minorCount,
  };
}

/** 仅返回严重违规 — H4 final gate 使用 */
export function getCriticalViolations(result: ComplianceCheckResult): ComplianceViolation[] {
  return result.violations.filter((v) => v.severity === "critical");
}

/** 构造 AI 重写 prompt — H3 retry loop 使用 */
export function buildRewritePrompt(
  violations: ComplianceViolation[],
  merchantName: string,
  industryLabel?: string | null,
): string {
  const grouped = violations.reduce<Record<string, ComplianceViolation[]>>((acc, v) => {
    if (!acc[v.field]) acc[v.field] = [];
    acc[v.field].push(v);
    return acc;
  }, {});

  const parts: string[] = [
    `The following ad copy lines violated Google Ads policies and must be rewritten.`,
    `Merchant: ${merchantName}${industryLabel ? ` (Industry: ${industryLabel})` : ""}.`,
    "",
    "ABSOLUTE RULES (MUST follow when rewriting):",
    "  · NO phone numbers anywhere in headlines/descriptions",
    "  · NO unfair-advantage claims (Trusted by Millions, Award-Winning, Best-in-Class, Guaranteed, #1, Stops All)",
    "  · NO inappropriate content (Spooky, Scary, Demon, Hacked, Sick of, Tired of, Violence)",
    "  · NO brand name leakage — describe what the merchant SELLS, not its name",
    "  · NO excessive ALL CAPS (>30% of words). Only ≤4-letter acronyms (USA, VPN, MXN) can stay ALL CAPS",
    "  · USE specific, verifiable facts (real review counts, real prices on site, real product features)",
    "",
    "Rewrite ONLY the violating lines below. Keep the same character limits (headlines ≤30 chars, descriptions ≤90 chars).",
    "",
  ];
  for (const field of ["headline", "description", "callout"] as const) {
    const items = grouped[field];
    if (!items?.length) continue;
    parts.push(`${field.toUpperCase()}S to rewrite:`);
    for (const v of items) {
      parts.push(`  [${field}#${v.index}] "${v.text}"`);
      parts.push(`    Violation: ${v.rule}${v.matchedTerm ? ` (matched: "${v.matchedTerm}")` : ""}`);
      parts.push(`    Fix: ${v.hint}`);
    }
    parts.push("");
  }
  parts.push("Return ONLY a valid JSON object in this exact format (omit fields with no fixes):");
  parts.push('{');
  parts.push('  "headlines":    { "0": "new text", "5": "new text", ... },');
  parts.push('  "descriptions": { "1": "new text", ... },');
  parts.push('  "callouts":     { "2": "new text", ... }');
  parts.push('}');
  return parts.join("\n");
}

/** 把 AI 重写返回的 JSON 应用到原数组（不可变，返回新数组） */
export function applyRewrites(
  headlines: string[],
  descriptions: string[],
  rewrites: { headlines?: Record<string, string>; descriptions?: Record<string, string>; callouts?: Record<string, string> },
  callouts: string[] = [],
): { headlines: string[]; descriptions: string[]; callouts: string[] } {
  const apply = (src: string[], patches?: Record<string, string>) => {
    if (!patches) return [...src];
    const out = [...src];
    for (const [k, v] of Object.entries(patches)) {
      const idx = Number(k);
      if (Number.isInteger(idx) && idx >= 0 && idx < out.length && typeof v === "string" && v.trim()) {
        out[idx] = v.trim();
      }
    }
    return out;
  };
  return {
    headlines: apply(headlines, rewrites.headlines),
    descriptions: apply(descriptions, rewrites.descriptions),
    callouts: apply(callouts, rewrites.callouts),
  };
}

/** 静态合规模板兜底（2 轮 AI 重写都失败时使用） */
export function staticFallbackHeadlines(merchantName: string, _category?: string | null): string[] {
  void _category;
  const safeName = brandRootToken(merchantName) || "Featured";
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  void cap;
  return [
    "Curated Top Selections",
    "Shop the Featured Collection",
    "Themed Product Picks",
    "New Arrivals This Week",
    "Customer-Favorite Picks",
    "Browse the Top Selections",
    "Bestselling Categories",
    "Limited Stock — Shop Today",
    "Featured Item Highlights",
    "Top Picks — Updated Weekly",
    "Discover Quality Picks",
    "Shop the Most Popular",
    "Trending Items This Season",
    "See Our Featured Items",
    "Explore Top Categories",
  ].slice(0, 15);
}

export function staticFallbackDescriptions(): string[] {
  return [
    "Browse hand-picked items featured in our curated category lists. Updated weekly with new arrivals.",
    "Shop bestselling categories with confidence. Easy returns and customer support throughout the journey.",
    "Discover top-selling collections aligned with current trends. Quality picks from established sellers.",
    "Explore our featured product highlights. Multiple categories, all curated for everyday shoppers.",
  ];
}
