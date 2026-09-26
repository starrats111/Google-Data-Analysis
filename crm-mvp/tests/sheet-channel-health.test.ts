import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyProbe,
  rankChannelRows,
  formatChannelDigest,
  CHANNEL_STATE_LABEL,
  type ChannelHealthRow,
} from "../src/lib/sheet-channel-health";

describe("classifyProbe（D-360 通道判定）", () => {
  test("403 / 权限不足 → PERM_DENIED", () => {
    assert.equal(classifyProbe({ error: "Google Sheet 权限不足，请确保…", wantFirstCol: "customerid" }), "PERM_DENIED");
    assert.equal(classifyProbe({ error: "读取 Sheet 失败（重试 3 次后放弃）: Error: HTTP 403", wantFirstCol: "customerid" }), "PERM_DENIED");
  });

  test("410 → GONE（表被删）", () => {
    assert.equal(classifyProbe({ error: "读取 Sheet 失败（重试 3 次后放弃）: Error: HTTP 410", wantFirstCol: "customerid" }), "GONE");
  });

  test("其它异常 → FETCH_FAIL（瞬态，不催人）", () => {
    assert.equal(classifyProbe({ error: "The operation was aborted due to timeout", wantFirstCol: "customerid" }), "FETCH_FAIL");
  });

  test("200 但 0 字节 → EMPTY_SHEET", () => {
    assert.equal(classifyProbe({ rows: [], wantFirstCol: "customerid" }), "EMPTY_SHEET");
  });

  test("gviz 回退到第一张表（表头是「最近7天每日数据」）→ MISSING_TAB", () => {
    const rows = [["最近7天每日数据", "", ""], ["广告系列名", "花费", "点击"]];
    assert.equal(classifyProbe({ rows, wantFirstCol: "customerid" }), "MISSING_TAB");
  });

  test("表头对但没有数据行 → NO_DATA_ROWS", () => {
    assert.equal(classifyProbe({ rows: [["CustomerID", "AccountName"]], wantFirstCol: "customerid" }), "NO_DATA_ROWS");
  });

  test("正常 → OK；表头吞行（D-359 形态）仍判 OK，不与吞行告警重复", () => {
    assert.equal(classifyProbe({ rows: [["CustomerID", "AccountName"], ["127-352-0631", ""]], wantFirstCol: "customerid" }), "OK");
    const absorbed = [["CustomerID 127-352-0631 130-586-4419", "AccountName ", "Status ENABLED ENABLED"], ["272-098-3152", "", "CANCELED"]];
    assert.equal(classifyProbe({ rows: absorbed, wantFirstCol: "customerid" }), "OK");
  });

  test("CampaignInfo 用自己的列名判定", () => {
    const rows = [["CampaignId", "CampaignName", "Status"], ["2334", "x", "PAUSED"]];
    assert.equal(classifyProbe({ rows, wantFirstCol: "campaignid" }), "OK");
    assert.equal(classifyProbe({ rows, wantFirstCol: "customerid" }), "MISSING_TAB");
  });
});

const row = (o: Partial<ChannelHealthRow> & { mccId: string }): ChannelHealthRow => ({
  mccName: null, owner: "jy01", cidList: "MISSING_TAB", campaignInfo: null,
  enabledCampaigns: 0, lastCampaignUpdate: null, lastCostDate: null, ...o,
});

describe("rankChannelRows", () => {
  test("冻结的在投广告多的排前面（先修烧钱的）", () => {
    const r = rankChannelRows([
      row({ mccId: "A", enabledCampaigns: 5 }),
      row({ mccId: "B", enabledCampaigns: 160 }),
      row({ mccId: "C", enabledCampaigns: 24 }),
    ]);
    assert.deepEqual(r.map((x) => x.mccId), ["B", "C", "A"]);
  });

  test("在投数相同时按状态严重度：拒访 > 表被删 > 缺 tab", () => {
    const r = rankChannelRows([
      row({ mccId: "A", cidList: "MISSING_TAB" }),
      row({ mccId: "B", cidList: "PERM_DENIED" }),
      row({ mccId: "C", cidList: "GONE" }),
    ]);
    assert.deepEqual(r.map((x) => x.mccId), ["B", "C", "A"]);
  });
});

describe("formatChannelDigest", () => {
  test("全好 → null（不发通知）", () => {
    assert.equal(formatChannelDigest([], 60), null);
    assert.equal(formatChannelDigest([row({ mccId: "A", cidList: "OK" })], 60), null);
  });

  test("坏的条目进正文：带归属人、冻结在投数、最后花费日与修法", () => {
    const d = formatChannelDigest([
      row({ mccId: "183-752-7166", mccName: "念魁mcc-2", owner: "jy06", cidList: "GONE",
            campaignInfo: "GONE", enabledCampaigns: 114, lastCostDate: "2026-09-25",
            lastCampaignUpdate: new Date("2026-09-01T14:09:21Z") }),
      row({ mccId: "988-504-7597", owner: "wj111", cidList: "PERM_DENIED", enabledCampaigns: 0 }),
    ], 60);
    assert.ok(d);
    assert.match(d!.title, /2\/60/);
    assert.match(d!.content, /念魁mcc-2（183-752-7166）｜归属 jy06/);
    assert.match(d!.content, /库内标在投 114 条/);
    assert.match(d!.content, /最后有花费 2026-09-25/);
    assert.match(d!.content, /CampaignInfo 同样如此/);          // 两个 tab 同样坏 → 合并成一句
    assert.match(d!.content, new RegExp(CHANNEL_STATE_LABEL.PERM_DENIED.replace(/[()（）/]/g, ".")));
    assert.match(d!.content, /在投 114 条/);                     // 汇总里的冻结总数
    assert.match(d!.content, /共享改回/);                        // 带上该做什么
  });

  test("在投为 0 的也进正文，只是排在后面（坏就是坏，不因没广告而隐去）", () => {
    const d = formatChannelDigest([
      row({ mccId: "X", cidList: "NO_DATA_ROWS", enabledCampaigns: 0 }),
    ], 60);
    assert.ok(d);
    assert.match(d!.content, /X/);
  });
});
