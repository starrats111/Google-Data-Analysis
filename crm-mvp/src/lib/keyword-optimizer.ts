import { normalizeAiRuleProfile, getActivePersona } from "@/lib/ai-rule-profile";

export type KeywordMatchType = "BROAD" | "PHRASE" | "EXACT";
export type KeywordIntentLayer = "HIGH_INTENT" | "FEATURE_SCENE" | "BRAND" | "LONG_TAIL" | "GENERAL";

export interface KeywordCandidate {
  phrase: string;
  volume?: number | null;
  competition?: string | number | null;
  suggested_bid?: number | null;
  cpc?: number | null;
  source?: string;
}

export interface OptimizedKeyword extends KeywordCandidate {
  score: number;
  reason: string;
  recommended_match_type: KeywordMatchType;
  competition_band: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  intent_layer: KeywordIntentLayer;
}

interface OptimizeKeywordOptions {
  merchantName?: string;
  dailyBudget?: number;
  maxCpc?: number;
  biddingStrategy?: string;
  aiRuleProfile?: unknown;
  limit?: number;
}

// ─── 意图层分类规则 ───────────────────────────────────────────

const HIGH_INTENT_PATTERNS = [
  /\b(buy|shop|order|purchase|get|checkout|add to cart)\b/i,
  /\b(case|cover|stand|holder|mount|strap|band|screen protector|charger)\b/i,
  /\b(magsafe|wireless charging|fast charge|usb-?c)\b/i,
  /\b(deal|sale|discount|coupon|promo|offer|cheap|price)\b/i,
  /\b(kaufen|bestellen|angebot|rabatt)\b/i,
  /\b(acheter|commander|promo|remise)\b/i,
  /\b(comprar|pedir|oferta|descuento)\b/i,
];

const FEATURE_SCENE_PATTERNS = [
  /\b(kickstand|clear|transparent|slim|thin|heavy.?duty|waterproof|shockproof|rugged)\b/i,
  /\b(protect|protection|drop.?proof|military.?grade|anti.?scratch)\b/i,
  /\b(compatible|for iphone|for samsung|for galaxy|for pixel)\b/i,
  /\b(wireless|bluetooth|noise.?cancel|active|passive)\b/i,
  /\b(best|top.?rated|review|comparison|vs|alternative)\b/i,
];

const BRAND_PATTERNS = [
  /\b(apple|samsung|google|huawei|xiaomi|iphone|ipad|macbook|galaxy|pixel)\b/i,
  /\b(torras|spigen|otterbox|casetify|anker|belkin|ugreen|baseus)\b/i,
];

/**
 * Adrian 意图层分类：决定词的购买漏斗位置
 */
export function classifyIntentLayer(phrase: string, merchantName = ""): KeywordIntentLayer {
  const p = phrase.toLowerCase();
  const tokens = p.split(/\s+/).filter(Boolean);

  if (HIGH_INTENT_PATTERNS.some((re) => re.test(p))) return "HIGH_INTENT";

  // 长尾（4+ tokens）且不含品牌词 → LONG_TAIL
  if (tokens.length >= 4 && !BRAND_PATTERNS.some((re) => re.test(p))) return "LONG_TAIL";

  if (BRAND_PATTERNS.some((re) => re.test(p))) return "BRAND";
  if (FEATURE_SCENE_PATTERNS.some((re) => re.test(p))) return "FEATURE_SCENE";

  // 商家品牌名本身
  if (merchantName && p.includes(merchantName.toLowerCase().split(/\s+/)[0])) return "BRAND";

  return "GENERAL";
}

// ─── 评分规则 ─────────────────────────────────────────────────

const LOW_VALUE_PATTERNS = [
  /customer\s+service/i,
  /contact\s+us/i,
  /about\s+us/i,
  /return\s+policy/i,
  /privacy\s+policy/i,
  /terms\s+of\s+service/i,
  /login|sign\s?in|sign\s?up|register/i,
  /jobs?|career/i,
  /free\s+download/i,
  /wikipedia/i,
];

const INFORMATIONAL_PATTERNS = [
  /what\s+is|how\s+to|guide|tutorial|review.*only|meaning|definition/i,
];

