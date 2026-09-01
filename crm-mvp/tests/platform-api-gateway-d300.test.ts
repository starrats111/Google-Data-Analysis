/**
 * D-300 平台 API 层对「网关故障」的处理（2026-08-29 RW 现场）。
 *
 * 两个回归点，都是这次让「密钥有效」显示成「API Key 已失效」的直接原因：
 *   1. RETRYABLE_STATUS 只有 502/503/504，Cloudflare 的 524（源站超时）一次都不重试，
 *      而 RW/LH 都挂在 CF 后面——524 恰恰是最该重试的一类。
 *   2. `resp.json()` 直接对 HTML 错误页开炸，抛出的 "Unexpected token '<' ..."
 *      不含状态码、不含平台，下游只能猜，最后猜成了密钥失效。
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchAllTransactions } from "../src/lib/platform-api";
import { classifyConnFailure } from "../src/lib/conn-failure-kind";

const CF_524_PAGE = '<!DOCTYPE html><html><head><title>524: A timeout occurred</title></head><body>Error 524</body></html>';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** 记录调用次数的 fetch 桩 */
function stubFetch(respond: () => Response) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return respond();
  }) as typeof fetch;
  return calls;
}

describe("D-300 平台 API 网关故障", () => {
  test("HTTP 524 的错误串要自带「与密钥无关」，且能被判成 transient", async () => {
    stubFetch(() => new Response(CF_524_PAGE, { status: 524, headers: { "content-type": "text/html" } }));

    const r = await fetchAllTransactions("RW", "tok", "2026-08-28", "2026-08-29", {
      timeoutMs: 5000, maxRetries: 0, maxPages: 1,
    });

    assert.ok(r.error, "应返回错误");
    assert.match(r.error!, /HTTP 524/);
    assert.match(r.error!, /与密钥无关/);
    assert.equal(classifyConnFailure(r.error!), "transient");
  });

  test("HTTP 524 会重试——旧表里没有 52x，源站一慢就一次都不试直接判死", async () => {
    const calls = stubFetch(() => new Response(CF_524_PAGE, { status: 524 }));

    await fetchAllTransactions("RW", "tok", "2026-08-28", "2026-08-29", {
      timeoutMs: 5000, maxRetries: 1, maxPages: 1,
    });

    assert.equal(calls.length, 2, "maxRetries=1 应发出 2 次请求（首次 + 1 次重试）");
  });

  test("HTTP 200 但正文是 HTML：错误串要说清是非 JSON 网关页，而不是裸的 Unexpected token", async () => {
    stubFetch(() => new Response(CF_524_PAGE, { status: 200, headers: { "content-type": "text/html" } }));

    const r = await fetchAllTransactions("RW", "tok", "2026-08-28", "2026-08-29", {
      timeoutMs: 5000, maxRetries: 0, maxPages: 1,
    });

    assert.ok(r.error, "应返回错误");
    assert.match(r.error!, /非 JSON 响应/);
    assert.match(r.error!, /HTTP 200/);
    assert.match(r.error!, /与密钥无关/);
    assert.equal(classifyConnFailure(r.error!), "transient");
    // 现场那条原始串（"RW: Unexpected token '<' ..."）不该再出现在库里
    assert.ok(!/^RW: Unexpected token/.test(r.error!), "不该再是裸的 JSON 解析错误");
  });

  test("平台明确拒绝凭据（401）仍然判 auth——放宽 5xx 不能把真失效一起放走", async () => {
    stubFetch(() => new Response(JSON.stringify({ status: { code: 1001, msg: "Invalid token" } }), {
      status: 200, headers: { "content-type": "application/json" },
    }));

    const r = await fetchAllTransactions("RW", "bad-tok", "2026-08-28", "2026-08-29", {
      timeoutMs: 5000, maxRetries: 0, maxPages: 1,
    });

    assert.ok(r.error, "应返回错误");
    assert.equal(classifyConnFailure(r.error!), "auth");
  });

  test("maxPages=1：探活只打首页，不会顺着分页把整账号拉一遍", async () => {
    // 满页响应会触发「未知总页数」翻页逻辑；探活口径必须把它挡住
    const fullPage = {
      status: { code: 0 },
      payload: { list: Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, order_time: "1756400000" })) },
    };
    const calls = stubFetch(() => new Response(JSON.stringify(fullPage), {
      status: 200, headers: { "content-type": "application/json" },
    }));

    await fetchAllTransactions("RW", "tok", "2026-08-28", "2026-08-29", {
      timeoutMs: 5000, maxRetries: 0, maxPages: 1,
    });

    assert.equal(calls.length, 1, "只该请求首页");
  });
});
