import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { syncFromSheet } from "../src/lib/sheet-sync";
import { generateUnifiedAdsScript } from "../src/lib/link-exchange-script-template";

// Google Ads 脚本每次整表重写 DailyData 且只采集近 30 天，早于窗口的数据必然丢失。
// 历史改由 DailyData_YYYY-MM 归档表保存，这里验证：
//   1. 读取端（CRM）能正确合并 DailyData 与归档表
//   2. 写入端（生成的脚本）跨月合并时不会冲掉月初数据

const SHEET_URL = "https://docs.google.com/spreadsheets/d/FAKEID/edit";
const HEADERS =
  "Date,Account,AccountName,CampaignId,CampaignName,Status,Budget,Impressions,Clicks,Cost,Conversions,ConversionValue,Currency";

function dataRow(date: string, campaignId: string, costDollars: number) {
  return `${date},123-456-7890,acct,${campaignId},RW_US_1001,ENABLED,10000000,100,10,${costDollars * 1_000_000},1,5,USD`;
}

function daysAgo(n: number) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

// ============================================================
// 读取端：sheet-sync
// ============================================================

let tabs: Record<string, string>;
let requestedTabs: string[];

beforeEach(() => {
  requestedTabs = [];
  tabs = {
    DailyData: [HEADERS, dataRow(daysAgo(10), "C_RECENT", 1)].join("\n"),
    "DailyData_2025-11": [HEADERS, dataRow("2025-11-05", "C_NOV_A", 2), dataRow("2025-11-20", "C_NOV_B", 3)].join("\n"),
    "DailyData_2025-12": [HEADERS, dataRow("2025-12-15", "C_DEC", 4)].join("\n"),
  };
  globalThis.fetch = (async (url: string) => {
    const tab = decodeURIComponent(new URL(url).searchParams.get("sheet") || "");
    requestedTabs.push(tab);
    if (!(tab in tabs)) return { ok: false, status: 400, text: async () => "" } as Response;
    return { ok: true, status: 200, text: async () => tabs[tab] } as Response;
  }) as unknown as typeof fetch;
});

describe("syncFromSheet 月度归档", () => {
  test("短区间同步落在 DailyData 覆盖内，不额外读归档表", async () => {
    const result = await syncFromSheet(SHEET_URL, daysAgo(20), daysAgo(0));
    assert.deepEqual(requestedTabs, ["DailyData"]);
    assert.equal(result.success, true);
    assert.equal(result.rows.length, 1);
  });

  test("超出 30 天窗口时自动补读归档表并合并", async () => {
    const result = await syncFromSheet(SHEET_URL, "2025-11-01", daysAgo(0));
    assert.equal(result.success, true);
    assert.equal(result.format, "crm");
    const ids = result.rows.map((r) => r.campaign_id).sort();
    assert.deepEqual(ids, ["C_DEC", "C_NOV_A", "C_NOV_B", "C_RECENT"]);
  });

  test("归档表的 Cost 同样按 micros 还原", async () => {
    const result = await syncFromSheet(SHEET_URL, "2025-11-01", daysAgo(0));
    assert.equal(result.rows.find((r) => r.campaign_id === "C_NOV_A")?.cost, 2);
  });

  test("同一 (日期, 系列) 以 DailyData 为准（它每次重写，数据最新）", async () => {
    const overlapDate = daysAgo(10);
    tabs[`DailyData_${overlapDate.slice(0, 7)}`] = [HEADERS, dataRow(overlapDate, "C_RECENT", 999)].join("\n");
    const result = await syncFromSheet(SHEET_URL, "2025-11-01", daysAgo(0));
    const hit = result.rows.filter((r) => r.campaign_id === "C_RECENT");
    assert.equal(hit.length, 1);
    assert.equal(hit[0].cost, 1);
  });

  test("DailyData 只剩表头时回落到归档表，不让整次同步白跑", async () => {
    tabs.DailyData = HEADERS;
    const result = await syncFromSheet(SHEET_URL, "2025-11-01", daysAgo(0));
    assert.equal(result.success, true);
    assert.equal(result.rows.length, 3);
  });

  test("月份探测有上限，不会因超长区间无限翻页", async () => {
    await syncFromSheet(SHEET_URL, "2000-01-01", daysAgo(0));
    const monthly = requestedTabs.filter((t) => t.startsWith("DailyData_"));
    assert.ok(monthly.length <= 36, `探测了 ${monthly.length} 个月`);
  });

  test("表格完全不可识别时仍报错，不被归档兜底掩盖", async () => {
    tabs = {};
    const result = await syncFromSheet(SHEET_URL, "2025-11-01", daysAgo(0));
    assert.equal(result.success, false);
  });
});

