/**
 * D-290 银行流水导入的三条新口径（07 2026-08-27 拍板）：
 * - 财务工作簿里「按投手分摊」的那张表不是银行流水，解析成 detail、不参与匹配；
 * - 既有条目登记日与银行差 ≤5 天 → 出「校正到账日」提案，差更多 → 以实际到账时间为准，保留现值；
 * - 银行分多笔到账、合计 = 某个既有条目：WISE 是「平台一笔打款、我们分批回款」保持一条；
 *   其余按明细净额把人精确落到各笔（实证 6-16 PM 413.03 = 蓝晨馨），落不到人就跳过不硬摊。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseBankSheet, matchBankRows,
  type ExistingEntry, type ImportMethod, type ParsedBankRow,
} from "../src/lib/bank-flow-import";

const METHOD_BANK: ImportMethod = { id: "2", payeeName: "张三", payChannel: "农业", cardNo: "6228480332687240215" };
const METHOD_WISE: ImportMethod = { id: "9", payeeName: "张三", payChannel: "WISE", cardNo: "6228480332687240215" };
const METHODS = [METHOD_BANK, METHOD_WISE];

function row(i: number, date: string, cny: number): ParsedBankRow {
  return { key: `s#${i}`, sheet: "s", rowNo: i + 2, date, payee: "张三", acct: METHOD_BANK.cardNo, cny, usd: null, note: "", counterparty: "" };
}

/** 一条 PM 条目：3 人明细，费率 0.2823%（真实 6-16 那笔） */
function pmEntry(over: Partial<ExistingEntry> = {}): ExistingEntry {
  return {
    ids: ["16"],
    methodId: METHOD_BANK.id,
    payChannel: METHOD_BANK.payChannel,
    amount: 46593.08,
    currency: "CNY",
    txnDate: "2026-06-16",
    expected: 46724.97,
    fee: 131.89,
    breakdown: [
      { userId: "5", username: "wj04", displayName: "甲", platform: "PM", account: "a", amount: 44495.16 },
      { userId: "6", username: "wj05", displayName: "乙", platform: "PM", account: "b", amount: 1815.61 },
      { userId: "11", username: "wj10", displayName: "丙", platform: "PM", account: "c", amount: 414.20 },
    ],
    splittable: true,
    ...over,
  };
}

const match = (rows: ParsedBankRow[], existingEntries: ExistingEntry[]) =>
  matchBankRows({ rows, methods: METHODS, payments: [], usedBatchKeys: new Set(), existingEntries });

describe("D-290 按投手分摊的明细表不参与流水", () => {
  const head = ["序号", "时间", "收款人户名", "收款人账号", "投手", "美金", "汇率", "人民币"];

  it("投手/汇率填满 → detail", () => {
    const sheet = parseBankSheet("2-5月份", [
      head,
      ["1", "2/12/26", "张三", "622", "小王", "50.89", "6.899", "351.09011"],
      ["2", "3/4/26", "张三", "622", "小李", "137.73", "6.879", "947.44467"],
    ]);
    assert.equal(sheet?.kind, "detail");
    assert.match(sheet?.detailReason ?? "", /投手/);
  });

  it("同样的表头但投手/汇率是空的 → flow（财务月表列数月月不同，只认有没有填）", () => {
    const sheet = parseBankSheet("6月份", [
      head,
      ["1", "6/15/26", "张三", "622", null, null, null, "29855.87"],
      ["2", "6/16/26", "张三", "622", null, null, null, "5768.95"],
    ]);
    assert.equal(sheet?.kind, "flow");
    assert.equal(sheet?.rows.length, 2);
  });
});

