import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkEvidenceOwnership } from "../src/lib/evidence-ownership";

// D-317：素材页归属校验。两个信号同时失守（host 对不上 + 正文没品牌词）才拦。
describe("D-317 checkEvidenceOwnership：拦「不是这个商家的页」", () => {
  it("07 报案原案：Adtraction 招商页当素材源 —— host 对不上、正文没有 Tchibo，判 off_merchant", () => {
    const r = checkEvidenceOwnership({
      evidenceUrl: "https://go.adt212.net/t/t",
      merchantUrl: "https://www.tchibo.ch",
      title: "Adtraction: Entwickle dein Business mit Partnern",
      metaDescription: "Umsatzsteigerung mit planbaren Kosten",
      pageText:
        "Aktives Partnermanagement seit 2007. 12 Büros in ganz Europa. " +
        "Self-managed ab 149 CHF/mo. Managed 249 CHF/mo. Proaktive Partnerrekrutierung. " +
        "Du wirst erst bei Sales bezahlt.",
    });
    assert.equal(r.verdict, "off_merchant");
    assert.equal(r.brand, "tchibo");
    assert.equal(r.hostOff, true);
    assert.equal(r.brandHit, false);
  });

  it("fatcoupon 空壳同样判掉（正文几乎为空，自然搜不到品牌词）", () => {
    const r = checkEvidenceOwnership({
      evidenceUrl: "https://fatcoupon.com/redirect.html",
      merchantUrl: "https://bellamiacollections.com",
      title: "Just a moment...",
      pageText: "",
    });
    assert.equal(r.verdict, "off_merchant");
  });

  it("商家自己的站照常放行（host 就对得上，压根不看正文）", () => {
    const r = checkEvidenceOwnership({
      evidenceUrl: "https://www.tchibo.ch/kaffee-s400.html",
      merchantUrl: "https://www.tchibo.ch",
      title: "Kaffee, Mode & mehr",
      pageText: "Jede Woche neue Themen",
    });
    assert.equal(r.verdict, "ok");
    assert.equal(r.hostOff, false);
  });

  it("换域/merchant_url 过期：host 对不上但正文有品牌词 → 放行，不硬拦", () => {
    const r = checkEvidenceOwnership({
      evidenceUrl: "https://www.eduscho.at/",
      merchantUrl: "https://www.tchibo.de",
      title: "Eduscho Österreich",
      pageText: "Eduscho ist Teil von Tchibo. Kaffee, Mode und Wohnen jede Woche neu.",
    });
    assert.equal(r.verdict, "brand_hit_allow");
    assert.equal(r.hostOff, true);
    assert.equal(r.brandHit, true);
  });

  it("品牌词跨标签被空格/标点断开也算命中（比对前统一去掉非字母数字）", () => {
    const r = checkEvidenceOwnership({
      evidenceUrl: "https://shop.example-cdn.net/",
      merchantUrl: "https://www.nomatic.com",
      title: "NO-MATIC | Travel Bags",
      pageText: "",
    });
    assert.equal(r.verdict, "brand_hit_allow");
  });

  it("品牌词只出现在导航项/features 里也算命中（extraText 参与比对）", () => {
    const r = checkEvidenceOwnership({
      evidenceUrl: "https://cdn-shop.example.net/",
      merchantUrl: "https://www.cariloha.com",
      pageText: "Bamboo sheets and pillows.",
      extraText: ["Cariloha Store", "Free shipping"],
    });
    assert.equal(r.verdict, "brand_hit_allow");
  });

  it("品牌段短于 3 字符不判，直接放行", () => {
    const r = checkEvidenceOwnership({
      evidenceUrl: "https://go.adt212.net/t/t",
      merchantUrl: "https://ab.com",
      pageText: "毫不相干的内容",
    });
    assert.equal(r.verdict, "ok");
    assert.equal(r.brand, "");
  });

  it("素材来源 URL 或商家 URL 缺失时不判，不拿缺数据当证据", () => {
    assert.equal(
      checkEvidenceOwnership({ evidenceUrl: "", merchantUrl: "https://www.tchibo.ch" }).verdict,
      "ok",
    );
    assert.equal(
      checkEvidenceOwnership({ evidenceUrl: "https://go.adt212.net/t/t", merchantUrl: null }).verdict,
      "ok",
    );
  });
});