// ============================================================
// 写入端：把生成脚本里的纯函数抠出来，配一个假的 Spreadsheet 跑
// ============================================================

type Row = (string | number)[];

/** 最小可用的 SpreadsheetApp 替身，只实现归档逻辑用到的那几个方法 */
function fakeSpreadsheet(initial: Record<string, Row[]> = {}) {
  const store: Record<string, Row[]> = JSON.parse(JSON.stringify(initial));
  const makeSheet = (name: string) => ({
    getLastRow: () => store[name].length,
    clearContents: () => {
      store[name] = [];
    },
    setFrozenRows: () => {},
    getRange: (row: number, col: number, numRows: number, numCols: number) => ({
      getValues: () =>
        store[name].slice(row - 1, row - 1 + numRows).map((r) => r.slice(col - 1, col - 1 + numCols)),
      setValues: (vals: Row[]) => {
        for (let i = 0; i < vals.length; i++) store[name][row - 1 + i] = vals[i].slice();
      },
    }),
  });
  return {
    store,
    getSheetByName: (name: string) => (name in store ? makeSheet(name) : null),
    insertSheet: (name: string) => {
      store[name] = [];
      return makeSheet(name);
    },
  };
}

function extractFn(script: string, name: string) {
  const found = script.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  assert.ok(found, `脚本里找不到 ${name}`);
  return found[0];
}

function loadArchiveFns() {
  const script = generateUnifiedAdsScript("ky_live_x", undefined, SHEET_URL);
  const src = [
    script.match(/var DATA_HEADERS = \[[^\]]*\];/)![0],
    extractFn(script, "rowKeyOf"),
    extractFn(script, "readMonthArchive"),
    extractFn(script, "writeMonthArchive"),
    extractFn(script, "mergeMonthArchive"),
    extractFn(script, "monthAdd"),
    extractFn(script, "monthLastDay"),
    "return { mergeMonthArchive: mergeMonthArchive, monthAdd: monthAdd, monthLastDay: monthLastDay };",
  ].join("\n");
  return new Function(src)() as {
    mergeMonthArchive: (
      ss: unknown, month: string, fresh: Row[], winStart: string, winEnd: string
    ) => number;
    monthAdd: (m: string, d: number) => string;
    monthLastDay: (m: string) => string;
  };
}

/** 造一行归档数据，字段顺序与 DATA_HEADERS 一致 */
function archiveRow(date: string, campaignId: string, costMicros: number, cid = "111"): Row {
  return [date, cid, "acct", campaignId, "RW_US_1", "ENABLED", 10000000, 100, 10, costMicros, 1, 5, "USD"];
}

