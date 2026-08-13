/**
 * 广告创建 · 缺口报告（gap report）类型定义 + 终结合并函数。
 *
 * 设计要点：
 * - `finalizeGapReport` 是代码侧的"权威裁决者"：它始终用 `headlinesCount` /
 *   `descriptionsCount` 重算 `breaksRsaMinimum`，忽略模型自述的同名字段。
 *   这避免了模型"说没破，但数值明显破了"的幻觉。
 * - `rejectionCounts` 用 `??` 合并默认 0，保留 AI 明确返回的 0。
 * - `R_LEN` 是代码侧新增的红线：条目因超过 Google Ads 字符上限被丢弃
 *   （filter 模式不截断，直接丢弃；`R_LEN` 由 sanitizer 单独累加）。
 * - `suggestionReason` 仅在破下限时填中文原因，否则为 `null`。
 */

export const HEADLINES_MIN_REQUIRED = 3;
export const DESCRIPTIONS_MIN_REQUIRED = 2;

export type RejectionCounts = {
  R1: number;
  R2: number;
  R3: number;
  R4: number;
  R5: number;
  R6: number;
  R_LEN: number;
};

export interface RawGapReport {
  headlinesCount: number;
  descriptionsCount: number;
  sitelinksCount: number;
  thresholdStoppedAt?: number | null;
  rejectionCounts?: Partial<RejectionCounts>;
  breaksRsaMinimum?: boolean;
  suggestSwitchToAiGenerate?: boolean;
  suggestionReason?: string | null;
}

export interface GapReport {
  headlinesCount: number;
  descriptionsCount: number;
  sitelinksCount: number;
  headlinesMinRequired: number;
  descriptionsMinRequired: number;
  thresholdStoppedAt: number | null;
  rejectionCounts: RejectionCounts;
  breaksRsaMinimum: boolean;
  suggestSwitchToAiGenerate: boolean;
  suggestionReason: string | null;
}

function mergeRejection(raw?: Partial<RejectionCounts>): RejectionCounts {
  return {
    R1: raw?.R1 ?? 0,
    R2: raw?.R2 ?? 0,
    R3: raw?.R3 ?? 0,
    R4: raw?.R4 ?? 0,
    R5: raw?.R5 ?? 0,
    R6: raw?.R6 ?? 0,
    R_LEN: raw?.R_LEN ?? 0,
  };
}

/**
 * 代码侧合并：以 RSA 最小下限为唯一权威，
 * 忽略模型自述的 `breaksRsaMinimum` / `suggestSwitchToAiGenerate`。
 */
export function finalizeGapReport(raw: RawGapReport): GapReport {
  const breaks =
    raw.headlinesCount < HEADLINES_MIN_REQUIRED ||
    raw.descriptionsCount < DESCRIPTIONS_MIN_REQUIRED;
  const rejectionCounts = mergeRejection(raw.rejectionCounts);
  const rejectionDetails: string[] = [];
  if (rejectionCounts.R5 > 0) {
    rejectionDetails.push(`其中 ${rejectionCounts.R5} 条候选因包含第三方品牌词或引流到非官方站点按 R5 剔除`);
  }
  if (rejectionCounts.R_LEN > 0) {
    rejectionDetails.push(`其中 ${rejectionCounts.R_LEN} 条候选因超过 Google Ads 字符上限被剔除`);
  }
  const suggestionReason = breaks
    ? [
        `当前筛选产出 ${raw.headlinesCount} 条标题 / ${raw.descriptionsCount} 条描述，未满足 Google Ads RSA 下限（≥${HEADLINES_MIN_REQUIRED} 标题、≥${DESCRIPTIONS_MIN_REQUIRED} 描述）`,
        ...rejectionDetails,
        "建议切换至 AI 生成模式重跑。",
      ].join("；")
    : null;

  return {
    headlinesCount: raw.headlinesCount,
    descriptionsCount: raw.descriptionsCount,
    sitelinksCount: raw.sitelinksCount,
    headlinesMinRequired: HEADLINES_MIN_REQUIRED,
    descriptionsMinRequired: DESCRIPTIONS_MIN_REQUIRED,
    thresholdStoppedAt: raw.thresholdStoppedAt ?? null,
    rejectionCounts,
    breaksRsaMinimum: breaks,
    suggestSwitchToAiGenerate: breaks,
    suggestionReason,
  };
}
