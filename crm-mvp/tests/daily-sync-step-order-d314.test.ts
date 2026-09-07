/**
 * D-314.3（07 2026-09-07 拍板）：daily-sync 里**打款同步必须排在交易同步之前**。
 *
 * 起因：交易同步每天 07:51 前后把 Node 堆撑爆（--max-old-space-size=768，崩在 765MB），
 * V8 FATAL、进程被 pm2 重启。堆溢出接不住，排在它后面的步骤等于永远不执行 ——
 * 打款同步（原 Step 3.5）自 2026-08-29 起一次没跑过，affiliate_payments 停更一周，
 * 财务导月表对不上（D-314.2 那笔 CG 8153325 就是被这个拖住的）。
 *
 * 这条守卫按源码顺序断言，防止以后有人「顺手」把打款同步挪回交易同步后面。
 * 同时钉住：已付剖分（carve）必须留在交易同步之后 —— 它要把**已存在的**交易行标成 paid。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROUTE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "api", "cron", "daily-sync", "route.ts");
const src = readFileSync(ROUTE, "utf8");

/** 取「调用点」的位置：函数定义处不算，只认 await xxx() */
const callAt = (fn: string): number => {
  const i = src.indexOf(`await ${fn}()`);
  assert.notEqual(i, -1, `daily-sync 里找不到 await ${fn}() 的调用`);
  return i;
};

describe("D-314.3 daily-sync 步骤顺序", () => {
  it("打款同步排在交易同步之前（交易同步 OOM 时打款数据仍能更新）", () => {
    assert.ok(
      callAt("syncAllUsersPayments") < callAt("syncAllUsersTransactions"),
      "syncAllUsersPayments 必须在 syncAllUsersTransactions 之前调用——它排在后面时，"
      + "交易同步一 OOM，打款单就整周不更新（2026-08-29 ~ 09-07 实况）",
    );
  });

  it("已付剖分留在交易同步之后（它依赖已存在的交易行）", () => {
    assert.ok(
      callAt("carvePaidForAllUsers") > callAt("syncAllUsersTransactions"),
      "carvePaidForAllUsers 依赖交易行已入库，不能跟着打款同步一起前移",
    );
  });
});