describe("D-290 既有条目的到账日校正", () => {
  it("差 4 天 → 校正到银行的日期", () => {
    const e: ExistingEntry = { ...pmEntry(), amount: 799.18, txnDate: "2026-06-22", expected: 806.19, fee: 7.01, breakdown: [] };
    const [p] = match([row(0, "2026-06-18", 799.18)], [e]);
    assert.equal(p.status, "date_fix");
    assert.equal(p.txnDate, "2026-06-18");
    assert.deepEqual(p.entryIds, ["16"]);
  });

  it("差 12 天 → 以实际到账时间为准，保留现值", () => {
    const e: ExistingEntry = { ...pmEntry(), amount: 2158.01, txnDate: "2026-03-31", expected: 2177.01, fee: 19, breakdown: [] };
    const [p] = match([row(0, "2026-03-19", 2158.01)], [e]);
    assert.equal(p.status, "exists");
    assert.equal(p.txnDate, "2026-03-31");
    assert.match(p.matchNote, /保留现值/);
  });

  it("同一天 → 什么都不改", () => {
    const e: ExistingEntry = { ...pmEntry(), amount: 5768.95, txnDate: "2026-06-16", expected: 5785.28, fee: 16.33, breakdown: [] };
    const [p] = match([row(0, "2026-06-16", 5768.95)], [e]);
    assert.equal(p.status, "exists");
    assert.doesNotMatch(p.matchNote, /校正/);
  });

  it("银行日期早于打款日超过 5 天 → 判表格有误，不给校正提案", () => {
    const e: ExistingEntry = {
      ...pmEntry(), amount: 1326.25, txnDate: "2026-03-04", expected: 1329.59, fee: 3.34,
      breakdown: [{ userId: "5", username: "wj04", displayName: "甲", platform: "RW", account: "a", amount: 1329.59, sourceDate: "2026-03-04" }],
    };
    const [p] = match([row(0, "2026-02-12", 1326.25)], [e]);
    assert.equal(p.status, "exists");
    assert.equal(p.txnDate, "2026-03-04");
  });
});

describe("D-290 银行分多笔到账时的既有条目", () => {
  it("平台分开汇款 → 按明细净额把人落到各笔", () => {
    const rows = [row(0, "2026-06-16", 46180.05), row(1, "2026-06-16", 413.03)];
    const [p] = match(rows, [pmEntry()]);
    assert.equal(p.status, "split_existing");
    assert.equal(p.parts?.length, 2);
    const byAmount = new Map(p.parts!.map((x) => [x.amount, x]));
    assert.deepEqual(byAmount.get(413.03)!.members, ["丙"]);
    assert.deepEqual(byAmount.get(46180.05)!.members.sort(), ["乙", "甲"]);
    // 一分钱都不许丢：拆出来的到账合计 = 原条目，明细合计 = 原明细合计
    assert.equal(p.parts!.reduce((s, x) => s + x.amount, 0).toFixed(2), "46593.08");
    const bdSum = p.parts!.flatMap((x) => x.breakdown).reduce((s, b) => s + b.amount, 0);
    assert.equal(bdSum.toFixed(2), "46724.97");
  });

  it("WISE 一笔打款分批回款 → 保持一条不拆", () => {
    const rows = [row(0, "2026-06-16", 46180.05), row(1, "2026-06-16", 413.03)];
    const [p] = match(rows, [pmEntry({ methodId: METHOD_WISE.id, payChannel: "WISE" })]);
    assert.equal(p.status, "exists");
    assert.match(p.matchNote, /分批回款/);
  });

  it("明细凑不出银行的分笔 → 跳过请人工处理，不按比例硬摊", () => {
    const rows = [row(0, "2026-06-16", 40000), row(1, "2026-06-16", 6593.08)];
    const [p] = match(rows, [pmEntry()]);
    assert.equal(p.status, "exists");
    assert.match(p.matchNote, /落不到具体的人/);
    assert.equal(p.parts, undefined);
  });

  it("C-180 已按平台拆过的组 → 不再按银行拆", () => {
    const rows = [row(0, "2026-06-16", 46180.05), row(1, "2026-06-16", 413.03)];
    const [p] = match(rows, [pmEntry({ ids: ["21", "22"], splittable: false })]);
    assert.equal(p.status, "exists");
    assert.match(p.matchNote, /C-180/);
  });
});
