/**
 * SLOT-ISO-01 车道配额分离（2026-08-15 07 指令）+ D-298 双档配额（2026-08-28 07 指令）。
 *
 * 为什么这条必须有测试：这是并发调度的硬分区，两个方向坏掉都是**静默**的：
 *   - 分区失效（换链接仍可借共享池）：高峰时段换链接批量把 3 槽占满，广告生成的
 *     sitelinks 验证/主爬排队 30s+，员工感知「生成很慢」——正是 2026-08-15 上午
 *     exchangeQ 积压 70+ 的现场。
 *   - 分区过度（某条车道被压到 0）：该车道彻底饿死且不抛任何错。2026-08-28 事故即此形态——
 *     换链接被钉死在 1 并发且不分工作日，09:00 一到就 400 次/小时抢不到槽，
 *     补货连续 8 小时零产出，最后 101 个系列被误报 no_tracking_stuck。
 *
 * 测试把时段/星期都用环境变量钉死，不依赖跑测试的时刻：
 *   EXCHANGE_ISOLATION_WORK_HOURS "0-24"=恒高峰、"0-0"=恒低谷（end 开区间）
 *   EXCHANGE_ISOLATION_WORK_DAYS  "0-6"=每天都算工作日（闭区间），避免周末跑测试时挂掉
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  acquireExchangeSlot,
  acquireMainCrawlSlot,
  acquirePuppeteerSlot,
  puppeteerSemaphoreStats,
  type SlotRelease,
} from "../src/lib/puppeteer-semaphore";

const held: SlotRelease[] = [];
function track(r: SlotRelease): SlotRelease {
  held.push(r);
  return r;
}

afterEach(() => {
  while (held.length) held.pop()!();
  delete process.env.EXCHANGE_ISOLATION_WORK_HOURS;
  delete process.env.EXCHANGE_ISOLATION_WORK_DAYS;
  delete process.env.EXCHANGE_SLOTS_PEAK;
  delete process.env.EXCHANGE_SLOTS_OFFPEAK;
  delete process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF;
  const s = puppeteerSemaphoreStats();
  assert.equal(s.active, 0, "用例结束应无残留占用");
  assert.equal(s.activeExchangeTotal, 0, "换链接计数应归零");
});

/** 钉成恒高峰（工作日白天档）：换链接 1 / 广告 2 */
function peakAlways() {
  process.env.EXCHANGE_ISOLATION_WORK_HOURS = "0-24";
  process.env.EXCHANGE_ISOLATION_WORK_DAYS = "0-6";
  delete process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF;
}

/** 钉成恒低谷（夜间/周末档）：换链接 2 / 广告 1 */
function offpeakAlways() {
  process.env.EXCHANGE_ISOLATION_WORK_HOURS = "0-0";
  process.env.EXCHANGE_ISOLATION_WORK_DAYS = "0-6";
  delete process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF;
}

async function expectImmediate(p: Promise<SlotRelease>, msg: string) {
  const r = await p.catch((e: Error) => e);
  assert.ok(typeof r === "function", `${msg}（实际被拒：${(r as Error)?.message}）`);
  return track(r as SlotRelease);
}

async function expectRejected(p: Promise<SlotRelease>, msg: string) {
  const r = await p.catch((e: Error) => e);
  if (typeof r === "function") {
    track(r as SlotRelease);
    assert.fail(msg);
  }
  assert.match((r as Error).message, /slot timeout/i, msg);
}

