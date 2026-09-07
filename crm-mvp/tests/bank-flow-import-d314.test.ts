/**
 * D-314（07 2026-09-04 拍板「不转人民币了，打款到香港卡里的美金直接导入月表后录入核对」）：
 * - 美金行不再挂起，与人民币行同一套引擎跑，拿打款单的美金原值比对（不经汇率），条目币种 USD；
 * - 引擎全线认币种：已录过判定、一批拆多笔（L4）都只在同币种内组合 ——
 *   美金行绝不能对上人民币条目（否则「已录过」判不出来，同一张表导两次会重复入账）；
 * - 只有美金列的 sheet（香港卡月表）也要解析成 flow。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseBankSheet, matchBankRows, resolveMethodCandidates,
  type ExistingEntry, type ImportMethod, type ImportPayment, type ParsedBankRow,
} from "../src/lib/bank-flow-import";

/** 张文俊的香港卡（月表里账号列写「恒生」）与大陆卡 */
const METHOD_HK: ImportMethod = { id: "7", payeeName: "张文俊", payChannel: "香港", cardNo: "" };
const METHOD_CN: ImportMethod = { id: "2", payeeName: "张文俊", payChannel: "农业", cardNo: "6228480332687240215" };
const METHODS = [METHOD_HK, METHOD_CN];

/** 美金到账行：月表写「龚建成-恒生」，按 PAYEE_ALIASES 归到系统里的「张文俊-香港」这张卡 */
function usdRow(i: number, date: string, usd: number, note = ""): ParsedBankRow {
  return { key: `hk#${i}`, sheet: "hk", rowNo: i + 2, date, payee: "龚建成", acct: "恒生", cny: null, usd, note, counterparty: "" };
}
/** 人民币到账行（大陆卡） */
function cnyRow(i: number, date: string, cny: number): ParsedBankRow {
  return { key: `cn#${i}`, sheet: "cn", rowNo: i + 2, date, payee: "张文俊", acct: METHOD_CN.cardNo, cny, usd: null, note: "", counterparty: "" };
}

/** 一笔打款单：usd 是平台打款原值，cny 是按打款日汇率折出来的值（人民币行才用） */
function payment(no: string, date: string, usd: number, methodId = METHOD_HK.id, platform = "PM", requestDate?: string): ImportPayment {
  return {
    paymentKey: `${platform}\u0000${no}`,
    platform,
    date,
    // D-314.2：默认申请日 = 打款日前 8 天（全库平均间隔 7.9 天）；要单独构造的用例自己传
    requestDate: requestDate ?? new Date(Date.parse(date) - 8 * 86400000).toISOString().slice(0, 10),
    methodId,
    userId: "5",
    username: "wj04",
    displayName: "甲",
    account: "acct-a",
    usd,
    cny: Math.round(usd * 7.1 * 100) / 100,
  };
}

const match = (rows: ParsedBankRow[], payments: ImportPayment[], existingEntries: ExistingEntry[] = []) =>
  matchBankRows({ rows, methods: METHODS, payments, usedBatchKeys: new Set(), existingEntries });

