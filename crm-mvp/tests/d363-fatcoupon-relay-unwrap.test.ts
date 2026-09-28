/**
 * D-363：FatCoupon 中转栈（BA/BonusArrive 的上级发布商）解包与「落地判定」回归。
 *
 * 报案现象（2026-09-28，齐满艳，广告系列 675-BA1-ContikiP-GB-0926-317889）：
 * 告警中心「链接无效 / 联盟链接疑似失效（连续 7 次跟链失败）：停在第三方中转域名 r.v2i8b.com」。
 * 链接本身是好的 —— 实测手工跟到底能落到 www.contiki.com。挂掉的是我方巡航：
 *   ① resolveViaBrowser 的 reachedLanding latch 用「不在三张名单里 ⇒ 就是广告主落地页」反推，
 *      在 fatcoupon.com 这一跳就误 latch，此后非导航请求全 abort，掐死了 r.v2i8b.com 的外链跳转脚本；
 *   ② onJumpHost() 同样不认这两个 host，不进 18s 轮询，直接把 URL 快照在中转域名上。
 * 于是 D-316 硬层把 ok 降级成 resolve_failed，且「换链接」治不好（每轮重巡再撞同一道闸）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNonLandingHost, unwrapDeeplink } from "../src/lib/affiliate-link-resolver";

// 实测链（2026-09-28 抓的真实跳转链，只截断了 store_image 等无关参数）
const FATCOUPON_SHELL =
  "https://fatcoupon.com/redirect.html?sr=999&trip=6ab9e28d95d6990012d7f2c5" +
  "&store_title=Contiki+US" +
  "&store_url=https%3A%2F%2Fr.v2i8b.com%2Fapi%2Fv1%2Fbid%2Fredirect%3Fcampaign_id%3D01K5EWCFGDD32G405G9Z5H6K4J" +
  "%26cid%3D6ab9e28d95d6990012d7f2c5%26url%3Dhttp%253A%252F%252Fwww.contiki.com" +
  "&afsrc=1";

const BID_REDIRECT =
  "https://r.v2i8b.com/api/v1/bid/redirect?campaign_id=01K5EWCFGDD32G405G9Z5H6K4J" +
  "&cid=6ab9e28d95d6990012d7f2c5&url=http%3A%2F%2Fwww.contiki.com";

describe("D-363 FatCoupon 中转栈", () => {
  it("fatcoupon.com / r.v2i8b.com 都算「不可作为落地页」的中转域名", () => {
    assert.equal(isNonLandingHost("fatcoupon.com"), true);
    assert.equal(isNonLandingHost("redirect.partner.fatcoupon.com"), true);
    assert.equal(isNonLandingHost("r.v2i8b.com"), true);
  });

  it("不误伤把 fatcoupon 写进参数值的正常落地页 host", () => {
    assert.equal(isNonLandingHost("www.contiki.com"), false);
    // 仅比主机名：形如 notfatcoupon.com 的独立域名不该命中
    assert.equal(isNonLandingHost("notfatcoupon.com"), false);
  });

  it("从 bid/redirect 的 url= 解出广告主 URL", () => {
    assert.equal(unwrapDeeplink(BID_REDIRECT), "http://www.contiki.com/");
  });

  it("从 redirect.html 的 store_url 递归解两层，一路解到广告主域名", () => {
    const got = unwrapDeeplink(FATCOUPON_SHELL);
    assert.ok(got);
    assert.equal(new URL(got).hostname, "www.contiki.com");
  });

  it("解出来的下一跳仍是中转域名时不得直接返回它", () => {
    const got = unwrapDeeplink(FATCOUPON_SHELL);
    assert.ok(got);
    assert.equal(isNonLandingHost(new URL(got).hostname), false);
  });
});
