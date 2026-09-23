/**
 * D-351 补货闸门：「本机资源持续开不出浏览器」的退避。
 *
 * 与 D-201 是同一个死循环的两扇门，故测试也照它的口径钉：
 *   (a) local_resource 按 D-231 刻意不累加死链计数（不冤枉链接——我方开不出浏览器不是链接的错）；
 *   (b) lease NO_STOCK 走 force，而 force 设计上穿透冷却。
 * 结果是库存恒 0 的系列每次 lease 都 NO_STOCK → force → 穿透冷却 → 内存仍不够 → 库存仍 0。
 * 实测 690-RW1-DepopLimitedUS（campaign 27842）单日 10,598 次：7,105 次内存反压 + 3,493 次
 * 抢不到槽；10min 冷却本该封顶 144 次/天，实际是它的 73 倍。全库同形态 1,377 个系列冷却字段为 NULL、
 * 处于冷却中的是 0 个。
 *
 * 两个方向都会悄悄坏掉且都不抛错：
 *   - 放太松 → 白跑照旧，内存压力不降（源站 520 继续）；
 *   - 收太紧 → 资源一抖动就长时间不补货，广告断供。
 * 故把 streak 累加、阈值、冷却时长、force/manual 的交叉结果逐一钉死。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCooldownGate,
  isLocalResourceBlocked,
  isNoTrackingStuck,
} from "../src/lib/suffix-engine/replenish-gate";
import { STOCK_CONFIG } from "../src/lib/suffix-engine/config";

const future = () => new Date(Date.now() + 60_000);
const past = () => new Date(Date.now() - 60_000);
const N = STOCK_CONFIG.LOCAL_BLOCK_STREAK_THRESHOLD;

describe("本机资源阻塞的阈值判定", () => {
  test("阈值与 D-201 对齐取 3 轮", () => {
    assert.equal(N, 3, "与 ALIVE_NO_TRACKING_STREAK_THRESHOLD 同口径；改动需回设计方案确认");
  });

  test("未达阈值不判定阻塞——瞬时内存尖峰要允许重试跨过去", () => {
    assert.equal(isLocalResourceBlocked(0), false);
    assert.equal(isLocalResourceBlocked(1), false, "第 1 轮可能只是别的 Chrome 恰好在跑");
    assert.equal(isLocalResourceBlocked(N - 1), false);
  });

  test("达阈值及以上判定为持续性阻塞", () => {
    assert.equal(isLocalResourceBlocked(N), true);
    assert.equal(isLocalResourceBlocked(N + 100), true);
  });

  test("与 no_tracking 的判据互不影响——病灶一个在我方机器、一个在链接", () => {
    assert.equal(isNoTrackingStuck(0), false, "local streak 高不该让链接被判卡死");
    assert.equal(isLocalResourceBlocked(0), false, "no_tracking streak 高不该让机器被判阻塞");
  });
});

describe("冷却闸门与 force 的交叉判定", () => {
  test("冷却已过期：一律放行，与改动前一致", () => {
    const r = evaluateCooldownGate({
      cooldownUntil: past(),
      noTrackingStreak: 0,
      localBlockStreak: N + 5,
      force: true,
      manual: false,
    });
    assert.equal(r.skip, false, "冷却到期就该自动恢复，资源紧张会自己缓解");
  });

  test("冷却中且非 force：照旧跳过（D-177 语义不变）", () => {
    const r = evaluateCooldownGate({
      cooldownUntil: future(),
      noTrackingStreak: 0,
      localBlockStreak: 0,
      force: false,
      manual: false,
    });
    assert.equal(r.skip, true);
    assert.equal(r.reason, "fail_cooldown");
  });

  test("★病灶：冷却中 + force + 未达阈值 → 仍放行", () => {
    const r = evaluateCooldownGate({
      cooldownUntil: future(),
      noTrackingStreak: 0,
      localBlockStreak: N - 1,
      force: true,
      manual: false,
    });
    assert.equal(r.skip, false, "真没货时要能按需补，不能一次失败就锁死");
  });

  test("★修复点：冷却中 + force + 达阈值 → 挡住", () => {
    const r = evaluateCooldownGate({
      cooldownUntil: future(),
      noTrackingStreak: 0,
      localBlockStreak: N,
      force: true,
      manual: false,
    });
    assert.equal(r.skip, true, "这一条不成立的话 27842 那 10,598 次/天照旧");
    assert.equal(r.reason, "local_resource_cooldown");
  });

  test("人工入口永远穿透——人在页面上等结论", () => {
    const r = evaluateCooldownGate({
      cooldownUntil: future(),
      noTrackingStreak: 0,
      localBlockStreak: N + 10,
      force: true,
      manual: true,
    });
    assert.equal(r.skip, false, "手工补货必须能立刻试，否则没法验证换的新链接");
  });

  test("localBlockStreak 省略时按 0 处理，等于改动前行为", () => {
    const r = evaluateCooldownGate({
      cooldownUntil: future(),
      noTrackingStreak: 0,
      force: true,
      manual: false,
    });
    assert.equal(r.skip, false, "新字段不传不该改变任何既有调用方的行为");
  });

  test("两种阻塞同时成立时先报 no_tracking——链接问题优先于机器问题", () => {
    const r = evaluateCooldownGate({
      cooldownUntil: future(),
      noTrackingStreak: STOCK_CONFIG.ALIVE_NO_TRACKING_STREAK_THRESHOLD,
      localBlockStreak: N,
      force: true,
      manual: false,
    });
    assert.equal(r.skip, true);
    assert.equal(r.reason, "no_tracking_stuck_cooldown", "链接卡死要人工换链接，机器紧张会自愈");
  });
});

describe("冷却时长", () => {
  test("达阈值后的冷却远长于 10min，但远短于死链的 8h", () => {
    assert.ok(
      STOCK_CONFIG.LOCAL_BLOCK_COOLDOWN_MS > STOCK_CONFIG.PROXY_UNAVAILABLE_COOLDOWN_MS,
      "不拉长就压不住重试频率",
    );
    assert.ok(
      STOCK_CONFIG.LOCAL_BLOCK_COOLDOWN_MS < STOCK_CONFIG.DEAD_LINK_COOLDOWN_MS,
      "资源紧张会自己缓解，不该像坏链那样锁半天",
    );
  });

  test("按小时量级取值：把重试从每分钟数次压到每小时一次", () => {
    assert.equal(STOCK_CONFIG.LOCAL_BLOCK_COOLDOWN_MS, 60 * 60_000);
  });
});