describe("D-314 美金行直接入账", () => {
  it("美金到账对上美金打款单 → 可自动入账（币种 USD，金额是美金原值，不折人民币）", () => {
    // 明细合计 $1,000.00，实际到账 $995.00 → 手续费 $5.00 / 0.5%
    const proposals = match(
      [usdRow(0, "2026-09-02", 995)],
      [payment("p1", "2026-09-01", 600), payment("p2", "2026-09-01", 400)],
    );
    assert.equal(proposals.length, 1);
    const p = proposals[0];
    assert.equal(p.status, "auto");
    assert.equal(p.currency, "USD");
    assert.equal(p.amount, 995);
    assert.equal(p.expected, 1000);
    assert.equal(p.fee, 5);
    assert.equal(p.methodId, METHOD_HK.id);
    // 明细金额也必须是美金原值（折 CNY 的 7,100 混进来就是串账）
    assert.deepEqual(p.breakdown.map((b) => b.amount), [1000]);
  });

  it("美金到账不会跟金额相同的人民币条目判成「已录过」", () => {
    const cnyEntry: ExistingEntry = {
      ids: ["1"], methodId: METHOD_HK.id, payChannel: "香港",
      amount: 995, currency: "CNY", txnDate: "2026-09-02",
      expected: 1000, fee: 5, breakdown: [], splittable: true,
    };
    const proposals = match([usdRow(0, "2026-09-02", 995)], [payment("p1", "2026-09-01", 1000)], [cnyEntry]);
    assert.equal(proposals.length, 1);
    assert.notEqual(proposals[0].status, "exists");
    assert.equal(proposals[0].currency, "USD");
  });

  it("同一张表导第二次：美金条目已登记 → 判「已录过」，不重复入账", () => {
    const usdEntry: ExistingEntry = {
      ids: ["1"], methodId: METHOD_HK.id, payChannel: "香港",
      amount: 995, currency: "USD", txnDate: "2026-09-02",
      expected: 1000, fee: 5, breakdown: [], splittable: true,
    };
    const proposals = match([usdRow(0, "2026-09-02", 995)], [payment("p1", "2026-09-01", 1000)], [usdEntry]);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].status, "exists");
  });

  it("美金条目登记日与银行差 ≤5 天 → 照样出「校正到账日」（原先美金行走不到这一步）", () => {
    const usdEntry: ExistingEntry = {
      ids: ["1"], methodId: METHOD_HK.id, payChannel: "香港",
      amount: 995, currency: "USD", txnDate: "2026-09-04",
      expected: 1000, fee: 5, breakdown: [], splittable: true,
    };
    const proposals = match([usdRow(0, "2026-09-02", 995)], [], [usdEntry]);
    assert.equal(proposals[0].status, "date_fix");
    assert.equal(proposals[0].txnDate, "2026-09-02");
  });

  it("一批美金打款拆成多笔到账（L4）也认：两笔合计 ≈ 该批次金额", () => {
    // 批次 $10,000（$6,000 + $4,000 两笔打款单），银行分两笔到账 $5,000 + $4,960 ——
    // 单笔都凑不出任何打款单子集（费率全在容差外），只有按批次合计才对得上，走的是 L4
    const proposals = match(
      [usdRow(0, "2026-09-02", 5000), usdRow(1, "2026-09-05", 4960)],
      [payment("p1", "2026-09-01", 6000), payment("p2", "2026-09-01", 4000)],
    );
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].currency, "USD");
    assert.equal(proposals[0].rows.length, 2);
    assert.equal(proposals[0].amount, 9960);
    assert.match(proposals[0].matchNote, /一批拆 2 笔到账/);
  });

  it("美金行与人民币行不会被凑成同一笔（币种不同的行永远不进同一个组合）", () => {
    // 香港卡批次 $10,000；故意给一笔金额相近的人民币行，看它会不会被吸进美金组合
    const proposals = match(
      [usdRow(0, "2026-09-02", 6000), cnyRow(1, "2026-09-03", 3960)],
      [payment("p1", "2026-09-01", 6000), payment("p2", "2026-09-01", 4000)],
    );
    const usdProposals = proposals.filter((p) => p.currency === "USD");
    for (const p of usdProposals) assert.ok(p.rows.every((r) => r.cny == null), "美金提案里混进了人民币行");
    const cnyProposals = proposals.filter((p) => p.currency === "CNY");
    for (const p of cnyProposals) assert.ok(p.rows.every((r) => r.usd == null), "人民币提案里混进了美金行");
  });

  it("对不上的美金行如实报「对不上」，不再挂「暂不导入」", () => {
    const proposals = match([usdRow(0, "2026-09-02", 995)], []);
    assert.equal(proposals[0].status, "unmatched");
    assert.equal(proposals[0].currency, "USD");
  });
});

