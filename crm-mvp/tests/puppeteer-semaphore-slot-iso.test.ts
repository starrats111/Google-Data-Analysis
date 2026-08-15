/**
 * SLOT-ISO-01 工作时间车道剥离（2026-08-15，07 指令）。
 *
 * 为什么这条必须有测试：这是并发调度的硬分区，两个方向坏掉都是**静默**的：
 *   - 剥离失效（换链接仍可借共享池）：工作时间换链接批量把 3 槽占满，广告生成的
 *     sitelinks 验证/主爬排队 30s+，员工感知「生成很慢」——正是 2026-08-15 上午
 *     exchangeQ 积压 70+ 的现场。
 *   - 剥离过度（广告侧把换链接专属槽也吃掉）：换链接工作时间彻底饿死，浏览器兜底
 *     全部 no_puppeteer_slot，跟不动的 JS 跳板链接全部积压。
 *
 * 测试用 EXCHANGE_ISOLATION_WORK_HOURS 环境变量把时段钉死（"0-24"=永远生效、
 * "0-0"=永远不生效），不依赖跑测试的时刻。
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
  delete process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF;
  const s = puppeteerSemaphoreStats();
  assert.equal(s.active, 0, "用例结束应无残留占用");
  assert.equal(s.activeExchangeTotal, 0, "换链接计数应归零");
});

/** 时段钉成 0-24：无论几点跑测试，剥离都生效 */
function isolationAlwaysOn() {
  process.env.EXCHANGE_ISOLATION_WORK_HOURS = "0-24";
  delete process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF;
}

/** 时段钉成 0-0（空区间）：剥离永远不生效，回到共享池 */
function isolationAlwaysOff() {
  process.env.EXCHANGE_ISOLATION_WORK_HOURS = "0-0";
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

describe("SLOT-ISO-01 工作时间换链接与广告生成槽位剥离", () => {
  test("剥离生效：换链接并发封顶 1，第 2 个被拒（哪怕池子还有空槽）", async () => {
    isolationAlwaysOn();
    await expectImmediate(acquireExchangeSlot(50), "第 1 个换链接应拿到专属槽");
    assert.equal(puppeteerSemaphoreStats().active, 1, "池子明明还有 2 个空槽");
    await expectRejected(acquireExchangeSlot(50), "第 2 个换链接必须被拒——不得再借弹性/预留");
  });

  test("剥离生效：换链接占着专属槽时，广告链路（normal+主爬）仍能拿满自己的 2 槽", async () => {
    isolationAlwaysOn();
    await expectImmediate(acquireExchangeSlot(50), "换链接占专属槽");
    // 先 normal 后 main：normal 授予时 ads 池空（预留完整），main 用掉预留——三车道共存
    await expectImmediate(acquirePuppeteerSlot(50), "normal（sitelinks 兜底）应有槽");
    await expectImmediate(acquireMainCrawlSlot(50), "主爬应立即有槽（用预留）");
    assert.equal(puppeteerSemaphoreStats().active, 3, "三条车道各归各位");
  });

  test("剥离生效：广告侧吃不掉换链接的专属槽（ads 封顶 2），换链接随到随有", async () => {
    isolationAlwaysOn();
    await expectImmediate(acquireMainCrawlSlot(50), "主爬 1");
    await expectImmediate(acquireMainCrawlSlot(50), "主爬 2（ads 池上限）");
    await expectRejected(acquireMainCrawlSlot(50), "第 3 个主爬必须被拒——那是换链接的专属槽");
    await expectRejected(acquirePuppeteerSlot(50), "normal 同样不得越界");
    await expectImmediate(acquireExchangeSlot(50), "换链接的专属槽必须还空着、随到随有");
  });

  test("剥离生效：normal 在 ads 池内仍给主爬留 1 个预留（D-027 语义不丢）", async () => {
    isolationAlwaysOn();
    await expectImmediate(acquirePuppeteerSlot(50), "normal 1");
    await expectRejected(acquirePuppeteerSlot(50), "normal 2 必须被拒——ads 池内要给主爬留预留");
    await expectImmediate(acquireMainCrawlSlot(50), "主爬到达即有槽");
  });

  test("剥离生效：换链接释放专属槽后，排队中的换链接被唤醒接棒", async () => {
    isolationAlwaysOn();
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

  test("非工作时间：维持 D-172/D-199 共享池行为（换链接可占满 3 槽）", async () => {
    isolationAlwaysOff();
    await expectImmediate(acquireExchangeSlot(50), "快车道");
    await expectImmediate(acquireExchangeSlot(50), "弹性配额");
    await expectImmediate(acquireExchangeSlot(50), "借预留");
    assert.equal(puppeteerSemaphoreStats().active, 3, "非工作时间行为与 D-199 完全一致");
  });

  test("回滚开关 PUPPETEER_EXCHANGE_ISOLATION_OFF=1 时剥离不生效", async () => {
    process.env.EXCHANGE_ISOLATION_WORK_HOURS = "0-24";
    process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF = "1";
    await expectImmediate(acquireExchangeSlot(50), "快车道");
    await expectImmediate(acquireExchangeSlot(50), "弹性配额（剥离已回滚，可借）");
    assert.equal(puppeteerSemaphoreStats().active, 2);
  });
});