function normalizePhrase(value: string): string {
  return value.trim().toLowerCase()
    .replace(/["'""'']/g, "")
    .replace(/[^a-z0-9\u00C0-\u024F\u4e00-\u9fa5\s-]/gi, " ")
    .replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizePhrase(value).split(" ").map((t) => t.trim()).filter((t) => t.length >= 2);
}

function parseBudget(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0 ? Number(value) : 1.5;
}

function parseMaxCpc(value: number | undefined): number {
  return Number.isFinite(value) && value && value > 0 ? Number(value) : 0.3;
}

function normalizeCompetitionBand(value: string | number | null | undefined): "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN" {
  if (typeof value === "number") {
    if (value <= 0.34) return "LOW";
    if (value <= 0.68) return "MEDIUM";
    return "HIGH";
  }
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "UNKNOWN";
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0.34) return "LOW";
    if (numeric <= 0.68) return "MEDIUM";
    return "HIGH";
  }
  if (["low", "l", "easy"].includes(text) || text.includes("low")) return "LOW";
  if (["medium", "med", "m"].includes(text) || text.includes("med")) return "MEDIUM";
  if (["high", "hard", "h"].includes(text) || text.includes("high")) return "HIGH";
  return "UNKNOWN";
}

function getEffectiveBid(candidate: KeywordCandidate): number | null {
  const bid = Number(candidate.suggested_bid ?? candidate.cpc ?? NaN);
  if (Number.isFinite(bid) && bid > 0) return bid;
  return null;
}

function hasMerchantIntent(phrase: string, merchantName: string): boolean {
  const phraseText = normalizePhrase(phrase);
  const merchantTokens = tokenize(merchantName).filter((t) => t.length >= 3);
  return merchantTokens.some((token) => phraseText.includes(token));
}

function getRecommendedMatchType(score: number, tokenCount: number, dailyBudget: number, intentLayer: KeywordIntentLayer): KeywordMatchType {
  if (intentLayer === "HIGH_INTENT" || intentLayer === "BRAND") return "EXACT";
  if (tokenCount >= 4 || score >= 72) return "EXACT";
  if (tokenCount >= 2 || dailyBudget <= 3 || score >= 48) return "PHRASE";
  return "BROAD";
}

/**
 * 生成句子级 reason（Adrian 风格：直接、有洞察力）
 */
function buildSentenceReason(
  intentLayer: KeywordIntentLayer,
  competitionBand: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN",
  effectiveBid: number | null,
  maxCpc: number,
  volume: number,
  score: number,
  matchType: KeywordMatchType,
): string {
  const intentDesc: Record<KeywordIntentLayer, string> = {
    HIGH_INTENT: "高意图购买词",
    FEATURE_SCENE: "功能场景词",
    BRAND: "品牌/竞品词",
    LONG_TAIL: "长尾精准词",
    GENERAL: "通用词",
  };
  const matchDesc: Record<KeywordMatchType, string> = {
    EXACT: "精确匹配",
    PHRASE: "短语匹配",
    BROAD: "广泛匹配",
  };
  const compDesc: Record<string, string> = {
    LOW: "竞争度低，性价比高",
    MEDIUM: "竞争适中，可测试",
    HIGH: "竞争激烈，需控制出价",
    UNKNOWN: "竞争数据未知",
  };

  const parts: string[] = [];
  parts.push(`${intentDesc[intentLayer]}，建议${matchDesc[matchType]}`);

  if (effectiveBid != null) {
    if (effectiveBid <= maxCpc) {
      parts.push(`预估 CPC $${effectiveBid.toFixed(2)} 在预算内`);
    } else {
      parts.push(`预估 CPC $${effectiveBid.toFixed(2)} 略超目标 $${maxCpc.toFixed(2)}`);
    }
  }

  parts.push(compDesc[competitionBand]);

  if (intentLayer === "HIGH_INTENT") {
    parts.push("目标 ROAS ≥ 300%，出价优先级最高");
  } else if (intentLayer === "LONG_TAIL") {
    parts.push("搜索量小但意图明确，适合 DKI");
  } else if (volume >= 5000) {
    parts.push("搜索量充足，流量潜力大");
  } else if (volume >= 1000) {
    parts.push("搜索量稳定");
  } else if (volume > 0) {
    parts.push("搜索量较小，适合小预算精投");
  }

  if (score < 30) parts.push("综合评分偏低，谨慎使用");

  return parts.join("；") + "。";
}

