/**
 * Token 池的纯决策逻辑（从 token-pool.ts 抽出，无 DB/无模块态，可单测）。
 * token-pool.ts 负责状态管理与落库，本文件只做判定。
 */

/** 池内 token 的自动体检元数据 */
export interface TokenQuotaMeta {
  healthStatus: string;
  /** {"<mcc客户号>": "ok" | "denied"} */
  mccAccess: Record<string, string>;
  /** 实测额度（触顶反推）；null = 未触顶过 */
  detectedQuota: number | null;
  /** 组长手填额度 */
  dailyQuota: number;
  /** 今日已用 */
  todayRequests: number;
}

/**
 * 今日剩余额度：实测额度（触顶反推）优先，否则组长预设，减去今日已用。
 * 非池内凭证（无元数据）返回 -1 表示最后兜底。
 */
export function remainingQuotaOf(meta: TokenQuotaMeta | undefined): number {
  if (!meta) return -1;
  const quota = meta.detectedQuota ?? meta.dailyQuota;
  return quota - meta.todayRequests;
}

/**
 * 该凭证对此 MCC 是否可用（unknown 视为可用，让真实流量去探明）。
 * @param deniedPair 实时学到的「token|mcc 无权限」标记（DB 缓存有延迟，内存立即生效）
 */
export function isTokenUsableForMcc(
  meta: TokenQuotaMeta | undefined,
  deniedPair: boolean,
  mccKey: string,
): boolean {
  if (deniedPair) return false;
  if (!meta) return true; // 环境变量/MCC 自带凭证无元数据，不设限
  if (meta.healthStatus === "invalid") return false;
  if (meta.mccAccess[mccKey] === "denied") return false;
  // 实测出真实额度后，当日用量触顶的 token 直接跳过，不再撞墙
  if (meta.detectedQuota != null && meta.todayRequests >= meta.detectedQuota) return false;
  return true;
}

/**
 * 判定一次 429 是否属于「每日额度耗尽」（区别于短时 QPS 限流）：
 * RESOURCE_EXHAUSTED（非 TEMPORARILY）且 retryDelay 很长或错误体提到每日配额。
 */
export function isDailyQuotaExhausted(retryDelaySec: number | undefined, errBody: string | undefined): boolean {
  return (
    !!errBody
    && errBody.includes("RESOURCE_EXHAUSTED")
    && !errBody.includes("RESOURCE_TEMPORARILY_EXHAUSTED")
    && ((retryDelaySec ?? 0) > 600 || /daily|per day|quota/i.test(errBody))
  );
}
