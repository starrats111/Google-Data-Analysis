/**
 * D-314.1（07 2026-09-04「美金要换算成人民币显示在月度和年度报表里」）：
 * 银行流水的美金条目在报表侧按**到账日汇率**折成人民币，再喂给原有的人民币聚合。
 * 折 amount / fee / breakdown 三者用同一个汇率；查不到当日汇率的返回 null，
 * 由调用方记进 warnings —— 绝不按 1:1 混进人民币口径。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bankRowToCny } from "../src/lib/monthly-report";

/** 固定汇率 7.10 的查找器；2026-09-01 之前查不到快照（模拟早于最早快照的情况） */
const rateOf = (d: Date) => (d.toISOString().slice(0, 10) >= "2026-09-01" ? 7.1 : 0);

const usdEntry = (over: Record<string, unknown> = {}) => ({
  platform: "PM",
  txn_at: new Date("2026-09-02T10:00:00Z"),
  currency: "USD",
  amount: 995,
  fee: 5,
  breakdown: JSON.stringify([
    { userId: "5", username: "wj04", platform: "PM", account: "a", amount: 600 },
    { userId: "6", username: "wj05", platform: "PM", account: "b", amount: 400 },
  ]),
  ...over,
});

describe("D-314.1 美金条目按到账日汇率折成人民币", () => {
  it("amount / fee / 明细金额三者同一个汇率", () => {
    const c = bankRowToCny(usdEntry(), rateOf)!;
    assert.equal(c.amount, 7064.5);   // 995 × 7.1
    assert.equal(c.fee, 35.5);        // 5 × 7.1
    const items = JSON.parse(c.breakdown!) as { amount: number }[];
    assert.deepEqual(items.map((i) => i.amount), [4260, 2840]); // 600/400 × 7.1
  });

  it("「明细合计 − 手续费 = 到账」折算后仍然成立", () => {
    const c = bankRowToCny(usdEntry(), rateOf)!;
    const items = JSON.parse(c.breakdown!) as { amount: number }[];
    const expected = items.reduce((s, i) => s + i.amount, 0);
    assert.ok(Math.abs(expected - Number(c.fee) - Number(c.amount)) <= 0.02, "恒等式漂移超过 2 分");
  });

  it("人民币条目原样返回（同一个对象，不做任何折算）", () => {
    const cny = usdEntry({ currency: "CNY" });
    assert.equal(bankRowToCny(cny, rateOf), cny);
  });

  it("查不到当日汇率 → 返回 null（调用方报警，不按 1:1 混进人民币）", () => {
    assert.equal(bankRowToCny(usdEntry({ txn_at: new Date("2026-08-20T10:00:00Z") }), rateOf), null);
  });

  it("明细是脏数据时不炸，金额照常折算", () => {
    const c = bankRowToCny(usdEntry({ breakdown: "{坏掉的 json" }), rateOf)!;
    assert.equal(c.amount, 7064.5);
    assert.equal(c.breakdown, "{坏掉的 json");
  });

  it("没有 fee 字段的查询（月度组长表只选了 amount）不会凭空造出 fee", () => {
    const row = { platform: "PM", txn_at: new Date("2026-09-02T10:00:00Z"), currency: "USD", amount: 995, breakdown: null };
    const c = bankRowToCny(row, rateOf)!;
    assert.equal(c.amount, 7064.5);
    assert.ok(!("fee" in c));
  });
});
