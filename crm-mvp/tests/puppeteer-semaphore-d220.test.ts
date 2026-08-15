/**
 * D-220 槽位与 Chrome 进程绑定 + 内存反压。
 *
 * 为什么这条必须有测试：这两处坏掉都是**静默**的，线上只会表现成别的症状。
 *   - 绑定失效（看门狗只放计数不杀进程）：真实 Chrome 数无声突破上限 3，机器被吃到 swap，
 *     表面症状是「全站联盟连接报 API Key 已失效」——2026-08-06 wj11 事故就是这么误诊的，
 *     查了半天密钥其实全都有效。
 *   - 心跳失效：合法长批量任务（6 页 harvest ≈ 300s）的槽位在 150s 被强制释放，
 *     Chrome 还在跑就又放进来一个，同样是无声超发。
 *   - 反压失效：内存见底还继续 launch，直接把整机拖进 swap 颠簸。
 * 全都不会抛错，只能靠测试兜住。
 */
import { test, describe, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  acquireExchangeSlot,
  acquirePuppeteerSlot,
  puppeteerSemaphoreStats,
  noopSlotRelease,
  type SlotRelease,
} from "../src/lib/puppeteer-semaphore";

const held: SlotRelease[] = [];
function track(r: SlotRelease): SlotRelease {
  held.push(r);
  return r;
}

// SLOT-ISO-01：本文件钉的是共享池语义下的槽位/进程绑定与反压，显式关闭工作时间剥离，
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
  const s = puppeteerSemaphoreStats();
  assert.equal(s.active, 0, "用例结束应无残留占用");
});

/**
 * 断言这次申请被拒。拿到槽位说明断言前提就错了——必须 track 后再报错，
 * 否则泄漏的槽位会连累后续用例（第一版测试就栽在这里）。
 */
async function expectRejectedWithCode(p: Promise<SlotRelease>, code: string, msg: string) {
  const r = await p.catch((e: Error) => e);
  if (typeof r === "function") {
    track(r as SlotRelease);
    assert.fail(`${msg}（实际拿到了槽位）`);
  }
  assert.equal((r as Error & { code?: string }).code, code, msg);
}

/** 伪 browser：只暴露 process().kill，够信号量强杀路径用 */
function fakeBrowser() {
  const state = { killed: false, signal: "" };
  return {
    state,
    browser: {
      process: () => ({
        kill: (sig: string) => {
          state.killed = true;
          state.signal = sig;
        },
      }),
    },
  };
}

describe("D-220 释放器接口", () => {
  test("acquire 返回的释放器带 heartbeat / bindBrowser，且仍可当普通函数调用", async () => {
    const r = track(await acquirePuppeteerSlot(1000));
    assert.equal(typeof r, "function", "释放器本身仍是函数（老调用点不受影响）");
    assert.equal(typeof r.heartbeat, "function");
    assert.equal(typeof r.bindBrowser, "function");
    assert.equal(puppeteerSemaphoreStats().active, 1);
  });

  test("noopSlotRelease 可安全当占位使用，不影响计数", () => {
    const r = noopSlotRelease();
    r.bindBrowser({});
    r.heartbeat();
    r();
    assert.equal(puppeteerSemaphoreStats().active, 0);
  });

  test("bindBrowser 后正常释放不会杀进程", async () => {
    const { state, browser } = fakeBrowser();
    const r = await acquirePuppeteerSlot(1000);
    r.bindBrowser(browser);
    r();
    assert.equal(state.killed, false, "正常释放路径由调用方 close，信号量不该插手");
  });

  test("重复释放幂等，不会把计数扣穿", async () => {
    const r = await acquirePuppeteerSlot(1000);
    r();
    r();
    r();
    assert.equal(puppeteerSemaphoreStats().active, 0);
  });
});

describe("D-220 内存反压", () => {
  test("可用内存低于水位时直接拒绝，不进队列白等", async () => {
    process.env.PUPPETEER_MIN_AVAILABLE_MB = "500";
    process.env.PUPPETEER_FAKE_AVAILABLE_MB = "120"; // 事故当天最低见过 128MB
    const started = Date.now();
    await expectRejectedWithCode(
      acquirePuppeteerSlot(30000),
      "PUPPETEER_LOW_MEMORY",
      "内存不足时应当拒绝而不是授予槽位",
    );
    assert.ok(
      Date.now() - started < 5000,
      "应当立即拒绝——排队等 30s 拿到的也只是再压垮一次",
    );
    assert.equal(puppeteerSemaphoreStats().active, 0, "被拒绝不应占用计数");
  });

  test("换链接车道同样受反压约束（事故中拉起 Chrome 最多的就是它）", async () => {
    process.env.PUPPETEER_MIN_AVAILABLE_MB = "500";
    process.env.PUPPETEER_FAKE_AVAILABLE_MB = "120";
    await expectRejectedWithCode(
      acquireExchangeSlot(20000),
      "PUPPETEER_LOW_MEMORY",
      "换链接车道也要挡住",
    );
  });

  test("水位设 0 关闭反压，恢复旧行为", async () => {
    process.env.PUPPETEER_MIN_AVAILABLE_MB = "0";
    process.env.PUPPETEER_FAKE_AVAILABLE_MB = "10";
    const r = await acquirePuppeteerSlot(1000).catch((e: Error) => e);
    assert.equal(typeof r, "function", "关掉反压后应照常授予");
    track(r as SlotRelease);
  });

  test("内存充裕时正常授予，不误伤", async () => {
    process.env.PUPPETEER_MIN_AVAILABLE_MB = "500";
    process.env.PUPPETEER_FAKE_AVAILABLE_MB = "2000";
    const r = await acquirePuppeteerSlot(1000).catch((e: Error) => e);
    assert.equal(typeof r, "function", "内存够用就不该拦");
    track(r as SlotRelease);
  });

  test("读不到内存读数时不限制，避免非 Linux 环境全面瘫痪", async () => {
    process.env.PUPPETEER_MIN_AVAILABLE_MB = "500";
    process.env.PUPPETEER_FAKE_AVAILABLE_MB = "-1"; // -1 = 读不到
    const r = await acquirePuppeteerSlot(1000).catch((e: Error) => e);
    assert.equal(typeof r, "function", "拿不到内存读数时应放行，交给并发上限兜底");
    track(r as SlotRelease);
  });

  test("已持有的槽位不受反压影响，不会被中途掐断", async () => {
    const r = track(await acquirePuppeteerSlot(1000));
    process.env.PUPPETEER_MIN_AVAILABLE_MB = "500";
    process.env.PUPPETEER_FAKE_AVAILABLE_MB = "10";
    assert.equal(puppeteerSemaphoreStats().active, 1, "反压只挡新申请");
    r.heartbeat(); // 续期路径也不应因内存不足而报错
  });

  test("诊断输出带内存水位，便于线上定位", () => {
    process.env.PUPPETEER_MIN_AVAILABLE_MB = "512";
    process.env.PUPPETEER_FAKE_AVAILABLE_MB = "777";
    const s = puppeteerSemaphoreStats();
    assert.equal(s.minAvailableMb, 512);
    assert.equal(s.availableMb, 777);
  });
});
