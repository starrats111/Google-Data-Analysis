/**
 * 广告系列决策引擎（批次6，参照 kyads decision-journal 思路，规则版 v1）
 *
 * 输入：单个广告系列近 7 天的聚合表现快照
 * 输出：结构化建议（action_type + 幅度 + 理由），写入 ad_decision_journal，
 *       3/7 天后由 track-outcomes cron 回填实际走势并评判建议对错。
 *
 * v1 是确定性规则（不调 LLM）：可测试、零成本、结果可复现。
 * 规则只产出「建议」，不自动执行——执行与否由投手决定，闭环评估的是建议质量。
 */

export interface CampaignSnapshot {
  /** 近 7 天花费（USD） */
  spend: number;
  /** 近 7 天净佣金（总佣金 - 拒付，USD） */
  commission: number;
  clicks: number;
  orders: number;
  impressions: number;
  /** 当前日预算（USD，未知为 0） */
  dailyBudget: number;
  /** 运行天数（创建至今） */
  daysRunning: number;
  /** ROI %（(佣金-花费)/花费*100；花费为 0 时无意义） */
  roi: number;
}

export type DecisionActionType =
  | "pause"
  | "decrease_budget"
  | "increase_budget"
  | "keep"
  | "observe";

export interface Decision {
  actionType: DecisionActionType;
  /** 建议幅度，如 "-30%" / "+20%"；无幅度动作为 null */
  magnitude: string | null;
  reasoning: string;
}

export function buildSnapshot(input: {
  spend: number;
  commission: number;
  clicks: number;
  orders: number;
  impressions: number;
  dailyBudget: number;
  daysRunning: number;
}): CampaignSnapshot {
  const roi = input.spend > 0 ? ((input.commission - input.spend) / input.spend) * 100 : 0;
  return { ...input, roi: Math.round(roi) };
}

/** 决策 ID：同一系列同一天只有一条（cron 幂等重跑不产生重复建议） */
export function buildDecisionId(campaignId: string | bigint, date: Date): string {
  return `${campaignId}_${date.toISOString().slice(0, 10)}`;
}

const MIN_SPEND_FOR_JUDGEMENT = 5;

/** 规则决策（顺序即优先级） */
export function decide(s: CampaignSnapshot): Decision {
  // 数据太少：先观察，不折腾
  if (s.spend < MIN_SPEND_FOR_JUDGEMENT) {
    return {
      actionType: "observe",
      magnitude: null,
      reasoning: `近7天花费仅 $${s.spend.toFixed(2)}，数据量不足以判断，继续观察`,
    };
  }

  // 结构性失败：跑了足够久、烧了钱、零成单 → 建议暂停
  if (s.daysRunning >= 30 && s.orders === 0 && s.spend >= 20) {
    return {
      actionType: "pause",
      magnitude: null,
      reasoning: `运行 ${s.daysRunning} 天、近7天花费 $${s.spend.toFixed(2)} 零成单，属结构性失败，建议暂停止损`,
    };
  }

  // 深度亏损 → 暂停
  if (s.roi <= -80) {
    return {
      actionType: "pause",
      magnitude: null,
      reasoning: `近7天 ROI ${s.roi}%（花费 $${s.spend.toFixed(2)} / 佣金 $${s.commission.toFixed(2)}），深度亏损，建议暂停`,
    };
  }

  // 明显亏损 → 减预算
  if (s.roi < -30) {
    return {
      actionType: "decrease_budget",
      magnitude: "-30%",
      reasoning: `近7天 ROI ${s.roi}%，持续亏损，建议预算下调 30% 控制损失后再观察`,
    };
  }

  // 高盈利且预算可能吃紧（日预算 * 7 与实际花费接近说明预算顶满）→ 加预算
  const budgetCapped = s.dailyBudget > 0 && s.spend >= s.dailyBudget * 7 * 0.85;
  if (s.roi >= 80 && budgetCapped) {
    return {
      actionType: "increase_budget",
      magnitude: "+20%",
      reasoning: `近7天 ROI ${s.roi}% 且花费已接近预算上限（$${s.spend.toFixed(2)} / 日预算 $${s.dailyBudget.toFixed(2)}×7），建议加预算 20% 扩量`,
    };
  }

  // 其余：维持
  return {
    actionType: "keep",
    magnitude: null,
    reasoning: `近7天 ROI ${s.roi}%（花费 $${s.spend.toFixed(2)} / 佣金 $${s.commission.toFixed(2)}），表现在可接受区间，维持现状`,
  };
}

// ─────────────────────── 结果回验（track-outcomes cron 用） ───────────────────────

export interface OutcomeData {
  spend: number;
  commission: number;
  orders: number;
  roi: number;
}

export function buildOutcome(input: { spend: number; commission: number; orders: number }): OutcomeData {
  const roi = input.spend > 0 ? ((input.commission - input.spend) / input.spend) * 100 : 0;
  return { ...input, roi: Math.round(roi) };
}

export type Verdict = "correct" | "partial" | "wrong" | "no_data";

/**
 * 评判建议质量：建议时点的快照 vs 建议后 7 天的实际走势。
 * 注意建议不一定被执行——这里评的是「建议方向是否被后续数据验证」：
 * - pause/decrease：后续继续亏（roi<0）→ 建议正确；后续转盈 → 建议错误
 * - increase：后续保持盈利（roi>=50）→ 正确；转亏 → 错误
 * - keep/observe：后续未大幅恶化（roi 降幅 <30pp）→ 正确
 */
export function judgeDecision(actionType: DecisionActionType, snapshotRoi: number, outcome: OutcomeData): Verdict {
  if (outcome.spend === 0 && outcome.commission === 0) return "no_data";

  switch (actionType) {
    case "pause":
    case "decrease_budget": {
      if (outcome.roi < 0) return "correct";
      if (outcome.roi < 30) return "partial";
      return "wrong";
    }
    case "increase_budget": {
      if (outcome.roi >= 50) return "correct";
      if (outcome.roi >= 0) return "partial";
      return "wrong";
    }
    case "keep":
    case "observe": {
      const delta = outcome.roi - snapshotRoi;
      if (delta >= -30) return "correct";
      if (delta >= -60) return "partial";
      return "wrong";
    }
  }
}
