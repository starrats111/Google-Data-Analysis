/**
 * D-231 内存反压的判定时机。
 *
 * 为什么这条必须有测试：D-220 把内存检查放在 _acquire 入口无条件执行，看起来完全合理，
 * 直到你意识到**满载时的低内存正是那几个在跑的 Chrome 造成的**——于是「有浏览器在跑」
 * 本身成了「拒绝你排队等浏览器」的理由，池子越忙拒绝越多，而且它们下一秒就会释放。
 *
 * 线上表现完全不像内存问题：换链接把跟得动的好链接判成「联盟链接疑似失效」，
 * 2026-08-12 单日 332 次 low_memory（现场快照几乎全是 active=3/3）+ 1577 次抢槽超时，
 * 2359 个在投系列里 1726 个库存归零。查的时候会一路查到联盟平台去。
 *
 * 所以这里要同时钉住两件事：满载必须排队、有空槽时 D-220 的保护一分不减。
 */
import { test, describe, afterEach, beforeEach } from "node:test";
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

// SLOT-ISO-01：本文件钉的是共享池语义下的内存反压时机，显式关闭工作时间剥离，
// 保证结果不随 CI 跑在几点而变。
process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF = "1";

beforeEach(() => {
  delete process.env.PUPPETEER_MIN_AVAILABLE_MB;
  delete process.env.PUPPETEER_FAKE_AVAILABLE_MB;
});

afterEach(() => {
  while (held.length) held.pop()!();
  delete process.env.PUPPETEER_MIN_AVAILABLE_MB;
  delete process.env.PUPPETEER_FAKE_AVAILABLE_MB;
  assert.equal(puppeteerSemaphoreStats().active, 0, "用例结束应无残留占用");
});

/** 拿到槽位说明断言前提就错了——必须 track 后再报错，否则泄漏的槽位会连累后续用例 */
async function expectRejectedWithCode(p: Promise<SlotRelease>, code: string, msg: string) {
  const r = await p.catch((e: Error) => e);
  if (typeof r === "function") {
    track(r as SlotRelease);
    assert.fail(`${msg}（实际拿到了槽位）`);
  }
  assert.equal((r as Error & { code?: string }).code, code, msg);
}

/**
 * 占满全池并返回释放器供用例按需放行。
 *
 * 2026-09-14：槽数从 stats 推导，不写死 3。D-335 把 MAX 3→2 时本文件因写死数字挂掉，
 * 而本用例钉的是「满载该排队、有空槽才查内存」这个**时机**语义，与池子多大无关。
 * 组成：normal 吃满自己的配额（normalMax），余下的预留槽由主爬占掉。
 */
async function fillPool(): Promise<SlotRelease[]> {
  const { max, normalMax } = puppeteerSemaphoreStats();
  const slots: SlotRelease[] = [];
  for (let i = 0; i < normalMax; i++) {
    slots.push(track(await acquirePuppeteerSlot(1000)));
  }
  // 剩下的都是主爬预留，用主爬车道占掉（normal 摸不到预留槽）
  for (let i = normalMax; i < max; i++) {
    slots.push(track(await acquireMainCrawlSlot(1000)));
  }
  assert.equal(puppeteerSemaphoreStats().active, max, `前提：池子已满（${max} 槽）`);
  return slots;
}

describe("D-231 内存反压只在真要 launch 那一刻判", () => {
  test("满载 + 低内存应当排队，等有槽释放后拿到——而不是当场判定资源耗尽", async () => {
    process.env.PUPPETEER_MIN_AVAILABLE_MB = "500";
    process.env.PUPPETEER_FAKE_AVAILABLE_MB = "2000";
    const slots = await fillPool();

    // 掉到水位以下——这正是「3 个 Chrome 正在跑」时 /proc/meminfo 的真实读数，
    // 事故当天 193 次拒绝全部落在 467-499MB 这个区间。
    process.env.PUPPETEER_FAKE_AVAILABLE_MB = "480";

    const pending = acquireExchangeSlot(3000);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      puppeteerSemaphoreStats().queuedExchange,
      1,
      "池子已满时没有槽可授，本就该排队；此刻拒绝等于因为浏览器在跑而拒绝等浏览器",
    );

    // 唤醒路径刻意不再查内存：一个约 350MB 的 Chrome 刚退出，正是内存最宽裕的时刻，
    // 此时再按「退出前」的读数把人拒掉，就又回到了事故当天那种自相矛盾的行为。
    slots[slots.length - 1]!();
    const granted = await pending;
    assert.equal(typeof granted, "function", "释放后排队者应当拿到槽位");
    track(granted);
  });

  test("仍有空槽时内存不足照样拒绝：D-220 的保护一分不减", async () => {
    process.env.PUPPETEER_MIN_AVAILABLE_MB = "500";
    process.env.PUPPETEER_FAKE_AVAILABLE_MB = "2000";
    track(await acquirePuppeteerSlot(1000));
    assert.equal(puppeteerSemaphoreStats().active, 1, "前提：池子还有空位");

    process.env.PUPPETEER_FAKE_AVAILABLE_MB = "120";
    await expectRejectedWithCode(
      acquireExchangeSlot(2000),
      "PUPPETEER_LOW_MEMORY",
      "还有空槽就意味着下一步真会 launch，内存见底必须拦住",
    );
  });

  test("空池 + 内存见底：与 D-220 原行为一致，立即拒绝不排队", async () => {
    process.env.PUPPETEER_MIN_AVAILABLE_MB = "500";
    process.env.PUPPETEER_FAKE_AVAILABLE_MB = "120";
    const started = Date.now();
    await expectRejectedWithCode(
      acquirePuppeteerSlot(30000),
      "PUPPETEER_LOW_MEMORY",
      "空池时有槽可授，内存不足应当立即拒绝",
    );
    assert.ok(Date.now() - started < 5000, "应当立即返回，不能白等 30s");
  });
});
