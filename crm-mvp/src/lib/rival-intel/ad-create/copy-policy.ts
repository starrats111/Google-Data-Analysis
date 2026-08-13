/**
 * Google Ads RSA copy policy: messaging angle classification,
 * relevance validation, and diversity enforcement.
 */

import { googleAdsLength } from "./text-length";
import {
  auditGoogleAdsEditorialCopy,
  sanitizeGoogleAdsRsaText,
} from "./google-ads-editorial-policy";

export type MessagingAngle =
  | "brand"
  | "price"
  | "trust"
  | "feature"
  | "cta"
  | "offer"
  | "unknown";

export interface AngleClassification {
  text: string;
  angle: MessagingAngle;
  confidence: number;
}

export interface PolicyViolation {
  text: string;
  rule: string;
  severity: "error" | "warning";
}

export interface PolicyResult {
  passed: PolicyViolation[];
  violations: PolicyViolation[];
  cleaned: string[];
}

const ECOMMERCE_BLACKLIST = [
  "free shipping",
  "new arrivals",
  "top products",
  "must-have items",
  "add to cart",
  "in stock",
  "ships fast",
  "warehouse sale",
  "clearance sale",
];

const CTA_PATTERNS = [
  /\b(book|reserve|get|find|compare|search|explore|discover|check|start|try|save|join|sign up)\b/i,
  /\bnow\b/i,
  /\btoday\b/i,
];

const TRUST_PATTERNS = [
  /\b\d[\d,.]*[+]?\s*(million|m\b|billion|b\b|guests|reviews|listings|properties|countries)/i,
  /\b(trusted|verified|official|guaranteed|award|rated|certified|accredited)\b/i,
  /\b(since \d{4})\b/i,
  /[®™©]/,
];

const PRICE_PATTERNS = [
  /\b(save|discount|deal|cheap|affordable|budget|low[- ]?price|best price|price match)\b/i,
  /\b\d+%\s*(off|savings?|discount)\b/i,
  /\b(free cancellation|no fees?|no hidden|no charge|pay later|pay at)\b/i,
  /\bup to \d+%/i,
];

const OFFER_PATTERNS = [
  /\b(exclusive|special|limited|bonus|reward|member|loyalty|promo|coupon|app[- ]only)\b/i,
  /\b(sale|offer|last[- ]minute)\b/i,
  /\b(seasonal|holiday|summer|winter|black friday|flash)\b/i,
];

const FEATURE_PATTERNS = [
  /\b(hotels?|flights?|cars?|rentals?|apartments?|resorts?|villas?|hostels?|motels?)\b/i,
  /\b(worldwide|global|international|\d+\+?\s*countr)/i,
  /\b(instant|24\/7|support|flexible|cancell?a|refund)\b/i,
  /\b(reviews?|photos?|maps?|filters?|search|compare)\b/i,
  /\b(near you|nearby|local)\b/i,
];

const BRAND_PATTERNS = [
  /\bofficial\s*(site|website|page)?\b/i,
  /[®™©]/,
];

export function classifyAngle(
  text: string,
  brandKeywords: string[],
): AngleClassification {
  const lower = text.toLowerCase();
  const brandLower = brandKeywords.map((k) => k.toLowerCase());

  const scores: Record<MessagingAngle, number> = {
    brand: 0,
    price: 0,
    trust: 0,
    feature: 0,
    cta: 0,
    offer: 0,
    unknown: 0,
  };

  for (const bk of brandLower) {
    if (lower.includes(bk)) scores.brand += 2;
  }
  for (const p of BRAND_PATTERNS) {
    if (p.test(text)) scores.brand += 3;
  }

  for (const p of PRICE_PATTERNS) {
    if (p.test(text)) scores.price += 3;
  }

  for (const p of TRUST_PATTERNS) {
    if (p.test(text)) scores.trust += 3;
  }

  for (const p of FEATURE_PATTERNS) {
    if (p.test(text)) scores.feature += 2;
  }

  for (const p of CTA_PATTERNS) {
    if (p.test(text)) scores.cta += 2;
  }

  for (const p of OFFER_PATTERNS) {
    if (p.test(text)) scores.offer += 3;
  }

  let bestAngle: MessagingAngle = "unknown";
  let bestScore = 0;
  for (const [angle, score] of Object.entries(scores) as [MessagingAngle, number][]) {
    if (angle === "unknown") continue;
    if (score > bestScore) {
      bestScore = score;
      bestAngle = angle;
    }
  }

  if (bestScore === 0) bestAngle = "unknown";

  return {
    text,
    angle: bestAngle,
    confidence: Math.min(bestScore / 6, 1),
  };
}

