/**
 * D-355（wj04 2026-09-24 报障：1 月报表 MYMCC1209 与 zwjmcc11261 各出两行——
 * 在投行 1,590.99 / 1,038.33，已删行 1,582.99 / 772.93——广告费合计 4,985.24 多算 2,355.92）：
 * 同一个 Google MCC 号删号重绑会在 google_mcc_accounts 留多行（生产实测最多 8 行），
 * 旧行与接替它的新行各自挂着同一批 ads_daily_stats，两行同时进合计 → 广告费翻倍。
 *
 * 去重在 SQL 里（按 `(号, 日, google_campaign_id)` 取最大值）；这里测的是**锚点行选择**——
 * 它决定补差额与手填覆盖搬到哪一行，搬错就静默失效（生产有 28 条 mcc:* 覆盖在跑）。
 * 锚点规则：未删优先 → 最近更新 → id 大者。必须与年报那段 SQL 的 ORDER BY 一致。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRowToAnchor, type MccAnchorRow } from "../src/lib/monthly-report";

const row = (id: number, num: string, del: number, updated: string): MccAnchorRow =>
  ({ id, mcc_id: num, is_deleted: del, updated_at: new Date(updated) });

describe("D-355 同号多库行归一到锚点行", () => {
  it("干净重绑（生产 658-633-7448 三行）：锚点取唯一在投行，两条已删行都指向它", () => {
    // 生产实数：14(已删,5) / 48(已删,9) / 66(在投,5)
    const toAnchor = buildRowToAnchor([
      row(14, "658-633-7448", 1, "2026-05-20T07:23:02Z"),
      row(48, "658-633-7448", 1, "2026-05-26T08:58:19Z"),
      row(66, "658-633-7448", 0, "2026-05-26T09:00:37Z"),
    ]);
    assert.equal(toAnchor("14"), "66");
    assert.equal(toAnchor("48"), "66");
    assert.equal(toAnchor("66"), "66", "在投行指向自己");
  });

  it("已删行更新时间更晚也不夺锚点——未删优先级高于时间", () => {
    const toAnchor = buildRowToAnchor([
      row(116, "152-782-6127", 0, "2026-05-28T03:14:28Z"),
      row(47, "152-782-6127", 1, "2026-09-01T00:00:00Z"), // 晚得多
    ]);
    assert.equal(toAnchor("47"), "116");
  });

  it("全部行已删（生产 791-461-8254 / 482-938-3854）：取最近更新的那行，仍有稳定锚点", () => {
    const toAnchor = buildRowToAnchor([
      row(26, "791-461-8254", 1, "2026-03-01T00:00:00Z"),
      row(30, "791-461-8254", 1, "2026-06-01T00:00:00Z"),
    ]);
    assert.equal(toAnchor("26"), "30");
    assert.equal(toAnchor("30"), "30");
  });

  it("更新时间相同则取 id 大者，结果稳定（不随查询顺序抖动）", () => {
    const same = "2026-04-01T00:00:00Z";
    const rows = [
      row(5, "999-000-1111", 1, same),
      row(9, "999-000-1111", 1, same),
      row(7, "999-000-1111", 1, same),
    ];
    assert.equal(buildRowToAnchor(rows)("5"), "9");
    assert.equal(buildRowToAnchor([...rows].reverse())("5"), "9", "与输入顺序无关");
  });

  it("单行号不受影响；未知 id 原样返回（不吞数据）", () => {
    const toAnchor = buildRowToAnchor([row(1, "941-949-6301", 0, "2026-01-01T00:00:00Z")]);
    assert.equal(toAnchor("1"), "1");
    assert.equal(toAnchor("12345"), "12345");
  });

  it("updated_at 为 null 不抛错，排在有时间的行之后", () => {
    const toAnchor = buildRowToAnchor([
      { id: 200, mcc_id: "308-527-6642", is_deleted: 1, updated_at: null },
      row(133, "308-527-6642", 1, "2026-02-01T00:00:00Z"),
    ]);
    assert.equal(toAnchor("200"), "133");
  });

  it("多个号互不串行（8 行那个号与别的号同时存在）", () => {
    const toAnchor = buildRowToAnchor([
      row(127, "494-081-4776", 0, "2026-07-01T00:00:00Z"),
      row(20, "494-081-4776", 1, "2026-03-01T00:00:00Z"),
      row(66, "658-633-7448", 0, "2026-05-26T09:00:37Z"),
      row(14, "658-633-7448", 1, "2026-05-20T07:23:02Z"),
    ]);
    assert.equal(toAnchor("20"), "127");
    assert.equal(toAnchor("14"), "66");
  });
});
