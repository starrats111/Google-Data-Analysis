/**
 * D-303（2026-09-01 RW 全线断流）两个回归点。
 *
 * 现场：2026-09-01 00:01:17 CST 起，**所有** RW 连接同时开始报
 *   `{status:{code:1003,msg:"Missing required parameters or incorrect format"}}`，
 * 当天 295 次，8-31 零次。生产实打确认：同一 token、同一日期窗口，
 * 只改 status 一个值——"all" 被拒、"All" 与「完全不传」都回 Success 且返回同一批 23 行。
 * 即 RW 把这个参数改成了大小写敏感，而我们表单分支一直发的是小写。
 *
 * 更糟的是第二层：这条错误在旧判据里落进 unknown，而 UI 对 unknown 的默认动作
 * 就是弹「该连接 API Key 已失效」+ 红色重配按钮——密钥全程没问题，
 * 组员（wj11）却被指着去重配。默认动作本身就是错的。
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import { fetchAllTransactions } from "../src/lib/platform-api";
import {
  classifyConnFailure,
  describeConnFailure,
  decideSaveGate,
  platformBizError,
} from "../src/lib/conn-failure-kind";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** 记录每次请求实际发出去的参数（表单体或查询串） */
function captureParams(body: unknown) {
  const sent: URLSearchParams[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const qs = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
    const form = typeof init?.body === "string" ? init.body : "";
    sent.push(new URLSearchParams(form || qs));
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return sent;
}

const EMPTY_OK = { status: { code: 0, msg: "Success" }, data: { total_page: 1, total_trans: 0, list: [] } };

describe("D-303 RW status 大小写", () => {
  test("RW 发出去的 status 必须是 All——小写 all 会被 RW 判 1003", async () => {
    const sent = captureParams(EMPTY_OK);

    await fetchAllTransactions("RW", "tok", "2026-08-28", "2026-08-29", {
      timeoutMs: 5000, maxRetries: 0, maxPages: 1,
    });

    assert.ok(sent.length > 0, "应至少发出一次请求");
    assert.equal(sent[0].get("status"), "All");
    assert.notEqual(sent[0].get("status"), "all");
  });

  test("其它平台不受影响——LH/LB 那家还吃小写，别顺手一起改坏", async () => {
    for (const p of ["LH", "LB"]) {
      const sent = captureParams(EMPTY_OK);
      await fetchAllTransactions(p, "tok", "2026-08-28", "2026-08-29", {
        timeoutMs: 5000, maxRetries: 0, maxPages: 1,
      });
      assert.equal(sent[0].get("status"), "all", `${p} 的 status 应保持小写 all`);
    }
  });

  test("PB 仍然完全不传 status（omitStatusAll）", async () => {
    const sent = captureParams(EMPTY_OK);
    await fetchAllTransactions("PB", "tok", "2026-08-28", "2026-08-29", {
      timeoutMs: 5000, maxRetries: 0, maxPages: 1,
    });
    assert.equal(sent[0].get("status"), null);
  });

  test("平台回业务错误时，错误串要带上业务码标记", async () => {
    captureParams({ status: { code: 1003, msg: "Missing required parameters or incorrect format" } });

    const r = await fetchAllTransactions("RW", "tok", "2026-08-28", "2026-08-29", {
      timeoutMs: 5000, maxRetries: 0, maxPages: 1,
    });

    assert.ok(r.error, "应返回错误");
    assert.match(r.error!, /1003/, "错误串要带上平台的业务码，别只留一句英文散文");
    assert.equal(classifyConnFailure(r.error!), "platform");
  });
});

describe("D-303 平台业务错误不再冤枉密钥", () => {
  // 库里 295 条历史 last_error 就长这样（没有标记），必须靠散文兜底也认出来
  const 现场原串 = "RW: Missing required parameters or incorrect format";

  test("现场那条错误：判成 platform，不是 auth、也不是 unknown", () => {
    assert.equal(classifyConnFailure(现场原串), "platform");
  });

  test("界面不许再说「API Key 已失效」，也不许给重配按钮", () => {
    const v = describeConnFailure(现场原串);
    assert.equal(v.showReconfigure, false, "重配密钥对这类故障 100% 无效，不能给按钮");
    assert.doesNotMatch(v.title, /API Key 已失效/);
    assert.match(v.hint, /重配密钥没有用|不是密钥/);
  });

  test("贴了标记的新格式同样判 platform", () => {
    const tagged = platformBizError("RW", 1003, "Missing required parameters or incorrect format");
    assert.equal(classifyConnFailure(tagged), "platform");
  });

  test("业务码里出现 5xx 样子的数字，也不能被网络判据抢走", () => {
    // \b5\d{2}\b 会匹配裸的 502；platform 判据排在 transient 前面才不会误伤
    assert.equal(classifyConnFailure(platformBizError("CG", 502, "参数错误")), "platform");
  });

  test("真失效仍然优先判 auth——哪怕它是包在业务码里回来的", () => {
    const tagged = platformBizError("CG", 1001, "Invalid token");
    assert.equal(classifyConnFailure(tagged), "auth");
    assert.equal(describeConnFailure(tagged).showReconfigure, true, "这种才该让人去重配");
  });

  test("其它平台业务错误（限流/跨度超限/发布者不存在）一并归 platform", () => {
    for (const s of [
      "CG: Call frequency too high",
      "LH: Query time span cannot exceed 62 days",
      "PM: Publisher does not exist",
    ]) {
      assert.equal(classifyConnFailure(s), "platform", s);
      assert.equal(describeConnFailure(s).showReconfigure, false, s);
    }
  });

  test("没判出性质的错误，说「原因未归类」，不许硬说成密钥失效", () => {
    const v = describeConnFailure("RW: 某种我们没见过的错");
    assert.equal(v.kind, "unknown");
    assert.doesNotMatch(v.title, /API Key 已失效/);
    assert.equal(v.showReconfigure, false);
  });

  test("网络类与凭据类的老结论不变", () => {
    assert.equal(classifyConnFailure("fetch failed"), "transient");
    assert.equal(describeConnFailure("fetch failed").showReconfigure, false);
    assert.equal(classifyConnFailure("RW: Invalid token"), "auth");
    assert.equal(describeConnFailure("RW: Invalid token").showReconfigure, true);
  });

  test("保存门禁：平台业务错误证明不了 Key 好坏 → 二次确认可存，不硬拦", () => {
    const gate = decideSaveGate({ keyUnchanged: false, testPassed: false, lastFailureKind: "platform" });
    assert.equal(gate.allow, "confirm");
    assert.match((gate as { reason: string }).reason, /跟这把 Key 无关/);
  });
});
