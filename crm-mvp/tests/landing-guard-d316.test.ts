import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { landingMatchesTarget } from "../src/lib/root-domain";

// D-316：巡航终点必须落在商家自己的域名下。
// 取向是「宁可漏判，不可错杀」——放过商家自己的各种变体，只揪无关的第三方中转。
describe("D-316 landingMatchesTarget：拦中转，不误伤商家自己的域", () => {
  it("07 报案原案：Adtraction 追踪域不是 Tchibo 的落地页", () => {
    // campaign 28106 实况：巡航停在 go.adt212.net/t/t 却判 ok，爬到 7577 字 Adtraction 招商页，
    // 15 条标题全成了「Partnerprogramm ab 149 CHF/mo」。
    assert.equal(landingMatchesTarget("go.adt212.net", "https://www.tchibo.ch"), false);
    assert.equal(landingMatchesTarget("https://go.adt212.net/t/t", "https://www.tchibo.ch"), false);
  });

  it("Adtraction 的轮换编号域一个都跑不掉（名单法追不上，这里靠域名无关判法）", () => {
    for (const host of ["tatrck.com", "adt212.net", "go.adt256.com", "go.adt284.net"]) {
      assert.equal(landingMatchesTarget(host, "https://www.tchibo.ch"), false, host);
    }
  });

  it("存量脏数据里的其余中转域同样拦住", () => {
    assert.equal(landingMatchesTarget("fatcoupon.com", "https://bellamiacollections.com"), false);
    assert.equal(landingMatchesTarget("app.partnerboost.com", "https://www.mpb.com"), false);
    assert.equal(landingMatchesTarget("fr-go.kelkoogroup.net", "https://www.miliboo.be"), false);
    assert.equal(landingMatchesTarget("admin.rewardoo.com", "https://www.thegamecollection.net"), false);
  });

  it("商家自己的子域 / 本地化路径照常放行", () => {
    assert.equal(landingMatchesTarget("shop.tchibo.ch", "https://www.tchibo.ch"), true);
    assert.equal(landingMatchesTarget("https://www.tchibo.ch/kaffee-s400.html", "https://www.tchibo.ch"), true);
    assert.equal(landingMatchesTarget("www.tchibo.ch:443", "https://www.tchibo.ch"), true);
  });

  it("换 ccTLD 的同品牌站放行（brand.co.uk vs brand.com）", () => {
    assert.equal(landingMatchesTarget("www.coach.co.uk", "https://www.coach.com"), true);
    assert.equal(landingMatchesTarget("nomatic.de", "https://www.nomatic.com"), true);
  });

  it("建站平台子域放行——根域是 myshopify.com，但品牌段还在 host 里", () => {
    assert.equal(landingMatchesTarget("saalt.myshopify.com", "https://saalt.com"), true);
    assert.equal(landingMatchesTarget("ethika.myshopify.com", "https://www.ethika.com"), true);
  });

  it("品牌段短于 3 字符一律放行，不拿两三个字母去猜", () => {
    assert.equal(landingMatchesTarget("go.adt212.net", "https://ab.com"), true);
  });

  it("落地 host 解析不出可比对的段就放行，不拿解析失败当证据", () => {
    assert.equal(landingMatchesTarget("", "https://www.tchibo.ch"), true);
    assert.equal(landingMatchesTarget("://", "https://www.tchibo.ch"), true);
  });
});
