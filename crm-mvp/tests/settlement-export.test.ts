/**
 * 结算查询导出：导出结果必须与屏幕完全一致（当前页签 + 表头筛选 + 表头排序 + 筛选后全量行）。
 *
 * 重点覆盖三个容易错的地方：
 * - applyTableState 复用列定义里的 onFilter/sorter，不能自己重写比较逻辑（否则页面和导出会漂）
 * - 率列必须传小数：Excel 的 0.00% 格式会自己乘 100，传 24.66 会显示成 2466%
 * - 总佣金为 0 的行率列传 null（留空），不能变成 0%
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ColumnsType } from "antd/es/table";
import { applyTableState, rateCell, type TableState } from "../src/lib/settlement-export";

interface Row {
  platform: string;
  merchant_name: string;
  total: number;
  paid: number;
}

/** 简化版商家列，filter/sorter 与页面同构 */
const columns: ColumnsType<Row> = [
  {
    title: "平台", dataIndex: "platform",
    filters: [{ text: "CG", value: "CG" }, { text: "MUI", value: "MUI" }],
    onFilter: (v, r) => r.platform === v,
  },
  { title: "商家", dataIndex: "merchant_name" },
  { title: "总佣金", dataIndex: "total", sorter: (a, b) => a.total - b.total },
  { title: "已支付", dataIndex: "paid", sorter: (a, b) => a.paid - b.paid },
];

const ROWS: Row[] = [
  { platform: "CG", merchant_name: "NASM", total: 20446.12, paid: 5042.09 },
  { platform: "CG", merchant_name: "Rula", total: 15567.5, paid: 292.5 },
  { platform: "LB", merchant_name: "FlexPro", total: 15324.98, paid: 0 },
  { platform: "MUI", merchant_name: "CLEARSTEM", total: 10519.71, paid: 0 },
  { platform: "CG", merchant_name: "零佣金商家", total: 0, paid: 0 },
];

describe("applyTableState", () => {
  it("没动过表头时保持接口原序（已 ORDER BY total DESC）", () => {
    const out = applyTableState(ROWS, columns, {});
    assert.deepEqual(out.map((r) => r.merchant_name), ["NASM", "Rula", "FlexPro", "CLEARSTEM", "零佣金商家"]);
  });

  it("不改动入参数组（导出不能把页面上的顺序搅乱）", () => {
    const before = ROWS.map((r) => r.merchant_name);
    applyTableState(ROWS, columns, { sortKey: "total", sortOrder: "ascend" });
    assert.deepEqual(ROWS.map((r) => r.merchant_name), before);
  });

  it("套用平台筛选，导出筛选后的全部行", () => {
    const state: TableState = { filters: { platform: ["CG"] } };
    const out = applyTableState(ROWS, columns, state);
    assert.deepEqual(out.map((r) => r.merchant_name), ["NASM", "Rula", "零佣金商家"]);
  });

  it("多选筛选是「或」关系，与 AntD 一致", () => {
    const state: TableState = { filters: { platform: ["CG", "MUI"] } };
    const out = applyTableState(ROWS, columns, state);
    assert.deepEqual(out.map((r) => r.platform), ["CG", "CG", "MUI", "CG"]);
  });

  it("空筛选数组视为未筛选", () => {
    const out = applyTableState(ROWS, columns, { filters: { platform: [] } });
    assert.equal(out.length, 5);
  });

  it("按已支付升序，与表头点出来的顺序一致", () => {
    const state: TableState = { sortKey: "paid", sortOrder: "ascend" };
    const out = applyTableState(ROWS, columns, state);
    assert.deepEqual(out.map((r) => r.paid), [0, 0, 0, 292.5, 5042.09]);
  });

  it("筛选和排序同时生效", () => {
    const state: TableState = { filters: { platform: ["CG"] }, sortKey: "total", sortOrder: "ascend" };
    const out = applyTableState(ROWS, columns, state);
    assert.deepEqual(out.map((r) => r.merchant_name), ["零佣金商家", "Rula", "NASM"]);
  });

  it("sortOrder 为 null（第三次点击取消排序）时不排序", () => {
    const state: TableState = { sortKey: "total", sortOrder: null };
    const out = applyTableState(ROWS, columns, state);
    assert.deepEqual(out.map((r) => r.merchant_name), ["NASM", "Rula", "FlexPro", "CLEARSTEM", "零佣金商家"]);
  });

  it("排序键在列里找不到时不炸，原序返回", () => {
    const state: TableState = { sortKey: "not_a_column", sortOrder: "ascend" };
    const out = applyTableState(ROWS, columns, state);
    assert.equal(out.length, 5);
    assert.equal(out[0].merchant_name, "NASM");
  });
});

describe("rateCell", () => {
  it("返回小数而非百分数（Excel 的 0.00% 会自己乘 100）", () => {
    // 页面显示 24.66%
    const v = rateCell(5042.09, 20446.12);
    assert.ok(v !== null);
    assert.ok(Math.abs(v - 0.24660) < 0.0001, `期望约 0.2466，实际 ${v}`);
  });

  it("总佣金为 0 时返回 null，导出留空而不是 0%", () => {
    assert.equal(rateCell(0, 0), null);
  });

  it("分子为 0、分母正常时返回 0 而不是 null", () => {
    assert.equal(rateCell(0, 15324.98), 0);
  });
});
