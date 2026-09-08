import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkLandingOwnership } from "../src/lib/landing-ownership";
import { landingMatchesTarget } from "../src/lib/root-domain";

// D-328：D-316 要拦下之前，先让落地页自证归属。
// 治的是「改名子品牌」误杀：域名字面判据对母子品牌无效（Tapo vs TP-Link）。
// 所有样本取自 2026-09-08 生产实况。

/** 造一个只返回给定 HTML 的 fetch */
function fakeFetch(html: string): typeof fetch {
  return (async () => ({
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  })) as unknown as typeof fetch;
}

function failingFetch(): typeof fetch {
  return (async () => {
    throw new Error("ETIMEDOUT");
  }) as unknown as typeof fetch;
}

// wj11 报案原案的落地页首屏（us.store.tapo.com 实访节选）
const TAPO_HTML = `<!doctype html><html><head>
<title>Tapo Store | TP-Link &ndash; TP-Link Tapo Store</title>
<link rel="canonical" href="https://us.store.tapo.com/">
<link href="https://cdn.shopify.com/s/files/1/x.css" rel="stylesheet">
<link href="https://static.tp-link.com/res/style/fonts/subset/A.woff2" rel="preload">
</head><body></body></html>`;

// PartnerBoost 中转页实况：rtrack2/ 后的 base64 解出来是 MERCHANT UNAVAILABLE
const PARTNERBOOST_HTML = `<!doctype html><html><head><title>Tips</title></head>
<body><div>Merchant unavailable</div></body></html>`;

describe("D-328 checkLandingOwnership：改名子品牌放行，真中转照旧拦下", () => {
  it("wj11 报案原案：Tapo 是 TP-Link 的子品牌，title 里自证 → 放行", async () => {
    // 商家 us.store.tp-link.com 落到 us.store.tapo.com，被 D-316 判「停在第三方中转域名」，
    // tracking_status 从 ok 掉成 resolve_failed，换两次链接都没用（每轮重巡再撞一次）。
    const r = await checkLandingOwnership(
      "https://us.store.tapo.com/",
      "https://us.store.tp-link.com/",
      fakeFetch(TAPO_HTML),
    );
    assert.equal(r.verdict, "brand_hit_allow");
    assert.equal(r.brand, "tplink");
    assert.equal(r.hitIn, "title");
  });

  it("先确认 D-316 单靠字面判据确实拦不住这一单（否则本测试无意义）", () => {
    assert.equal(
      landingMatchesTarget("us.store.tapo.com", "https://us.store.tp-link.com/"),
      false,
    );
  });

  it("title 里没有品牌名时，静态资源域能兜住（商家把资源放母品牌域下）", async () => {
    const html = TAPO_HTML.replace(
      "<title>Tapo Store | TP-Link &ndash; TP-Link Tapo Store</title>",
      "<title>Smart Home Store</title>",
    ).replace('href="https://us.store.tapo.com/"', 'href="https://us.store.tapo.com/x"');
    const r = await checkLandingOwnership(
      "https://us.store.tapo.com/",
      "https://us.store.tp-link.com/",
      fakeFetch(html),
    );
    assert.equal(r.verdict, "brand_hit_allow");
    assert.equal(r.hitIn, "assetHost");
  });

  it("PartnerBoost 真中转页照旧拦下——那 12 行是商家真下线了，不能放行", async () => {
    for (const merchant of [
      "https://practicebetter.io/",
      "https://www.lizensio.de",
      "https://cravot.com",
      "https://www.pixartprinting.fr/",
      "https://www.greencrossvets.com.au/",
      "https://www.francoisesaget.com/fr-fr/",
    ]) {
      const r = await checkLandingOwnership(
        "https://app.partnerboost.com/rtrack2/TUVSQ0hBTlQgVU5BVkFJTEFCTEU=",
        merchant,
        fakeFetch(PARTNERBOOST_HTML),
      );
      assert.equal(r.verdict, "off_merchant", merchant);
    }
  });

  it("抓不到页面时维持原判——不拿网络故障当放行理由", async () => {
    const r = await checkLandingOwnership(
      "https://us.store.tapo.com/",
      "https://us.store.tp-link.com/",
      failingFetch(),
    );
    assert.equal(r.verdict, "undetermined");
    assert.equal(r.fetched, false);
  });

  it("空响应体同样维持原判", async () => {
    const r = await checkLandingOwnership(
      "https://us.store.tapo.com/",
      "https://us.store.tp-link.com/",
      fakeFetch("   "),
    );
    assert.equal(r.verdict, "undetermined");
  });

  it("品牌段取不出来时不判（建站平台域、短名），且不发请求", async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return { arrayBuffer: async () => new ArrayBuffer(0) };
    }) as unknown as typeof fetch;
    for (const merchant of ["https://e6026e.myshopify.com", "https://ab.com", null]) {
      const r = await checkLandingOwnership("https://x.example.com/", merchant, spy);
      assert.equal(r.verdict, "undetermined", String(merchant));
    }
    assert.equal(called, false, "品牌段取不出来就不该抓页面");
  });

  it("品牌词只出现在路径里不算——太容易碰巧命中（/brands/tplink 这类列表页）", async () => {
    const html = `<!doctype html><html><head><title>Deals</title>
<link rel="canonical" href="https://coupon-site.example/x">
<img src="https://cdn.example.com/brands/tplink/logo.png">
</head></html>`;
    const r = await checkLandingOwnership(
      "https://coupon-site.example/deals",
      "https://us.store.tp-link.com/",
      fakeFetch(html),
    );
    assert.equal(r.verdict, "off_merchant");
  });
});
