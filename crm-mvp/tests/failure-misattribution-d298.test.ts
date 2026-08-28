/**
 * D-298 失败归因：我方故障不得记成「链接失效」。
 *
 * 为什么这两条必须有测试：错了完全静默——不抛错、日志也看不出，只会在几小时后表现为
 * 告警中心冒出一批「链接不记点击 / 链接疑似失效」，而链接本身健康，人被支去联盟后台白折腾，
 * 同时系列被冻结 8 小时、库存耗尽、广告断供。2026-08-28 一次误伤 101 个在投系列。
 *
 * 判据只有一条：**这一轮有没有真把点击送到联盟服务器**。没送到就不许对链接下结论。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { classifyBrowserBlocked, BROWSER_BLOCKED_REASONS } from "../src/lib/affiliate-link-resolver";
import { isProxyHardFailure } from "../src/lib/suffix-engine/failure-classify";

describe("D-298 之一：硬代理错误不得算链接失效", () => {
  test("Socks5 认证失败 —— 2026-08-28 单日 417 次的那一个", () => {
    assert.equal(
      isProxyHardFailure(
        "REQUEST_FAILED: request to https://www.linkbux.com/track/90c9nhJ failed, reason: Socks5 Authentication failed",
      ),
      true,
      "认成硬代理错误才会返回 proxy_unavailable；漏掉就会按疑似死链累计并报 invalid_link",
    );
  });

  test("其余硬代理错误一并覆盖", () => {
    for (const e of [
      "Socks5 proxy rejected connection - Failure",
      "connect ECONNREFUSED 10.0.0.1:1080",
      "read ECONNRESET",
      "socket hang up",
      "tunneling socket could not be established, statusCode=407",
    ]) {
      assert.equal(isProxyHardFailure(e), true, `应认成硬代理错误：${e}`);
    }
  });

  test("链接侧的真实失败不许被误吞成代理问题", () => {
    // 反方向同样危险：把真死链算成 proxy_unavailable，坏链接就永远不报警了
    for (const e of [
      "停在跳板域名 click.linksynergy.com，未跟到广告主落地页",
      "跟链成功但落地页无追踪参数，无法生成 suffix",
      "HTTP 403 Forbidden",
      "CONNECTION_RESET: 连接被重置",
    ]) {
      assert.equal(isProxyHardFailure(e), false, `不该认成代理错误：${e}`);
    }
  });

  test("空值不炸且按非代理错误处理", () => {
    assert.equal(isProxyHardFailure(null), false);
    assert.equal(isProxyHardFailure(undefined), false);
    assert.equal(isProxyHardFailure(""), false);
  });
});

describe("D-298 之二：浏览器导航失败不得算链接失效", () => {
  test("chrome-error://chromewebdata/ 归为 browser_nav_error（带前缀，非精确串）", () => {
    assert.equal(
      classifyBrowserBlocked("browser_nav_error: chrome-error://chromewebdata/"),
      "browser_nav_error",
      "漏掉这一支，HTTP 阶段的 no_tracking 会被当结论上报，攒 3 轮即误报 no_tracking_stuck",
    );
  });

  test("原有四种「压根没起飞」的原因保持精确匹配不变", () => {
    for (const r of ["proxy_unavailable", "no_browser", "no_puppeteer_slot", "low_memory"] as const) {
      assert.equal(classifyBrowserBlocked(r), r, `D-231 既有语义不得回退：${r}`);
      assert.ok(BROWSER_BLOCKED_REASONS.includes(r), `${r} 应仍在名单内`);
    }
  });

  test("浏览器真的跑完并给出结论时，不得被误判成「被挡住」", () => {
    // 这几种是浏览器确实工作过的结果，必须放行到下游做链接判定，否则真坏链永远不报警
    for (const e of [null, undefined, "", "fallback_rejected: Navigation timeout of 30000 ms exceeded"]) {
      assert.equal(classifyBrowserBlocked(e), null, `不该算被挡住：${e}`);
    }
  });

  test("browser_nav_error 前缀后面挂任何错误页都认得出", () => {
    assert.equal(classifyBrowserBlocked("browser_nav_error: chrome-error://networkerror/"), "browser_nav_error");
    assert.equal(classifyBrowserBlocked("browser_nav_error"), "browser_nav_error");
  });
});
