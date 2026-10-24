/**
 * D-346 重投放按系列名里的投放日期接管
 *
 * 07 2026-09-21：「八月十五号投了一个广告，八月二十号停掉，后面又重新投放了，
 * 数据要跟着新的投放时间统计，前面的数据和新的数据不能混在一起。」
 *
 * 纯花费口径下有个真空期：新系列名字写 0909、但审核/预算原因 0910 才跑出花费，
 * 0909 那天的单会回溯到上一条早就停投的系列头上。现在接管点提前到名字里的日期。
 *
 * 三个闸门（缺一不可，见 commission-attribution.ts 文件头 D-346）：
 *   1. 新系列自己确实花过钱（从没投放的不参选）；
 *   2. 名字日期早于它自己的首个花费日；
 *   3. 那天没有任何系列真的在花钱。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAttributionIndex,
  resolveAttributionTarget,
  parseCampaignNameDate,
  type AttributionCampaign,
  type AttributionSpendDay,
} from "../src/lib/commission-attribution";

const MERCHANT = "m1";
const CONN = "c1";

const camp = (id: string, name: string | null, createdAt: string | null): AttributionCampaign => ({
  id,
  userMerchantId: MERCHANT,
  platformConnectionId: CONN,
  campaignName: name,
  createdAt,
});
const spend = (campaignId: string, date: string, cost: number): AttributionSpendDay => ({
  campaignId, date, cost,
});

function resolve(
  campaigns: AttributionCampaign[],
  spendDays: AttributionSpendDay[],
  txnDate: string,
  fallback: Map<string, string> = new Map(),
): string | null {
  return resolveAttributionTarget(
    buildAttributionIndex(campaigns, spendDays),
    fallback,
    MERCHANT,
    CONN,
    txnDate,
  );
}

describe("D-346 parseCampaignNameDate", () => {
  it("解析末段 -MMDD-MID", () => {
    assert.equal(
      parseCampaignNameDate("171-MUI1-ecoflow-US-0909-18650274", "2026-09-09T02:00:00Z"),
      "2026-09-09",
    );
  });

  it("年份用 created_at 做锚", () => {
    assert.equal(parseCampaignNameDate("1-MUI1-x-US-0315-123", "2025-03-15T00:00:00Z"), "2025-03-15");
  });

  it("跨年按就近校正：12 月底建档、名字写 0103 → 次年", () => {
    assert.equal(parseCampaignNameDate("1-MUI1-x-US-0103-123", "2025-12-28T00:00:00Z"), "2026-01-03");
  });

  it("跨年反向：1 月初建档、名字写 1230 → 上一年", () => {
    assert.equal(parseCampaignNameDate("1-MUI1-x-US-1230-123", "2026-01-02T00:00:00Z"), "2025-12-30");
  });

  it("名字里没有日期段 / 缺 created_at → null（退回纯花费口径）", () => {
    assert.equal(parseCampaignNameDate("6-23-18653497", "2026-06-23T00:00:00Z"), null);
    assert.equal(parseCampaignNameDate("1-MUI1-x-US-0909-123", null), null);
    assert.equal(parseCampaignNameDate(null, "2026-09-09T00:00:00Z"), null);
  });

  it("非法月日不采信", () => {
    assert.equal(parseCampaignNameDate("1-MUI1-x-US-1345-123", "2026-09-09T00:00:00Z"), null);
  });
});

describe("D-346 停投后重投放：真空期归新系列", () => {
  // 生产还原（wj08 / ecoflow 18650274）：
  // 884 名字 0809，投 8/9~8/12 后停；171 名字 0909，9/10 才跑出花费。
  // 9/9 那单：纯花费口径回溯到 884，按名字应归 171。
  const cs = [
    camp("884", "884-MUI1-ecoflow-US-0809-18650274", "2026-08-09T00:00:00Z"),
    camp("171", "171-MUI1-ecoflow-US-0909-18650274", "2026-09-09T00:00:00Z"),
  ];
  const days = [
    spend("884", "2026-08-09", 3),
    spend("884", "2026-08-12", 4),
    spend("171", "2026-09-10", 0.08),
  ];

  it("名字日期当天的单归新系列，不再回溯到早就停投的旧系列", () => {
    assert.equal(resolve(cs, days, "2026-09-09"), "171");
  });

  it("名字日期之后、真正花钱之前的日子同样归新系列", () => {
    // 171 名字 0909、首个花费日 0912：9/10 与 9/11 都在真空期
    const lateSpend = [
      spend("884", "2026-08-09", 3),
      spend("884", "2026-08-12", 4),
      spend("171", "2026-09-12", 1),
    ];
    assert.equal(resolve(cs, lateSpend, "2026-09-10"), "171");
    assert.equal(resolve(cs, lateSpend, "2026-09-11"), "171");
  });

  it("名字日期之前仍归旧系列（前后不混）", () => {
    assert.equal(resolve(cs, days, "2026-09-08"), "884");
    assert.equal(resolve(cs, days, "2026-08-20"), "884");
  });

  it("新系列真正开投后照常归它", () => {
    assert.equal(resolve(cs, days, "2026-09-10"), "171");
    assert.equal(resolve(cs, days, "2026-09-30"), "171");
  });
});

describe("D-346 闸门一：从没花过钱的系列不参选", () => {
  // 生产还原（yz04 / bellamiacollections 18688666）：
  // 181 名字 0901 但零花费零点击；979 名字 0726 从 7/26 一直投到 9/20 没停过。
  const cs = [
    camp("979", "979-CG1-bellamiacollections-US-0726-18688666", "2026-07-26T00:00:00Z"),
    camp("181", "181-CG1-bellamiacollections-US-0901-18688666", "2026-09-01T00:00:00Z"),
  ];
  const days = [
    spend("979", "2026-07-26", 5),
    spend("979", "2026-09-20", 9),
  ];

  it("名字日期到了但那条从没投放 → 佣金留在真正花钱的系列上", () => {
    // 9/1 名字日期已到，但 181 零花费；9/5 是 979 的花费真空期
    assert.equal(resolve(cs, days, "2026-09-01"), "979");
    assert.equal(resolve(cs, days, "2026-09-05"), "979");
  });
});

describe("D-346 真花钱的日子不让名字抢走，接管顺延到次日", () => {
  // 旧系列 9/9 还在花钱，新系列名字也写 0909 → 当天归旧（D-168 不变），9/10 起归新
  const cs = [
    camp("old", "old-MUI1-x-US-0801-1", "2026-08-01T00:00:00Z"),
    camp("new", "new-MUI1-x-US-0909-1", "2026-09-09T00:00:00Z"),
  ];
  const days = [
    spend("old", "2026-09-09", 50),
    spend("new", "2026-09-15", 1),
  ];

  it("那天旧系列真的在花钱 → 仍归旧系列", () => {
    assert.equal(resolve(cs, days, "2026-09-09"), "old");
  });

  it("次日起归新系列（真空期不再回到旧系列）", () => {
    assert.equal(resolve(cs, days, "2026-09-10"), "new");
    assert.equal(resolve(cs, days, "2026-09-12"), "new");
  });
});

describe("D-346 并行投放不受影响", () => {
  // 两条都在跑、名字日期不同：各自花费日各有格子，按当日花费最高者
  const cs = [
    camp("a", "a-LB1-DOGCHEF-FR-0910-377567", "2026-09-10T00:00:00Z"),
    camp("b", "b-LB1-DOGCHEF-FR-0915-377567", "2026-09-15T00:00:00Z"),
  ];
  const days = [
    spend("a", "2026-09-14", 6),
    spend("a", "2026-09-16", 9),
    spend("b", "2026-09-15", 1.5),
    spend("b", "2026-09-16", 3),
  ];

  it("b 的名字日期当天 b 自己就在花钱，无需插格", () => {
    assert.equal(resolve(cs, days, "2026-09-15"), "b");
  });

  it("同日双方都花钱时归当日最高（a 9/16 花 9 > b 花 3）", () => {
    assert.equal(resolve(cs, days, "2026-09-16"), "a");
  });
});

describe("D-346 名字解析失败时退回纯花费口径", () => {
  const cs = [
    camp("old", "6-23-18653497", "2026-06-23T00:00:00Z"),      // 无日期段
    camp("new", null, "2026-09-09T00:00:00Z"),                  // 无名字
  ];
  const days = [spend("old", "2026-08-01", 5), spend("new", "2026-09-10", 2)];

  it("解析不出日期就不插格，行为与 D-345 一致", () => {
    assert.equal(resolve(cs, days, "2026-09-09"), "old");
    assert.equal(resolve(cs, days, "2026-09-10"), "new");
  });
});
