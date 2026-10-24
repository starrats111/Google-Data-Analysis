import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSameUrl } from "@/lib/link-resolver/tracker";

// D-337B：「取链接」把「填成商家官网」单列成一种提示。
//
// 判定信号是「整条链一步没跳，终点就是输入本身」——真联盟链接必然至少跳一次到广告主域名，
// 而商家官网上没有联盟跳板，跟链只会原样回来。route 里用 tracker 的 isSameUrl 做这个判定。
//
// 这里锁两件事：
//   1) 两个真实事故案例必须判成「商家官网」（否则提示不会出现，问题照旧）；
//   2) 凡是「真发生过跳转」的形态必须判成不同 —— 提示语明说了「没有发生任何跳转」，
//      误判会让文案变成假话，且会把一条正常的联盟链接骂成官网。
//
// 之所以值得留常驻测试：判定完全依赖 URL 等价性的边界，而这些边界（要不要忽略 hash、
// http↔https 算不算跳转）是容易被后人"顺手统一一下"改坏的地方，改坏了没有任何报错。
describe("D-337B 取链接：识别用户填了商家官网而非联盟追踪链接", () => {
  it("判成商家官网：整条链没跳，终点 === 输入（两个真实案例）", () => {
    // yz08 2026-09-15：输入 New Balance 沙特官网 + KW，返回同一 URL、无追踪参数
    assert.equal(
      isSameUrl("https://www.newbalance.com.sa/en/", "https://www.newbalance.com.sa/en/"),
      true,
    );
    // wj10 2026-09-14：Bitdefender 官网，且这条还入了库，导致该系列被误报链接失效
    assert.equal(isSameUrl("https://www.bitdefender.com/", "https://www.bitdefender.com/"), true);
  });

  it("判成商家官网：只是同一个 URL 的等价写法（末尾斜杠、域名大小写、hash）", () => {
    assert.equal(isSameUrl("https://a.com/en/", "https://a.com/en"), true, "末尾斜杠");
    assert.equal(isSameUrl("https://WWW.A.com/en/", "https://www.a.com/en/"), true, "域名大小写");
    assert.equal(isSameUrl("https://a.com/en#top", "https://a.com/en"), true, "hash 不发给服务器");
  });

  it("不判成商家官网：真联盟链接跳到了广告主域名", () => {
    // 库里 077-LH1-NewBalance-SA-0807 用的就是这个形态
    assert.equal(
      isSameUrl(
        "https://www.newbalance.com.sa/en/?utm_source=lh",
        "https://www.linkhaitao.com/index.php?mod=lhdeal&track=38e96",
      ),
      false,
    );
  });

  it("不判成商家官网：这些差异都意味着真跳过一次，文案不能说『没有任何跳转』", () => {
    assert.equal(isSameUrl("https://a.com/x", "http://a.com/x"), false, "http→https 是一次跳转");
    assert.equal(isSameUrl("https://www.a.com/x", "https://a.com/x"), false, "补 www 是一次跳转");
    assert.equal(isSameUrl("https://a.com/x?utm=1", "https://a.com/x"), false, "多出查询串");
    assert.equal(isSameUrl("https://a.com/x", "https://a.com/X"), false, "路径大小写敏感");
    assert.equal(isSameUrl("https://a.com:8443/x", "https://a.com/x"), false, "端口不同");
  });

  it("URL 解析失败时退回字符串比较，不抛异常", () => {
    // route 已用正则挡住非 http(s) 输入，这里只保证 isSameUrl 本身不炸
    assert.equal(isSameUrl("not-a-url", "not-a-url"), true);
    assert.equal(isSameUrl("not-a-url", "https://a.com"), false);
  });
});
