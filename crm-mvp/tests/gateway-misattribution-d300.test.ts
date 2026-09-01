/**
 * D-300 网关故障不能显示成「API Key 已失效」（2026-08-29 RW kaizenflowshop 现场）。
 *
 * 现场两条错误，密钥实际有效：
 *   卡片：「该连接 API Key 已失效 / RW: Unexpected token ... is not valid JSON」
 *   弹窗：「API 连接测试失败 / 服务响应超时（HTTP 524）：平台 API 响应过慢」
 * 前者是联盟侧网关塞了个 HTML 错误页、resp.json() 炸了；后者是我方 Cloudflare
 * 在 100s 处掐断。两条都跟密钥无关，但 D-220 的判据一条都认不出来，
 * 双双落进 unknown → UI 走「重新配置 API Key」分支。
 *
 * 这组用例锁的就是「认得出来」：改判据时别再把 52x 和非 JSON 正文漏掉。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { classifyConnFailure, isNonKeyFailure, decideSaveGate } from "../src/lib/conn-failure-kind";

describe("D-300 网关/非 JSON 故障归因", () => {
  test("事故现场的两条原始错误串必须判成 transient", () => {
    const cases = [
      `RW: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
      "服务响应超时（HTTP 524）：平台 API 响应过慢，请稍后重试",
    ];
    for (const c of cases) {
      assert.equal(classifyConnFailure(c), "transient", `判成 auth 就会重演误报: ${c}`);
      assert.equal(isNonKeyFailure(c), true, `UI 会显示「重新配置 API Key」: ${c}`);
    }
  });

  test("Cloudflare 自有状态码 520~527 全部算服务端故障", () => {
    for (let s = 520; s <= 527; s++) {
      const msg = `RW: HTTP ${s}（平台网关/上游错误，与密钥无关）`;
      assert.equal(classifyConnFailure(msg), "transient", `HTTP ${s} 应判为 transient`);
    }
  });

  test("其余 5xx 同样是服务端的事，不是密钥的事", () => {
    for (const s of [500, 502, 503, 504, 508, 599]) {
      assert.equal(classifyConnFailure(`LH: HTTP ${s}`), "transient", `HTTP ${s} 应判为 transient`);
    }
  });

  test("非 JSON 正文的各种写法都要认出来", () => {
    const cases = [
      "平台返回非 JSON 响应（HTTP 200，疑似网关错误页/维护页，与密钥无关）：<!DOCTYPE html><html>...",
      "CG: Unexpected end of JSON input",
      "LB: SyntaxError: Unexpected token < in JSON at position 0",
      "PM: max retries exceeded",
    ];
    for (const c of cases) {
      assert.equal(classifyConnFailure(c), "transient", `应判为 transient: ${c}`);
    }
  });

  test("放宽判据后，真失效仍然优先判 auth——否则连接永远红不了、佣金静默断流", () => {
    const cases = [
      "RW: Invalid token",
      "LH: HTTP 401 Unauthorized",
      "LB: HTTP 403 Forbidden",
      // 混进 5xx 字样也不能把 auth 抢走
      "CG: 1001 Invalid token (upstream 503)",
      "MUI: api key invalid, gateway closed connection",
    ];
    for (const c of cases) {
      assert.equal(classifyConnFailure(c), "auth", `应判为 auth: ${c}`);
      assert.equal(isNonKeyFailure(c), false, `不该被当成网络问题: ${c}`);
    }
  });

  test("connection-health 的 re-export 与纯模块是同一份判据", async () => {
    const health = await import("../src/lib/connection-health");
    assert.equal(health.classifyConnFailure, classifyConnFailure);
  });
});

/**
 * 保存门禁分档。这三条分支各自的错法代价都不小：
 *   - 网关类也硬拦 → 人拿着刚生成的有效 Key 存不进去（放开这道口子的初衷）；
 *   - auth 类也放行 → 明知是坏 Key 还入库，后续同步一路撞墙、连接刷成 error；
 *   - 没测过就放行 → 填错一个字符也能存，D-026 这道习惯就白立了。
 */
describe("D-300 保存门禁分档", () => {
  test("没换 Key / 测试通过 → 直接放行", () => {
    assert.equal(decideSaveGate({ keyUnchanged: true, testPassed: false }).allow, "yes");
    assert.equal(decideSaveGate({ keyUnchanged: false, testPassed: true }).allow, "yes");
  });

  test("网关/网络/认不出的失败 → 二次确认后可存", () => {
    for (const kind of ["transient", "unknown"] as const) {
      const gate = decideSaveGate({ keyUnchanged: false, testPassed: false, lastFailureKind: kind });
      assert.equal(gate.allow, "confirm", `${kind} 应放到二次确认`);
      assert.match(gate.allow === "confirm" ? gate.reason : "", /待验证/);
    }
  });

  test("平台明确拒绝凭据 → 硬拦，别把已知坏掉的 Key 存进来", () => {
    const gate = decideSaveGate({ keyUnchanged: false, testPassed: false, lastFailureKind: "auth" });
    assert.equal(gate.allow, "no");
    assert.match(gate.allow === "no" ? gate.reason : "", /重新生成/);
  });

  test("压根没测过 → 硬拦，保留「先测一下」的习惯", () => {
    const gate = decideSaveGate({ keyUnchanged: false, testPassed: false });
    assert.equal(gate.allow, "no");
    assert.match(gate.allow === "no" ? gate.reason : "", /测试连接/);
  });

  test("现场那两条错误串走完整链路后都落在「可确认保存」", () => {
    const cases = [
      `RW: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`,
      "我方网关在平台响应前掐断了本次测试（HTTP 524）：平台 API 这会儿很慢，与 API Key 无关，请稍后重试",
    ];
    for (const err of cases) {
      const gate = decideSaveGate({
        keyUnchanged: false,
        testPassed: false,
        lastFailureKind: classifyConnFailure(err),
      });
      assert.equal(gate.allow, "confirm", `不该再把人卡死: ${err}`);
    }
  });
});