describe("高峰档（工作日白天）：广告 2 / 换链接 1", () => {
  test("换链接并发封顶 1，第 2 个被拒（哪怕池子还有空槽）", async () => {
    peakAlways();
    await expectImmediate(acquireExchangeSlot(50), "第 1 个换链接应拿到专属槽");
    assert.equal(puppeteerSemaphoreStats().active, 1, "池子明明还有 2 个空槽");
    await expectRejected(acquireExchangeSlot(50), "第 2 个换链接必须被拒——不得再借弹性/预留");
  });

  test("换链接占着专属槽时，广告链路（normal+主爬）仍能拿满自己的 2 槽", async () => {
    peakAlways();
    await expectImmediate(acquireExchangeSlot(50), "换链接占专属槽");
    // 先 normal 后 main：normal 授予时 ads 池空（预留完整），main 用掉预留——三车道共存
    await expectImmediate(acquirePuppeteerSlot(50), "normal（sitelinks 兜底）应有槽");
    await expectImmediate(acquireMainCrawlSlot(50), "主爬应立即有槽（用预留）");
    assert.equal(puppeteerSemaphoreStats().active, 3, "三条车道各归各位");
  });

  test("广告侧吃不掉换链接的专属槽（ads 封顶 2），换链接随到随有", async () => {
    peakAlways();
    await expectImmediate(acquireMainCrawlSlot(50), "主爬 1");
    await expectImmediate(acquireMainCrawlSlot(50), "主爬 2（ads 池上限）");
    await expectRejected(acquireMainCrawlSlot(50), "第 3 个主爬必须被拒——那是换链接的专属槽");
    await expectRejected(acquirePuppeteerSlot(50), "normal 同样不得越界");
    await expectImmediate(acquireExchangeSlot(50), "换链接的专属槽必须还空着、随到随有");
  });

  test("normal 在 ads 池内仍给主爬留 1 个预留（D-027 语义不丢）", async () => {
    peakAlways();
    await expectImmediate(acquirePuppeteerSlot(50), "normal 1");
    await expectRejected(acquirePuppeteerSlot(50), "normal 2 必须被拒——ads 池内要给主爬留预留");
    await expectImmediate(acquireMainCrawlSlot(50), "主爬到达即有槽");
  });

  test("换链接释放专属槽后，排队中的换链接被唤醒接棒", async () => {
    peakAlways();
    const first = await expectImmediate(acquireExchangeSlot(200), "第 1 个换链接");
    let secondGot = false;
    const secondP = acquireExchangeSlot(2000).then((rel) => {
      secondGot = true;
      return track(rel);
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(secondGot, false, "专属槽被占时第 2 个换链接应在排队");
    first();
    await secondP;
    assert.equal(secondGot, true, "释放后排队中的换链接应接棒");
  });
});

describe("D-298 低谷档（夜间 / 周末）：换链接 2 / 广告 1", () => {
  test("换链接拿到 2 槽，第 3 个才被拒（高峰只给 1）", async () => {
    offpeakAlways();
    await expectImmediate(acquireExchangeSlot(50), "换链接 1");
    await expectImmediate(acquireExchangeSlot(50), "换链接 2 —— 低谷档就该比高峰多");
    assert.equal(puppeteerSemaphoreStats().active, 2);
    await expectRejected(acquireExchangeSlot(50), "第 3 个越界：那 1 槽留给广告");
  });

  test("广告降到 1 槽，但绝不为 0——主爬随到随有", async () => {
    offpeakAlways();
    await expectImmediate(acquireExchangeSlot(50), "换链接 1");
    await expectImmediate(acquireExchangeSlot(50), "换链接 2");
    await expectImmediate(acquireMainCrawlSlot(50), "广告最后 1 槽必须还在，不能被换链接吃掉");
    assert.equal(puppeteerSemaphoreStats().active, 3);
  });

  test("广告预算只剩 1 时不再给主爬预留，否则 normal 恒为 0 被饿死", async () => {
    offpeakAlways();
    await expectImmediate(acquirePuppeteerSlot(50), "normal 必须拿得到——预算 1 时不留预留");
    await expectRejected(acquirePuppeteerSlot(50), "但也只有这 1 个，第 2 个越界");
  });

  test("统计口径暴露当前档位与配额", async () => {
    offpeakAlways();
    const s = puppeteerSemaphoreStats();
    assert.equal(s.quotaProfile, "offpeak");
    assert.equal(s.quotaExchange, 2);
    assert.equal(s.quotaAds, 1);
    peakAlways();
    const p = puppeteerSemaphoreStats();
    assert.equal(p.quotaProfile, "peak");
    assert.equal(p.quotaExchange, 1);
    assert.equal(p.quotaAds, 2);
  });
});

describe("D-298 档位判定与配额夹紧", () => {
  test("周末整天走低谷：工作日区间排除周六周日", async () => {
    // 把工作日钉成「只有周三」(3-3)，再把时段开满——非周三的任何一天都必须落低谷。
    process.env.EXCHANGE_ISOLATION_WORK_HOURS = "0-24";
    process.env.EXCHANGE_ISOLATION_WORK_DAYS = "3-3";
    delete process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF;
    const beijingDay = new Date(Date.now() + 8 * 3600_000).getUTCDay();
    const expected = beijingDay === 3 ? "peak" : "offpeak";
    assert.equal(puppeteerSemaphoreStats().quotaProfile, expected, "档位应只看北京时间的星期");
  });

  test("配额被配成 0 时夹到 1——任何一条车道都不许饿死", async () => {
    offpeakAlways();
    process.env.EXCHANGE_SLOTS_OFFPEAK = "0";
    const s = puppeteerSemaphoreStats();
    assert.equal(s.quotaExchange, 1, "0 必须夹成 1");
    assert.equal(s.quotaAds, 2);
    await expectImmediate(acquireExchangeSlot(50), "夹紧后换链接仍拿得到槽");
  });

  test("配额被配成满池时夹到 MAX-1——广告侧同样不许饿死", async () => {
    offpeakAlways();
    process.env.EXCHANGE_SLOTS_OFFPEAK = "3";
    const s = puppeteerSemaphoreStats();
    assert.equal(s.quotaExchange, 2, "3 必须夹成 MAX-1");
    assert.equal(s.quotaAds, 1, "广告至少留 1");
  });

  test("非法配额值回退默认，不至于把池子配没", async () => {
    offpeakAlways();
    process.env.EXCHANGE_SLOTS_OFFPEAK = "abc";
    assert.equal(puppeteerSemaphoreStats().quotaExchange, 2, "非法值应回退低谷默认 2");
  });
});

describe("回滚开关", () => {
  test("PUPPETEER_EXCHANGE_ISOLATION_OFF=1 退回 D-172/D-199 共享池", async () => {
    process.env.EXCHANGE_ISOLATION_WORK_HOURS = "0-24";
    process.env.EXCHANGE_ISOLATION_WORK_DAYS = "0-6";
    process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF = "1";
    await expectImmediate(acquireExchangeSlot(50), "快车道");
    await expectImmediate(acquireExchangeSlot(50), "弹性配额（分区已回滚，可借）");
    await expectImmediate(acquireExchangeSlot(50), "借预留——共享池下换链接可占满 3 槽");
    assert.equal(puppeteerSemaphoreStats().active, 3);
    assert.equal(puppeteerSemaphoreStats().quotaProfile, "off");
  });
});
