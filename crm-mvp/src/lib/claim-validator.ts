/**
 * C-016 claim-validator
 *
 * 职责：检测广告文案（headline/description/sitelink/callout）里的**事实性承诺**
 * 是否在爬取的证据集里能找到支撑。
 *
 * 证据集来源（全部来自 CrawlCache）：
 *   - rawMentions.promo       —— 原文促销片段
 *   - rawMentions.shipping    —— 原文物流片段
 *   - rawMentions.features    —— 原文特性/卖点片段
 *   - promoRegex              —— 结构化折扣（discount_percent / discount_amount / currency_code）
 *   - phone                   —— 官方电话
 *   - features                —— 页面提取的特性词
 *
 * 检测维度：
 *   - 百分比   "10% off" → 必须有 promoRegex.discount_percent >= N 或 rawMentions.promo 含 N%
 *   - 货币额   "$20 off"  → 同上（匹配 discount_amount）
 *   - 电话     "+49 …"    → 必须等于 phone.phone_number
 *   - 年限     "2 Jaar"   → rawMentions.features 或 promo 含原文
 *   - 免运费   "free shipping" / 多语言 → features 或 rawMentions.shipping 命中
 *   - 保修     "warranty/garantie" → rawMentions.features/promo 含原文
 *
 * 主观文案（"Premium Quality" 等）不在检测范围（非事实索赔，不违反 Google 政策）。
 */

export interface TextItem {
  field: "headline" | "description" | "sitelink" | "callout";
  index: number;
  text: string;
}

export interface UnsupportedClaim {
  field: "headline" | "description" | "sitelink" | "callout";
  index: number;
  text: string;
  claim: string;   // 违规的具体事实片段
  reason: string;  // 人话说明
  hint: string;    // 注入 AI retry 的修改建议
}

export interface ValidatorEvidence {
  rawMentions?: {
    promo?: string[];
    shipping?: string[];
    features?: string[];
  } | null;
  promoRegex?: Record<string, unknown> | null;
  phone?: { phone_number?: string | null } | null;
  features?: string[];
}

export interface ValidateResult {
  ok: boolean;
  unsupported: UnsupportedClaim[];
}

// ─── 多语言事实正则 ────────────────────────────────────────────

// 百分比（必须 < 100，避免误伤 2025）
const PERCENT_RE = /\b(\d{1,2})\s?%/g;

// 货币额（$, €, £, ¥, CHF, zł）
const CURRENCY_RE = /(?:[$€£¥]|CHF|zł|SEK|NOK|DKK)\s?(\d{1,5}(?:[.,]\d{1,2})?)|(\d{1,5}(?:[.,]\d{1,2})?)\s?(?:[$€£¥])/gi;

// 电话 E.164 + 欧洲本地格式
const PHONE_RE = /(?:\+?\d[\d\s\-().]{6,}\d)/g;

// 年限（多语言）
const YEARS_RE = /\b(\d+)\s*[-\s]?\s*(years?|jaar|jahre|jahr|ans|anni|años|anos|år|vuotta|lat|rok)/gi;

// 免运费（多语言）
const FREE_SHIPPING_RE = /\b(?:free\s*(?:ship(?:ping)?|deliv(?:ery)?)|gratis\s*verzend(?:ing|en)?|livraison\s*gratuite|kostenlose\s*lieferung|spedizione\s*gratuit[ao]|envío\s*gratis|frete\s*gr[áa]tis|gratis\s*levering|ilmainen\s*toimitus|бесплатная\s*доставка)\b/i;

// 保修/质保（多语言）
const WARRANTY_RE = /\b(?:warranty|guarantee|garantie|garanzia|garantía|garantia|takuu|gwarancja|保修|保證|保证)\b/i;

// ─── 工具函数 ────────────────────────────────────────────

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u00A0/g, " ")
    .replace(/[,.\u2013\u2014\u2212]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mentionContains(mentions: string[] | undefined, needle: string): boolean {
  if (!mentions || mentions.length === 0) return false;
  const n = normalizeText(needle);
  return mentions.some((m) => normalizeText(m).includes(n));
}

function anyMentionContains(evidence: ValidatorEvidence, needle: string): boolean {
  if (
    mentionContains(evidence.rawMentions?.promo, needle) ||
    mentionContains(evidence.rawMentions?.shipping, needle) ||
    mentionContains(evidence.rawMentions?.features, needle)
  ) return true;
  if (mentionContains(evidence.features, needle)) return true;
  return false;
}

function validatePercent(text: string, evidence: ValidatorEvidence): UnsupportedClaim["claim"] | null {
  const matches = [...text.matchAll(PERCENT_RE)];
  for (const m of matches) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0 || n >= 100) continue;
    // 1. promoRegex.discount_percent >= N（允许等值）
    const pr = evidence.promoRegex;
    const discountPct = pr && typeof pr.discount_percent === "number" ? Number(pr.discount_percent) : 0;
    if (discountPct >= n) continue;
    // 2. rawMentions 原文含 N%
    if (anyMentionContains(evidence, `${n}%`)) continue;
    if (anyMentionContains(evidence, `${n} %`)) continue;
    return `${n}%`;
  }
  return null;
}

