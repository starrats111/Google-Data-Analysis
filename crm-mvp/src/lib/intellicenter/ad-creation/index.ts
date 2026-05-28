/**
 * C-112 / D-046.C — AI 广告创建智能闭环统一入口
 */

export {
  runIntelligentAdCreation,
  type OrchestratorContext,
  type OrchestratorResult,
  type OrchestratorTask,
  type OrchestratorTaskKind,
} from "./orchestrator";

export { checkReachability, type ReachabilityResult } from "./reachability";
export { ensureCrawlCache, type CrawlerBridgeResult } from "./crawler-bridge";
export {
  generateMerchantProfile,
  type ProfileGenerationContext,
  type ProfileGenerationResult,
} from "./profile-generator";
export {
  policyPreflight,
  type PreflightContext,
  type PreflightResult,
  type AdType,
} from "./policy-preflight";
export {
  runKeywordIntelligence,
  type KeywordCandidate,
  type KeywordIntelligenceContext,
  type KeywordIntelligenceResult,
  type KeywordWithMatchType,
  type MatchType,
} from "./keyword-intelligence";
export { buildEvidencePrompt, type EvidenceContext } from "./evidence-prompt";
export {
  scoreSingle,
  scoreBatch,
  buildRetryHintForLowSimilarity,
  SIMILARITY_THRESHOLD,
  type BatchSimilarityResult,
  type SimilarityScore,
} from "./similarity-scorer";
export { lintAdCopy, type LinterReport } from "./compliance-linter";
