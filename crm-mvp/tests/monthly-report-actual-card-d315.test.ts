/**
 * D-315（07 2026-09-05 报障：8 月收支报表 CG3/wenjun2 实收 ¥53,184.18，
 * 可张文俊工商卡 8 月真实流水只有 ¥3,562.91）：
 * 那 $7,885.88 是打到**张文俊香港卡**的（打款单 id=704 逐笔修正到收款方式 6），
 * 钱和折算都没错，错的是报表列头照着「账号绑定卡」印成了 张文俊(工商) 6222…3768。
 *
 * 口径：列头印**钱实际到账的那张卡**——打款单的逐笔修正 payment_method_id_override
 * 优先于账号绑定/历史快照（C-179 早已是数据中心打款列表与银行流水 prefill 的口径）。
 * 没有逐笔修正的列一个字都不动，历史月快照的冻结语义必须原样保留。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickActualCard } from "../src/lib/monthly-report";

/** 生产库 payment_methods 实数（team 1） */
const byId = new Map([
  ["1", { payee_name: "龚建成(农业)", card_no: "6228480332687240215" }],
  ["2", { payee_name: "张文俊(工商)", card_no: "6222031203014493768" }],
  ["4", { payee_name: "龚建成(PingPong)", card_no: "30000002789242" }],
  ["6", { payee_name: "张文俊(香港)", card_no: "971520622888" }],
  ["7", { payee_name: "龚建成(香港)", card_no: "011769338833" }],
]);

const cards = (overrides: string[], bound: string[] = []) =>
  ({ overrides: new Set(overrides), bound: new Set(bound) });

describe("D-315 报表列头印实际到账卡", () => {
  it("2026-08 CG/wenjun2：绑定工商卡，钱实际到张文俊香港卡 → 印香港卡", () => {
    // 打款单 704：$7,885.88，payment_method_id_override = 6
    const r = pickActualCard(cards(["6"]), byId);
    assert.deepEqual(r, { payee: "张文俊(香港)", card: "971520622888" });
  });

  it("2026-07 CG 六笔：绑定香港卡，钱实际到 PingPong → 印 PingPong", () => {
    assert.deepEqual(pickActualCard(cards(["4"]), byId), {
      payee: "龚建成(PingPong)", card: "30000002789242",
    });
  });

  it("没有逐笔修正 → 返回 null，调用方保持绑定/快照原样（不破坏历史月冻结）", () => {
    assert.equal(pickActualCard(cards([], ["2"]), byId), null);
    assert.equal(pickActualCard(undefined, byId), null);
  });

  it("同列一部分改卡、一部分走绑定 → 两张卡都印出来，不让任何一张消失", () => {
    const r = pickActualCard(cards(["6"], ["2"]), byId)!;
    assert.equal(r.payee, "张文俊(香港) / 张文俊(工商)");
    assert.equal(r.card, "971520622888 / 6222031203014493768");
  });

  it("多笔改到同一张卡 → 去重，只印一张", () => {
    assert.deepEqual(pickActualCard(cards(["6", "6"], ["6"]), byId), {
      payee: "张文俊(香港)", card: "971520622888",
    });
  });

  it("修正到的收款方式已从清单里消失 → 返回 null，宁可不改也不印错", () => {
    assert.equal(pickActualCard(cards(["999"]), byId), null);
  });

  it("卡号为空的收款方式不把空串拼进卡号列", () => {
    const withBlank = new Map(byId);
    withBlank.set("3", { payee_name: "翁宇斌", card_no: "" });
    const r = pickActualCard(cards(["3"], ["2"]), withBlank)!;
    assert.equal(r.payee, "翁宇斌 / 张文俊(工商)");
    assert.equal(r.card, "6222031203014493768");
  });
});