export function describeOptimizedKeyword(
  candidate: KeywordCandidate,
  options: OptimizeKeywordOptions = {},
): OptimizedKeyword {
  const profile = normalizeAiRuleProfile(options.aiRuleProfile);
  const persona = getActivePersona(profile);
  const phrase = String(candidate.phrase || "").trim();
  const volume = Math.max(0, Number(candidate.volume || 0));
  const dailyBudget = parseBudget(options.dailyBudget);
  const maxCpc = parseMaxCpc(options.maxCpc);
  const effectiveBid = getEffectiveBid(candidate);
  const competitionBand = normalizeCompetitionBand(candidate.competition);
  const tokenCount = tokenize(phrase).length;
  const merchantMatched = hasMerchantIntent(phrase, options.merchantName || "");
  const preferredMatched = persona.preferred_terms.some(
    (term) => normalizePhrase(phrase).includes(normalizePhrase(term))
  );
  const informational = INFORMATIONAL_PATTERNS.some((pattern) => pattern.test(phrase));

  // 意图层分类
  const intentLayer = classifyIntentLayer(phrase, options.merchantName);

  let score = 0;

  // 出价评分
  if (effectiveBid != null) {
    if (effectiveBid <= maxCpc * 0.7) score += 24;
    else if (effectiveBid <= maxCpc) score += 18;
    else if (effectiveBid <= maxCpc * 1.2) score += 8;
    else score -= 16;
  } else {
    score += 8;
  }

  // 竞争度
  if (competitionBand === "LOW") score += 18;
  else if (competitionBand === "MEDIUM") score += 10;
  else if (competitionBand === "HIGH") score -= 8;
  else score += 5;

  // 搜索量
  if (volume >= 5000) score += 14;
  else if (volume >= 1000) score += 11;
  else if (volume >= 100) score += 8;
  else if (volume > 0) score += 4;

  // 商家/偏好匹配
  if (merchantMatched) score += 18;
  if (preferredMatched) score += 10;

  // 意图层加权（Adrian 核心策略）
  if (intentLayer === "HIGH_INTENT") score += 12;
  else if (intentLayer === "FEATURE_SCENE") score += 8;
  else if (intentLayer === "BRAND") score += 6;
  else if (intentLayer === "LONG_TAIL") score += 4;

  // 降分项
  if (informational) score -= 10;
  if (tokenCount >= 3 && tokenCount <= 5) score += 6;
  if (dailyBudget <= 2 && effectiveBid != null && effectiveBid > dailyBudget * 0.4) score -= 6;

  const recommendedMatchType = getRecommendedMatchType(score, tokenCount, dailyBudget, intentLayer);

  return {
    phrase,
    volume,
    competition: candidate.competition ?? null,
    suggested_bid: candidate.suggested_bid ?? null,
    cpc: candidate.cpc ?? null,
    source: candidate.source || "semrush",
    score: Number(score.toFixed(2)),
    reason: buildSentenceReason(intentLayer, competitionBand, effectiveBid, maxCpc, volume, score, recommendedMatchType),
    recommended_match_type: recommendedMatchType,
    competition_band: competitionBand,
    intent_layer: intentLayer,
  };
}

export function optimizeKeywordCandidates(
  rawCandidates: KeywordCandidate[],
  options: OptimizeKeywordOptions = {},
): OptimizedKeyword[] {
  const profile = normalizeAiRuleProfile(options.aiRuleProfile);
  const persona = getActivePersona(profile);
  const dailyBudget = parseBudget(options.dailyBudget);
  const maxCpc = parseMaxCpc(options.maxCpc);
  // Adrian 严选：硬上限 5 个
  const limit = Math.max(1, Math.min(options.limit ?? 5, 5));
  const seen = new Set<string>();
  const filtered: KeywordCandidate[] = [];

  for (const candidate of rawCandidates) {
    const phrase = String(candidate.phrase || "").trim();
    const normalized = normalizePhrase(phrase);
    if (!phrase || normalized.length < 2) continue;
    if (seen.has(normalized)) continue;
    if (LOW_VALUE_PATTERNS.some((pattern) => pattern.test(phrase))) continue;
    if (persona.forbidden_terms.some((term) => normalized.includes(normalizePhrase(term)))) continue;

    const effectiveBid = getEffectiveBid(candidate);
    if (effectiveBid != null && effectiveBid > maxCpc * 1.4) continue;
    if (dailyBudget <= 2 && effectiveBid != null && effectiveBid > dailyBudget) continue;

    seen.add(normalized);
    filtered.push({ ...candidate, phrase });
  }

  const scored = filtered
    .map((candidate) => describeOptimizedKeyword(candidate, options))
    // Adrian 严格阈值：score < 20 直接淘汰
    .filter((kw) => kw.score >= 20)
    .sort((a, b) => {
      // 意图层优先级排序
      const intentPriority: Record<KeywordIntentLayer, number> = {
        HIGH_INTENT: 4,
        FEATURE_SCENE: 3,
        BRAND: 2,
        LONG_TAIL: 1,
        GENERAL: 0,
      };
      const intentDiff = intentPriority[b.intent_layer] - intentPriority[a.intent_layer];
      if (intentDiff !== 0) return intentDiff;
      if (b.score !== a.score) return b.score - a.score;
      return (b.volume || 0) - (a.volume || 0);
    });

  return scored.slice(0, limit);
}
