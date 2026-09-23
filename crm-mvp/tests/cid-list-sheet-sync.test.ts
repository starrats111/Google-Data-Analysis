import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCidListRows,
  diffCidList,
  diffCidStatuses,
  mapSheetStatus,
  type ExistingCidRow,
} from "../src/lib/cid-list-sheet-sync";

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
      { customer_id: "1234567890", customer_name: "acc1", google_status: null },
      { customer_id: "9876543210", customer_name: "acc2", google_status: null },
    ]);
  });

  test("D-277 三列表头：Status 列解析为大写原值；空串归 null（不确定不动库）", () => {
    const rows = parseCidListRows([
      ["CustomerID", "AccountName", "Status"],
      ["123-456-7890", "acc1", "ENABLED"],
      ["222-222-2222", "acc2", "suspended"],
      ["333-333-3333", "acc3", ""],
    ]);
    assert.deepEqual(rows, [
      { customer_id: "1234567890", customer_name: "acc1", google_status: "ENABLED" },
      { customer_id: "2222222222", customer_name: "acc2", google_status: "SUSPENDED" },
      { customer_id: "3333333333", customer_name: "acc3", google_status: null },
    ]);
  });

  test("表头不符（老格式/别的 tab）→ null", () => {
    assert.equal(parseCidListRows([["Date", "Cost"], ["2026-08-21", "1"]]), null);
    assert.equal(parseCidListRows([]), null);
  });

  test("D-353 表头单元格被合并（列名后拼进了前几行值）仍能定位列", () => {
    // gviz 导出的真实形态：表头合并后，列名单元格里跟着被吞进来的前若干行值
    const rows = parseCidListRows([
      ["CustomerID 127-352-0631 130-586-4419", "AccountName ", "Status ENABLED CANCELED"],
      ["123-456-7890", "acc1", "ENABLED"],
      ["566-459-8997", "", "CANCELED"],
    ]);
    assert.deepEqual(rows, [
      { customer_id: "1234567890", customer_name: "acc1", google_status: "ENABLED" },
      { customer_id: "5664598997", customer_name: "", google_status: "CANCELED" },
    ]);
  });

  test("D-353 退化匹配只认首段，不把 StatusChangedAt 误当 Status 列", () => {
    const rows = parseCidListRows([
      ["CustomerID", "AccountName", "StatusChangedAt"],
      ["123-456-7890", "acc1", "2026-09-01"],
    ]);
    // 没有 Status 列 → google_status 必须为 null，不能把日期当状态读进来
    assert.deepEqual(rows, [
      { customer_id: "1234567890", customer_name: "acc1", google_status: null },
    ]);
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

describe("mapSheetStatus (D-277)", () => {
  test("Google 状态 → 库内三态；不确定值归 null", () => {
    assert.equal(mapSheetStatus("ENABLED"), "active");
    assert.equal(mapSheetStatus("SUSPENDED"), "suspended");
    assert.equal(mapSheetStatus("CANCELED"), "cancelled");
    assert.equal(mapSheetStatus("CANCELLED"), "cancelled");
    assert.equal(mapSheetStatus("CLOSED"), "cancelled");
    assert.equal(mapSheetStatus("enabled"), "active"); // 大小写容错
    assert.equal(mapSheetStatus("UNKNOWN"), null);
    assert.equal(mapSheetStatus(""), null);
    assert.equal(mapSheetStatus(null), null);
    assert.equal(mapSheetStatus(undefined), null);
  });
});

describe("diffCidStatuses (D-277)", () => {
  const row = (cid: string, status: string | null) => ({
    customer_id: cid, customer_name: `n${cid.slice(0, 3)}`, google_status: status,
  });

  test("active + Sheet SUSPENDED → suspend；active + CANCELED → cancel", () => {
    const changes = diffCidStatuses(
      [row("1111111111", "SUSPENDED"), row("2222222222", "CANCELED")],
      [ex(1, "1111111111", "a"), ex(2, "2222222222", "b")],
    );
    assert.equal(changes.length, 2);
    assert.deepEqual(changes.map((c) => c.kind), ["suspend", "cancel"]);
    assert.deepEqual(changes.map((c) => c.toStatus), ["suspended", "cancelled"]);
  });

  test("库内被停 + Sheet ENABLED → 跟随真值恢复（recover，D-324 改判 q5=b）", () => {
    const changes = diffCidStatuses(
      [row("1111111111", "ENABLED")],
      [ex(1, "1111111111", "a", "suspended")],
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, "recover");
    assert.equal(changes[0].toStatus, "active");
  });

  test("库内 cancelled + Sheet ENABLED 同样恢复（申诉回来的注销号）", () => {
    const changes = diffCidStatuses(
      [row("1111111111", "ENABLED")],
      [ex(1, "1111111111", "a", "cancelled")],
    );
    assert.deepEqual(changes.map((c) => c.kind), ["recover"]);
  });

  test("D-324：状态列缺失/不确定时绝不恢复（只认 Status 列真值，不看在不在表里）", () => {
    const changes = diffCidStatuses(
      [row("1111111111", null), row("2222222222", "UNKNOWN"), row("3333333333", "")],
      [
        ex(1, "1111111111", "a", "suspended"),
        ex(2, "2222222222", "b", "cancelled"),
        ex(3, "3333333333", "c", "suspended"),
      ],
    );
    assert.equal(changes.length, 0);
  });

  test("suspended ↔ cancelled 之间跟随 Google 真值", () => {
    const changes = diffCidStatuses(
      [row("1111111111", "CANCELLED"), row("2222222222", "SUSPENDED")],
      [ex(1, "1111111111", "a", "suspended"), ex(2, "2222222222", "b", "cancelled")],
    );
    assert.deepEqual(changes.map((c) => c.kind), ["cancel", "suspend"]);
  });

  test("状态一致 / 无状态列 / 不确定值 / 新 CID → 不产生动作", () => {
    const changes = diffCidStatuses(
      [
        row("1111111111", "ENABLED"),   // 与库内 active 一致
        row("2222222222", null),         // 老脚本无列
        row("3333333333", "UNKNOWN"),   // 不确定值
        row("9999999999", "SUSPENDED"), // 库内无此号（新号走 create 路径）
      ],
      [ex(1, "1111111111", "a"), ex(2, "2222222222", "b"), ex(3, "3333333333", "c")],
    );
    assert.equal(changes.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────
// D-330：CID_List 取消佐证 vs 状态同步的循环依赖死锁
// 实证：jymcc 的 1377549607 自 08-13 卡死一个月，日志每天报「不自动取消」。
// 破解判据 = CampaignInfo tab 里还有没有这个 CID（同脚本同轮生成的第三方证据）。
// ─────────────────────────────────────────────────────────────
describe("diffCidList D-330 死锁破解", () => {
  test("两个 tab 同时缺席 → 改判 cancel（ENABLED 是被跳过的冻结脏数据，不再当证据）", () => {
    const d = diffCidList(
      [],                                  // CID_List 里没有
      [ex(1, "1377549607", "deadlocked")],
      new Set(["1377549607"]),             // 库内名下仍有 ENABLED 系列
      new Set(["9999999999"]),             // 但 CampaignInfo 里也没有它
    );
    assert.equal(d.cancel.length, 1);
    assert.equal(d.cancel[0].customer_id, "1377549607");
    assert.equal(d.cancelBlocked.length, 0);
  });

  test("系列仍在 CampaignInfo → 仍判定为「隐藏」，保持只告警不取消", () => {
    const d = diffCidList(
      [],
      [ex(1, "1111111111", "hiddenButLive")],
      new Set(["1111111111"]),
      new Set(["1111111111"]),             // CampaignInfo 里还在 → 真的是隐藏
    );
    assert.equal(d.cancel.length, 0);
    assert.equal(d.cancelBlocked.length, 1);
    assert.equal(d.cancelBlocked[0].customer_id, "1111111111");
  });

  test("拿不到 CampaignInfo（undefined）→ 退回旧的保守行为，不误取消", () => {
    const d = diffCidList(
      [],
      [ex(1, "1111111111", "hiddenButLive")],
      new Set(["1111111111"]),
      undefined,
    );
    assert.equal(d.cancel.length, 0);
    assert.equal(d.cancelBlocked.length, 1);
  });

  test("名下本来就没有 ENABLED 系列 → 与 CampaignInfo 无关，照常 cancel", () => {
    const d = diffCidList(
      [],
      [ex(1, "2222222222", "trulyGone")],
      new Set(),
      new Set(["2222222222"]),             // 即便 CampaignInfo 里有，也不影响
    );
    assert.equal(d.cancel.length, 1);
    assert.equal(d.cancelBlocked.length, 0);
  });

  test("缩水保护优先于 D-330 改判：疑似残表时一个都不取消", () => {
    const existing = Array.from({ length: 12 }, (_, i) =>
      ex(i + 1, String(1000000000 + i), `a${i}`),
    );
    const d = diffCidList(
      [{ customer_id: "1000000000", customer_name: "a0" }], // 1 行 << 12 个 active 的一半
      existing,
      new Set(["1000000001"]),
      new Set([]),                          // CampaignInfo 空集合也不该突破残表保护
    );
    assert.equal(d.cancelSkippedByGuard, true);
    assert.equal(d.cancel.length, 0);
    assert.equal(d.cancelBlocked.length, 0);
  });
});