function validateCurrency(text: string, evidence: ValidatorEvidence): string | null {
  const matches = [...text.matchAll(CURRENCY_RE)];
  for (const m of matches) {
    const raw = m[0];
    const amount = Number((m[1] || m[2] || "").replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    // 1. promoRegex.discount_amount 匹配
    const pr = evidence.promoRegex;
    const discountAmt = pr && typeof pr.discount_amount === "number" ? Number(pr.discount_amount) : 0;
    if (Math.abs(discountAmt - amount) < 0.01) continue;
    // 2. 原文里能找到金额
    if (anyMentionContains(evidence, raw)) continue;
    if (anyMentionContains(evidence, String(amount))) continue;
    return raw;
  }
  return null;
}

function normalizePhone(s: string): string {
  return s.replace(/[^\d+]/g, "");
}

function validatePhone(text: string, evidence: ValidatorEvidence): string | null {
  const matches = [...text.matchAll(PHONE_RE)];
  if (matches.length === 0) return null;
  const refPhone = evidence.phone?.phone_number ? normalizePhone(evidence.phone.phone_number) : "";
  for (const m of matches) {
    const raw = m[0];
    const normalized = normalizePhone(raw);
    if (normalized.length < 8) continue; // 太短，可能是误识别
    if (refPhone && normalized.includes(refPhone.slice(-8))) continue;
    if (refPhone && refPhone.includes(normalized.slice(-8))) continue;
    return raw;
  }
  return null;
}

function validateYears(text: string, evidence: ValidatorEvidence): string | null {
  const matches = [...text.matchAll(YEARS_RE)];
  for (const m of matches) {
    const raw = m[0];
    const year = Number(m[1]);
    if (!Number.isFinite(year) || year <= 0 || year > 99) continue;
    // 原文必须含有该数字 + years/jaar/etc
    if (anyMentionContains(evidence, raw)) continue;
    if (anyMentionContains(evidence, `${year}`)) {
      // 数字命中但需要 year 单位也命中
      const unit = (m[2] || "").toLowerCase();
      if (anyMentionContains(evidence, unit)) continue;
    }
    return raw;
  }
  return null;
}

function validateFreeShipping(text: string, evidence: ValidatorEvidence): string | null {
  if (!FREE_SHIPPING_RE.test(text)) return null;
  // features 列表里有 free shipping 类词 → 通过
  if (evidence.features?.some((f) => FREE_SHIPPING_RE.test(f))) return null;
  // rawMentions.shipping 或 promo 里有命中 → 通过
  if (evidence.rawMentions?.shipping?.some((s) => FREE_SHIPPING_RE.test(s))) return null;
  if (evidence.rawMentions?.promo?.some((s) => FREE_SHIPPING_RE.test(s))) return null;
  const m = text.match(FREE_SHIPPING_RE);
  return m ? m[0] : "免运费";
}

function validateWarranty(text: string, evidence: ValidatorEvidence): string | null {
  if (!WARRANTY_RE.test(text)) return null;
  if (evidence.features?.some((f) => WARRANTY_RE.test(f))) return null;
  if (evidence.rawMentions?.promo?.some((s) => WARRANTY_RE.test(s))) return null;
  if (evidence.rawMentions?.features?.some((s) => WARRANTY_RE.test(s))) return null;
  if (evidence.rawMentions?.shipping?.some((s) => WARRANTY_RE.test(s))) return null;
  const m = text.match(WARRANTY_RE);
  return m ? m[0] : "warranty";
}

// ─── 主入口 ────────────────────────────────────────────

export function validateClaims(input: {
  texts: TextItem[];
  evidence: ValidatorEvidence;
  country?: string;
}): ValidateResult {
  const { texts, evidence } = input;
  const unsupported: UnsupportedClaim[] = [];

  for (const item of texts) {
    if (!item.text || item.text.trim().length < 2) continue;

    const percentBad = validatePercent(item.text, evidence);
    if (percentBad) {
      unsupported.push({
        field: item.field,
        index: item.index,
        text: item.text,
        claim: percentBad,
        reason: `文案声称 ${percentBad} 折扣，但商家页面未找到该折扣证据`,
        hint: `Remove the ${percentBad} discount claim; use a non-numeric value proposition instead.`,
      });
      continue;
    }
    const currencyBad = validateCurrency(item.text, evidence);
    if (currencyBad) {
      unsupported.push({
        field: item.field,
        index: item.index,
        text: item.text,
        claim: currencyBad,
        reason: `文案出现 ${currencyBad} 金额，但商家页面未找到该金额证据`,
        hint: `Remove the ${currencyBad} price/discount claim; use a non-numeric benefit instead.`,
      });
      continue;
    }
    const phoneBad = validatePhone(item.text, evidence);
    if (phoneBad) {
      unsupported.push({
        field: item.field,
        index: item.index,
        text: item.text,
        claim: phoneBad,
        reason: `文案出现电话号码 ${phoneBad}，但与商家页面的官方电话不匹配`,
        hint: `Remove the phone number; phone numbers are not allowed in ad copy unless verified.`,
      });
      continue;
    }
    const yearsBad = validateYears(item.text, evidence);
    if (yearsBad) {
      unsupported.push({
        field: item.field,
        index: item.index,
        text: item.text,
        claim: yearsBad,
        reason: `文案出现年限声明 ${yearsBad}，但商家页面未找到该证据`,
        hint: `Remove the "${yearsBad}" claim; use a non-temporal value proposition instead.`,
      });
      continue;
    }
    const shippingBad = validateFreeShipping(item.text, evidence);
    if (shippingBad) {
      unsupported.push({
        field: item.field,
        index: item.index,
        text: item.text,
        claim: shippingBad,
        reason: `文案声称免运费，但商家页面未明确提供`,
        hint: `Remove the free shipping claim; focus on product quality or brand benefits.`,
      });
      continue;
    }
    const warrantyBad = validateWarranty(item.text, evidence);
    if (warrantyBad) {
      unsupported.push({
        field: item.field,
        index: item.index,
        text: item.text,
        claim: warrantyBad,
        reason: `文案声称保修/质保，但商家页面未明确提供`,
        hint: `Remove the warranty claim; use a different trust signal instead.`,
      });
      continue;
    }
  }

  return { ok: unsupported.length === 0, unsupported };
}
