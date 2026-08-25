/**
 * D-272 TnbProxy 余量响应解析测试。
 *
 * 为什么这条必须有测试：TnbProxy 无公开 API 文档，接口是拆前端实测出来的，响应契约
 * 没有任何官方保证。解析必须显式三态（成功/业务错误/结构不符），把「不确定」折叠进
 * 「余量 0」会直接触发误告警甚至误判断供（D-261 二态误报的教训）。
 * 另一个坑：鉴权失败时该接口也回 200 且 data 全零（code=401 在 JSON 里）——
 * 只看 data 不看 code 会把「key 失效」误读成「流量耗尽」。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseTnbQuotaResponse } from "../src/lib/suffix-engine/tnbproxy-quota";

describe("parseTnbQuotaResponse", () => {
  test("成功响应 → 提取 remaining/used bytes", () => {
    const r = parseTnbQuotaResponse({
      code: 0, message: "success", error: "",
      data: { cumulative_usage_bytes: 990681, remaining_bytes: 499999009319 },
    });
    assert.deepEqual(r, { ok: true, remainingBytes: 499999009319, usedBytes: 990681 });
  });

  test("鉴权失败（code=401 但 data 带全零字段）→ 业务错误，绝不当成余量 0", () => {
    const r = parseTnbQuotaResponse({
      code: 401, message: "unauthorized", error: "token is malformed",
      data: { cumulative_usage_bytes: 0, remaining_bytes: 0 },
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /401/);
  });

  test("结构不符（缺 remaining_bytes / 非对象 / null）→ 显式失败", () => {
    for (const bad of [{ code: 0, data: {} }, null, "html error page", { code: 0 }]) {
      const r = parseTnbQuotaResponse(bad);
      assert.equal(r.ok, false, `应判失败: ${JSON.stringify(bad)}`);
    }
  });

  test("used 缺失但 remaining 有效 → 成功且 used 置 0（不阻塞余量展示）", () => {
    const r = parseTnbQuotaResponse({ code: 0, data: { remaining_bytes: 5e9 } });
    assert.deepEqual(r, { ok: true, remainingBytes: 5e9, usedBytes: 0 });
  });
});