/**
 * D-314.1（07 2026-09-04「不要重复记账 你自己解决」）：美金已在香港卡入账，换成人民币
 * 划回大陆卡的那笔到账是同一笔钱搬家，不是新收入。
 */
describe("D-314.1 香港卡换汇划回不重复记账", () => {
  /** 划回款：人民币到大陆卡，对方户名/标注写着恒生（财务的习惯写法） */
  function remitRow(i: number, date: string, cny: number, note: string, counterparty = ""): ParsedBankRow {
    return { key: `rm#${i}`, sheet: "cn", rowNo: i + 2, date, payee: "张文俊", acct: METHOD_CN.cardNo, cny, usd: null, note, counterparty };
  }

  it("对方户名指向香港卡的人民币到账 → 内部划转·不入账", () => {
    const proposals = match([remitRow(0, "2026-09-20", 70000, "", "恒生")], []);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].status, "internal_transfer");
    assert.equal(proposals[0].breakdown.length, 0);
    assert.match(proposals[0].matchNote, /重复记账/);
  });

  it("标注里写「汇丰」「香港」也算（财务写法不统一）", () => {
    for (const note of ["汇丰转入", "香港划回", "HSBC"]) {
      const p = match([remitRow(0, "2026-09-20", 70000, note)], []);
      assert.equal(p[0].status, "internal_transfer", note);
    }
  });

  it("对得上打款单的行绝不拦——真实的平台打款照样入账（哪怕备注里带「香港」）", () => {
    // 该行能凑出 $600+$400 折 CNY 的组合 → 是平台真打的款，不是划回款
    const cny = Math.round((600 + 400) * 7.1 * 0.995 * 100) / 100;
    const proposals = match(
      [remitRow(0, "2026-09-02", cny, "香港")],
      [payment("p1", "2026-09-01", 600, METHOD_CN.id), payment("p2", "2026-09-01", 400, METHOD_CN.id)],
    );
    assert.equal(proposals[0].status, "auto");
    assert.equal(proposals[0].currency, "CNY");
  });

  it("没写备注的划回款只能落到「对不上」，但提示里必须点明别重复登记", () => {
    // 同一批导入里有美金行 → 未命中的人民币行要带上这句提醒
    const proposals = match([usdRow(0, "2026-09-02", 995), remitRow(1, "2026-09-20", 70000, "")], []);
    const cnyProposal = proposals.find((p) => p.currency === "CNY")!;
    assert.equal(cnyProposal.status, "unmatched");
    assert.match(cnyProposal.matchNote, /香港卡美金换汇划回/);
  });

  it("整批都没有美金活动时，未命中提示保持原样（不制造无关噪音）", () => {
    const proposals = match([remitRow(0, "2026-09-20", 70000, "")], []);
    assert.equal(proposals[0].status, "unmatched");
    assert.doesNotMatch(proposals[0].matchNote, /香港卡美金换汇划回/);
  });
});

/**
 * D-314（生产库实证 2026-09-04）：香港卡在系统里的渠道名是「香港」（张文俊 971520622888、
 * 龚建成 011769338833），月表账号列写的却是银行名（恒生 / 汇丰）——不做映射的话，
 * 龚建成的汇丰行会整行判「无收款方式」，一笔都导不进来。
 */
/**
 * D-314.2（07 2026-09-05 拍板「这一笔实际就是八月的，不能记到九月，这种数据不能错」）：
 * 到账日与平台打款日差得远时，用**申请日**判断是谁写错的 —— 钱不可能在申请之前到账。
 * 生产实证：CG 8153325 —— 8-15 申请、8-20 钱进香港卡、CG 直到 9-04 才盖 paid_date。
 */
