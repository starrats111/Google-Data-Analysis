/**
 * D-251 换 CID 续跑的佣金归属：同日交接特例
 *
 * 口径（徐克提出、07 2026-08-18 拍板）：
 * - 老系列投放期与停投后缝隙期（cookie 滞后单）的佣金归老；
 * - 新系列从开始花钱那天起接管佣金；
 * - 若「老的最后花费日」=「新的首个花费日」（同天停老上新），当天归老、新从次日起算；
 * - 其余同日多系列花费仍按「当日花费最高者整拿」（07 2026-08-04 拍板，不回退）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAttributionIndex,
  resolveAttributionTarget,
  type AttributionCampaign,
  type AttributionSpendDay,
} from "../src/lib/commission-attribution";

const MERCHANT = "m1";
const CONN = "c1";

function campaign(id: string): AttributionCampaign {
  return { id, userMerchantId: MERCHANT, platformConnectionId: CONN };
}

function spend(campaignId: string, date: string, cost: number): AttributionSpendDay {
  return { campaignId, date, cost };
}

/** 无代表行兜底地解析归属（测试里只关心时间轴） */
function resolve(
  campaigns: AttributionCampaign[],
  spendDays: AttributionSpendDay[],
  txnDate: string,
): string | null {
  const index = buildAttributionIndex(campaigns, spendDays);
  return resolveAttributionTarget(index, new Map(), MERCHANT, CONN, txnDate);
}

describe("D-251 同日交接：老的最后花费日 = 新的首个花费日", () => {
  // 老 old 投 08-01 ~ 08-05，新 new 从 08-05 起接管（同天停老上新）
  const handover = [
    spend("old", "2026-08-01", 5),
    spend("old", "2026-08-04", 6),
    spend("old", "2026-08-05", 2),
    spend("new", "2026-08-05", 9), // 新当天花得比老多，特例仍要求归老
    spend("new", "2026-08-06", 8),
  ];
  const cs = [campaign("old"), campaign("new")];

  it("交接当天的佣金归老（即使新当天花费更高）", () => {
    assert.equal(resolve(cs, handover, "2026-08-05"), "old");
  });

  it("交接次日起归新", () => {
    assert.equal(resolve(cs, handover, "2026-08-06"), "new");
    assert.equal(resolve(cs, handover, "2026-08-10"), "new");
  });

  it("交接前照常归老", () => {
    assert.equal(resolve(cs, handover, "2026-08-03"), "old");
  });
});

describe("D-251 不触发特例的场景维持旧口径", () => {
  it("缝隙期（老停后、新上前）的 cookie 单回溯归老", () => {
    const days = [
      spend("old", "2026-08-01", 5),
      spend("old", "2026-08-03", 4), // 老最后花费日
      spend("new", "2026-08-08", 7), // 新隔了几天才上
    ];
    const cs = [campaign("old"), campaign("new")];
    assert.equal(resolve(cs, days, "2026-08-05"), "old"); // 缝隙期
    assert.equal(resolve(cs, days, "2026-08-08"), "new"); // 无同日冲突，上广告当天即归新
  });

  it("老没停（当天不是其最后花费日）时，同日并跑仍按花费最高者", () => {
    const days = [
      spend("a", "2026-08-01", 5),
      spend("a", "2026-08-05", 3),
      spend("b", "2026-08-05", 9), // b 当天首投且花更多，但 a 之后还在投 → 非交接
      spend("a", "2026-08-06", 4),
      spend("b", "2026-08-06", 1),
    ];
    const cs = [campaign("a"), campaign("b")];
    assert.equal(resolve(cs, days, "2026-08-05"), "b"); // 花费最高者
    assert.equal(resolve(cs, days, "2026-08-06"), "a");
  });

  it("同日都是首投（无老可归）时按花费最高者", () => {
    const days = [
      spend("a", "2026-08-05", 3),
      spend("b", "2026-08-05", 9),
    ];
    const cs = [campaign("a"), campaign("b")];
    assert.equal(resolve(cs, days, "2026-08-05"), "b");
  });

  it("单系列多行同日（gcid 去重后的重复行）取最大花费，不影响归属", () => {
    const days = [
      spend("a", "2026-08-05", 3),
      spend("a", "2026-08-05", 8), // 同系列重复行
      spend("b", "2026-08-05", 5),
    ];
    const cs = [campaign("a"), campaign("b")];
    assert.equal(resolve(cs, days, "2026-08-05"), "a");
  });

  it("交易早于全部花费记录时回退代表行", () => {
    const index = buildAttributionIndex(
      [campaign("a")],
      [spend("a", "2026-08-10", 5)],
    );
    const fallback = new Map([[`${MERCHANT}:${CONN}`, "rep"]]);
    assert.equal(
      resolveAttributionTarget(index, fallback, MERCHANT, CONN, "2026-08-01"),
      "rep",
    );
  });
});

describe("D-251 多系列混合交接", () => {
  it("三方同日：老 A 停、新 B 上、在跑 C 继续 → 当天归停投的老 A", () => {
    const days = [
      spend("A", "2026-08-01", 5),
      spend("C", "2026-08-01", 2),
      spend("A", "2026-08-05", 2), // A 最后花费日
      spend("B", "2026-08-05", 9), // B 首投
      spend("C", "2026-08-05", 6), // C 前后都在投
      spend("C", "2026-08-06", 6),
    ];
    const cs = [campaign("A"), campaign("B"), campaign("C")];
    assert.equal(resolve(cs, days, "2026-08-05"), "A");
  });

  it("多条老同日交接时归当日花费最高的老", () => {
    const days = [
      spend("A1", "2026-08-01", 5),
      spend("A2", "2026-08-02", 5),
      spend("A1", "2026-08-05", 2),
      spend("A2", "2026-08-05", 7), // 两条老同天停，A2 当天花更多
      spend("B", "2026-08-05", 9),  // 新
    ];
    const cs = [campaign("A1"), campaign("A2"), campaign("B")];
    assert.equal(resolve(cs, days, "2026-08-05"), "A2");
  });
});
