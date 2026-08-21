import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCidListRows, diffCidList, type ExistingCidRow } from "../src/lib/cid-list-sheet-sync";

const ex = (id: number, cid: string, name: string | null, status = "active"): ExistingCidRow => ({
  id: BigInt(id), customer_id: cid, customer_name: name, status,
});

describe("parseCidListRows", () => {
  test("标准表头 + 横杠 CID 归一为纯数字", () => {
    const rows = parseCidListRows([
      ["CustomerID", "AccountName"],
      ["123-456-7890", "acc1"],
      ["9876543210", "acc2"],
    ]);
    assert.deepEqual(rows, [
      { customer_id: "1234567890", customer_name: "acc1" },
      { customer_id: "9876543210", customer_name: "acc2" },
    ]);
  });

  test("表头不符（老格式/别的 tab）→ null", () => {
    assert.equal(parseCidListRows([["Date", "Cost"], ["2026-08-21", "1"]]), null);
    assert.equal(parseCidListRows([]), null);
  });

  test("空 CID / 过短 / 重复行被剔除", () => {
    const rows = parseCidListRows([
      ["CustomerID", "AccountName"],
      ["", "empty"],
      ["123", "tooShort"],
      ["123-456-7890", "a"],
      ["1234567890", "dup"],
    ]);
    assert.equal(rows!.length, 1);
    assert.equal(rows![0].customer_name, "a");
  });
});

describe("diffCidList", () => {
  test("新 CID → create（D-253 未登记盲区自动补）", () => {
    const d = diffCidList(
      [{ customer_id: "1111111111", customer_name: "new" }],
      [],
    );
    assert.equal(d.create.length, 1);
    assert.equal(d.cancel.length, 0);
  });

  test("active 行不在 Sheet → cancel", () => {
    const d = diffCidList(
      [{ customer_id: "1111111111", customer_name: "a" }],
      [ex(1, "1111111111", "a"), ex(2, "2222222222", "gone")],
    );
    assert.equal(d.cancel.length, 1);
    assert.equal(d.cancel[0].customer_id, "2222222222");
  });

  test("消失但名下有 ENABLED 系列 → 不取消只告警（隐藏账号防误锁）", () => {
    const d = diffCidList(
      [],
      [ex(1, "1111111111", "hiddenButLive"), ex(2, "2222222222", "trulyGone")],
      new Set(["1111111111"]),
    );
    assert.equal(d.cancel.length, 1);
    assert.equal(d.cancel[0].customer_id, "2222222222");
    assert.equal(d.cancelBlocked.length, 1);
    assert.equal(d.cancelBlocked[0].customer_id, "1111111111");
  });

  test("suspended/cancelled 行出现在 Sheet 不复活（迭代器不过滤状态，防洗白 D-248）", () => {
    const d = diffCidList(
      [{ customer_id: "1111111111", customer_name: "s" }, { customer_id: "2222222222", customer_name: "c" }],
      [ex(1, "1111111111", "s", "suspended"), ex(2, "2222222222", "c", "cancelled")],
    );
    assert.equal(d.create.length, 0);
    assert.equal(d.rename.length, 0);
    assert.equal(d.cancel.length, 0);
    assert.equal(d.presentButDisabled, 2);
  });

  test("suspended 行不在 Sheet 也不动（只取消 active）", () => {
    const d = diffCidList([], [ex(1, "1111111111", "s", "suspended")]);
    assert.equal(d.cancel.length, 0);
  });

  test("名字变化 → rename；Sheet 名为空不覆盖", () => {
    const d = diffCidList(
      [{ customer_id: "1111111111", customer_name: "newName" }, { customer_id: "2222222222", customer_name: "" }],
      [ex(1, "1111111111", "oldName"), ex(2, "2222222222", "keep")],
    );
    assert.equal(d.rename.length, 1);
    assert.equal(d.rename[0].customer_name, "newName");
  });

  test("缩水保护：消失 ≥5 且 Sheet 行数 < active 一半 → 跳过取消，仍处理新增", () => {
    const existing = Array.from({ length: 12 }, (_, i) => ex(i + 1, `${1000000000 + i}`, `a${i}`));
    const d = diffCidList(
      [{ customer_id: "1000000000", customer_name: "a0" }, { customer_id: "9999999999", customer_name: "new" }],
      existing,
    );
    assert.equal(d.cancelSkippedByGuard, true);
    assert.equal(d.cancel.length, 0);
    assert.equal(d.create.length, 1);
  });

  test("正常小幅消失（<5 个）不触发保护", () => {
    const existing = Array.from({ length: 6 }, (_, i) => ex(i + 1, `${1000000000 + i}`, `a${i}`));
    const d = diffCidList(
      [{ customer_id: "1000000000", customer_name: "a0" }, { customer_id: "1000000001", customer_name: "a1" }],
      existing,
    );
    assert.equal(d.cancelSkippedByGuard, false);
    assert.equal(d.cancel.length, 4);
  });
});
