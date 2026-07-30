/**
 * D-201 补货闸门：「链接活着但不记点击」的判定与退避。
 *
 * 为什么这些必须有测试：病灶本身就是两条各自合理的规则叠成了死循环——
 *   (a) handleProbeFailure 把 alive_no_tracking 判成「活链」并清零死链计数，永远升不到告警；
 *   (b) lease NO_STOCK 走 force，而 force 设计上穿透冷却。
 * 卡死系列库存恒为 0 → 每次 lease 都 NO_STOCK → force → 绕过冷却 → 开浏览器 → 又零参数。
 * 实测 214-LB2-jwpei 连续 5 天约 130 次/天全部白跑、且一条新告警都没有。
 *
 * 修复方向两头都可能悄悄坏掉，且都不抛错：
 *   - 放太松 → 白跑照旧（省不到任何东西）；
 *   - 收太紧 → 健康系列真没货时也被挡，广告断供。
 * 故这里把四个条件的交叉结果逐一钉死。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyNoTrackingRound,
  evaluateCooldownGate,
  isNoTrackingStuck,
} from "../src/lib/suffix-engine/replenish-gate";
import { STOCK_CONFIG } from "../src/lib/suffix-engine/config";

const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);
const N = STOCK_CONFIG.ALIVE_NO_TRACKING_STREAK_THRESHOLD;

describe("连续零参数轮次的升级判定", () => {
  test("07 定的阈值是 3 轮", () => {
    assert.equal(N, 3, "07 2026-07-30 拍板 N=3；改动此值需回到设计方案确认");
  });

  test("未达阈值维持短冷却重试，不误判成死链", () => {
    const r1 = classifyNoTrackingRound(0);
    assert.equal(r1.streak, 1);
    assert.equal(r1.stuck, false, "第 1 轮可能只是出口 IP 抖动，不能判死");
    assert.equal(r1.cooldownMs, STOCK_CONFIG.ALIVE_LINK_COOLDOWN_MS);

    const r2 = classifyNoTrackingRound(1);
    assert.equal(r2.streak, 2);
    assert.equal(r2.stuck, false);
  });

  test("第 3 轮升级为卡死并切换到长冷却", () => {
    const r3 = classifyNoTrackingRound(2);
    assert.equal(r3.streak, 3);
    assert.equal(r3.stuck, true);
    assert.equal(
      r3.cooldownMs,
      STOCK_CONFIG.DEAD_LINK_COOLDOWN_MS,
      "达阈值后必须拉长到 8h，否则 30 分钟一轮的白跑照旧",
    );
  });

  test("已卡死的系列继续累加、保持长冷却（不会自己降级）", () => {
    const r = classifyNoTrackingRound(9);
    assert.equal(r.streak, 10);
    assert.equal(r.stuck, true);
    assert.equal(r.cooldownMs, STOCK_CONFIG.DEAD_LINK_COOLDOWN_MS);
  });

  test("isNoTrackingStuck 的边界正好落在阈值上", () => {
    assert.equal(isNoTrackingStuck(N - 1), false);
    assert.equal(isNoTrackingStuck(N), true);
  });
});

describe("冷却闸门：force / manual / 卡死 的交叉判定", () => {
  test("不在冷却期一律放行（含已卡死系列，到期就该再验一次）", () => {
    const g = evaluateCooldownGate({
      cooldownUntil: past(),
      noTrackingStreak: 99,
      force: false,
      manual: false,
    });
    assert.equal(g.skip, false, "长冷却到期后必须自动再探一次，否则系列永久失联");
  });

  test("冷却截止为 null 时放行", () => {
    const g = evaluateCooldownGate({
      cooldownUntil: null,
      noTrackingStreak: 0,
      force: false,
      manual: false,
    });
    assert.equal(g.skip, false);
  });

  test("冷却期内的普通 cron 轮次被挡（D-177 原语义不变）", () => {
    const g = evaluateCooldownGate({
      cooldownUntil: future(),
      noTrackingStreak: 0,
      force: false,
      manual: false,
    });
    assert.equal(g.skip, true);
    assert.equal(g.reason, "fail_cooldown");
  });

  test("健康系列的 force 仍能穿透冷却——真没货时不能挡（防断供）", () => {
    const g = evaluateCooldownGate({
      cooldownUntil: future(),
      noTrackingStreak: N - 1,
      force: true,
      manual: false,
    });
    assert.equal(g.skip, false, "未判卡死的系列必须保留 D-177 的 force 穿透能力");
  });

  test("卡死系列的自动 force 被挡住——这条就是省下白跑的那一刀", () => {
    const g = evaluateCooldownGate({
      cooldownUntil: future(),
      noTrackingStreak: N,
      force: true,
      manual: false,
    });
    assert.equal(g.skip, true, "lease NO_STOCK 不得再触发浏览器");
    assert.equal(g.reason, "no_tracking_stuck_cooldown");
  });

  test("人工入口永远放行：换了新链接必须能当场重试", () => {
    const g = evaluateCooldownGate({
      cooldownUntil: future(),
      noTrackingStreak: 999,
      force: true,
      manual: true,
    });
    assert.equal(g.skip, false, "否则员工换了链接还要干等 8h，等于没救");
  });

  test("manual 但没带 force：仍按普通冷却挡（manual 只解卡死这一条例外）", () => {
    const g = evaluateCooldownGate({
      cooldownUntil: future(),
      noTrackingStreak: N,
      force: false,
      manual: true,
    });
    assert.equal(g.skip, true);
    assert.equal(g.reason, "fail_cooldown");
  });
});

describe("回归复现：jwpei 死循环在修复后被切断", () => {
  test("库存恒为 0 的卡死系列，连续 lease 不再各开一次浏览器", () => {
    // 复刻真实序列：系列已连续 N 轮零参数并进入长冷却，脚本随后反复 lease。
    let browserRuns = 0;
    const cooldownUntil = new Date(Date.now() + STOCK_CONFIG.DEAD_LINK_COOLDOWN_MS);
    for (let i = 0; i < 50; i++) {
      const g = evaluateCooldownGate({
        cooldownUntil,
        noTrackingStreak: N,
        force: true, // lease NO_STOCK 恒走 force
        manual: false,
      });
      if (!g.skip) browserRuns++;
    }
    assert.equal(browserRuns, 0, "修复前这里是 50 次浏览器白跑");
  });
});
