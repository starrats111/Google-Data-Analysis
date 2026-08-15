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

/** 占满全部 3 个槽（normal 吃满 2 个 + 主爬预留 1 个），返回释放器供用例按需放行 */
async function fillPool(): Promise<SlotRelease[]> {
  const slots = [
    track(await acquirePuppeteerSlot(1000)),
    track(await acquirePuppeteerSlot(1000)),
    track(await acquireMainCrawlSlot(1000)),
  ];
  assert.equal(puppeteerSemaphoreStats().active, 3, "前提：池子已满");
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
    slots[2]();
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
