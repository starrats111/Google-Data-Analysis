import { normalizeAiRuleProfile } from "@/lib/ai-rule-profile";

export type KeywordMatchType = "BROAD" | "PHRASE" | "EXACT";

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
}

interface OptimizeKeywordOptions {
  merchantName?: string;
  dailyBudget?: number;
  maxCpc?: number;
  biddingStrategy?: string;
  aiRuleProfile?: unknown;
  limit?: number;
}

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

const TRANSACTIONAL_PATTERNS = [
  /buy|shop|sale|deal|discount|price|pricing|order|official|coupon|promo|offer|best/i,
  /versand|rabatt|angebot|kaufen/i,
  /livraison|promo|remise|acheter/i,
  /env[ií]o|descuento|comprar/i,
];

const INFORMATIONAL_PATTERNS = [
  /what\s+is|how\s+to|guide|tutorial|review|meaning|definition/i,
];

function normalizePhrase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/["'“”‘’]/g, "")
    .replace(/[^a-z0-9\u00C0-\u024F\u4e00-\u9fa5\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizePhrase(value)
    .split(" ")
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
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
  if (["low", "l", "easy", "0", "0.0", "0.1", "0.2", "0.3"].includes(text)) return "LOW";
  if (["medium", "med", "m", "0.4", "0.5", "0.6"].includes(text)) return "MEDIUM";
  if (["high", "hard", "h", "0.7", "0.8", "0.9", "1", "1.0"].includes(text)) return "HIGH";
  if (text.includes("low")) return "LOW";
  if (text.includes("med")) return "MEDIUM";
  if (text.includes("high")) return "HIGH";
  return "UNKNOWN";
}

function getEffectiveBid(candidate: KeywordCandidate): number | null {
  const bid = Number(candidate.suggested_bid ?? candidate.cpc ?? NaN);
  if (Number.isFinite(bid) && bid > 0) return bid;
  return null;
}

function hasMerchantIntent(phrase: string, merchantName: string): boolean {
  const phraseText = normalizePhrase(phrase);
  const merchantTokens = tokenize(merchantName).filter((item) => item.length >= 3);
  return merchantTokens.some((token) => phraseText.includes(token));
}

function buildReason(parts: string[]): string {
  return parts.filter(Boolean).slice(0, 4).join("，");
}

function getRecommendedMatchType(score: number, tokenCount: number, dailyBudget: number): KeywordMatchType {
  if (tokenCount >= 4 || score >= 72) return "EXACT";
  if (tokenCount >= 2 || dailyBudget <= 3 || score >= 48) return "PHRASE";
  return "BROAD";
}

export function describeOptimizedKeyword(
  candidate: KeywordCandidate,
  options: OptimizeKeywordOptions = {},
): OptimizedKeyword {
  const profile = normalizeAiRuleProfile(options.aiRuleProfile);
  const phrase = String(candidate.phrase || "").trim();
  const volume = Math.max(0, Number(candidate.volume || 0));
  const dailyBudget = parseBudget(options.dailyBudget);
  const maxCpc = parseMaxCpc(options.maxCpc);
  const effectiveBid = getEffectiveBid(candidate);
  const competitionBand = normalizeCompetitionBand(candidate.competition);
  const tokenCount = tokenize(phrase).length;
  const merchantMatched = hasMerchantIntent(phrase, options.merchantName || "");
  const preferredMatched = profile.preferred_terms.some((term) => normalizePhrase(phrase).includes(normalizePhrase(term)));
  const transactional = TRANSACTIONAL_PATTERNS.some((pattern) => pattern.test(phrase));
  const informational = INFORMATIONAL_PATTERNS.some((pattern) => pattern.test(phrase));

  let score = 0;
  const reasons: string[] = [];

  if (effectiveBid != null) {
    if (effectiveBid <= maxCpc * 0.7) {
      score += 24;
      reasons.push(`建议出价低于 $${maxCpc.toFixed(2)} 目标`);
    } else if (effectiveBid <= maxCpc) {
      score += 18;
      reasons.push(`建议出价可控制在 $${maxCpc.toFixed(2)} 内`);
    } else if (effectiveBid <= maxCpc * 1.2) {
      score += 8;
      reasons.push("出价略高但仍可测试");
    } else {
      score -= 16;
      reasons.push("预估出价偏高");
    }
  } else {
    score += 8;
    reasons.push("缺少出价数据，按保守模式评估");
  }

  if (competitionBand === "LOW") {
    score += 18;
    reasons.push("竞争度较低");
  } else if (competitionBand === "MEDIUM") {
    score += 10;
    reasons.push("竞争度适中");
  } else if (competitionBand === "HIGH") {
    score -= 8;
    reasons.push("竞争度偏高");
  } else {
    score += 5;
  }

  if (volume >= 5000) {
    score += 14;
    reasons.push("搜索量充足");
  } else if (volume >= 1000) {
    score += 11;
    reasons.push("搜索量稳定");
  } else if (volume >= 100) {
    score += 8;
    reasons.push("长尾量级适合小预算");
  } else if (volume > 0) {
    score += 4;
    reasons.push("搜索量较小但更聚焦");
  }

  if (merchantMatched) {
    score += 18;
    reasons.push("与品牌或商家强相关");
  }
  if (preferredMatched) {
    score += 10;
    reasons.push("命中用户偏好词");
  }
  if (transactional) {
    score += 12;
    reasons.push("购买意图更强");
  }
  if (informational) {
    score -= 8;
    reasons.push("信息型意图偏强");
  }
  if (tokenCount >= 3 && tokenCount <= 5) {
    score += 8;
    reasons.push("更适合精准控量");
  }

  if (dailyBudget <= 2 && effectiveBid != null && effectiveBid > dailyBudget * 0.4) {
    score -= 6;
    reasons.push("低预算下点击空间有限");
  }

  const recommendedMatchType = getRecommendedMatchType(score, tokenCount, dailyBudget);

  return {
    phrase,
    volume,
    competition: candidate.competition ?? null,
    suggested_bid: candidate.suggested_bid ?? null,
    cpc: candidate.cpc ?? null,
    source: candidate.source || "semrush",
    score: Number(score.toFixed(2)),
    reason: buildReason(reasons),
    recommended_match_type: recommendedMatchType,
    competition_band: competitionBand,
  };
}

export function optimizeKeywordCandidates(
  rawCandidates: KeywordCandidate[],
  options: OptimizeKeywordOptions = {},
): OptimizedKeyword[] {
  const profile = normalizeAiRuleProfile(options.aiRuleProfile);
  const dailyBudget = parseBudget(options.dailyBudget);
  const maxCpc = parseMaxCpc(options.maxCpc);
  const limit = Math.max(1, Math.min(options.limit || 12, 20));
  const seen = new Set<string>();
  const filtered: KeywordCandidate[] = [];

  for (const candidate of rawCandidates) {
    const phrase = String(candidate.phrase || "").trim();
    const normalized = normalizePhrase(phrase);
    if (!phrase || normalized.length < 2) continue;
    if (seen.has(normalized)) continue;
    if (LOW_VALUE_PATTERNS.some((pattern) => pattern.test(phrase))) continue;
    if (profile.forbidden_terms.some((term) => normalized.includes(normalizePhrase(term)))) continue;

    const effectiveBid = getEffectiveBid(candidate);
    if (effectiveBid != null && effectiveBid > maxCpc * 1.4) continue;
    if (dailyBudget <= 2 && effectiveBid != null && effectiveBid > dailyBudget) continue;

    seen.add(normalized);
    filtered.push({ ...candidate, phrase });
  }

  const scored = filtered
    .map((candidate) => describeOptimizedKeyword(candidate, options))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.volume || 0) - (a.volume || 0);
    });

  return scored.slice(0, limit);
}
