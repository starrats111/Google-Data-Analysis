/**
 * D-331（2026-09-10）：佣金回写区间必须按 **CST 零点** 切，不能用 UTC 零点。
 *
 * 起因：applyAffiliateCommissionToDailyStats 把同一对 Date 边界用在两处——
 *   ① affiliate_transactions.transaction_time（DATETIME，聚合时 CONVERT_TZ 到 CST 切日）
 *   ② ads_daily_stats.date（DATE 列）
 * txn-quick-sync 原来传的是 dateColumnStart/dateColumnEndExclusive（UTC 零点），
 * 比 CST 零点晚 8 小时：窗口首日 CST 00:00-08:00 的订单落在聚合区间外，
 * 而那一天的行照样被对齐成「无佣金」→ 佣金被抹平；次日该日期滑出 14 天窗口，
 * 再没有任何任务会重算它，于是永久停在 0。
 *
 * 生产实证（2026-09-10 08:00 CST 全库对账，窗口首日 = 08-27）：
 *   yz04 缺 51 单 $392.03、yz02 缺 49 单 $301.85、yz03 缺 69 单 $212.48、
 *   wj02 缺 24 单 $133.66、wj10 缺 30 单 $104.94 …… 缺口与「该日 CST 00:00-08:00
 *   的单」逐用户逐分钱吻合。
 *
 * 另外四个调用方（daily-sync / data-center sync / sync-transactions / c082）
 * 本来就用 CST 口径，只有 quick-sync 这一处走偏。这条守卫钉住它别再改回去。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTxnDateStart, parseTxnDateEndExclusive, dateColumnStart } from "../src/lib/date-utils";

const HERE = dirname(fileURLToPath(import.meta.url));
const QUICK_SYNC = join(HERE, "..", "src", "app", "api", "cron", "txn-quick-sync", "route.ts");
const src = readFileSync(QUICK_SYNC, "utf8");

describe("D-331 佣金回写区间按 CST 切日", () => {
  it("txn-quick-sync 用 parseTxnDate* 生成回写边界", () => {
    assert.match(
      src,
      /const statsRangeStart = parseTxnDateStart\(startStr\);/,
      "statsRangeStart 必须用 parseTxnDateStart（CST 零点）",
    );
    assert.match(
      src,
      /const statsRangeEnd = parseTxnDateEndExclusive\(endStr\);/,
      "statsRangeEnd 必须用 parseTxnDateEndExclusive（CST 次日零点）",
    );
  });

  it("不再出现 UTC 零点的 dateColumn* 边界", () => {
    assert.ok(
      !/dateColumn(Start|EndExclusive)\s*\(/.test(src),
      "dateColumn* 给的是 UTC 零点，用作 transaction_time 上下界会漏掉窗口首日 CST 00:00-08:00 的单",
    );
  });

  it("CST 零点比 UTC 零点早 8 小时（即被漏掉的那一段）", () => {
    const cst = parseTxnDateStart("2026-08-27").getTime();
    const utc = dateColumnStart("2026-08-27").getTime();
    assert.equal(utc - cst, 8 * 60 * 60 * 1000, "两者应恰好差 8 小时");
  });

  it("CST 区间完整覆盖首日与末日整天", () => {
    const start = parseTxnDateStart("2026-08-27");
    const end = parseTxnDateEndExclusive("2026-09-10");
    // 首日 CST 00:30 的单（UTC 前一日 16:30）必须落在区间内
    const firstDayEarly = new Date("2026-08-26T16:30:00.000Z");
    assert.ok(firstDayEarly >= start, "窗口首日 CST 凌晨的单不能被排除在外");
    // 末日 CST 23:30 的单（UTC 当日 15:30）必须落在区间内
    const lastDayLate = new Date("2026-09-10T15:30:00.000Z");
    assert.ok(lastDayLate < end, "窗口末日深夜的单必须包含在内");
    // 末日次日 CST 00:30 的单必须落在区间外
    const nextDay = new Date("2026-09-10T16:30:00.000Z");
    assert.ok(nextDay >= end, "窗口外的单不能被算进来");
  });
});
