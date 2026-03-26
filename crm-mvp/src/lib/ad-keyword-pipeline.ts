import { describeOptimizedKeyword, optimizeKeywordCandidates, type KeywordCandidate, type OptimizedKeyword } from "@/lib/keyword-optimizer";

export interface KeywordPipelineOptions {
  merchantName?: string;
  dailyBudget?: number;
  maxCpc?: number;
  biddingStrategy?: string;
  aiRuleProfile?: unknown;
  limit?: number;
}

export interface StoredKeywordRecord {
  id: bigint | string;
  keyword_text: string;
  match_type: string;
  avg_monthly_searches?: number | null;
  competition?: string | null;
  suggested_bid?: unknown;
}

export function selectOptimizedKeywords(
  candidates: KeywordCandidate[],
  options: KeywordPipelineOptions = {},
): OptimizedKeyword[] {
  const optimized = optimizeKeywordCandidates(candidates, options);
  if (optimized.length > 0) return optimized;

  const limit = Math.max(1, Math.min(options.limit || 12, 20));
  return candidates
    .slice(0, limit)
    .map((candidate) => describeOptimizedKeyword(candidate, options))
    .sort((a, b) => b.score - a.score);
}

export function buildKeywordCreateManyInput(adGroupId: bigint, keywords: OptimizedKeyword[]) {
  return keywords.map((keyword) => ({
    ad_group_id: adGroupId,
    keyword_text: keyword.phrase,
    match_type: keyword.recommended_match_type,
    avg_monthly_searches: keyword.volume || null,
    competition: keyword.competition != null ? String(keyword.competition) : null,
    suggested_bid: keyword.suggested_bid ?? keyword.cpc ?? null,
  }));
}

export function mapStoredKeywordsForClient(
  records: StoredKeywordRecord[],
  options: KeywordPipelineOptions = {},
) {
  return records.map((record) => {
    const candidate: KeywordCandidate = {
      phrase: record.keyword_text,
      volume: record.avg_monthly_searches ?? 0,
      competition: record.competition ?? null,
      suggested_bid: record.suggested_bid != null ? Number(record.suggested_bid) : null,
      source: "stored",
    };
    const optimized = describeOptimizedKeyword(candidate, options);
    return {
      id: record.id,
      keyword_text: record.keyword_text,
      match_type: record.match_type,
      avg_monthly_searches: candidate.volume || null,
      competition: record.competition ?? null,
      suggested_bid: candidate.suggested_bid,
      score: optimized.score,
      reason: optimized.reason,
      recommended_match_type: optimized.recommended_match_type,
      competition_band: optimized.competition_band,
    };
  });
}
