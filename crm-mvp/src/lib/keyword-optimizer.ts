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
  /\b(deal|sale|discount|coupon|promo|offer|cheap|price|best price)\b/i,
  /\b(delivery|shipping|next day|free shipping|express)\b/i,
  /\bkit\b/i,
  /\bfor sale\b/i,
  /\b(subscribe|subscription|membership)\b/i,
  /\b(kaufen|bestellen|angebot|rabatt)\b/i,
  /\b(acheter|commander|promo|remise)\b/i,
  /\b(comprar|pedir|oferta|descuento)\b/i,
];

const FEATURE_SCENE_PATTERNS = [
  /\b(how to|guide|beginner|starter|complete|step.?by.?step)\b/i,
  /\b(indoor|outdoor|home|garden|diy)\b/i,
  /\b(supply|supplies|equipment|tool|material)\b/i,
  /\b(organic|natural|premium|professional|grade)\b/i,
  /\b(best|top.?rated|review|comparison|vs|alternative)\b/i,
  /\b(compatible|for iphone|for samsung|for galaxy|for pixel)\b/i,
  /\b(wireless|bluetooth|noise.?cancel)\b/i,
  /\b(protect|protection|waterproof|shockproof)\b/i,
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

/**
 * Google Ads 受限内容策略过滤 — Adrian 的合规直觉
 * 单词级正则：直接匹配即判定违规
 */
const POLICY_RISK_SINGLE_PATTERNS = [
  // Controlled substances — single-word triggers
  /\bshrooms?\b/i,
  /\bpsilocybin/i,
  /\bpsilocybe/i,
  /\bpsychedelic/i,
  /\bhallucino/i,
  /\b(lsd|mdma|ecstasy)\b/i,
  /\bcocaine\b/i,
  /\bheroin\b/i,
  /\bmethamphet/i,
  /\bkratom\b/i,
  /\bayahuasca/i,
  /\bdmt\b/i,
  /\bketamine/i,
  /\bopiat/i,
  /\bopioid/i,
  /\bfentanyl/i,
  /\bdelta[\s-]*[89]\b/i,
  // Cannabis (restricted in most Google Ads regions)
  /\bmarijuana\b/i,
  /\bcannabis\b/i,
  /\b(thc|cbd)\s*(oil|gumm|edible|vape|cart)/i,
  /\bweed\b(?!\s*(killer|removal|control|garden))/i,
  // Weapons & explosives
  /\b(buy|purchase|order|sell)\s+(gun|firearm|rifle|pistol|handgun|shotgun|ammo|ammunition)\b/i,
  /\bassault\s+(rifle|weapon)/i,
  /\bexplosive/i,
  /\bswitchblade/i,
  // Counterfeit / fraudulent
  /\b(fake|counterfeit|replica|forged)\s+(id|passport|license|diploma|degree|certificate)\b/i,
  /\bbuy\s+(fake|forged)/i,
  // Hacking / surveillance abuse
  /\bhack\s+(account|password|email|facebook|instagram|wifi)/i,
  /\bspyware\b/i,
  /\bkeylogger/i,
  /\bphishing\s+kit/i,
  // Tobacco / vaping (restricted)
  /\b(buy|order|cheap)\s+(cigarette|cigar|tobacco|vape|e[\s-]?cig)/i,
  // Gambling (restricted, needs certification)
  /\b(online\s+)?casino\s+(real\s+money|bonus|slot)/i,
  /\bsports?\s*bet(ting)?\s+(site|app|online)/i,
  // Academic dishonesty
  /\b(buy|order|pay)\s+(essay|thesis|homework|assignment|dissertation)\b/i,
];

/**
 * 多词组合检测 — 词序无关
 * 只要短语中同时包含 set 中的所有词根，就判定违规
 * 例如 "magic" + "mushroom/mush" → 无论 "buy mushrooms magic" 还是 "magic mushroom buy" 都能匹配
 */
const POLICY_RISK_COMBO_SETS: Array<{ roots: string[]; label: string }> = [
  { roots: ["magic", "mushroom"], label: "controlled substance" },
  { roots: ["magic", "mush"], label: "controlled substance" },
];

function phraseContainsAllRoots(phrase: string, roots: string[]): boolean {
  const lower = phrase.toLowerCase();
  return roots.every((root) => lower.includes(root));
}

/**
 * 统一政策风险检查 — 所有关键词链路共用此函数
 * 返回 true 表示该关键词存在政策风险，应被过滤
 */
export function isPolicyRiskKeyword(phrase: string): boolean {
  if (!phrase || phrase.trim().length < 2) return false;
  const text = phrase.trim();
  if (POLICY_RISK_SINGLE_PATTERNS.some((p) => p.test(text))) return true;
  if (POLICY_RISK_COMBO_SETS.some((combo) => phraseContainsAllRoots(text, combo.roots))) return true;
  return false;
}

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

const MATCH_DESC: Record<KeywordMatchType, string> = { EXACT: "精确匹配", PHRASE: "短语匹配", BROAD: "广泛匹配" };

/**
 * 生成 Adrian 风格的选词理由 — 每个词要回答"为什么选它"
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
  const parts: string[] = [];

  if (intentLayer === "HIGH_INTENT") {
    parts.push("高意图购买词，搜索者有明确购买意愿");
    if (effectiveBid != null && effectiveBid <= maxCpc) {
      parts.push(`CPC $${effectiveBid.toFixed(2)} 在预算内，转化率高`);
    } else if (effectiveBid != null) {
      parts.push(`CPC $${effectiveBid.toFixed(2)} 略高但转化价值大`);
    }
  } else if (intentLayer === "FEATURE_SCENE") {
    parts.push("场景/功能词，精准触达有需求的用户群");
  } else if (intentLayer === "BRAND") {
    parts.push("品牌词，搜索者已认知品牌，点击率高");
  } else if (intentLayer === "LONG_TAIL") {
    parts.push("长尾精准词，竞争小、意图明确、ROI 优");
  } else {
    parts.push(`通用词，建议${MATCH_DESC[matchType]}配合否定词控制`);
  }

  if (volume >= 5000) parts.push(`月搜索量 ${volume.toLocaleString()}，流量充足`);
  else if (volume >= 1000) parts.push(`月搜索量 ${volume.toLocaleString()}，稳定可投`);
  else if (volume >= 100) parts.push(`月搜索量 ${volume}，适合精准小预算投放`);

  if (competitionBand === "LOW") parts.push("竞争低，性价比优");
  else if (competitionBand === "MEDIUM") parts.push("竞争适中");
  else if (competitionBand === "HIGH" && intentLayer === "HIGH_INTENT") parts.push("竞争高但值得投入");

  parts.push(`建议${MATCH_DESC[matchType]}`);

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
  if (isPolicyRiskKeyword(phrase)) score -= 100;
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
  const limit = Math.max(1, Math.min(options.limit ?? 8, 8));
  const seen = new Set<string>();
  const filtered: KeywordCandidate[] = [];

  for (const candidate of rawCandidates) {
    const phrase = String(candidate.phrase || "").trim();
    const normalized = normalizePhrase(phrase);
    if (!phrase || normalized.length < 2) continue;
    if (seen.has(normalized)) continue;
    if (LOW_VALUE_PATTERNS.some((pattern) => pattern.test(phrase))) continue;
    if (isPolicyRiskKeyword(phrase)) continue;
    if (persona.forbidden_terms.some((term) => normalized.includes(normalizePhrase(term)))) continue;

    const effectiveBid = getEffectiveBid(candidate);
    if (effectiveBid != null && effectiveBid > maxCpc * 2.5) continue;
    if (dailyBudget <= 2 && effectiveBid != null && effectiveBid > dailyBudget * 2) continue;

    seen.add(normalized);
    filtered.push({ ...candidate, phrase });
  }

  const scored = filtered
    .map((candidate) => describeOptimizedKeyword(candidate, options))
    .filter((kw) => kw.score >= 25)
    .sort((a, b) => {
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

  return diversifyKeywordSelection(scored, limit);
}

/**
 * 多样化关键词选择：确保不同意图层都有代表，避免全部集中在同一类型
 */
function diversifyKeywordSelection(sorted: OptimizedKeyword[], limit: number): OptimizedKeyword[] {
  if (sorted.length <= limit) return sorted;

  const result: OptimizedKeyword[] = [];
  const usedPhrases = new Set<string>();

  const layerBuckets: Record<KeywordIntentLayer, OptimizedKeyword[]> = {
    HIGH_INTENT: [], FEATURE_SCENE: [], BRAND: [], LONG_TAIL: [], GENERAL: [],
  };
  for (const kw of sorted) {
    layerBuckets[kw.intent_layer].push(kw);
  }

  const layerOrder: KeywordIntentLayer[] = ["HIGH_INTENT", "FEATURE_SCENE", "LONG_TAIL", "BRAND", "GENERAL"];
  for (const layer of layerOrder) {
    const bucket = layerBuckets[layer];
    const slotCount = layer === "HIGH_INTENT" ? 3 :
                      layer === "FEATURE_SCENE" ? 2 :
                      layer === "LONG_TAIL" ? 2 :
                      layer === "BRAND" ? 1 :
                      1;
    for (const kw of bucket) {
      if (result.length >= limit) break;
      if (usedPhrases.has(normalizePhrase(kw.phrase))) continue;
      result.push(kw);
      usedPhrases.add(normalizePhrase(kw.phrase));
      if (result.filter(r => r.intent_layer === layer).length >= slotCount) break;
    }
  }

  if (result.length < limit) {
    for (const kw of sorted) {
      if (result.length >= limit) break;
      if (usedPhrases.has(normalizePhrase(kw.phrase))) continue;
      result.push(kw);
      usedPhrases.add(normalizePhrase(kw.phrase));
    }
  }

  return result.sort((a, b) => b.score - a.score);
}
