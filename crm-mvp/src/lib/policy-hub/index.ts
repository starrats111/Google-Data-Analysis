/**
 * D-041 / Policy Hub — Google Ads 政策合规中台统一导出
 *
 * 中台职责（4 大类 30+ 子项 × 6 个 AI 流统一接入点）：
 *   1. policy-categories.ts — 政策映射知识库（基于 Google Ads Policy Center 原文）
 *   2. error-parser.ts — Google Ads API 错误深度解析器（PolicyTopicEntry/policyViolationDetails）
 *   3. violation-logger.ts — policy_violations 表写入器
 *
 * 后续模块（D-042 ~ D-045）：
 *   - policy-kb/ — 4 大类原文 markdown 存档（D-042）
 *   - merchant-policy-profile.ts — 商家政策画像（D-043）
 *   - policy-prompt-injector.ts — Prompt 动态注入（D-044）
 *   - policy-update-monitor.ts — 政策更新告警（D-045）
 */

export {
  POLICY_CATEGORY_MAP,
  POLICY_CATEGORY_LABELS,
  mapToPolicyCategory,
  type PolicyCategoryEntry,
  type PolicyCategoryId,
} from "./policy-categories";

export {
  parsePolicyError,
  getViolatingOperationIndices,
  type ParsedPolicyError,
  type ParsedPolicyResult,
} from "./error-parser";

export {
  logPolicyViolations,
  markViolationResolved,
  serializeForLog,
  type LogPolicyViolationContext,
} from "./violation-logger";
