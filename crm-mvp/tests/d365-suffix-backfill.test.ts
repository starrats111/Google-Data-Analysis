import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeSuffixForBackfill,
  hasExistingSuffix,
  FINAL_URL_SUFFIX_MAX,
} from "../src/lib/final-url-suffix";

describe("D-365 后缀回填口径：巡航拿到的 query 串 → 可入库可上传的后缀", () => {
  it("01 报案的真实后缀（HYTEST US / Partnerize）必须能原样留住", () => {
    // 截图里广告预览页显示的那串，Google Ads 侧却是空的
    const raw =
      "clickref=111014xQC2Nf&utm_medium=affiliate&utm_source=partnerize" +
      "&utm_campaign=afl-hytt-us-ecom-evergreen&utm_term=11001332352";
    assert.equal(normalizeSuffixForBackfill(raw), raw);
  });

  it("带前导 ? 的 location.search 直接喂进来也要能用（巡航返回值的常见形态）", () => {
    assert.equal(
      normalizeSuffixForBackfill("?clickref=abc&utm_source=partnerize"),
      "clickref=abc&utm_source=partnerize",
    );
  });

  it("D-234：referer= / url=<URL> 这类脏参数必须在入库前剔掉", () => {
    // 曾经真实投放过 1985 次的那类脏后缀，不能借回填这条新路径再溜回去
    assert.equal(normalizeSuffixForBackfill("clickid=9&referer=https://lh.com/x"), "clickid=9");
    assert.equal(normalizeSuffixForBackfill("url=https://a.com/p&utm_source=lh"), "utm_source=lh");
  });

  it("D-354：参数值里含 URL 是合法后缀，不能误杀", () => {
    const raw = "utm_source=soicos&utm_campaign=https://www.rewardoo.com/_tnd-2600861802";
    assert.equal(normalizeSuffixForBackfill(raw), raw);
  });

  it("D-354：真·整条链接判不可用（返回 null，调用方跳过回填）", () => {
    assert.equal(normalizeSuffixForBackfill("https://app.partnermatic.com/track/4c34i0Yu"), null);
    assert.equal(normalizeSuffixForBackfill("%2F%2Fa.com/x"), null);
  });

  it("空 / 全脏 / 只剩分隔符 → null，不能写出空串（空串在 Google 侧是「清空」语义）", () => {
    assert.equal(normalizeSuffixForBackfill(null), null);
    assert.equal(normalizeSuffixForBackfill(undefined), null);
    assert.equal(normalizeSuffixForBackfill(""), null);
    assert.equal(normalizeSuffixForBackfill("?"), null);
    assert.equal(normalizeSuffixForBackfill("&&"), null);
    assert.equal(normalizeSuffixForBackfill("referer=https://a.com/x"), null);
  });

  it("尾部多余 & 去掉（D-157 口径），不留给 Google 报 INVALID_ARGUMENT", () => {
    assert.equal(normalizeSuffixForBackfill("a=1&b=2&"), "a=1&b=2");
    assert.equal(normalizeSuffixForBackfill("  a=1&b=2  "), "a=1&b=2");
  });

  it("超长截断到 VARCHAR(500)，不靠数据库报错兜底", () => {
    const long = "k=" + "x".repeat(600);
    const out = normalizeSuffixForBackfill(long);
    assert.ok(out);
    assert.equal(out!.length, FINAL_URL_SUFFIX_MAX);
  });
});

describe("D-365 不覆盖已有后缀：员工手填值优先级最高", () => {
  it("库里已有值 → 判为已设置，巡航不再回填", () => {
    assert.equal(hasExistingSuffix(undefined, "clickref=existing"), true);
  });

  it("前端显式带了后缀 → 判为已设置（无需回填）", () => {
    assert.equal(hasExistingSuffix("utm_source=manual", null), true);
  });

  it("两头都空/空白 → 判为未设置，这才是回填的目标场景（竞品引擎的常态）", () => {
    assert.equal(hasExistingSuffix(undefined, null), false);
    assert.equal(hasExistingSuffix(undefined, ""), false);
    assert.equal(hasExistingSuffix("", null), false);
    assert.equal(hasExistingSuffix("   ", "  "), false);
  });

  it("前端传空串但库里有值 → 仍算已设置（?? 只挡 null/undefined，空串要靠 || 兜）", () => {
    assert.equal(hasExistingSuffix("", "clickref=existing"), true);
  });
});
