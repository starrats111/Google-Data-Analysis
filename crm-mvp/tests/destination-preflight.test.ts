import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ADSBOT_USER_AGENT,
  BROWSER_USER_AGENT,
  buildDestinationCheckUrl,
  checkAdsBotDestinationReachable,
} from "../src/lib/google-ads/destination-preflight";

/** 按 UA 返回不同状态码的假 fetch */
function fakeFetch(statusByUa: Record<string, number | Error>): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const ua = String((init?.headers as Record<string, string>)?.["User-Agent"] ?? "");
    const outcome = ua.startsWith("AdsBot") ? statusByUa[ADSBOT_USER_AGENT] : statusByUa[BROWSER_USER_AGENT];
    if (outcome instanceof Error) throw outcome;
    return new Response(null, { status: outcome ?? 200 });
  }) as typeof fetch;
}

describe("buildDestinationCheckUrl", () => {
  it("无后缀原样返回", () => {
    assert.equal(
      buildDestinationCheckUrl({ finalUrl: "https://example.com/p?a=1" }),
      "https://example.com/p?a=1",
    );
  });

  it("有 query 时用 & 拼接后缀，并剥掉后缀开头的 ?/&", () => {
    assert.equal(
      buildDestinationCheckUrl({ finalUrl: "https://example.com/p?a=1", finalUrlSuffix: "?utm_source=g" }),
      "https://example.com/p?a=1&utm_source=g",
    );
  });

  it("无 query 时用 ? 拼接后缀，hash 保留在最后", () => {
    assert.equal(
      buildDestinationCheckUrl({ finalUrl: "https://example.com/p#top", finalUrlSuffix: "aff=123" }),
      "https://example.com/p?aff=123#top",
    );
  });

  it("非 http(s) 协议抛错", () => {
    assert.throws(() => buildDestinationCheckUrl({ finalUrl: "ftp://example.com" }));
  });
});

describe("checkAdsBotDestinationReachable", () => {
  it("AdsBot 2xx → reachable，不再发浏览器复核", async () => {
    const r = await checkAdsBotDestinationReachable(
      { finalUrl: "https://example.com" },
      { fetch: fakeFetch({ [ADSBOT_USER_AGENT]: 200, [BROWSER_USER_AGENT]: 500 }) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.reason, "reachable");
  });

  it("AdsBot 403 但浏览器 200 → not_publishable_status（bot 被针对性拦截）", async () => {
    const r = await checkAdsBotDestinationReachable(
      { finalUrl: "https://example.com" },
      { fetch: fakeFetch({ [ADSBOT_USER_AGENT]: 403, [BROWSER_USER_AGENT]: 200 }) },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not_publishable_status");
    assert.equal(r.status, 403);
    assert.equal(r.browserStatus, 200);
  });

  it("两边都不可达 → server_blocked（出口问题，不据此下结论）", async () => {
    const r = await checkAdsBotDestinationReachable(
      { finalUrl: "https://example.com" },
      { fetch: fakeFetch({ [ADSBOT_USER_AGENT]: 503, [BROWSER_USER_AGENT]: 503 }) },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "server_blocked");
  });

  it("AdsBot 网络异常但浏览器可达 → not_publishable_status", async () => {
    const r = await checkAdsBotDestinationReachable(
      { finalUrl: "https://example.com" },
      { fetch: fakeFetch({ [ADSBOT_USER_AGENT]: new Error("connect timeout"), [BROWSER_USER_AGENT]: 200 }) },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not_publishable_status");
    assert.match(r.errorMessage ?? "", /timeout/);
  });

  it("非法 URL → invalid_url，不发任何请求", async () => {
    const r = await checkAdsBotDestinationReachable(
      { finalUrl: "not-a-url" },
      { fetch: (() => { throw new Error("不应被调用"); }) as unknown as typeof fetch },
    );
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid_url");
  });
});