export function detectIrrelevantCopy(text: string): PolicyViolation | null {
  const lower = text.toLowerCase();
  for (const phrase of ECOMMERCE_BLACKLIST) {
    if (lower.includes(phrase)) {
      return {
        text,
        rule: `irrelevant_ecommerce_phrase:${phrase}`,
        severity: "error",
      };
    }
  }
  return null;
}

export function validateCharUtilization(
  text: string,
  maxLength: number,
  minRatio: number,
): PolicyViolation | null {
  const ratio = googleAdsLength(text) / maxLength;
  if (ratio < minRatio) {
    return {
      text,
      rule: `low_char_utilization:${Math.round(ratio * 100)}%<${Math.round(minRatio * 100)}%`,
      severity: "warning",
    };
  }
  return null;
}

export function validateHeadlinePolicy(
  headline: string,
  brandKeywords: string[],
): PolicyViolation[] {
  void brandKeywords;
  const violations: PolicyViolation[] = [];

  const irrelevant = detectIrrelevantCopy(headline);
  if (irrelevant) violations.push(irrelevant);

  if (headline === headline.toUpperCase() && headline.length > 3) {
    violations.push({
      text: headline,
      rule: "all_caps_headline",
      severity: "warning",
    });
  }

  if (/[!]{2,}/.test(headline) || /[?]{2,}/.test(headline)) {
    violations.push({
      text: headline,
      rule: "excessive_punctuation",
      severity: "warning",
    });
  }

  for (const ev of auditGoogleAdsEditorialCopy(sanitizeGoogleAdsRsaText(headline), {
    field: "headline",
  })) {
    if (ev.severity === "error") {
      violations.push({
        text: headline,
        rule: `google_editorial:${ev.rule}`,
        severity: "error",
      });
    }
  }

  const charViolation = validateCharUtilization(headline, 30, 0.5);
  if (charViolation) violations.push(charViolation);

  return violations;
}

export function validateDescriptionPolicy(
  description: string,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];

  const irrelevant = detectIrrelevantCopy(description);
  if (irrelevant) violations.push(irrelevant);

  const charViolation = validateCharUtilization(description, 90, 0.6);
  if (charViolation) violations.push(charViolation);

  for (const ev of auditGoogleAdsEditorialCopy(sanitizeGoogleAdsRsaText(description), {
    field: "description",
  })) {
    if (ev.severity === "error") {
      violations.push({
        text: description,
        rule: `google_editorial:${ev.rule}`,
        severity: "error",
      });
    }
  }

  if (/\.\s*$/.test(description) === false && description.length > 20) {
    const endsWithCta = /[!?]\s*$/.test(description);
    if (!endsWithCta) {
      violations.push({
        text: description,
        rule: "missing_terminal_punctuation",
        severity: "warning",
      });
    }
  }

  return violations;
}

export interface AngleDiversityReport {
  distribution: Record<MessagingAngle, number>;
  missingAngles: MessagingAngle[];
  diversityScore: number;
}

const REQUIRED_ANGLES: MessagingAngle[] = [
  "brand",
  "price",
  "trust",
  "feature",
  "cta",
  "offer",
];

export function analyzeAngleDiversity(
  classifications: AngleClassification[],
): AngleDiversityReport {
  const distribution: Record<MessagingAngle, number> = {
    brand: 0,
    price: 0,
    trust: 0,
    feature: 0,
    cta: 0,
    offer: 0,
    unknown: 0,
  };

  for (const c of classifications) {
    distribution[c.angle]++;
  }

  const missingAngles = REQUIRED_ANGLES.filter((a) => distribution[a] === 0);

  const coveredAngles = REQUIRED_ANGLES.filter((a) => distribution[a] > 0).length;
  const diversityScore = coveredAngles / REQUIRED_ANGLES.length;

  return { distribution, missingAngles, diversityScore };
}

export function runHeadlinePolicy(
  headlines: string[],
  brandKeywords: string[],
): { clean: string[]; violations: PolicyViolation[] } {
  const allViolations: PolicyViolation[] = [];
  const errorTexts = new Set<string>();

  for (const h of headlines) {
    const vs = validateHeadlinePolicy(h, brandKeywords);
    allViolations.push(...vs);
    if (vs.some((v) => v.severity === "error")) {
      errorTexts.add(h);
    }
  }

  const clean = headlines.filter((h) => !errorTexts.has(h));
  return { clean, violations: allViolations };
}

export function runDescriptionPolicy(
  descriptions: string[],
): { clean: string[]; violations: PolicyViolation[] } {
  const allViolations: PolicyViolation[] = [];
  const errorTexts = new Set<string>();

  for (const d of descriptions) {
    const vs = validateDescriptionPolicy(d);
    allViolations.push(...vs);
    if (vs.some((v) => v.severity === "error")) {
      errorTexts.add(d);
    }
  }

  const clean = descriptions.filter((d) => !errorTexts.has(d));
  return { clean, violations: allViolations };
}
