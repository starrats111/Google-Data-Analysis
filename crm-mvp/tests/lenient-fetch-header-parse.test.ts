/**
 * 站点响应头不合规导致的「浏览器能打开、系统说打不开」。
 *
 * 为什么这条必须有测试（2026-08-29 promodirect 事故）：
 * Node 的 undici fetch 用 llhttp 严格模式解析响应头，promodirect.com 的 CSP 头
 * 用裸 LF + 空格折行（9 处），undici 直接抛 `TypeError: fetch failed`，
 * 整个响应连状态码都拿不到。curl 和浏览器都容错放行——于是运营在浏览器里
 * 能正常打开商家网站，站内链接校验却标红「链接无效」，被引导去删掉好链接。
 *
 * 这里锁两件事：
 *   ① 解析错误必须能和「网络不通/超时/TLS 失败」区分开——只有前者才该降级重放，
 *      后者降级也没用，反而白白多打一次目标站。
 *   ② 降级路径要真能把不合规响应读回来，且状态码/正文/最终 URL 都正确，
 *      否则 404 死链会被降级路径混成有效链接（比误杀更贵）。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

import { fetchCompat, isHttpParseError } from "../src/lib/lenient-fetch";

describe("isHttpParseError", () => {
  test("响应头不合规 → 认定为解析错误（该降级重放）", () => {
    const cases = [
      new TypeError("fetch failed", { cause: new Error("Response does not match the HTTP/1.1 protocol (Missing expected CR after header value)") }),
      new Error("Parse Error: Expected HTTP/"),
      Object.assign(new Error("boom"), { code: "HPE_INVALID_HEADER_TOKEN" }),
      new TypeError("fetch failed", { cause: new Error("Invalid header value char") }),
    ];
    for (const e of cases) {
      assert.equal(isHttpParseError(e), true, `应判为解析错误: ${e.message}`);
    }
  });

  test("网络不通/超时/TLS 失败 → 不是解析错误（降级也救不回来，别多打一次）", () => {
    const cases = [
      new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND x.com"), { code: "ENOTFOUND" }) }),
      new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }),
      new TypeError("fetch failed", { cause: Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }) }),
      new DOMException("The operation was aborted", "AbortError"),
    ];
    for (const e of cases) {
      assert.equal(isHttpParseError(e), false, `不该判为解析错误: ${(e as Error).message}`);
    }
  });
});

describe("fetchCompat 降级路径", () => {
  // 复刻 promodirect 的病灶：header 值内用裸 LF 折行
  let badServer: net.Server;
  let badPort = 0;
  let goodServer: http.Server;
  let goodPort = 0;

  before(async () => {
    badServer = net.createServer((sock) => {
      let req = "";
      sock.on("data", (d) => {
        req += d.toString("latin1");
        if (!req.includes("\r\n\r\n")) return;
        const isHead = req.startsWith("HEAD ");
        const is404 = req.split(" ")[1]?.startsWith("/gone");
        const body = is404 ? "<html><title>404 Page Not Found</title></html>" : "<html><title>Real Page</title></html>";
        // ↓ CSP 值里塞裸 LF + 空格续行，与线上病灶一致
        const headers =
          `HTTP/1.1 ${is404 ? "404 Not Found" : "200 OK"}\r\n` +
          `Content-Type: text/html;charset=utf-8\r\n` +
          `Content-Security-Policy-Report-Only: default-src 'self';\n  script-src 'self';\n  img-src 'self'\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\n` +
          `Connection: close\r\n\r\n`;
        sock.end(headers + (isHead ? "" : body));
      });
    });
    await new Promise<void>((r) => badServer.listen(0, "127.0.0.1", r));
    badPort = (badServer.address() as net.AddressInfo).port;

    goodServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><title>Normal</title></html>");
    });
    await new Promise<void>((r) => goodServer.listen(0, "127.0.0.1", r));
    goodPort = (goodServer.address() as net.AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((r) => badServer.close(() => r()));
    await new Promise<void>((r) => goodServer.close(() => r()));
  });

  test("原生 fetch 确实读不了这种响应（病灶复现，别让测试假绿）", async () => {
    await assert.rejects(
      () => fetch(`http://127.0.0.1:${badPort}/`),
      (e: unknown) => isHttpParseError(e),
      "构造的响应必须真能触发严格解析器报错，否则本测试无意义",
    );
  });

  test("不合规响应头 → 降级后拿回 200 和正文（好链接不再被误杀）", async () => {
    const res = await fetchCompat(`http://127.0.0.1:${badPort}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Real Page/);
  });

  test("降级路径不吞状态码：真 404 仍是 404（死链不能被混成有效）", async () => {
    const res = await fetchCompat(`http://127.0.0.1:${badPort}/gone`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /404 Page Not Found/);
  });

  test("降级路径支持 HEAD，且 res.url 是真实最终地址", async () => {
    const url = `http://127.0.0.1:${badPort}/`;
    const res = await fetchCompat(url, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.url, url);
  });

  test("正常站点不走降级，行为与原生 fetch 一致", async () => {
    const res = await fetchCompat(`http://127.0.0.1:${goodPort}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Normal/);
  });

  test("连不通的地址仍然抛错，不被降级路径吞成成功", async () => {
    await assert.rejects(() => fetchCompat("http://127.0.0.1:1/"));
  });
});