describe("D-314.2 到账日归属：银行日期 vs 平台补盖的打款日", () => {
  const bankRow = (date: string, usd: number, note = "CG1248（美金） / CG"): ParsedBankRow => ({
    key: "hk#0", sheet: "8月", rowNo: 10, date, payee: "龚建成", acct: "恒生",
    cny: null, usd, note, counterparty: "",
  });

  it("平台打款日晚于到账日（CG 补盖）→ 以银行到账日为准，记进 8 月", () => {
    // 8-15 申请 → 8-20 到账 $1,338.74（= $1,353.74 − $15 电汇费）→ CG 9-04 才盖 paid_date
    const [p] = match(
      [bankRow("2026-08-20", 1338.74)],
      [payment("8153325", "2026-09-04", 1353.74, METHOD_HK.id, "CG", "2026-08-15")],
    );
    assert.equal(p.txnDate, "2026-08-20", "到账日必须是银行的 8-20，不能被平台的 9-04 顶掉");
    assert.equal(p.txnDate!.slice(0, 7), "2026-08");
    assert.equal(p.sourceDate, "2026-09-04", "批次日仍记平台打款日（防重复用）");
    assert.equal(p.fee, 15);
    assert.equal(p.status, "review", "跨 15 天必须标复核，不能静默入账");
    assert.ok(p.warnings.some((w) => /补盖晚了/.test(w)), `告警要说清是平台补盖：${p.warnings.join("；")}`);
  });

  it("到账日早于申请日 → 钱不可能在申请前到账，判财务写错，按库内打款日入账（D-290 口径保留）", () => {
    // D-290 实证：PM 那批 2-15 申请 / 3-02 打款，月表把到账写成 2-12（比申请日还早 3 天）
    const [p] = match(
      [bankRow("2026-02-12", 1000, "")],
      [payment("8150393", "2026-03-02", 1000, METHOD_HK.id, "PM", "2026-02-15")],
    );
    assert.equal(p.txnDate, "2026-03-02", "表格日期比申请日还早，应按库内打款日入账");
    assert.ok(p.warnings.some((w) => /早于该批次申请日/.test(w)), p.warnings.join("；"));
  });

  it("条目已被登记成 9 月时，重新导入要出「校正到账日」把它挪回 8 月", () => {
    // 线上实况：id=83 条目 txn 2026-09-04、month 2026-09，银行流水明明是 8-20
    const wrongEntry: ExistingEntry = {
      ids: ["83"], methodId: METHOD_HK.id, payChannel: "香港",
      amount: 1338.74, currency: "USD", txnDate: "2026-09-04",
      expected: 1353.74, fee: 15,
      breakdown: [{ userId: "3", username: "wj02", displayName: "朱于森", platform: "CG", account: "wenjun3", amount: 1353.74, sourceDate: "2026-09-04" }],
      splittable: true,
    };
    const [p] = match(
      [bankRow("2026-08-20", 1338.74)],
      [payment("8153325", "2026-09-04", 1353.74, METHOD_HK.id, "CG", "2026-08-15")],
      [wrongEntry],
    );
    assert.equal(p.status, "date_fix", "应出校正到账日提案，而不是「已录过」跳过");
    assert.deepEqual(p.entryIds, ["83"]);
    assert.equal(p.txnDate, "2026-08-20");
    assert.ok(/补盖晚了/.test(p.matchNote) && /2026-08/.test(p.matchNote), p.matchNote);
  });

  it("已登记条目的到账日早于申请日 → 判表格有误，保留登记日（D-290 口径保留）", () => {
    const entry: ExistingEntry = {
      ids: ["9"], methodId: METHOD_HK.id, payChannel: "香港",
      amount: 1000, currency: "USD", txnDate: "2026-03-02",
      expected: 1000, fee: 0,
      breakdown: [{ userId: "3", username: "wj02", displayName: "朱于森", platform: "PM", account: "a", amount: 1000, sourceDate: "2026-03-02" }],
      splittable: true,
    };
    const [p] = match(
      [bankRow("2026-02-12", 1000, "")],
      [payment("8150393", "2026-03-02", 1000, METHOD_HK.id, "PM", "2026-02-15")],
      [entry],
    );
    assert.equal(p.status, "exists");
    assert.equal(p.txnDate, "2026-03-02");
    assert.ok(/早于该批次申请日/.test(p.matchNote), p.matchNote);
  });

  it("正常情形（到账在申请之后、与打款日差 ≤5 天）不出日期告警", () => {
    const [p] = match(
      [bankRow("2026-08-14", 995)],
      [payment("p1", "2026-08-13", 1000, METHOD_HK.id, "CG", "2026-08-05")],
    );
    assert.equal(p.txnDate, "2026-08-14");
    assert.equal(p.status, "auto");
    assert.deepEqual(p.warnings, []);
  });
});

