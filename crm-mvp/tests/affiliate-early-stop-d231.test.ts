/**
 * D-231：V1 跟链（fetchChain）的目标域早停。
 *
 * 病根：联盟跳板在第 N 跳就已经 302 到「商家域名 + irclickid」，后缀这时候就已经拿到手了，
 * 点击也已在联盟侧登记。V1 却还要老老实实把商家首页整页拉完——慢站一超时，整条链被判
 * resolve_failed，最后报成「联盟链接疑似失效」。2026-08-12 现场：CG1 系列连续 42 次超时
 * （>55s），链接本身用浏览器一跟就通。
 *
 * 所以这里钉死三件事：命中目标域后立刻收工、那一跳的请求仍要发出去（点击注册不能丢）、
 * 以及最关键的——落地页超时/报错都不得再影响结论。
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { fetchChain } from "../src/lib/affiliate-link-resolver";

/** 落地页被真实访问的次数——早停不等于「不访问」，点击注册那一下必须还在 */
let landHits = 0;
let server: http.Server;
let port = 0;

/** 落地页正文的拖延时间：早停应当在收到响应头就断开，完全不等这段 */
const BODY_DELAY_MS = 2500;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // 联盟跳板：302 到「商家域名 + 追踪参数」。走到这里点击就算登记完成了。
    if (url.pathname === "/start") {
      res.writeHead(302, { Location: `http://localhost:${port}/slow?irclickid=abc123` });
      res.end();
      return;
    }
    if (url.pathname === "/start-hang") {
      res.writeHead(302, { Location: `http://localhost:${port}/hang?irclickid=abc123` });
      res.end();
      return;
    }

    // 慢商家落地页：响应头很快，正文拖 2.5 秒
    if (url.pathname === "/slow") {
      landHits++;
      res.writeHead(200, { "content-type": "text/html" });
      // 真实站点是「响应头先到、正文慢慢来」。Node 默认攒着一起发，不 flush 就测不出早停的价值。
      res.flushHeaders();
      setTimeout(() => {
        try {
          res.end("<html><body>landing</body></html>");
        } catch {
          /* 早停已断开连接，属预期 */
        }
      }, BODY_DELAY_MS);
      return;
    }

    // 死活不响应的商家站：模拟 2026-08-12 那批超时
    if (url.pathname === "/hang") {
      landHits++;
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  landHits = 0;
  delete process.env.AFFILIATE_V1_EARLY_STOP_PCT;
});

describe("D-231 目标域早停", () => {
  test("命中商家根域名：立刻收工，但那一跳的请求照发（点击已注册）", async () => {
    process.env.AFFILIATE_V1_EARLY_STOP_PCT = "100";
    const t0 = Date.now();
    const r = await fetchChain(`http://127.0.0.1:${port}/start`, null, 10, 5000, {}, 0, "localhost");
    const cost = Date.now() - t0;

    assert.match(r.finalUrl, /irclickid=abc123/, "后缀所在的那个 URL 就是结论，必须留住");
    assert.equal(r.error, undefined);
    assert.equal(landHits, 1, "落地页仍要被访问一次，否则联盟侧的点击登记可能受影响");
    assert.ok(cost < BODY_DELAY_MS - 500, `应当不等正文就返回，实际耗时 ${cost}ms`);
  });

  test("落地页整跳超时：结论不变，不再冤枉链接（本次事故的核心路径）", async () => {
    process.env.AFFILIATE_V1_EARLY_STOP_PCT = "100";
    const r = await fetchChain(`http://127.0.0.1:${port}/start-hang`, null, 10, 800, {}, 2, "localhost");

    assert.match(r.finalUrl, /irclickid=abc123/);
    assert.equal(r.error, undefined, "商家站不响应，证明不了联盟链接失效，不能带 error 上去");
    assert.equal(r.status, 0);
  });

  test("早停关闭（灰度 0）时行为与改造前逐字节一致", async () => {
    process.env.AFFILIATE_V1_EARLY_STOP_PCT = "0";
    const t0 = Date.now();
    const r = await fetchChain(`http://127.0.0.1:${port}/start`, null, 10, 5000, {}, 0, "localhost");
    const cost = Date.now() - t0;

    assert.match(r.finalUrl, /irclickid=abc123/);
    assert.ok(cost >= BODY_DELAY_MS - 200, `旧行为要把正文等完，实际耗时 ${cost}ms`);
  });

  test("同样是超时，关掉早停就会带上 error —— 正是旧版判死链的依据", async () => {
    process.env.AFFILIATE_V1_EARLY_STOP_PCT = "0";
    const r = await fetchChain(`http://127.0.0.1:${port}/start-hang`, null, 10, 800, {}, 0, "localhost");

    assert.ok(r.error, "对照组：旧路径确实会把超时当成失败证据");
  });

  test("落地域名不是目标域名时不早停，避免半路收工丢参数", async () => {
    process.env.AFFILIATE_V1_EARLY_STOP_PCT = "100";
    const t0 = Date.now();
    const r = await fetchChain(`http://127.0.0.1:${port}/start`, null, 10, 5000, {}, 0, "example.com");
    const cost = Date.now() - t0;

    assert.match(r.finalUrl, /irclickid=abc123/);
    assert.ok(cost >= BODY_DELAY_MS - 200, `没命中目标域就该走完整流程，实际耗时 ${cost}ms`);
  });

  test("没有目标域名可用时早停整体关闭（存量系列大量如此）", async () => {
    process.env.AFFILIATE_V1_EARLY_STOP_PCT = "100";
    const t0 = Date.now();
    await fetchChain(`http://127.0.0.1:${port}/start`, null, 10, 5000, {}, 0, null);
    const cost = Date.now() - t0;

    assert.ok(cost >= BODY_DELAY_MS - 200, `无目标域名应退化成全程跟随，实际耗时 ${cost}ms`);
  });

  test("灰度按链接稳定分桶：同一条链接的开关结论不会来回跳", async () => {
    process.env.AFFILIATE_V1_EARLY_STOP_PCT = "50";
    const url = `http://127.0.0.1:${port}/start`;
    const first = await fetchChain(url, null, 10, 5000, {}, 0, "localhost");
    const second = await fetchChain(url, null, 10, 5000, {}, 0, "localhost");

    assert.equal(first.finalUrl, second.finalUrl);
    assert.equal(first.error, second.error, "同一条链接两次跑出不同结论会让灰度期的对照失去意义");
  });
});