describe("脚本内的月度归档合并", () => {
  const fns = loadArchiveFns();

  test("跨月运行不会冲掉月初数据（9/2 采集 8/3~9/2，8/1-8/2 必须保留）", () => {
    const ss = fakeSpreadsheet({
      "DailyData_2026-08": [
        ["Date"],
        archiveRow("2026-08-01", "C1", 1_000_000),
        archiveRow("2026-08-02", "C1", 2_000_000),
        archiveRow("2026-08-05", "C1", 3_000_000),
      ],
    });
    const fresh = [archiveRow("2026-08-05", "C1", 9_000_000), archiveRow("2026-08-06", "C1", 4_000_000)];

    const count = fns.mergeMonthArchive(ss, "2026-08", fresh, "2026-08-03", "2026-09-02");

    assert.equal(count, 4);
    const rows = ss.store["DailyData_2026-08"].slice(1);
    assert.deepEqual(rows.map((r) => r[0]), ["2026-08-01", "2026-08-02", "2026-08-05", "2026-08-06"]);
    // 窗口内的 08-05 被新数据覆盖，窗口外的 08-01/02 原值保留
    assert.equal(rows[2][9], 9_000_000);
    assert.equal(rows[0][9], 1_000_000);
  });

  test("窗口内的旧行即使本次没采到也会被清掉（系列删除后不留幽灵数据）", () => {
    const ss = fakeSpreadsheet({
      "DailyData_2026-08": [["Date"], archiveRow("2026-08-10", "GONE", 5_000_000)],
    });
    const count = fns.mergeMonthArchive(ss, "2026-08", [archiveRow("2026-08-10", "ALIVE", 1)], "2026-08-01", "2026-08-31");
    assert.equal(count, 1);
    assert.equal(ss.store["DailyData_2026-08"][1][3], "ALIVE");
  });

  test("同一 (日期, 子账号, 系列) 只保留一行", () => {
    const ss = fakeSpreadsheet({});
    const dup = [archiveRow("2026-08-10", "C1", 1), archiveRow("2026-08-10", "C1", 2)];
    assert.equal(fns.mergeMonthArchive(ss, "2026-08", dup, "", ""), 1);
  });

  test("同一天不同子账号的相同系列名不会互相覆盖", () => {
    const ss = fakeSpreadsheet({});
    const rows = [archiveRow("2026-08-10", "C1", 1, "111"), archiveRow("2026-08-10", "C1", 2, "222")];
    assert.equal(fns.mergeMonthArchive(ss, "2026-08", rows, "", ""), 2);
  });

  test("历史回补整月替换（不传窗口）不会读旧数据", () => {
    const ss = fakeSpreadsheet({
      "DailyData_2026-03": [["Date"], archiveRow("2026-03-01", "OLD", 1)],
    });
    const count = fns.mergeMonthArchive(ss, "2026-03", [archiveRow("2026-03-09", "NEW", 1)], "", "");
    assert.equal(count, 1);
    assert.equal(ss.store["DailyData_2026-03"][1][3], "NEW");
  });

  test("输出按日期升序，便于人工翻阅", () => {
    const ss = fakeSpreadsheet({});
    const rows = [archiveRow("2026-08-20", "C", 1), archiveRow("2026-08-02", "C", 1), archiveRow("2026-08-11", "C", 1)];
    fns.mergeMonthArchive(ss, "2026-08", rows, "", "");
    assert.deepEqual(
      ss.store["DailyData_2026-08"].slice(1).map((r) => r[0]),
      ["2026-08-02", "2026-08-11", "2026-08-20"]
    );
  });

  test("micros 原值写入，不做任何换算或四舍五入", () => {
    const ss = fakeSpreadsheet({});
    fns.mergeMonthArchive(ss, "2026-08", [archiveRow("2026-08-10", "C", 123456789)], "", "");
    assert.equal(ss.store["DailyData_2026-08"][1][9], 123456789);
  });

  test("月份推算正确（含跨年与闰月）", () => {
    assert.equal(fns.monthAdd("2026-01", -1), "2025-12");
    assert.equal(fns.monthAdd("2026-08", -9), "2025-11");
    assert.equal(fns.monthAdd("2025-12", 1), "2026-01");
    assert.equal(fns.monthLastDay("2026-02"), "2026-02-28");
    assert.equal(fns.monthLastDay("2024-02"), "2024-02-29");
    assert.equal(fns.monthLastDay("2026-07"), "2026-07-31");
  });
});

/** 把 archiveRecentWindow 抠出来跑，验证它对归档进度的标记是否谨慎 */
function loadWindowArchiver(thisMonth: string) {
  const script = generateUnifiedAdsScript("ky_live_x", undefined, SHEET_URL);
  const metaWrites: [string, string][] = [];
  const fn = new Function(
    "metaWrites",
    [
      "var STATE = { forceStopped: false };",
      "function mergeMonthArchive(ss, month, rows) { return rows.length; }",
      "function upsertBackfillMeta(ss, key, status) { metaWrites.push([key, status]); }",
      `function currentMonthKey() { return '${thisMonth}'; }`,
      extractFn(script, "monthKeyOfDate"),
      extractFn(script, "archiveRecentWindow"),
      "return archiveRecentWindow;",
    ].join("\n")
  )(metaWrites) as (ss: unknown, rows: Row[], ws: string, we: string) => void;
  return { run: (rows: Row[], ws: string, we: string) => fn({}, rows, ws, we), metaWrites };
}

