import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { looksLikeWholeTrackingLink } from "../src/lib/affiliate-link-resolver";

describe("D-354 后缀「整条链接」判定：只看开头，不再 includes('://')", () => {
  it("wj04 报案的真实后缀：参数值里带 URL，必须放行（旧口径误杀，保存不了）", () => {
    // Coppel / Rewardoo(soicos)：utm_campaign 的值本身就是一条 rewardoo 链接，这是联盟的正常写法
    const raw =
      "utm_source=soicos&utm_term=2600861802&utm_medium=afiliados" +
      "&utm_campaign=https://www.rewardoo.com/_tnd-2600861802";
    assert.equal(looksLikeWholeTrackingLink(raw), false);
  });

  it("参数值里带 URL 的其他常见形态一律放行", () => {
    assert.equal(looksLikeWholeTrackingLink("clickid=9&back=https://a.com/x"), false);
    assert.equal(looksLikeWholeTrackingLink("u=https%3A%2F%2Fa.com%2F&k=1"), false);
    assert.equal(looksLikeWholeTrackingLink("a=1&b=http://x.io/p?q=2"), false);
  });

  it("真·整条链接仍然拦住（这是这道闸门的本职）", () => {
    assert.equal(looksLikeWholeTrackingLink("https://app.partnermatic.com/track/4c34i0Yu"), true);
    assert.equal(looksLikeWholeTrackingLink("http://www.linkhaitao.com/index.php?mod=login"), true);
    assert.equal(looksLikeWholeTrackingLink("HTTPS://A.COM/x"), true);
  });

  it("编码 / 省略协议的整条链接形态也拦", () => {
    assert.equal(looksLikeWholeTrackingLink("https%3A%2F%2Fa.com%2Fx"), true);
    assert.equal(looksLikeWholeTrackingLink("%2F%2Fa.com/x"), true);
    assert.equal(looksLikeWholeTrackingLink("//a.com/x"), true);
  });

  it("前导 ?/& 不影响判定（保存时会先剥，判定自己也要能扛）", () => {
    assert.equal(looksLikeWholeTrackingLink("?https://a.com/x"), true);
    assert.equal(looksLikeWholeTrackingLink("?utm_campaign=https://a.com/x"), false);
    assert.equal(looksLikeWholeTrackingLink("  &https://a.com/x  "), true);
  });

  it("第一段没有 key、协议头在 '=' 之前 → 判整条链接", () => {
    // 贴进来时把 scheme 删了但带了 host 与 query 的形态
    assert.equal(looksLikeWholeTrackingLink("x.com://p&a=1"), true);
  });

  it("第一段的 '=' 在协议头之前 → 是 key=value，放行", () => {
    assert.equal(looksLikeWholeTrackingLink("k=x.com://p&a=1"), false);
  });

  it("空值不判为整条链接（交由上层存 null）", () => {
    assert.equal(looksLikeWholeTrackingLink(""), false);
    assert.equal(looksLikeWholeTrackingLink("   "), false);
    assert.equal(looksLikeWholeTrackingLink(null), false);
    assert.equal(looksLikeWholeTrackingLink(undefined), false);
  });

  it("普通后缀（无任何 URL）放行", () => {
    assert.equal(looksLikeWholeTrackingLink("utm_source=xx&clickid=yy"), false);
    assert.equal(looksLikeWholeTrackingLink("gclid={gclid}&aff=123"), false);
  });
});
