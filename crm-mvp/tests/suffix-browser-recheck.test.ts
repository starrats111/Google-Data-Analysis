/**
 * D-197 刀 1 的安全阀：「必须浏览器」系列每天放行一条 HTTP 回探。
 *
 * 为什么这条必须有测试：`campaigns.suffix_needs_browser` 是靠「probe 有没有用上浏览器」学出来的。
 * 刀 1 让这类系列跳过 HTTP 直接上浏览器后，若回探闸门坏成「永远不放行」，系统就再也观测不到
 * 「联盟改了实现、纯 HTTP 又能跟通」，系列会被永久锁死在浏览器档、每条反而更贵；
 * 若坏成「每次都放行」，则等于刀 1 没生效、省不到流量。两个方向都是静默失效，只能靠测试兜。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { claimHttpRecheck } from "../src/lib/suffix-engine/suffix-generator";

describe("claimHttpRecheck 每系列每天放行一条 HTTP 回探", () => {
  test("同一系列当天只放行第一次", () => {
    const cid = BigInt(900001);
    assert.equal(claimHttpRecheck(cid), true, "当天首次应放行");
    assert.equal(claimHttpRecheck(cid), false, "同一天第二次不应再放行");
    assert.equal(claimHttpRecheck(cid), false, "后续多次仍不放行");
  });

  test("不同系列各自独立计名额，互不影响", () => {
    const a = BigInt(900002);
    const b = BigInt(900003);
    assert.equal(claimHttpRecheck(a), true);
    assert.equal(claimHttpRecheck(b), true, "另一个系列不该被前者占掉名额");
    assert.equal(claimHttpRecheck(a), false);
    assert.equal(claimHttpRecheck(b), false);
  });

  test("缺 campaignId 时不放行，退化为纯按 needsBrowser 决定", () => {
    // 手动「取链接」工具这类无系列上下文的调用不参与每日回探台账；
    // 它们本来也不传 needsBrowser，preferBrowser 恒为 false。
    assert.equal(claimHttpRecheck(null), false);
    assert.equal(claimHttpRecheck(undefined), false);
  });

  test("批量补货的调用顺序下，只有第一条走 HTTP、其余都走浏览器优先", () => {
    // 复刻 replenishOne 的真实序列：1 条 probe + 23 条 batch，且 probe 一定跑在 batch 之前。
    const cid = BigInt(900004);
    const needsBrowser = true;
    const preferBrowserPerCall: boolean[] = [];
    for (let i = 0; i < 24; i++) {
      preferBrowserPerCall.push(needsBrowser && !claimHttpRecheck(cid));
    }
    assert.equal(preferBrowserPerCall[0], false, "probe 应走 HTTP 回探");
    assert.equal(
      preferBrowserPerCall.filter((v) => v === false).length,
      1,
      "整轮 24 条里只应有 1 条走 HTTP",
    );
    assert.equal(
      preferBrowserPerCall.filter((v) => v === true).length,
      23,
      "其余 23 条都应浏览器优先，省掉必败的 HTTP",
    );
  });
});
