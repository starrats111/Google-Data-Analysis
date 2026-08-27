/**
 * D-293 香港卡别名（07 2026-08-27）：香港卡的钱要回大陆卡，财务在月表里用银行名标是哪张香港卡 ——
 * 恒生 = 张文俊的香港卡，汇丰 = 龚建成的香港卡（户名列财务一律写龚建成，不能按户名判）。
 * 别名是硬映射，命中就不许再往同收款人的其它卡兜底。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveMethodCandidates, isAliasRow, type ImportMethod } from "../src/lib/bank-flow-import";

const METHODS: ImportMethod[] = [
  { id: "1", payeeName: "龚建成", payChannel: "农业", cardNo: "6228480332687240215" },
  { id: "4", payeeName: "龚建成", payChannel: "PingPong", cardNo: "30000002789242" },
  { id: "6", payeeName: "张文俊", payChannel: "香港", cardNo: "971520622888" },
  { id: "7", payeeName: "龚建成", payChannel: "香港", cardNo: "011769338833" },
];

const resolve = (payee: string, acct: string) =>
  resolveMethodCandidates({ payee, acct }, METHODS).map((m) => `${m.payeeName}-${m.payChannel}`);

describe("D-293 香港卡别名", () => {
  it("恒生 → 张文俊的香港卡", () => {
    assert.deepEqual(resolve("龚建成", "恒生"), ["张文俊-香港"]);
  });

  it("汇丰 → 龚建成的香港卡", () => {
    assert.deepEqual(resolve("龚建成", "汇丰"), ["龚建成-香港"]);
  });

  it("户名列写谁都不影响（财务一律写龚建成）", () => {
    assert.deepEqual(resolve("张文俊", "恒生"), ["张文俊-香港"]);
    assert.deepEqual(resolve("张文俊", "汇丰"), ["龚建成-香港"]);
  });

  it("卡号行不算别名行（仍可按同收款人跨渠道兜底）", () => {
    assert.equal(isAliasRow({ payee: "龚建成", acct: "6228480332687240215" }), false);
    assert.equal(isAliasRow({ payee: "龚建成", acct: "恒生" }), true);
    assert.equal(isAliasRow({ payee: "龚建成", acct: "汇丰" }), true);
  });
});
