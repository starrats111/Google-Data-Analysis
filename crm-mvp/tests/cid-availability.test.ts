import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  deriveDisplayAvailability,
  isCidSelectable,
  rankCidsForAutoPick,
  CID_WRITE_GUARD,
} from "../src/lib/google-ads/cid-availability";

describe("deriveDisplayAvailability", () => {
  test("active + 无 ENABLED + 存量 Y → Y", () => {
    assert.equal(deriveDisplayAvailability({ rowStatus: "active", storedAvailability: "Y", enabledCount: 0 }), "Y");
  });

  test("active + 有 ENABLED → N（无论存量标记）", () => {
    assert.equal(deriveDisplayAvailability({ rowStatus: "active", storedAvailability: "Y", enabledCount: 2 }), "N");
    assert.equal(deriveDisplayAvailability({ rowStatus: "active", storedAvailability: "U", enabledCount: 1 }), "N");
  });

  test("存量 D → D，即使本地计数为 0（管理员强停不被计数洗白）", () => {
    assert.equal(deriveDisplayAvailability({ rowStatus: "active", storedAvailability: "D", enabledCount: 0 }), "D");
  });

  test("行状态非 active → D", () => {
    assert.equal(deriveDisplayAvailability({ rowStatus: "cancelled", storedAvailability: "Y", enabledCount: 0 }), "D");
    assert.equal(deriveDisplayAvailability({ rowStatus: "suspended", storedAvailability: "N", enabledCount: 3 }), "D");
  });

  test("存量 U + 本地无 ENABLED → 保持 U（本地计数可能过期，不升为 Y）", () => {
    assert.equal(deriveDisplayAvailability({ rowStatus: "active", storedAvailability: "U", enabledCount: 0 }), "U");
  });
});

describe("isCidSelectable", () => {
  test("Y/N/U 可选，D 禁选", () => {
    assert.equal(isCidSelectable("Y"), true);
    assert.equal(isCidSelectable("N"), true);
    assert.equal(isCidSelectable("U"), true);
    assert.equal(isCidSelectable("D"), false);
  });
});

describe("rankCidsForAutoPick", () => {
  test("排除 D，其余按 ENABLED 数量升序", () => {
    const ranked = rankCidsForAutoPick([
      { customer_id: "1", is_available: "N", enabled_count: 3 },
      { customer_id: "2", is_available: "D", enabled_count: 0 },
      { customer_id: "3", is_available: "Y", enabled_count: 0 },
    ]);
    assert.deepEqual(ranked.map((c) => c.customer_id), ["3", "1"]);
  });

  test("已核实（Y/N）优先于未核实（U），即使 U 的计数更小", () => {
    const ranked = rankCidsForAutoPick([
      { customer_id: "u", is_available: "U", enabled_count: 0 },
      { customer_id: "n", is_available: "N", enabled_count: 2 },
    ]);
    assert.deepEqual(ranked.map((c) => c.customer_id), ["n", "u"]);
  });

  test("同 ENABLED 数量时按 customer_name 数字升序", () => {
    const ranked = rankCidsForAutoPick([
      { customer_id: "a", customer_name: "12", is_available: "Y", enabled_count: 0 },
      { customer_id: "b", customer_name: "3", is_available: "Y", enabled_count: 0 },
    ]);
    assert.deepEqual(ranked.map((c) => c.customer_id), ["b", "a"]);
  });

  test("缺 enabled_count 时回退存量标记（Y=0，其他=1）", () => {
    const ranked = rankCidsForAutoPick([
      { customer_id: "n", is_available: "N" },
      { customer_id: "y", is_available: "Y" },
    ]);
    assert.deepEqual(ranked.map((c) => c.customer_id), ["y", "n"]);
  });
});

describe("CID_WRITE_GUARD", () => {
  test("guard 是 not-D 过滤条件（批量 Y/N 回写不得覆盖停用终态）", () => {
    assert.deepEqual(CID_WRITE_GUARD, { is_available: { not: "D" } });
  });
});
