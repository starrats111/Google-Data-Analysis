import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeTrackingQuery } from "../src/lib/affiliate-link-resolver";
import { computeHopReferer } from "../src/lib/link-resolver/tracker";

describe("D-234 后缀清洗：referer= / url= 不得进 final_url_suffix", () => {
  it("07 报案的真实后缀：剔掉 referer= 与 url=，追踪参数一个不少", () => {
    const raw =
      "referer=https://app.partnermatic.com/track/4c34i0Yu0Gs7vlt1zscFdxIVhrbZ90kd_c_c" +
      "&url=https%3A%2F%2Fwww.ferryhopper.com%2Fen%2F" +
      "&tduid=fc16202ee5f8a56cb130c2c2441059d7&progId=377715&affId=3360223&aff_uid=tradedblr" +
      "&utm_source=tradedoubler&utm_medium=affiliate&utm_campaign=Partnermatic+%28US%29";
    assert.equal(
      sanitizeTrackingQuery(raw),
      "tduid=fc16202ee5f8a56cb130c2c2441059d7&progId=377715&affId=3360223&aff_uid=tradedblr" +
        "&utm_source=tradedoubler&utm_medium=affiliate&utm_campaign=Partnermatic+%28US%29",
    );
  });

  it("Rewardoo 那条（referer= 在最前、还带 source=inner）同样清干净", () => {
    const raw =
      "referer=https://admin.rewardoo.com/track/f453NJgV_bkln98u_c_c&source=inner" +
      "&url=https%3A%2F%2Fwww.thegamecollection.net%2F&tduid=bafc123";
    assert.equal(sanitizeTrackingQuery(raw), "source=inner&tduid=bafc123");
  });

  it("Kelkoo 的 originReferer= 是联盟自己的正常参数，绝不能被误剔", () => {
    const raw = "country=uk&originReferer=Jswebproduction.com&publisherSubId=P4Bqtg";
    assert.equal(sanitizeTrackingQuery(raw), raw);
  });

  it("referrer= 拼写也剔", () => {
    assert.equal(sanitizeTrackingQuery("referrer=https://x.com/a&clickid=9"), "clickid=9");
  });

  it("url= 的值不是 URL 时保留（商家站自己的站内参数）", () => {
    assert.equal(sanitizeTrackingQuery("url=/women/dresses&clickid=9"), "url=/women/dresses&clickid=9");
  });

  it("url= 裸写与百分号编码两种形态都要认出来", () => {
    assert.equal(sanitizeTrackingQuery("url=https://a.com/&x=1"), "x=1");
    assert.equal(sanitizeTrackingQuery("url=https%3A%2F%2Fa.com%2F&x=1"), "x=1");
  });

  it("不动其余参数的原始编码（联盟对字面值敏感）", () => {
    const raw = "referer=https://t.co&tduid=a%2Fb%3Dc&utm_campaign=X+%28US%29";
    assert.equal(sanitizeTrackingQuery(raw), "tduid=a%2Fb%3Dc&utm_campaign=X+%28US%29");
  });

  it("剥前导 ?，并丢掉空段（Google 不接受）", () => {
    assert.equal(sanitizeTrackingQuery("?a=1&&b=2"), "a=1&b=2");
  });

  it("清洗后什么都不剩 → null（交由上层判 no_tracking，语义正确）", () => {
    assert.equal(sanitizeTrackingQuery("referer=https://t.co&url=https://a.com/"), null);
  });

  it("空值容错", () => {
    assert.equal(sanitizeTrackingQuery(""), null);
    assert.equal(sanitizeTrackingQuery(null), null);
    assert.equal(sanitizeTrackingQuery(undefined), null);
    assert.equal(sanitizeTrackingQuery("   "), null);
  });

  it("大小写不敏感（Referer= / URL= 一样剔）", () => {
    assert.equal(sanitizeTrackingQuery("Referer=https://t.co&URL=https://a.com/&k=1"), "k=1");
  });
});

describe("D-234 跟链 Referer：按浏览器 strict-origin-when-cross-origin 口径", () => {
  it("跨源只发 origin，不泄露 path 与 track token", () => {
    assert.equal(
      computeHopReferer("https://app.partnermatic.com/track/4c34i0Yu0Gs7secret", "https://clk.tradedoubler.com/click?a=1"),
      "https://app.partnermatic.com/",
    );
  });

  it("同源发完整 URL（与浏览器一致，不影响联盟自家多跳的归因）", () => {
    const prev = "https://clk.tradedoubler.com/click?p=1";
    assert.equal(computeHopReferer(prev, "https://clk.tradedoubler.com/step2"), prev);
  });

  it("https → http 降级时完全不发", () => {
    assert.equal(computeHopReferer("https://a.com/x", "http://b.com/y"), undefined);
  });

  it("http → http 跨源仍发 origin", () => {
    assert.equal(computeHopReferer("http://a.com/x/y", "http://b.com/"), "http://a.com/");
  });

  it("端口不同视为跨源", () => {
    assert.equal(computeHopReferer("https://a.com:8443/x", "https://a.com/y"), "https://a.com:8443/");
  });

  it("没有上一跳 / URL 非法时不发", () => {
    assert.equal(computeHopReferer(null, "https://a.com/"), undefined);
    assert.equal(computeHopReferer("not-a-url", "https://a.com/"), undefined);
    assert.equal(computeHopReferer("https://a.com/", "not-a-url"), undefined);
  });
});