describe("D-314 月表写银行名、系统里是「香港」渠道", () => {
  const HK_ZWJ: ImportMethod = { id: "6", payeeName: "张文俊", payChannel: "香港", cardNo: "971520622888" };
  const HK_GJC: ImportMethod = { id: "7", payeeName: "龚建成", payChannel: "香港", cardNo: "011769338833" };
  const CN_GJC: ImportMethod = { id: "1", payeeName: "龚建成", payChannel: "农业", cardNo: "6228480332687240215" };
  const ALL = [HK_ZWJ, HK_GJC, CN_GJC];

  it("龚建成 + 汇丰 → 龚建成的香港卡（原先对不上任何收款方式）", () => {
    const hit = resolveMethodCandidates({ payee: "龚建成", acct: "汇丰" }, ALL);
    assert.deepEqual(hit.map((m) => m.id), [HK_GJC.id]);
  });

  it("张文俊 + 恒生 → 张文俊的香港卡", () => {
    const hit = resolveMethodCandidates({ payee: "张文俊", acct: "恒生" }, ALL);
    assert.deepEqual(hit.map((m) => m.id), [HK_ZWJ.id]);
  });

  it("07 拍板的别名优先级不变：龚建成 + 恒生 仍归张文俊的香港卡", () => {
    const hit = resolveMethodCandidates({ payee: "龚建成", acct: "恒生" }, ALL);
    assert.deepEqual(hit.map((m) => m.id), [HK_ZWJ.id]);
  });

  it("账号列写了卡号就以卡号为准（银行名回退不抢卡号的活）", () => {
    // 张文俊 + 恒生 不在 PAYEE_ALIASES 里，走的是卡号 → 银行名回退这条正常顺序
    const hit = resolveMethodCandidates({ payee: "龚建成", acct: "汇丰 6228480332687240215" }, ALL);
    assert.deepEqual(hit.map((m) => m.id), [CN_GJC.id]);
  });

  it("07 拍板的别名是最高优先级：龚建成+恒生 即便带着大陆卡号也仍归张文俊香港卡", () => {
    // 「别名命中即权威、不跨卡兜底」是 07 2026-08-26 的口径，D-314 不动它
    const hit = resolveMethodCandidates({ payee: "龚建成", acct: "恒生 6228480332687240215" }, ALL);
    assert.deepEqual(hit.map((m) => m.id), [HK_ZWJ.id]);
  });
});

describe("D-314 只有美金列的 sheet 也要解析", () => {
  it("表头只有「美金」列（香港卡月表）→ flow，金额进 usd 列", () => {
    const sheet = parseBankSheet("9月香港", [
      ["序号", "时间", "收款人户名", "收款人账号", "美金", "平台"],
      ["1", "9/2/26", "张文俊", "恒生", "995.00", "pm"],
      ["2", "9/5/26", "张文俊", "恒生", "3960.00", "pm"],
    ]);
    assert.equal(sheet?.kind, "flow");
    assert.deepEqual(sheet?.rows.map((r) => r.usd), [995, 3960]);
    assert.deepEqual(sheet?.rows.map((r) => r.cny), [null, null]);
  });

  it("两列都有值的行仍以人民币为准（老口径不变）", () => {
    const sheet = parseBankSheet("9月份", [
      ["序号", "时间", "收款人户名", "收款人账号", "美金", "人民币"],
      ["1", "9/2/26", "张文俊", "622", "140.14", "995.00"],
    ]);
    assert.equal(sheet?.rows[0].cny, 995);
    assert.equal(sheet?.rows[0].usd, null);
  });
});
