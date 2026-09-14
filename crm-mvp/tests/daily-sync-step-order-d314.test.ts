/**
 * D-314.3（07 2026-09-07 拍板）：daily-sync 里**打款同步必须排在交易同步之前**。
 *
 * 起因：交易同步每天 07:51 前后把 Node 堆撑爆（--max-old-space-size=768，崩在 765MB），
 * V8 FATAL、进程被 pm2 重启。堆溢出接不住，排在它后面的步骤等于永远不执行 ——
 * 打款同步（原 Step 3.5）自 2026-08-29 起一次没跑过，affiliate_payments 停更一周，
 * 财务导月表对不上（D-314.2 那笔 CG 8153325 就是被这个拖住的）。
 *
 * 这条守卫按源码顺序断言，防止以后有人「顺手」把打款同步挪回交易同步后面。
 *
 * D-333（2026-09-14）续：已付剖分原先钉在「交易同步之后」，但那个位置根本到不了 ——
 * 交易同步的 OOM 同样会吃掉排在它后面的剖分（pm2 日志：Step 3 出现 14 次，
 * Step 3.6 / All done in 各 0 次），RW/LH/LB 的 paid 桶因此冻结半年。
 * 剖分已摘成独立 cron（api/cron/paid-carve，09:40，排在 07:51 那次 OOM 重启之后），
 * 「必须在交易同步之后」这条不变量改由独立进程周期保证，不再靠 daily-sync 内的顺序。
 * 所以本文件的第二条守卫从「顺序」改为钉住「剖分不得回流进 daily-sync」。
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

  it("D-333 已付剖分不得回流进 daily-sync（会被交易同步的 OOM 吃掉）", () => {
    // 只认真实调用点，不认注释里的提名（源码里留了「原 carvePaidForAllUsers() 已迁走」的说明）
    const called = (fn: string) =>
      new RegExp(`(?<!//[^\\n]*)\\bawait\\s+${fn}\\s*\\(`).test(src);
    assert.ok(
      !called("carvePaidForAllUsers") && !called("markPaidFromPaymentDetails"),
      "剖分必须留在独立 cron api/cron/paid-carve 里。放回 daily-sync 就会重演 D-333："
      + "交易同步 OOM → 进程被 pm2 重启 → 剖分永不执行 → RW/LH/LB 的 paid 桶冻结、结算率低估",
    );
  });

  it("D-333 独立剖分 cron 存在且会遍历用户执行剖分", () => {
    const carveRoute = join(
      dirname(fileURLToPath(import.meta.url)),
      "..", "src", "app", "api", "cron", "paid-carve", "route.ts",
    );
    const carveSrc = readFileSync(carveRoute, "utf8");
    assert.ok(
      carveSrc.includes("markPaidFromPaymentDetails"),
      "paid-carve cron 必须调用 markPaidFromPaymentDetails",
    );
  });
});
