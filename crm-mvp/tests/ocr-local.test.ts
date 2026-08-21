import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { withOcrSlot, pickDomainFromOcrText, toRootDomain } from "../src/lib/ocr-local";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withOcrSlot 全局并发闸", () => {
  test("并发 6 个任务，同时在跑的 ≤ 2", async () => {
    let running = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        withOcrSlot(async () => {
          running++;
          peak = Math.max(peak, running);
          await sleep(30);
          running--;
          return i;
        }),
      ),
    );
    assert.equal(peak, 2);
    assert.deepEqual(results.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  });

  test("任务抛异常也释放名额，后续任务不被卡死", async () => {
    await assert.rejects(withOcrSlot(async () => { throw new Error("boom"); }));
    await assert.rejects(withOcrSlot(async () => { throw new Error("boom2"); }));
    // 闸若泄漏名额，这里会永远挂起（test runner 超时兜底）
    const v = await withOcrSlot(async () => 42);
    assert.equal(v, 42);
  });
});

describe("pickDomainFromOcrText", () => {
  test("频次最高的根域名胜出", () => {
    assert.equal(
      pickDomainFromOcrText("Visit www.foo-shop.com now! foo-shop.com deals bar.net"),
      "foo-shop.com",
    );
  });

  test("TLD 白名单过滤误拼假域名", () => {
    assert.equal(pickDomainFromOcrText("sentence.ends here.badtld"), null);
  });

  test("Google/社媒域名被屏蔽", () => {
    assert.equal(pickDomainFromOcrText("vm.tiktok.com youtube.com"), null);
  });
});

describe("toRootDomain", () => {
  test("eTLD+1 归一化", () => {
    assert.equal(toRootDomain("uk.xtool.com"), "xtool.com");
    assert.equal(toRootDomain("shop.foo.co.uk"), "foo.co.uk");
    assert.equal(toRootDomain("bar.com"), "bar.com");
  });
});
