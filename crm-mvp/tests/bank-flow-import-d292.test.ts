/**
 * D-292（07 2026-08-27）：条目备注不写 sheet 名与行号，写对方户名 ——
 * 财务对账看的是「这笔钱从上海汇还是连连银通来的」，sheet 名对他们没用。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBankSheet, counterpartyOf } from "../src/lib/bank-flow-import";

const cp = (note: string, counterparty = "") => counterpartyOf([{ note, counterparty }]);

describe("D-292 对方户名提取", () => {
  it("有「对方户名」列就原样用", () => {
    assert.equal(cp("pm / 连连银通", "连连银通"), "连连银通");
  });

  it("没有该列时从标注里抽，平台码不算户名", () => {
    assert.equal(cp("pm / 连连银通"), "连连银通");
    assert.equal(cp("lh / 上海汇"), "上海汇");
  });

  it("连在数字上的平台码也剔掉（上海汇（rw52.39））", () => {
    assert.equal(cp("rw / 上海汇（rw52.39）"), "上海汇");
  });

  it("财务写的整句话不当户名（实证「实际发生日是3.4号」）", () => {
    assert.equal(cp("实际发生日是3.4号"), "");
  });

  it("多行去重后用「、」连起来", () => {
    assert.equal(
      counterpartyOf([
        { note: "YIWS / CG", counterparty: "" },
        { note: "22.63 / YIWS / 支付宝（CG）", counterparty: "" },
      ]),
      "YIWS、支付宝",
    );
  });

  it("表里有「对方户名」列时解析进行（表头列名月月漂移，只认列名）", () => {
    const sheet = parseBankSheet("8月份", [
      ["序号", "时间", "收款人户名", "收款人账号", "人民币", "平台", "对方户名"],
      ["1", "8/12/26", "龚建成", "622", "3987.54", "pm", "连连银通"],
      ["2", "8/21/26", "龚建成", "622", "2538.19", null, "上海汇"],
    ]);
    assert.equal(sheet?.kind, "flow");
    assert.deepEqual(sheet?.rows.map((r) => r.counterparty), ["连连银通", "上海汇"]);
  });
});

describe("D-292 HT 是 LH 的笔误（07 2026-08-27 确认）", () => {
  it("HT 当平台码剔掉，不进对方户名", () => {
    assert.equal(counterpartyOf([{ note: "HT", counterparty: "" }]), "");
    assert.equal(counterpartyOf([{ note: "HT / 上海汇", counterparty: "" }]), "上海汇");
  });
});