describe("近 30 天窗口的归档进度标记", () => {
  test("窗口最前面的残缺月不标 complete，留给历史回补", () => {
    // 8/3 运行，窗口 7/4~8/3：7 月缺 1-3 号，不能当作已定稿
    const h = loadWindowArchiver("2026-08");
    h.run([archiveRow("2026-07-10", "C", 1), archiveRow("2026-08-01", "C", 1)], "2026-07-04", "2026-08-03");
    assert.deepEqual(h.metaWrites, [["2026-08", "current"]]);
  });

  test("被窗口完整覆盖的过去月份才标 complete", () => {
    // 8/31 运行，窗口 8/1~8/31，但当月仍标 current
    const h = loadWindowArchiver("2026-09");
    h.run([archiveRow("2026-08-10", "C", 1), archiveRow("2026-09-01", "C", 1)], "2026-08-01", "2026-09-01");
    assert.deepEqual(h.metaWrites.sort(), [["2026-08", "complete"], ["2026-09", "current"]]);
  });

  test("采集被中断时整个归档跳过，不删未采集账号的历史", () => {
    const script = generateUnifiedAdsScript("ky_live_x", undefined, SHEET_URL);
    const merged: string[] = [];
    const fn = new Function(
      "merged",
      [
        "var STATE = { forceStopped: true };",
        "function mergeMonthArchive(ss, month, rows) { merged.push(month); return rows.length; }",
        "function upsertBackfillMeta() {}",
        "function currentMonthKey() { return '2026-08'; }",
        extractFn(script, "monthKeyOfDate"),
        extractFn(script, "archiveRecentWindow"),
        "return archiveRecentWindow;",
      ].join("\n")
    )(merged) as (ss: unknown, rows: Row[], ws: string, we: string) => void;
    fn({}, [archiveRow("2026-08-01", "C", 1)], "2026-07-04", "2026-08-03");
    assert.deepEqual(merged, []);
  });
});

/**
 * 把 runHistoryBackfill 抠出来跑，其余依赖全部打桩。
 * 重点验证撞上 30 分钟运行时上限时不会写坏数据。
 */
function loadBackfillRunner(opts: {
  metaStore: Record<string, string>;
  earliest: string;
  remainingSeconds: number;
  /** 返回该月的行数；返回 -1 表示「采到一半被打断」 */
  fetchMonth: (month: string) => number;
}) {
  const script = generateUnifiedAdsScript("ky_live_x", undefined, SHEET_URL);
  const merged: string[] = [];
  const metaWrites: [string, string][] = [];

  const sandbox = new Function(
    "opts", "merged", "metaWrites",
    [
      script.match(/var CONFIG = \{[\s\S]*?\n\};/)![0],
      "var EARLIEST_META_KEY = '__EARLIEST__';",
      "var STATE = { forceStopped: false };",
      "function shouldStop() { return STATE.forceStopped; }",
      "function getRemainingSeconds() { return opts.remainingSeconds; }",
      "function readBackfillMeta() { return opts.metaStore; }",
      "function upsertBackfillMeta(ss, key, status) { opts.metaStore[key] = status; metaWrites.push([key, status]); }",
      "function detectEarliestMonth() { return opts.earliest; }",
      "function mergeMonthArchive(ss, month, rows) { merged.push(month); return rows.length; }",
      "function currentMonthKey() { return '2026-08'; }",
      `function fetchRangeForAccounts(accounts, s, e, label) {
         var month = s.slice(0, 7);
         var n = opts.fetchMonth(month);
         if (n < 0) { STATE.forceStopped = true; return []; }
         var rows = []; for (var i = 0; i < n; i++) rows.push([month + '-01']);
         return rows;
       }`,
      extractFn(script, "monthAdd"),
      extractFn(script, "monthLastDay"),
      extractFn(script, "runHistoryBackfill"),
      "return runHistoryBackfill;",
    ].join("\n")
  )(opts, merged, metaWrites) as (ss: unknown, accounts: unknown[], info: unknown[]) => void;

  return { run: () => sandbox({}, [{}], []), merged, metaWrites };
}

