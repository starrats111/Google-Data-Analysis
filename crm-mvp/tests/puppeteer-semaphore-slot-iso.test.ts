/**
 * SLOT-ISO-01 车道配额分离（2026-08-15 07 指令）+ D-298 双档配额（2026-08-28 07 指令）。
 *
 * 为什么这条必须有测试：这是并发调度的硬分区，两个方向坏掉都是**静默**的：
 *   - 分区失效（换链接仍可借共享池）：高峰时段换链接批量把 3 槽占满，广告生成的
 *     sitelinks 验证/主爬排队 30s+，员工感知「生成很慢」——正是 2026-08-15 上午
 *     exchangeQ 积压 70+ 的现场。
 *   - 分区过度（某条车道被压到 0）：该车道彻底饿死且不抛任何错。2026-08-28 事故即此形态——
 *     换链接被钉死在 1 并发且不分工作日，09:00 一到就 400 次/小时抢不到槽，
 *     补货连续 8 小时零产出，最后 101 个系列被误报 no_tracking_stuck。
 *
 * 测试把时段/星期都用环境变量钉死，不依赖跑测试的时刻：
 *   EXCHANGE_ISOLATION_WORK_HOURS "0-24"=恒高峰、"0-0"=恒低谷（end 开区间）
 *   EXCHANGE_ISOLATION_WORK_DAYS  "0-6"=每天都算工作日（闭区间），避免周末跑测试时挂掉
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  acquireExchangeSlot,
  acquireMainCrawlSlot,
  acquirePuppeteerSlot,
  puppeteerSemaphoreStats,
  type SlotRelease,
} from "../src/lib/puppeteer-semaphore";

const held: SlotRelease[] = [];
function track(r: SlotRelease): SlotRelease {
  held.push(r);
  return r;
}

afterEach(() => {
  while (held.length) held.pop()!();
  delete process.env.EXCHANGE_ISOLATION_WORK_HOURS;
  delete process.env.EXCHANGE_ISOLATION_WORK_DAYS;
  delete process.env.EXCHANGE_SLOTS_PEAK;
  delete process.env.EXCHANGE_SLOTS_OFFPEAK;
  delete process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF;
  const s = puppeteerSemaphoreStats();
  assert.equal(s.active, 0, "用例结束应无残留占用");
  assert.equal(s.activeExchangeTotal, 0, "换链接计数应归零");
});

/** 钉成恒高峰（工作日白天档）：换链接 1 / 广告 2 */
function peakAlways() {
  process.env.EXCHANGE_ISOLATION_WORK_HOURS = "0-24";
  process.env.EXCHANGE_ISOLATION_WORK_DAYS = "0-6";
  delete process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF;
}

/** 钉成恒低谷（夜间/周末档）：换链接 2 / 广告 1 */
function offpeakAlways() {
  process.env.EXCHANGE_ISOLATION_WORK_HOURS = "0-0";
  process.env.EXCHANGE_ISOLATION_WORK_DAYS = "0-6";
  delete process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF;
}

async function expectImmediate(p: Promise<SlotRelease>, msg: string) {
  const r = await p.catch((e: Error) => e);
  assert.ok(typeof r === "function", `${msg}（实际被拒：${(r as Error)?.message}）`);
  return track(r as SlotRelease);
}

async function expectRejected(p: Promise<SlotRelease>, msg: string) {
  const r = await p.catch((e: Error) => e);
  if (typeof r === "function") {
    track(r as SlotRelease);
    assert.fail(msg);
  }
  assert.match((r as Error).message, /slot timeout/i, msg);
}

/**
 * 2026-09-14：配额一律向实现查询，不写死 1/2/3。
 *
 * 起因：D-335 因内存实测把 MAX_PUPPETEER_SLOTS 3→2，本文件 15 条断言集体挂掉，
 * 而失败原因全是「测试写死了 MAX=3 时的配额数字」。写死数字让这批测试在容量调整时
 * 集体误报，反过来掩盖真正的调度回归——正是它们本该拦住的那类问题。
 *
 * ⚠️ MAX=2 时 D-298 双档配额**整体塌平**：夹紧区间是 [1, MAX-1] = [1, 1]，
 * 于是高峰与低谷都是 换链接 1 / 广告 1，EXCHANGE_SLOTS_PEAK/OFFPEAK 无论设成
 * 0、3 还是非法值都没有任何效果（实测确认）。D-298 那句「白天让广告、夜间让换链接」
 * 在 MAX=2 下不成立，不是配置错了，是池子太小分不出两档。
 * 下面 `quotasCollapsed` 显式钉住这个事实：等哪天 MAX 回到 ≥3，双档差异会自动恢复，
 * 该断言也会自动切回「两档必须不同」那一支，不需要再改测试。
 */
