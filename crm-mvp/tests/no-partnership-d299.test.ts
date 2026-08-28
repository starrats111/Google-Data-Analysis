/**
 * D-299：把「与商家已无合作关系」从普通 403 里分出来。
 *
 * 07 2026-08-28 反馈：「122-LH1-jymsupplementscience 是属于没有合作关系的商家，
 * 这种应该在换链接的时候检测出来报告，而不是一直单纯警告，这种属于提示不到位。」
 *
 * 为什么必须分开：两者**人工处置相反**。
 *   普通 403（token 失效/被停用）→ 到平台后台重新取一条链接就好；
 *   无合作关系              → 取多少次都还是 403，必须重新申请合作或下架系列。
 * 原先一律报「需人工到平台重新获取链接」，人照着做只会白跑，报错也永远不会停——
 * 该系列自 2026-08-12 累计报了 2744 次，7 天烧 $70 广告费而佣金为零。
 *
 * 判定必须偏保守：漏判只是退回普通 403（照旧处置，不比现在差），
 * 误判则会让人去下架一条其实只是 token 过期的好广告。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isNoPartnershipBody } from "../src/lib/affiliate-link-resolver";

/** LinkHaitao 2026-08-28 生产实测返回的 403 页面（1599 字节，此处保留结构与关键措辞） */
const LINKHAITAO_403 = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Tips</title>
<style>.plugins__modal-cont{position:fixed;width:600px;left:50%;top:50%}
.plugins__modal-hd{padding:12px 28px;background-color:#2898FF}</style></head>
<body><div class="plugins__modal-cont"><div class="plugins__modal-hd">
<span class="plugins__modal-title">Tips</span></div>
<div class="plugins__modal-bd">No business partnership with merchants</div>
</div></body></html>`;

describe("D-299 认出「无合作关系」", () => {
  test("LinkHaitao 实测 403 页面必须认出来", () => {
    assert.equal(
      isNoPartnershipBody(LINKHAITAO_403),
      true,
      "认不出就会退回普通 403，继续催人「去平台重新取链接」——而那是无效动作",
    );
  });

  test("其它常见措辞一并覆盖", () => {
    for (const b of [
      "<p>No partnership with this merchant.</p>",
      "Your partnership has been terminated",
      "The partnership ended on 2026-07-01",
      "You are not an approved partner for this advertiser",
      "<div>与该商家无合作关系</div>",
      "该商家合作已终止",
      "尚未建立合作，无法推广",
    ]) {
      assert.equal(isNoPartnershipBody(b), true, `应认出无合作关系：${b}`);
    }
  });

  test("大小写与跨空白不影响判定", () => {
    assert.equal(isNoPartnershipBody("NO   BUSINESS\n  PARTNERSHIP with merchants"), true);
  });
});

describe("D-299 不许误判——误判会让人下架好广告", () => {
  test("普通 403 / token 失效页面不得被认成无合作关系", () => {
    for (const b of [
      "<h1>403 Forbidden</h1><p>Access denied</p>",
      "Invalid or expired tracking token",
      "This link has been disabled by the advertiser",
      "Rate limit exceeded, please try again later",
      "<title>Just a moment...</title> Checking your browser before accessing",
      // 只提到 partnership 但没说「没有」——不能仅凭关键词命中
      "Thanks for your partnership! Please update your creative.",
    ]) {
      assert.equal(isNoPartnershipBody(b), false, `不该认成无合作关系：${b.slice(0, 40)}`);
    }
  });

  test("空正文一律退回普通 403 处置", () => {
    assert.equal(isNoPartnershipBody(null), false);
    assert.equal(isNoPartnershipBody(undefined), false);
    assert.equal(isNoPartnershipBody(""), false);
  });

  test("超长正文只看头部 8KB，不因尾部噪音改判", () => {
    const padded = "x".repeat(9000) + "No business partnership with merchants";
    assert.equal(isNoPartnershipBody(padded), false, "关键措辞在 8KB 之外，按未命中处理（保守）");
    const early = "No business partnership with merchants" + "x".repeat(9000);
    assert.equal(isNoPartnershipBody(early), true, "头部命中即算数");
  });
});
