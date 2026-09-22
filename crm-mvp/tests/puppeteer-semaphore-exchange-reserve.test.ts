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

/**
 * 2026-09-14：断言值一律从 stats 推导，不写死 2/3。
 *   起因：D-335 因内存实测把 MAX_PUPPETEER_SLOTS 3→2，本文件 23 条断言集体挂掉，
 *   而失败原因全是「测试写死了 MAX=3 的数字」，不是调度真的坏了。写死数字让这批测试
 *   在容量调整时集体误报，反过来掩盖真正的回归。
 *   钉的是**语义**（借预留能把池占满、总量不超 MAX、normal 摸不到预留槽），与 MAX 取值无关。
 */
const CAP = puppeteerSemaphoreStats();
/** 共享池下换链接可占满的槽数 = 全池 */
const POOL = CAP.max;
/** normal 车道上限（= MAX - 主爬预留） */
const NORMAL_MAX = CAP.normalMax;

/** 连续申请 n 个槽，全部必须立即拿到 */
async function fillWith(acquire: (ms: number) => Promise<() => void>, n: number, label: string) {
  for (let i = 1; i <= n; i++) {
    await expectImmediate(acquire(50), `${label} 第 ${i}/${n} 个`);
  }
}

describe("D-199 换链接借用主爬预留槽", () => {
  test("回归：非预留槽已占满、主爬没排队时，下一个换链接会话仍立即拿到槽（借预留）", async () => {
    // 先占满「不含主爬预留」的部分（快车道 + 弹性），此刻即线上超时现场：
    // active = MAX-1，第 3 槽空着且无人排队，旧实现两条路全断会干等 30s。
    await fillWith(acquireExchangeSlot, POOL - CAP.reservedMainCrawl, "占满非预留部分");
    assert.equal(
      puppeteerSemaphoreStats().active,
      POOL - CAP.reservedMainCrawl,
      `此时正是线上超时现场的 active=${POOL - CAP.reservedMainCrawl}/${POOL}`,
    );

    await expectImmediate(acquireExchangeSlot(50), "下一个换链接应借用空着的预留槽");
    assert.equal(puppeteerSemaphoreStats().active, POOL, "借预留后应恰好占满全池");
  });

  test(`总并发上限仍是 MAX(${POOL})，借预留不会把池撑大`, async () => {
    await fillWith(acquireExchangeSlot, POOL, "换链接");
    await expectRejected(acquireExchangeSlot(50), `第 ${POOL + 1} 个换链接必须被拒，否则内存上限失守`);
  });

  test("主爬优先级不受影响：池被换链接占满后，第一个释放的槽归主爬而不是排队中的换链接", async () => {
    const r1 = await expectImmediate(acquireExchangeSlot(50), "换链接 1");
    await fillWith(acquireExchangeSlot, POOL - 1, "换链接占满余下");

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

  test(`normal 车道语义不变：仍只能用 normalMax(${NORMAL_MAX}) 个槽，不会因为新增借预留而摸到预留槽`, async () => {
    await fillWith(acquirePuppeteerSlot, NORMAL_MAX, "normal");
    await expectRejected(
      acquirePuppeteerSlot(50),
      `normal 第 ${NORMAL_MAX + 1} 个必须被拒（预留槽只给主爬和换链接）`,
    );
  });

  test("PUPPETEER_EXCHANGE_RESERVE_OFF=1 可单独回滚到旧行为", async () => {
    process.env.PUPPETEER_EXCHANGE_RESERVE_OFF = "1";
    // 回滚后换链接只能用「非预留」部分：快车道 + 弹性，拿不到预留槽。
    await fillWith(acquireExchangeSlot, POOL - CAP.reservedMainCrawl, "回滚后换链接");
    await expectRejected(
      acquireExchangeSlot(50),
      `回滚开关打开时，第 ${POOL - CAP.reservedMainCrawl + 1} 个换链接应恢复成拿不到槽`,
    );
  });
});