describe("历史回补的中断安全", () => {
  test("正常情况下逐月往前补并标记完成", () => {
    const h = loadBackfillRunner({
      metaStore: { __EARLIEST__: "2026-05" },
      earliest: "2026-05",
      remainingSeconds: 1500,
      fetchMonth: () => 10,
    });
    h.run();
    assert.deepEqual(h.merged, ["2026-07", "2026-06", "2026-05"]);
    assert.deepEqual(
      h.metaWrites.map(([k, s]) => `${k}=${s}`),
      ["2026-07=complete", "2026-06=complete", "2026-05=complete"]
    );
  });

  test("已标记 complete 的月份不重复补", () => {
    const h = loadBackfillRunner({
      metaStore: { __EARLIEST__: "2026-05", "2026-06": "complete" },
      earliest: "2026-05",
      remainingSeconds: 1500,
      fetchMonth: () => 10,
    });
    h.run();
    assert.deepEqual(h.merged, ["2026-07", "2026-05"]);
  });

  test("采集中途撞上运行时上限：残缺月既不写入也不标记完成", () => {
    const h = loadBackfillRunner({
      metaStore: { __EARLIEST__: "2026-05" },
      earliest: "2026-05",
      remainingSeconds: 1500,
      fetchMonth: (m) => (m === "2026-06" ? -1 : 10),
    });
    h.run();
    // 07 月正常补完；06 月被打断，必须留到下次重来；05 月不能越过 06 月先补
    assert.deepEqual(h.merged, ["2026-07"]);
    assert.equal(h.metaWrites.filter(([k]) => k === "2026-06").length, 0);
    assert.equal(h.metaWrites.filter(([k]) => k === "2026-05").length, 0);
  });

  test("剩余时间不足时整个回补跳过，把时间留给换链循环", () => {
    const h = loadBackfillRunner({
      metaStore: { __EARLIEST__: "2026-05" },
      earliest: "2026-05",
      remainingSeconds: 150,
      fetchMonth: () => 10,
    });
    h.run();
    assert.deepEqual(h.merged, []);
    assert.deepEqual(h.metaWrites, []);
  });

  test("连续空月收敛起点，避免以后每次重扫不存在的月份", () => {
    const h = loadBackfillRunner({
      metaStore: { __EARLIEST__: "2024-01" },
      earliest: "2024-01",
      remainingSeconds: 1500,
      fetchMonth: (m) => (m >= "2026-05" ? 10 : 0),
    });
    h.run();
    // 04/03/02 连空三个月即收敛，起点落在最后扫到的那个空月；
    // 这三个月同时被标记 complete，所以下次运行 pending 为空，不再重扫
    const earliestWrites = h.metaWrites.filter(([k]) => k === "__EARLIEST__");
    assert.equal(earliestWrites.length, 1);
    assert.equal(earliestWrites[0][1], "2026-02");
    assert.deepEqual(h.merged, ["2026-07", "2026-06", "2026-05"]);
  });

  test("历史已补齐时不做任何写入", () => {
    const h = loadBackfillRunner({
      metaStore: { __EARLIEST__: "2026-07", "2026-07": "complete" },
      earliest: "2026-07",
      remainingSeconds: 1500,
      fetchMonth: () => 10,
    });
    h.run();
    assert.deepEqual(h.merged, []);
    assert.deepEqual(h.metaWrites, []);
  });
});

describe("生成的统一脚本", () => {
  const script = generateUnifiedAdsScript("ky_live_x", undefined, SHEET_URL);

  test("是合法 JavaScript", () => {
    assert.doesNotThrow(() => new Function(script));
  });

  test("日常窗口降到 30 天", () => {
    assert.match(script, /DATA_CENTER_DAYS: 30/);
  });

  test("含归档、进度表与历史回补", () => {
    assert.ok(script.includes("archiveRecentWindow"));
    assert.ok(script.includes("runHistoryBackfill"));
    assert.ok(script.includes("_BackfillMeta"));
    assert.ok(script.includes("'DailyData_' + monthKey"));
  });

  test("回补预算受剩余时间约束，不会饿死换链循环", () => {
    assert.match(script, /Math\.min\(budget, getRemainingSeconds\(\) - 120\)/);
  });
});
