/**
 * D-199 借预留槽：主爬没在排队时，空着的第 3 槽让给换链接。
 *
 * 为什么这条必须有测试：这是并发调度，两个方向坏掉都是**静默**的，线上只会表现为莫名其妙的
 * 业务症状，不会抛错。
 *   - 借不到（回退成旧行为）：换链接干等 30s 后 no_puppeteer_slot，症状是 suffix 生成失败刷
 *     invalid_link 告警，而监控里 active 明明只有 2/3 —— 正是 2026-07-29 当天 29 次超时的现场。
 *   - 借了不还 / 抢不回：主爬被换链接饿死，UI 报「爬取失败」假象，即 D-027 那次事故的复发。
 * 两者都只能靠测试兜住，线上看不出来。
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  acquireExchangeSlot,
  acquireMainCrawlSlot,
  acquirePuppeteerSlot,
  puppeteerSemaphoreStats,
} from "../src/lib/puppeteer-semaphore";

// SLOT-ISO-01：本文件钉的是「非工作时间」的共享池行为（快车道/弹性/借预留），
// 显式关闭工作时间剥离，否则测试结果随 CI 跑在几点而变（北京白天必挂）。
process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF = "1";

/** 每个用例结束后归零，模块级状态是跨用例共享的。 */
const held: Array<() => void> = [];
function track(release: () => void): () => void {
  held.push(release);
  return release;
}
afterEach(() => {
  while (held.length) held.pop()!();
  delete process.env.PUPPETEER_EXCHANGE_RESERVE_OFF;
  const s = puppeteerSemaphoreStats();
  assert.equal(s.active, 0, "用例结束应无残留占用");
  assert.equal(s.activeExchangeFast, 0, "快车道计数应归零");
});

/** 断言这次申请没有排队——排队的话会等满 timeout 才 reject。 */
async function expectImmediate(p: Promise<() => void>, msg: string) {
  const r = await p.catch((e: Error) => e);
  assert.ok(typeof r === "function", `${msg}（实际被拒：${(r as Error)?.message}）`);
  return track(r as () => void);
}

async function expectRejected(p: Promise<() => void>, msg: string) {
  const r = await p.catch((e: Error) => e);
  if (typeof r === "function") {
    track(r);
    assert.fail(msg);
  }
  assert.match((r as Error).message, /slot timeout/i, msg);
}

describe("D-199 换链接借用主爬预留槽", () => {
  test("回归：快车道已占 + 弹性已占（active=2/3、主爬没排队）时，第三个换链接会话立即拿到槽", async () => {
    await expectImmediate(acquireExchangeSlot(50), "第 1 个换链接应走快车道");
    await expectImmediate(acquireExchangeSlot(50), "第 2 个换链接应走弹性配额");

    assert.equal(puppeteerSemaphoreStats().active, 2, "此时正是线上超时现场的 active=2/3");

    // 修复前这里两条路全断（快车道封顶 1、normal 判定 _active<2 不成立），会干等 30s 后失败。
    await expectImmediate(acquireExchangeSlot(50), "第 3 个换链接应借用空着的预留槽");
    assert.equal(puppeteerSemaphoreStats().active, 3);
  });

  test("总并发上限仍是 3，借预留不会把池撑大", async () => {
    await expectImmediate(acquireExchangeSlot(50), "1");
    await expectImmediate(acquireExchangeSlot(50), "2");
    await expectImmediate(acquireExchangeSlot(50), "3");
    await expectRejected(acquireExchangeSlot(50), "第 4 个换链接必须被拒，否则内存上限失守");
  });

  test("主爬优先级不受影响：池被换链接占满后，第一个释放的槽归主爬而不是排队中的换链接", async () => {
    const r1 = await expectImmediate(acquireExchangeSlot(50), "1");
    await expectImmediate(acquireExchangeSlot(50), "2");
    await expectImmediate(acquireExchangeSlot(50), "3");

    let mainGot = false;
    const mainP = acquireMainCrawlSlot(2000).then((rel) => {
      mainGot = true;
      return track(rel);
    });
    let exchangeGot = false;
    const exchangeP = acquireExchangeSlot(2000).then((rel) => {
      exchangeGot = true;
      return track(rel);
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(puppeteerSemaphoreStats().queuedMain, 1, "主爬应在排队");

    r1(); // 释放一个换链接会话
    await mainP;
    assert.equal(mainGot, true, "主爬应抢到这个槽");
    assert.equal(exchangeGot, false, "排队中的换链接不得插队到主爬前面");

    // 收尾：让排队中的换链接拿到槽后一并释放，避免污染后续用例
    held.pop()!();
    await exchangeP;
  });

  test("normal 车道语义不变：仍只能用 2 个槽，不会因为新增借预留而摸到预留槽", async () => {
    await expectImmediate(acquirePuppeteerSlot(50), "normal 1");
    await expectImmediate(acquirePuppeteerSlot(50), "normal 2");
    await expectRejected(acquirePuppeteerSlot(50), "normal 第 3 个必须被拒（预留槽只给主爬和换链接）");
  });

  test("PUPPETEER_EXCHANGE_RESERVE_OFF=1 可单独回滚到旧行为", async () => {
    process.env.PUPPETEER_EXCHANGE_RESERVE_OFF = "1";
    await expectImmediate(acquireExchangeSlot(50), "快车道不受回滚开关影响");
    await expectImmediate(acquireExchangeSlot(50), "弹性配额不受回滚开关影响");
    await expectRejected(acquireExchangeSlot(50), "回滚开关打开时，第 3 个换链接应恢复成拿不到槽");
  });
});