function quotasFor(mode: "peak" | "offpeak") {
  mode === "peak" ? peakAlways() : offpeakAlways();
  const s = puppeteerSemaphoreStats();
  return {
    exchange: s.quotaExchange,
    ads: s.quotaAds,
    max: s.max,
    // normal 的**有效**上限随档位变，不等于 stats.normalMax（那是 D-027 的静态常量
    // MAX-预留）。镜像实现里的 normalCap()：ads 预算 >1 时给主爬留 1 个预留，
    // 恰好为 1 时不留（否则 normal 恒为 0 被饿死）。
    normalCap: s.quotaAds > s.reservedMainCrawl ? s.quotaAds - s.reservedMainCrawl : s.quotaAds,
  };
}
const PEAK = quotasFor("peak");
const OFFPEAK = quotasFor("offpeak");
// quotasFor 会写 env 钉档位，模块级探测完必须清掉，否则污染第一个用例的初始状态
delete process.env.EXCHANGE_ISOLATION_WORK_HOURS;
delete process.env.EXCHANGE_ISOLATION_WORK_DAYS;
/** 池子小到分不出两档（MAX ≤ 2）时两档配额相同 */
const quotasCollapsed = PEAK.exchange === OFFPEAK.exchange && PEAK.ads === OFFPEAK.ads;

/** 连续申请 n 个槽，全部必须立即拿到 */
async function fillWith(
  acquire: (ms: number) => Promise<SlotRelease>,
  n: number,
  label: string,
) {
  for (let i = 1; i <= n; i++) {
    await expectImmediate(acquire(50), `${label} 第 ${i}/${n} 个`);
  }
}

