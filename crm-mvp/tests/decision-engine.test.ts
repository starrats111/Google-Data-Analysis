import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildSnapshot,
  buildDecisionId,
  decide,
  buildOutcome,
  judgeDecision,
} from "../src/lib/decision-engine";

function snap(over: Partial<Parameters<typeof buildSnapshot>[0]> = {}) {
  return buildSnapshot({
    spend: 100,
    commission: 100,
    clicks: 200,
    orders: 5,
    impressions: 5000,
    dailyBudget: 30,
    daysRunning: 10,
    ...over,
  });
}

describe("buildSnapshot", () => {
  test("ROI 计算：(佣金-花费)/花费*100，取整", () => {
    assert.equal(snap({ spend: 100, commission: 150 }).roi, 50);
    assert.equal(snap({ spend: 100, commission: 40 }).roi, -60);
  });

  test("花费为 0 时 ROI 为 0（不除零）", () => {
    assert.equal(snap({ spend: 0, commission: 50 }).roi, 0);
  });
});

describe("buildDecisionId", () => {
  test("同系列同日期幂等", () => {
    const d = new Date("2026-07-09T03:00:00Z");
    assert.equal(buildDecisionId(BigInt(42), d), "42_2026-07-09");
    assert.equal(buildDecisionId("42", d), buildDecisionId(BigInt(42), d));
  });
});

describe("decide 规则优先级", () => {
  test("花费不足 $5 → observe（即使深度亏损）", () => {
    const d = decide(snap({ spend: 3, commission: 0 }));
    assert.equal(d.actionType, "observe");
  });

  test("运行 ≥30 天零成单且花费 ≥$20 → pause", () => {
    const d = decide(snap({ daysRunning: 45, orders: 0, spend: 50, commission: 0 }));
    assert.equal(d.actionType, "pause");
  });

  test("ROI ≤ -80 → pause", () => {
    const d = decide(snap({ spend: 100, commission: 10 }));
    assert.equal(d.actionType, "pause");
  });

  test("-80 < ROI < -30 → decrease_budget -30%", () => {
    const d = decide(snap({ spend: 100, commission: 50 }));
    assert.equal(d.actionType, "decrease_budget");
    assert.equal(d.magnitude, "-30%");
  });

  test("ROI ≥ 80 且花费顶满预算 → increase_budget +20%", () => {
    // 日预算 20 × 7 天 = 140，花费 130 > 85% 阈值
    const d = decide(snap({ spend: 130, commission: 260, dailyBudget: 20 }));
    assert.equal(d.actionType, "increase_budget");
    assert.equal(d.magnitude, "+20%");
  });

  test("ROI 高但预算未顶满 → keep（不盲目加预算）", () => {
    const d = decide(snap({ spend: 50, commission: 120, dailyBudget: 30 }));
    assert.equal(d.actionType, "keep");
  });

  test("普通区间 → keep", () => {
    const d = decide(snap({ spend: 100, commission: 110 }));
    assert.equal(d.actionType, "keep");
  });
});

describe("judgeDecision", () => {
  const out = (roi: number, spend = 50) => buildOutcome({ spend, commission: spend * (1 + roi / 100), orders: 1 });

  test("后续无数据 → no_data", () => {
    assert.equal(judgeDecision("pause", -90, buildOutcome({ spend: 0, commission: 0, orders: 0 })), "no_data");
  });

  test("pause/decrease：后续继续亏 → correct；后续大幅转盈 → wrong", () => {
    assert.equal(judgeDecision("pause", -90, out(-50)), "correct");
    assert.equal(judgeDecision("decrease_budget", -50, out(-20)), "correct");
    assert.equal(judgeDecision("pause", -90, out(100)), "wrong");
  });

  test("increase：后续保持高盈利 → correct；转亏 → wrong", () => {
    assert.equal(judgeDecision("increase_budget", 100, out(80)), "correct");
    assert.equal(judgeDecision("increase_budget", 100, out(10)), "partial");
    assert.equal(judgeDecision("increase_budget", 100, out(-30)), "wrong");
  });

  test("keep/observe：未大幅恶化 → correct；暴跌 → wrong", () => {
    assert.equal(judgeDecision("keep", 20, out(10)), "correct");
    assert.equal(judgeDecision("keep", 50, out(0)), "partial");
    assert.equal(judgeDecision("observe", 50, out(-60)), "wrong");
  });
});
