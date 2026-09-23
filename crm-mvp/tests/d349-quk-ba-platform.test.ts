/**
 * D-349 接入 QUK / BA 两个新联盟平台。
 *
 * 为什么这几条必须有测试：它们全是「错了也不会报错」的那一类，线上只会表现为数字不对。
 *
 * 1) QUK 的 orderStatus 数字码与 AD 的**含义相反**（QUK 0/1/2 = pending/approved/rejected，
 *    AD 1/2/3 = pending/approved/rejected）。两者若共用 TXN_STATUS_MAP，QUK 的「已批准」
 *    会被记成 pending、「已拒绝」会被记成 approved——佣金、结算率、已确认口径全错，
 *    而且一条错误日志都不会有。
 *
 * 2) BA 的 commissions 里凡 name="Contact for rates" 的行，commission_val 一律是硬编码
 *    的 70 配 commission_type="percent"。那是「费率未公开、需找 AM 询价」的占位值，
 *    不是 70%。照字面入库会让商家库凭空多出几个 70% 佣金的商家，直接把选品和 ROI 带偏。
 *    实测 503 家 active 里 8 家是这种。
 *
 * 3) BA 的商家字段名和通用兜底链对不上（site_name / region / adv_catagory / site_logo_url）。
 *    漏一个不会报错，只会安静地把 503 家商家名写成域名（联调第一版就踩到了：
 *    "Nano Bond" 全被写成 "nanobondus.com"）。
 *
 * 4) BA 的响应包是 {status:1} 数字而不是 {status:{code}} 对象，失败是 status:0 + info 文字。
 *    旧的 status?.code 判定在这里恒为 undefined，失败会被当成「这段时间没数据」静默吞掉。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  __d349Internals,
  PLATFORM_API_CONFIG,
  PLATFORM_TXN_CONFIG,
  PLATFORM_CLICK_CONFIG,
} from "../src/lib/platform-api";

const { normalizeTxnStatus, parseBaCommission, preNormalizeMerchantItem, clickErrorMessage } = __d349Internals;

describe("D-349 QUK 交易状态码", () => {
  test("QUK 的 0/1/2 映射为 pending/approved/rejected", () => {
    assert.equal(normalizeTxnStatus("0", "QUK"), "pending");
    assert.equal(normalizeTxnStatus("1", "QUK"), "approved");
    assert.equal(normalizeTxnStatus("2", "QUK"), "rejected");
  });

  test("同样的数字对 AD 口径仍是旧含义（两张表不能并）", () => {
    // 不传 platform 走通用表：AD 的 1=pending、2=approved
    assert.equal(normalizeTxnStatus("1"), "pending");
    assert.equal(normalizeTxnStatus("2"), "approved");
    // 正是这组差异决定了 QUK 必须单独查表
    assert.notEqual(normalizeTxnStatus("1", "QUK"), normalizeTxnStatus("1"));
    assert.notEqual(normalizeTxnStatus("2", "QUK"), normalizeTxnStatus("2"));
  });

  test("QUK 若改成返回英文词，回落通用表而不是一律 pending", () => {
    assert.equal(normalizeTxnStatus("approved", "QUK"), "approved");
    assert.equal(normalizeTxnStatus("rejected", "QUK"), "rejected");
    assert.equal(normalizeTxnStatus("paid", "QUK"), "paid");
  });
});

describe("D-349 BA 佣金解析", () => {
  test('"Contact for rates" 的 70 不当费率用（占位值）', () => {
    const raw = '[{"name":"Contact for rates","type":"","id":"","commission_type":"percent","commission_val":70,"commission_currency":"USD"}]';
    assert.equal(parseBaCommission(raw), "");
  });

  test("数组形态与字符串形态都能解（实测两种都出现过）", () => {
    // 字符串里装 JSON 数组（278/282 是这种）
    assert.equal(parseBaCommission('[{"name":"Online Sale","commission_val":"7%"}]'), "7%");
    // 数组里每项是 JSON 文本（4/282 是这种）
    assert.equal(parseBaCommission(['{"name":"Online Sale","commission_val":"2.1%"}']), "2.1%");
  });

  test("裸数字补 %，带 % 的原样保留", () => {
    assert.equal(parseBaCommission('[{"name":"Sale","commission_val":"8.4%"}]'), "8.4%");
    assert.equal(parseBaCommission('[{"name":"Sale","commission_val":5}]'), "5%");
  });

  test("0 / 空 / 非 JSON 一律返回空串，不抛异常", () => {
    assert.equal(parseBaCommission('[{"name":"Sale","commission_val":"0%"}]'), "");
    assert.equal(parseBaCommission('[{"name":"Sale","commission_val":""}]'), "");
    assert.equal(parseBaCommission("not json at all"), "");
    assert.equal(parseBaCommission(null), "");
    assert.equal(parseBaCommission([]), "");
  });

  test("占位行与正常行混排时取正常行", () => {
    const raw = '[{"name":"Contact for rates","commission_val":70},{"name":"Online Sale","commission_val":"3%"}]';
    assert.equal(parseBaCommission(raw), "3%");
  });

  test("按字符串逐字遍历的老 bug 不会复现（字符串不是被当数组拆开）", () => {
    // 若把字符串当数组遍历，第一个元素是 "["，parse 失败 → 结果为空。
    // 这里必须拿到 9%，说明是整串一次 parse 的。
    assert.equal(parseBaCommission('[{"name":"Sale","commission_val":"9%"}]'), "9%");
  });
});

describe("D-349 BA 商家字段摊平", () => {
  const row = {
    m_id: "600039",
    site_name: "Nano Bond",
    site_url: "https://nanobondus.com",
    site_logo_url: "https://cdn.example/logo.png",
    region: "US",
    adv_catagory: "Auto & Automotive",
    merchant_status: "active",
    tracking_url: "https://www.bonusarrive.com/link?c=4024&ad=600039",
    update_time: "2026-09-22 06:13:38",
    commissions: '[{"name":"Online Sale","commission_val":"7%"}]',
  };

  test("site_name 摊到 merchant_name（否则会落到域名兜底）", () => {
    const out = preNormalizeMerchantItem("BA", row);
    assert.equal(out.merchant_name, "Nano Bond");
    assert.notEqual(out.merchant_name, "nanobondus.com");
  });

  test("单数 region 摊到 support_region（通用链只认复数形式）", () => {
    assert.equal(preNormalizeMerchantItem("BA", row).support_region, "US");
  });

  test("拼错的 adv_catagory 与 site_logo_url 都要接上", () => {
    const out = preNormalizeMerchantItem("BA", row);
    assert.equal(out.category, "Auto & Automotive");
    assert.equal(out.logo_url, "https://cdn.example/logo.png");
  });

  test("merchant_status active/needapply → joined/not_joined", () => {
    assert.equal(preNormalizeMerchantItem("BA", row).relationship, "joined");
    assert.equal(
      preNormalizeMerchantItem("BA", { ...row, merchant_status: "needapply" }).relationship,
      "not_joined",
    );
  });
});

describe("D-349 QUK 商家字段摊平", () => {
  const row = {
    merchantId: 259,
    merchantName: "QVC - US",
    siteUrl: "https://qvc.com",
    commission: "0.7%",
    supportRegion: "US",
    channelList: [
      { channelId: 983, datetime: "2026-09-22 07:15:10", relationship: 1, trackingUrl: "https://click.quk.com/tracking?code=abc" },
    ],
  };

  test("camelCase merchantId 摊到 mid（通用链只有 merchant_id/mid/m_id/id）", () => {
    assert.equal(preNormalizeMerchantItem("QUK", row).mid, 259);
  });

  test("trackingUrl / datetime 从 channelList 里取出来", () => {
    const out = preNormalizeMerchantItem("QUK", row);
    assert.equal(out.tracking_url, "https://click.quk.com/tracking?code=abc");
    assert.equal(out.datetime, "2026-09-22 07:15:10");
    assert.equal(out.relationship, "joined");
  });

  test("多渠道时优先取已批准（relationship=1）的那条链接", () => {
    const multi = {
      ...row,
      channelList: [
        { channelId: 1, relationship: 3, trackingUrl: "https://click.quk.com/NOT_APPROVED" },
        { channelId: 983, relationship: 1, trackingUrl: "https://click.quk.com/APPROVED" },
      ],
    };
    assert.equal(preNormalizeMerchantItem("QUK", multi).tracking_url, "https://click.quk.com/APPROVED");
  });

  test("channelList 缺失/为空不抛异常，判为未加入", () => {
    assert.equal(preNormalizeMerchantItem("QUK", { ...row, channelList: [] }).relationship, "not_joined");
    assert.doesNotThrow(() => preNormalizeMerchantItem("QUK", { merchantId: 1 }));
  });
});

describe("D-349 点击接口错误判定", () => {
  // BA 的成功值由配置声明（successStatus:1），这里照生产调用方式传
  const BA_OK = PLATFORM_CLICK_CONFIG.BA.successStatus;

  test("BA 在配置里声明了 successStatus=1（不声明就判不出失败）", () => {
    assert.equal(BA_OK, 1);
  });

  test("BA 成功包 status:1 不判错", () => {
    assert.equal(clickErrorMessage("data", { status: 1, info: "success", data: { list: [] } }, BA_OK), null);
  });

  test("BA 失败包 status:0 + data:'' 必须判错（旧逻辑会静默吞掉）", () => {
    // data 是空字符串而非 null，且没有 code 字段——两道旧判定都漏
    const msg = clickErrorMessage("data", { status: 0, info: "Only 15 requests in 60 seconds", data: "" }, BA_OK);
    assert.equal(msg, "Only 15 requests in 60 seconds");
  });

  test("LH 的 status:0 是成功，不能被 BA 那条规则误伤", () => {
    // LH 未声明 successStatus，走旧口径：根级 list + status:0 = 正常
    assert.equal(PLATFORM_CLICK_CONFIG.LH.successStatus, undefined);
    assert.equal(clickErrorMessage("root", { status: 0, list: [] }, PLATFORM_CLICK_CONFIG.LH.successStatus), null);
  });

  test("QUK 成功码是 200 而不是 0", () => {
    assert.equal(clickErrorMessage("data", { code: "200", msg: "success", data: { list: [] } }), null);
  });

  test("QUK 错误文案在 msg 里（message 是空的）", () => {
    assert.equal(clickErrorMessage("data", { code: "1001", msg: "Invalid api key" }), "Invalid api key");
  });

  test("原有 SaaS 平台 code:0 成功 / 非 0 判错的口径不变", () => {
    assert.equal(clickErrorMessage("data", { code: "0", data: { list: [] } }), null);
    assert.equal(clickErrorMessage("data", { code: "1002", message: "boom" }), "boom");
  });
});

describe("D-349 平台配置落位", () => {
  test("QUK / BA 四套配置都挂上了（QUK 无打款，故不在支付表里）", () => {
    for (const p of ["QUK", "BA"]) {
      assert.ok(PLATFORM_API_CONFIG[p], `${p} 缺商家配置`);
      assert.ok(PLATFORM_TXN_CONFIG[p], `${p} 缺交易配置`);
      assert.ok(PLATFORM_CLICK_CONFIG[p], `${p} 缺点击配置`);
    }
  });

  test("QUK 商家必须带 relationship=1 且 pageSize 不超过服务端硬顶 100", () => {
    const c = PLATFORM_API_CONFIG.QUK;
    // 不带过滤会拉回全站 39 万家（39,539 页），这条是防线
    assert.equal(c.requiresRelationshipParam, true);
    assert.equal(c.relationshipValue, "1");
    assert.ok(c.maxSize <= 100, `pageSize 服务端硬顶 100，配了 ${c.maxSize} 只会白翻页`);
  });

  test("QUK 三个接口都要节流（15 次/60 秒是整个 Key 共享的）", () => {
    for (const cfg of [PLATFORM_API_CONFIG.QUK, PLATFORM_TXN_CONFIG.QUK, PLATFORM_CLICK_CONFIG.QUK]) {
      assert.ok((cfg.rateLimitMs ?? 0) >= 4000, `限流间隔 ${cfg.rateLimitMs} 不足 60/15=4000ms`);
    }
  });

  test("BA 三套配置都要声明 successStatus=1（漏一个，那一路的失败就被当空结果吞掉）", () => {
    assert.equal(PLATFORM_API_CONFIG.BA.successStatus, 1);
    assert.equal(PLATFORM_TXN_CONFIG.BA.successStatus, 1);
    assert.equal(PLATFORM_CLICK_CONFIG.BA.successStatus, 1);
  });

  test("除 BA 外没有平台声明 successStatus（它们的 status 是 {code,msg} 包装对象）", () => {
    // 这条是防误伤：LH 的成功标志是 status:0，若给它配上 successStatus:1 会把正常响应全判成失败
    for (const [table, name] of [
      [PLATFORM_API_CONFIG, "商家"],
      [PLATFORM_TXN_CONFIG, "交易"],
      [PLATFORM_CLICK_CONFIG, "点击"],
    ] as const) {
      for (const [code, cfg] of Object.entries(table)) {
        if (code === "BA") continue;
        assert.equal(
          (cfg as { successStatus?: number }).successStatus,
          undefined,
          `${name}配置 ${code} 不该声明 successStatus`,
        );
      }
    }
  });

  test("BA 商家走本地过滤（服务端没有 relationship 参数）", () => {
    const c = PLATFORM_API_CONFIG.BA;
    assert.equal(c.joinedFilterField, "merchant_status");
    assert.equal(c.joinedFilterValue, "active");
    // 服务端过滤不生效，若误设 assumeAllJoined 会把 2676 家未加入的也当成已加入入库
    assert.notEqual(c.assumeAllJoined, true);
  });

  test("BA 交易跨度上限 31 天 → 切片必须 ≤31", () => {
    assert.ok((PLATFORM_TXN_CONFIG.BA.maxDateSpanDays ?? 999) <= 31);
  });

  test("两个平台的点击窗口都是 1 天，且只收纯日期", () => {
    for (const p of ["QUK", "BA"]) {
      assert.ok(PLATFORM_CLICK_CONFIG[p].maxWindowHours <= 24);
      assert.equal(PLATFORM_CLICK_CONFIG[p].withTime, false);
    }
  });

  test("QUK 的 base 必须带 /openapi/（少这段全部 404）", () => {
    for (const cfg of [PLATFORM_API_CONFIG.QUK, PLATFORM_TXN_CONFIG.QUK, PLATFORM_CLICK_CONFIG.QUK]) {
      assert.match(cfg.url, /\/api\/v1\/openapi\/publisher\//);
    }
    // 商家是 camelCase、交易与点击是全小写——三者风格不一致，别照着一个推另一个
    assert.match(PLATFORM_API_CONFIG.QUK.url, /advertiserSearch$/);
    assert.match(PLATFORM_TXN_CONFIG.QUK.url, /transactiondetails$/);
    assert.match(PLATFORM_CLICK_CONFIG.QUK.url, /clickdetails$/);
  });

  test("BA 的 base 必须是 /slapi/（/sapi/ 是前端文档页路由，会 404）", () => {
    for (const cfg of [PLATFORM_API_CONFIG.BA, PLATFORM_TXN_CONFIG.BA, PLATFORM_CLICK_CONFIG.BA]) {
      assert.match(cfg.url, /\/slapi\/service\//);
      assert.doesNotMatch(cfg.url, /\/sapi\//);
    }
  });
});
