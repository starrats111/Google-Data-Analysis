import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeTodayNewAds, type TodayDbCampaign, type TodaySheetCampaign } from "../src/lib/today-new-ads";

const db = (userId: string, gcid: string, campaignName = ""): TodayDbCampaign =>
  ({ userId, gcid, campaignName });
const sheet = (userId: string, gcid: string, campaignName = ""): TodaySheetCampaign =>
  ({ userId, gcid, campaignName });

const noHistory = new Map<string, Set<string>>();

describe("D-366 今日投放广告：入库时间 != 投放时间，补录影子不算今日新投", () => {
  it("01 报案的真实现场：wj05 卡片 19 条、实际 0 条。MCC 736-710-9619 换人接手，19 条老系列在新主人名下补录", () => {
    // 2026-10-13 01:42 MCC 从 wj07(user 8) 转登记给 wj05(user 6)；
    // 10-14 06:11:37 补录任务一次性插 19 行，created_at 全是同一刻。
    // 这些 gcid 在 user 8 名下 9/14~9/19 就已有行。
    const dbRows = Array.from({ length: 19 }, (_, i) => db("6", `2424940103${i}`, `10${40 + i}-PM1-x-US-0914-1866${i}`));
    const preexistingGcids = new Set(dbRows.map((r) => r.gcid));

    const { countByUser, backfillSkipped } = computeTodayNewAds({
      dbRows,
      preexistingGcids,
      sheetRows: [],
      historicalNamesByUser: noHistory,
    });

    assert.equal(countByUser.get("6") ?? 0, 0, "wj05 今日实际没投放，必须是 0 而不是 19");
    assert.equal(backfillSkipped, 19);
  });

  it("同一天的真新建一条都不能误伤：当天 wj07 2 / yz08 1 / wj11 1 均无更早同 gcid 行", () => {
    const dbRows = [
      db("8", "90000001", "a"), db("8", "90000002", "b"),
      db("30", "90000003", "c"),
      db("39", "90000004", "d"),
    ];
    const { countByUser, backfillSkipped } = computeTodayNewAds({
      dbRows,
      preexistingGcids: new Set(),
      sheetRows: [],
      historicalNamesByUser: noHistory,
    });

    assert.equal(backfillSkipped, 0);
    assert.equal(countByUser.get("8"), 2);
    assert.equal(countByUser.get("30"), 1);
    assert.equal(countByUser.get("39"), 1);
  });

  it("同一人同一批里混着真新建和补录影子 → 只剔影子，真的照算", () => {
    const dbRows = [
      db("6", "OLD-1", "老系列1"),
      db("6", "OLD-2", "老系列2"),
      db("6", "NEW-1", "今天真投的"),
    ];
    const { countByUser, backfillSkipped } = computeTodayNewAds({
      dbRows,
      preexistingGcids: new Set(["OLD-1", "OLD-2"]),
      sheetRows: [],
      historicalNamesByUser: noHistory,
    });

    assert.equal(countByUser.get("6"), 1);
    assert.equal(backfillSkipped, 2);
  });

  it("Sheet 分支不套这个判据：CreationDateCST 是 Google 侧真实创建日，它说今天建的就是今天建的", () => {
    // 场景：广告今天在 Google 后台新建 → Sheet 今日行有它；CRM 也在今天补录了同 gcid，
    // 而原主人名下恰好有同 gcid 的历史行（极端：同一人换 MCC 重登记）。
    // 库内分支剔掉它，但 Sheet 分支仍应把它算进来——否则又回到「静默少算」那头。
    const { countByUser } = computeTodayNewAds({
      dbRows: [db("6", "G-1", "今天建的")],
      preexistingGcids: new Set(["G-1"]),
      sheetRows: [sheet("6", "G-1", "今天建的")],
      historicalNamesByUser: noHistory,
    });
    assert.equal(countByUser.get("6"), 1);
  });

  it("历史同名口径不变：复用旧名字重开的系列不计入（D-302 原有规则）", () => {
    const { countByUser } = computeTodayNewAds({
      dbRows: [db("6", "G-1", "旧名字"), db("6", "G-2", "新名字")],
      preexistingGcids: new Set(),
      sheetRows: [],
      historicalNamesByUser: new Map([["6", new Set(["旧名字"])]]),
    });
    assert.equal(countByUser.get("6"), 1);
  });

  it("同 gcid 在库内与 Sheet 都出现时按 gcid 去重，不翻倍", () => {
    const { countByUser } = computeTodayNewAds({
      dbRows: [db("6", "G-1", "库里的名字")],
      preexistingGcids: new Set(),
      sheetRows: [sheet("6", "G-1", "Sheet 上被改过的名字")],
      historicalNamesByUser: noHistory,
    });
    assert.equal(countByUser.get("6"), 1);
  });

  it("库内先收录的 gcid，其名字不被 Sheet 覆盖：历史同名要拿库里的名字去比（D-225 回写前后不一致）", () => {
    // 库里叫「旧名字」且该人历史用过「旧名字」→ 应判为重开、不计入。
    // 若被 Sheet 的新名字覆盖，就会误算成今日新投。
    const { countByUser } = computeTodayNewAds({
      dbRows: [db("6", "G-1", "旧名字")],
      preexistingGcids: new Set(),
      sheetRows: [sheet("6", "G-1", "Google 后台改后的名字")],
      historicalNamesByUser: new Map([["6", new Set(["旧名字"])]]),
    });
    assert.equal(countByUser.get("6") ?? 0, 0);
  });

  it("无名字的行不走历史同名，按条数算：补录行可能只有 gcid", () => {
    const { countByUser } = computeTodayNewAds({
      dbRows: [db("6", "G-1", "")],
      preexistingGcids: new Set(),
      sheetRows: [],
      historicalNamesByUser: new Map([["6", new Set([""])]]),
    });
    assert.equal(countByUser.get("6"), 1);
  });

  it("全是影子时该人不出现在结果里（卡片显示 —，不是 0 条也不是 19 条）", () => {
    const { countByUser } = computeTodayNewAds({
      dbRows: [db("6", "OLD-1")],
      preexistingGcids: new Set(["OLD-1"]),
      sheetRows: [],
      historicalNamesByUser: noHistory,
    });
    assert.equal(countByUser.has("6"), false);
  });
});
