import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { judgeSitelinkDomain, sitelinkDomainAllowed } from "../src/lib/sitelink-domain-verdict";

// D-350：站内链接域名归属判定统一到一处。
// 报案原案（01 2026-09-23）：商家 Veracity 联盟登记域 veracityselfcare.com，
// 站内链接全是 AI 从商家平台爬出来的 veracityhealth.co / veracityhealth.com，
// 界面上链接 2～5「已验证」、唯独链接 1 红着报「与商家域名不匹配」。

/** 造一个只返回给定 HTML 的 fetch；同时记录被抓过几次，用来断言「正常链接不发请求」 */
function fakeFetch(html: string, counter?: { n: number }): typeof fetch {
  return (async () => {
    if (counter) counter.n += 1;
    return { arrayBuffer: async () => new TextEncoder().encode(html).buffer };
  }) as unknown as typeof fetch;
}

function failingFetch(counter?: { n: number }): typeof fetch {
  return (async () => {
    if (counter) counter.n += 1;
    throw new Error("ETIMEDOUT");
  }) as unknown as typeof fetch;
}

const VERACITY_MERCHANT = "https://veracityselfcare.com";

describe("D-350 报案原案：Veracity 的站内链接不该被判成不匹配", () => {
  it("链接 1（veracityhealth.com）—— 原先前端裸比对拦下，现在按 D-318 共同前缀放行", async () => {
    // 原先前端判据：urlDomain.includes(baseDomain) || baseDomain.includes(urlDomain)
    //   veracityhealth.com vs veracityselfcare.com → 互不包含 → 拦下（就是图二那条红的）
    // 现在走 landingMatchesTarget：共同前缀 veracity = 8 ≥ SAME_ENTITY_PREFIX(6) → 放行
    const counter = { n: 0 };
    const r = await judgeSitelinkDomain(
      "https://veracityhealth.com/collections/bestselling-items",
      { merchantUrl: VERACITY_MERCHANT, fetchImpl: failingFetch(counter) },
    );
    assert.equal(r.verdict, "on_merchant");
    assert.equal(r.via, "literal");
    assert.equal(sitelinkDomainAllowed(r.verdict), true);
    // 字面判据即过 → 不该为此多抓一次页面
    assert.equal(counter.n, 0, "字面判据通过时不应发起网络请求");
  });

  it("链接 2～5（veracityhealth.co）—— 与链接 1 同一结论，不再两条路径各说各话", async () => {
    for (const u of [
      "https://veracityhealth.co/products/metabolic-power-protein",
      "https://veracityhealth.co/collections/best-sellers",
      "https://veracityhealth.co/products/hormone-wellness-test",
    ]) {
      const r = await judgeSitelinkDomain(u, { merchantUrl: VERACITY_MERCHANT, fetchImpl: failingFetch() });
      assert.equal(r.verdict, "on_merchant", `${u} 应判在商家域下`);
    }
  });

  it("基准取 final_url 优先：落地页已校正到 veracityhealth.co 时，同域链接直接过", async () => {
    // Google Ads 的要求是 sitelink 与落地页同域，不是与联盟登记域同域。
    // 原先前端取 merchant_url 优先，基准取反了。
    const r = await judgeSitelinkDomain("https://veracityhealth.co/collections/all", {
      finalUrl: "https://veracityhealth.co/",
      merchantUrl: VERACITY_MERCHANT,
      fetchImpl: failingFetch(),
    });
    assert.equal(r.verdict, "on_merchant");
    assert.equal(r.matchedBaseline, "https://veracityhealth.co/");
  });
});

describe("D-350 不误伤，也不放行真中转", () => {
  it("第三方中转域（fatcoupon）且页面证不出归属 → 仍然拦下", async () => {
    const r = await judgeSitelinkDomain("https://fatcoupon.com/redirect.html", {
      merchantUrl: "https://bellamiacollections.com",
      fetchImpl: fakeFetch("<html><head><title>FatCoupon</title></head><body></body></html>"),
    });
    assert.equal(r.verdict, "off_merchant");
    assert.equal(sitelinkDomainAllowed(r.verdict), false);
  });

  it("改名子品牌（Tapo vs TP-Link）：字面判据全不成立，靠 D-328 页面自证放行", async () => {
    const r = await judgeSitelinkDomain("https://us.store.tapo.com/", {
      merchantUrl: "https://us.store.tp-link.com",
      fetchImpl: fakeFetch(
        `<html><head><title>Tapo Store | TP-Link &ndash; TP-Link Tapo Store</title></head><body></body></html>`,
      ),
    });
    assert.equal(r.verdict, "self_certified");
    assert.equal(r.via, "ownership");
    assert.equal(r.hitIn, "title");
    assert.equal(sitelinkDomainAllowed(r.verdict), true);
  });

  it("两个基准都取不到 → no_baseline 放行，不拿缺基准当拒绝理由", async () => {
    const r = await judgeSitelinkDomain("https://whatever.example.com/x", {
      finalUrl: null,
      merchantUrl: "",
      fetchImpl: failingFetch(),
    });
    assert.equal(r.verdict, "no_baseline");
    assert.equal(sitelinkDomainAllowed(r.verdict), true);
  });

  it("抓不到页面时维持拦下（沿用 D-328：不拿网络故障当放行理由）", async () => {
    const r = await judgeSitelinkDomain("https://sometracker.example/click", {
      merchantUrl: "https://bellamiacollections.com",
      fetchImpl: failingFetch(),
    });
    assert.equal(r.verdict, "off_merchant");
    assert.equal(sitelinkDomainAllowed(r.verdict), false);
  });

  it("换 ccTLD 与建站平台子域照旧放行（D-316 原有三类正常情况不回归）", async () => {
    const co_uk = await judgeSitelinkDomain("https://brand.co.uk/shop", {
      merchantUrl: "https://brand.com",
      fetchImpl: failingFetch(),
    });
    assert.equal(co_uk.verdict, "on_merchant");

    const shopify = await judgeSitelinkDomain("https://brand.myshopify.com/collections/all", {
      merchantUrl: "https://brand.com",
      fetchImpl: failingFetch(),
    });
    assert.equal(shopify.verdict, "on_merchant");
  });
});
