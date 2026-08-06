/**
 * D-220 连接失败分类：区分「密钥真失效」与「本机拉不通」。
 *
 * 为什么这条必须有测试：分错方向的代价完全不对称，而且两边都很隐蔽。
 *   - 把网络问题判成密钥失效（2026-08-06 wj11 事故）：UI 弹「该连接 API Key 已失效」，
 *     组员反复重配一个本来就有效的 Key，越配越懵，真因（Chrome 堆积吃爆内存）没人看得见。
 *   - 反过来把真失效判成网络问题：连接一直红不了，没人去换 Key，佣金数据静默断流。
 * 判据是一组正则，改动时极易顾此失彼，必须锁住。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { classifyConnFailure } from "../src/lib/connection-health";

describe("classifyConnFailure", () => {
  test("平台明确拒绝凭据 → auth（这类才该提示换 Key）", () => {
    const cases = [
      "MUI: Invalid token",
      "LH: invalid_token",
      "RW: 401 Unauthorized",
      "CG: Unauthorized",
      "LB: HTTP 403 Forbidden",
      "PM: token expired",
      "CF: api key invalid",
      "BSH: 签名错误",
      "EV: 认证失败",
    ];
    for (const c of cases) {
      assert.equal(classifyConnFailure(c), "auth", `应判为 auth: ${c}`);
    }
  });

  test("网络/超时/对端故障 → transient（重配 Key 无用）", () => {
    const cases = [
      "MUI: fetch failed",
      "LH: fetch failed",
      "TypeError: fetch failed",
      "UND_ERR_CONNECT_TIMEOUT",
      "connect ETIMEDOUT 47.83.5.110:443",
      "read ECONNRESET",
      "connect ECONNREFUSED",
      "getaddrinfo ENOTFOUND api.ultrainfluence.com",
      "socket hang up",
      "The operation was aborted",
      "RW: 504 Gateway Timeout",
      "LB: 502 Bad Gateway",
      "请求超时",
    ];
    for (const c of cases) {
      assert.equal(classifyConnFailure(c), "transient", `应判为 transient: ${c}`);
    }
  });

  test("事故现场的原始错误串必须判成 transient", () => {
    // 这五条就是 wj11 当时库里存的 last_error，密钥实测全部有效
    for (const p of ["LB", "MUI", "CF", "LH", "RW"]) {
      assert.equal(
        classifyConnFailure(`${p}: fetch failed`),
        "transient",
        `${p}: fetch failed 被判成 auth 就会重演误报`,
      );
    }
  });

  test("auth 信号优先于 transient——平台常把 401 裹在一段普通文案里", () => {
    assert.equal(
      classifyConnFailure("request failed: 401 unauthorized, connection closed"),
      "auth",
      "同时含 auth 与网络字样时，以平台明确拒绝为准",
    );
  });

  test("认不出来的归 unknown，走保守阈值而不是立刻判死", () => {
    assert.equal(classifyConnFailure("something weird happened"), "unknown");
    assert.equal(classifyConnFailure(""), "unknown");
  });
});
