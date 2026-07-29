import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldEscalateToBrowser, toHttpProxyUrl, type ResolveResult } from "../src/lib/affiliate-link-resolver";
import { parseProxyUrl } from "../src/lib/link-resolver";

type Step1 = Pick<ResolveResult, "status" | "error" | "requiresBrowserEnrich">;
const step1 = (s: Step1): Step1 => s;

describe("D-193 严格双条件分流", () => {
  it("同时拿到广告主域名和追踪参数（ok）才直出", () => {
    assert.equal(shouldEscalateToBrowser(step1({ status: "ok" }), true), false);
  });

  it("落到广告主域名但没追踪参数 → 升级", () => {
    assert.equal(shouldEscalateToBrowser(step1({ status: "no_tracking" }), true), true);
  });

  it("命中平台黑名单是业务终态，不再浪费一次点击", () => {
    assert.equal(shouldEscalateToBrowser(step1({ status: "forbidden_network" }), true), false);
  });

  it("tracker_forbidden 只是第一步的归类，仍要升级试一次", () => {
    assert.equal(shouldEscalateToBrowser(step1({ status: "tracker_forbidden" }), true), true);
  });

  it("旧逻辑漏掉的失败成因（超时/连接重置）现在也升级", () => {
    assert.equal(
      shouldEscalateToBrowser(step1({ status: "resolve_failed", error: "跟链失败: ETIMEDOUT" }), true),
      true,
    );
  });

  it("status 已 ok 但只是静态解包缺参数 → 仍要补跑浏览器", () => {
    assert.equal(shouldEscalateToBrowser(step1({ status: "ok", requiresBrowserEnrich: true }), true), true);
  });
});

describe("开关关闭时完全回滚到改造前判定", () => {
  it("超时类 resolve_failed 不升级（旧行为：直接判死链）", () => {
    assert.equal(
      shouldEscalateToBrowser(step1({ status: "resolve_failed", error: "跟链失败: ETIMEDOUT" }), false),
      false,
    );
  });

  it("停在跳板域名仍升级", () => {
    assert.equal(
      shouldEscalateToBrowser(step1({ status: "resolve_failed", error: "停在跳板域名 prf.hn，未跟到广告主落地页" }), false),
      true,
    );
  });

  it("停在联盟点击中转域名仍升级", () => {
    assert.equal(
      shouldEscalateToBrowser(
        step1({ status: "resolve_failed", error: "停在联盟点击中转域名 pub.engagevantage.com，未跟到广告主落地页" }),
        false,
      ),
      true,
    );
  });

  it("no_tracking 仍升级", () => {
    assert.equal(shouldEscalateToBrowser(step1({ status: "no_tracking" }), false), true);
  });

  it("tracker_forbidden 在旧逻辑下不升级", () => {
    assert.equal(shouldEscalateToBrowser(step1({ status: "tracker_forbidden" }), false), false);
  });
});

describe("toHttpProxyUrl 复用第一步的粘性会话", () => {
  // 会话 ID 藏在用户名里，必须逐字保留，否则 kookeey 会开新会话换出口 IP，
  // 联盟侧就会看到同一链接来自两个 IP 的两次点击。
  it("socks5 改写成 http，凭据与 host:port 原样保留", () => {
    assert.equal(
      toHttpProxyUrl("socks5://user-country-US-session-abc123:pw%401@gate.kookeey.info:1000"),
      "http://user-country-US-session-abc123:pw%401@gate.kookeey.info:1000",
    );
  });

  it("已经是 http 的原样通过", () => {
    assert.equal(toHttpProxyUrl("http://u:p@1.2.3.4:8080"), "http://u:p@1.2.3.4:8080");
  });

  it("无认证信息时不拼出多余的 @", () => {
    assert.equal(toHttpProxyUrl("socks5://1.2.3.4:1080"), "http://1.2.3.4:1080");
  });

  it("缺端口或非法 URL 返回 null，调用方退回常规取代理", () => {
    assert.equal(toHttpProxyUrl("socks5://gate.kookeey.info"), null);
    assert.equal(toHttpProxyUrl("not a url"), null);
  });
});

describe("parseProxyUrl 拆给第一步的跟跳引擎", () => {
  it("socks5 拆出协议、无凭据的 url 和解码后的账号密码", () => {
    assert.deepEqual(parseProxyUrl("socks5://user%2Da:p%40ss@gate.kookeey.info:1000"), {
      url: "socks5://gate.kookeey.info:1000",
      username: "user-a",
      password: "p@ss",
      protocol: "socks5",
    });
  });

  it("http 代理协议标成 http", () => {
    assert.equal(parseProxyUrl("http://u:p@1.2.3.4:8080")?.protocol, "http");
  });

  it("无代理返回 undefined（直连）", () => {
    assert.equal(parseProxyUrl(null), undefined);
  });
});