describe("高峰档（工作日白天）：广告 2 / 换链接 1", () => {
  test(`换链接并发封顶 quotaExchange(${PEAK.exchange})，超出的被拒（哪怕池子还有空槽）`, async () => {
    peakAlways();
    await fillWith(acquireExchangeSlot, PEAK.exchange, "换链接");
    assert.equal(
      puppeteerSemaphoreStats().active,
      PEAK.exchange,
      `池子明明还有 ${PEAK.max - PEAK.exchange} 个空槽`,
    );
    await expectRejected(
      acquireExchangeSlot(50),
      `第 ${PEAK.exchange + 1} 个换链接必须被拒——不得再借弹性/预留`,
    );
  });

  test(`换链接占着专属槽时，广告链路（normal+主爬）仍能拿满自己的 ${PEAK.ads} 槽`, async () => {
    peakAlways();
    await fillWith(acquireExchangeSlot, PEAK.exchange, "换链接占专属槽");
    // 先 normal 后 main：normal 授予时 ads 池空（预留完整），main 用掉预留——三车道共存。
    // ads 预算为 1 时不再留预留（见 normalCap），此时 normal 就吃掉那 1 槽，主爬没有余量。
    await fillWith(acquirePuppeteerSlot, PEAK.normalCap, "normal（sitelinks 兜底）");
    const mainRoom = PEAK.ads - PEAK.normalCap;
    if (mainRoom > 0) {
      await fillWith(acquireMainCrawlSlot, mainRoom, "主爬（用预留）");
    }
    assert.equal(
      puppeteerSemaphoreStats().active,
      PEAK.exchange + PEAK.ads,
      "各条车道应恰好占满自己的配额",
    );
  });

  test(`广告侧吃不掉换链接的专属槽（ads 封顶 ${PEAK.ads}），换链接随到随有`, async () => {
    peakAlways();
    await fillWith(acquireMainCrawlSlot, PEAK.ads, "主爬");
    await expectRejected(
      acquireMainCrawlSlot(50),
      `第 ${PEAK.ads + 1} 个主爬必须被拒——那是换链接的专属槽`,
    );
    await expectRejected(acquirePuppeteerSlot(50), "normal 同样不得越界");
    await expectImmediate(acquireExchangeSlot(50), "换链接的专属槽必须还空着、随到随有");
  });

  test("normal 在 ads 池内仍给主爬留预留（D-027 语义不丢）", async () => {
    peakAlways();
    await fillWith(acquirePuppeteerSlot, PEAK.normalCap, "normal");
    await expectRejected(
      acquirePuppeteerSlot(50),
      `normal 第 ${PEAK.normalCap + 1} 个必须被拒——ads 池内要给主爬留预留`,
    );
    // ads 预算降到 1 时按设计不再留预留（normalCap），此时预留槽已被 normal 吃掉，
    // 主爬拿不到是**预期行为**，不是回归；D-027 的「主爬随到随有」只在 ads ≥2 时成立。
    if (PEAK.ads > PEAK.normalCap) {
      await expectImmediate(acquireMainCrawlSlot(50), "主爬到达即有槽");
    } else {
      await expectRejected(
        acquireMainCrawlSlot(50),
        `ads 预算只剩 ${PEAK.ads} 时不留预留，主爬需排队（设计取舍，见 normalCap）`,
      );
    }
  });

  test("换链接释放专属槽后，排队中的换链接被唤醒接棒", async () => {
    peakAlways();
    const first = await expectImmediate(acquireExchangeSlot(200), "第 1 个换链接");
    let secondGot = false;
    const secondP = acquireExchangeSlot(2000).then((rel) => {
      secondGot = true;
      return track(rel);
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(secondGot, false, "专属槽被占时第 2 个换链接应在排队");
    first();
    await secondP;
    assert.equal(secondGot, true, "释放后排队中的换链接应接棒");
  });
});

describe("D-298 低谷档（夜间 / 周末）：换链接 2 / 广告 1", () => {
  test(`换链接拿到 quotaExchange(${OFFPEAK.exchange}) 槽，超出的被拒`, async () => {
    offpeakAlways();
    await fillWith(acquireExchangeSlot, OFFPEAK.exchange, "换链接");
    assert.equal(puppeteerSemaphoreStats().active, OFFPEAK.exchange);
    await expectRejected(
      acquireExchangeSlot(50),
      `第 ${OFFPEAK.exchange + 1} 个越界：余下 ${OFFPEAK.ads} 槽留给广告`,
    );
  });

  test("低谷档应比高峰给换链接更多槽——MAX ≤ 2 时两档必然塌平", async () => {
    if (quotasCollapsed) {
      // 这不是配置错误：夹紧区间 [1, MAX-1] 在 MAX=2 时只剩 [1,1]，两档无从区分。
      assert.equal(
        OFFPEAK.exchange,
        PEAK.exchange,
        "MAX ≤ 2：两档配额相同是数学必然（见文件头注释）",
      );
      assert.equal(PEAK.max, 2, "塌平只应发生在 MAX=2；MAX 更大却塌平说明夹紧逻辑坏了");
      return;
    }
    assert.ok(
      OFFPEAK.exchange > PEAK.exchange,
      `低谷档换链接配额(${OFFPEAK.exchange})必须大于高峰(${PEAK.exchange})——D-298 的核心意图`,
    );
    assert.ok(OFFPEAK.ads < PEAK.ads, "对应地，低谷档广告配额应小于高峰");
  });

  test("广告配额绝不为 0——主爬随到随有", async () => {
    offpeakAlways();
    await fillWith(acquireExchangeSlot, OFFPEAK.exchange, "换链接");
    assert.ok(OFFPEAK.ads >= 1, "广告侧任何档位都不许被配成 0");
    await expectImmediate(acquireMainCrawlSlot(50), "广告的槽必须还在，不能被换链接吃掉");
    assert.equal(puppeteerSemaphoreStats().active, OFFPEAK.exchange + 1);
  });

  test("广告预算只剩 1 时不再给主爬预留，否则 normal 恒为 0 被饿死", async () => {
    offpeakAlways();
    await fillWith(acquirePuppeteerSlot, OFFPEAK.normalCap, "normal（预算 1 时不留预留）");
    await expectRejected(
      acquirePuppeteerSlot(50),
      `normal 只有 ${OFFPEAK.normalCap} 个，第 ${OFFPEAK.normalCap + 1} 个越界`,
    );
  });

  test("统计口径暴露当前档位与配额", async () => {
    offpeakAlways();
    const s = puppeteerSemaphoreStats();
    assert.equal(s.quotaProfile, "offpeak");
    assert.equal(s.quotaExchange, OFFPEAK.exchange);
    assert.equal(s.quotaAds, OFFPEAK.ads);
    assert.equal(s.quotaExchange + s.quotaAds, s.max, "两条车道配额之和应恰好等于全池");
    peakAlways();
    const p = puppeteerSemaphoreStats();
    assert.equal(p.quotaProfile, "peak");
    assert.equal(p.quotaExchange, PEAK.exchange);
    assert.equal(p.quotaAds, PEAK.ads);
    assert.equal(p.quotaExchange + p.quotaAds, p.max, "高峰档同样应铺满全池");
  });
});

describe("D-298 档位判定与配额夹紧", () => {
  test("周末整天走低谷：工作日区间排除周六周日", async () => {
    // 把工作日钉成「只有周三」(3-3)，再把时段开满——非周三的任何一天都必须落低谷。
    process.env.EXCHANGE_ISOLATION_WORK_HOURS = "0-24";
    process.env.EXCHANGE_ISOLATION_WORK_DAYS = "3-3";
    delete process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF;
    const beijingDay = new Date(Date.now() + 8 * 3600_000).getUTCDay();
    const expected = beijingDay === 3 ? "peak" : "offpeak";
    assert.equal(puppeteerSemaphoreStats().quotaProfile, expected, "档位应只看北京时间的星期");
  });

  test("配额被配成 0 时夹到 1——任何一条车道都不许饿死", async () => {
    offpeakAlways();
    process.env.EXCHANGE_SLOTS_OFFPEAK = "0";
    const s = puppeteerSemaphoreStats();
    assert.equal(s.quotaExchange, 1, "0 必须夹成 1");
    assert.equal(s.quotaAds, s.max - 1, "余下的全给广告");
    await expectImmediate(acquireExchangeSlot(50), "夹紧后换链接仍拿得到槽");
  });

  test("配额被配成满池时夹到 MAX-1——广告侧同样不许饿死", async () => {
    offpeakAlways();
    const { max } = puppeteerSemaphoreStats();
    process.env.EXCHANGE_SLOTS_OFFPEAK = String(max + 1); // 故意超过全池
    const s = puppeteerSemaphoreStats();
    assert.equal(s.quotaExchange, max - 1, `超出全池的值必须夹成 MAX-1(${max - 1})`);
    assert.equal(s.quotaAds, 1, "广告至少留 1");
  });

  test("非法配额值回退默认，不至于把池子配没", async () => {
    offpeakAlways();
    process.env.EXCHANGE_SLOTS_OFFPEAK = "abc";
    const s = puppeteerSemaphoreStats();
    assert.equal(s.quotaExchange, OFFPEAK.exchange, "非法值应回退低谷默认（再经夹紧）");
    assert.ok(s.quotaExchange >= 1 && s.quotaAds >= 1, "回退后两条车道都不为 0");
  });
});

describe("回滚开关", () => {
  test("PUPPETEER_EXCHANGE_ISOLATION_OFF=1 退回 D-172/D-199 共享池", async () => {
    process.env.EXCHANGE_ISOLATION_WORK_HOURS = "0-24";
    process.env.EXCHANGE_ISOLATION_WORK_DAYS = "0-6";
    process.env.PUPPETEER_EXCHANGE_ISOLATION_OFF = "1";
    const { max } = puppeteerSemaphoreStats();
    // 分区回滚后是 D-172/D-199 共享池：换链接走快车道 → 弹性 → 借预留，可占满全池
    await fillWith(acquireExchangeSlot, max, "共享池下换链接");
    assert.equal(puppeteerSemaphoreStats().active, max, "共享池下换链接可占满全池");
    assert.equal(puppeteerSemaphoreStats().quotaProfile, "off");
  });
});
