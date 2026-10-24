/**
 * D-345 交易行的联盟账号不可信时的佣金归属
 *
 * 背景：一个物理联盟号可以配多把 api_key，在 CRM 里变成多条 platform_connections；
 * 而 affiliate_transactions.platform_connection_id 只在 create 时写入，记的是
 * 「哪把 key 先抓到这条」。于是「花钱的系列挂 A 号、交易挂 B 号」很常见（生产 382 组）。
 *
 * 口径：strict（商家|账号）时间轴只在「确实是最近一次为该商家花钱的账号」时保持权威；
 * 回溯不到、或商家级时间轴上有更近的花费日时，让位给商家级时间轴。
 * 同商家被两个账号同期投放（两条时间轴最近花费日相同）时仍按 strict 走，D-168 不受影响。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAttributionIndex,
  resolveAttributionTarget,
  type AttributionCampaign,
  type AttributionSpendDay,
} from "../src/lib/commission-attribution";

const MERCHANT = "m1";
const CONN_A = "90";  // aura-bloom：真正花钱的号
const CONN_B = "274"; // quiblo：交易被挂到的号（同一个 publisher）

const camp = (id: string, conn: string | null): AttributionCampaign => ({
  id,
  userMerchantId: MERCHANT,
  platformConnectionId: conn,
});
const spend = (campaignId: string, date: string, cost: number): AttributionSpendDay => ({
  campaignId, date, cost,
});

/** 不带代表行兜底地解析（只考察时间轴本身） */
function resolve(
  campaigns: AttributionCampaign[],
  spendDays: AttributionSpendDay[],
  connId: string | null,
  txnDate: string,
  fallback: Map<string, string> = new Map(),
): string | null {
  return resolveAttributionTarget(
    buildAttributionIndex(campaigns, spendDays),
    fallback,
    MERCHANT,
    connId,
    txnDate,
  );
}

describe("D-345 交易挂在 B 号、花钱的系列在 A 号", () => {
  // 生产还原（wj10 / CLEARSTEM 8005453）：
  // 928 挂 A 号，6/29 起一直在投；1272 挂 B 号，只在 8/11~8/14 投过一点就停了。
  const cs = [camp("928", CONN_A), camp("1272", CONN_B)];
  const days = [
    spend("928", "2026-06-29", 3),
    spend("928", "2026-08-12", 5),
    spend("928", "2026-09-20", 7),
    spend("1272", "2026-08-11", 2),
    spend("1272", "2026-08-14", 1),
  ];

  it("9 月的交易归到真正在投的 928，而不是 8 月就停投的 1272", () => {
    assert.equal(resolve(cs, days, CONN_B, "2026-09-20"), "928");
  });

  it("B 号时间轴过期就让位，A 号更近的花费日说话", () => {
    // 8/20：B 号最后花费 8/14，A 号最后花费 8/12 —— B 号更近，仍归 B
    assert.equal(resolve(cs, days, CONN_B, "2026-08-20"), "1272");
    // 9/20：A 号 9/20 更近 —— 让位给 A
    assert.equal(resolve(cs, days, CONN_B, "2026-09-20"), "928");
  });

  it("交易挂 A 号时照常归 A", () => {
    assert.equal(resolve(cs, days, CONN_A, "2026-09-20"), "928");
  });
});

describe("D-345 strict 时间轴回溯不到：别整坨投给代表行", () => {
  // 生产还原（wj10 / Lenovo Peru 8026722）：
  // 1398 挂 A 号，9/1 起投；1488 挂 B 号，9/15 才第一次花钱。
  // 9/1~9/14 的交易挂在 B 号上，B 号时间轴回溯不到 → 旧代码退到代表行，
  // 整个 9 月的 $988.60 全投给 1488，其中 9/1~9/14 的部分其实是 1398 打出来的。
  const cs = [camp("1398", CONN_A), camp("1488", CONN_B)];
  const days = [
    spend("1398", "2026-09-01", 9),
    spend("1398", "2026-09-10", 8),
    spend("1488", "2026-09-15", 4),
  ];

  it("回溯不到本账号的花费时，走商家级时间轴而不是代表行", () => {
    // 带上代表行兜底：证明优先走时间轴，不会落到 1488 身上
    const fb = new Map([[`${MERCHANT}:${CONN_B}`, "1488"], [MERCHANT, "1488"]]);
    assert.equal(resolve(cs, days, CONN_B, "2026-09-05", fb), "1398");
    assert.equal(resolve(cs, days, CONN_B, "2026-09-14", fb), "1398");
  });

  it("B 号自己开始花钱之后，当天起归 B", () => {
    assert.equal(resolve(cs, days, CONN_B, "2026-09-15"), "1488");
    assert.equal(resolve(cs, days, CONN_B, "2026-09-16"), "1488");
  });

  it("两条时间轴都回溯不到时才退回代表行兜底", () => {
    const fb = new Map([[`${MERCHANT}:${CONN_B}`, "1488"]]);
    assert.equal(resolve(cs, days, CONN_B, "2026-08-31", fb), "1488");
  });
});

describe("D-345 不回退 D-168：同商家被两个账号同期投放时仍按账号精确投行", () => {
  const cs = [camp("A1", CONN_A), camp("B1", CONN_B)];
  const days = [
    spend("A1", "2026-09-10", 5),
    spend("B1", "2026-09-10", 50), // 同一天两个号都在投，B 花得更多
  ];

  it("两条时间轴最近花费日相同 → 各归各号，不被「商家级花费最高」抢走", () => {
    assert.equal(resolve(cs, days, CONN_A, "2026-09-12"), "A1");
    assert.equal(resolve(cs, days, CONN_B, "2026-09-12"), "B1");
  });
});

describe("D-345 单账号商家（87% 的情况）完全不受影响", () => {
  const cs = [camp("only", CONN_A)];
  const days = [spend("only", "2026-09-01", 5), spend("only", "2026-09-09", 6)];

  it("照常按最近花费日归属", () => {
    assert.equal(resolve(cs, days, CONN_A, "2026-09-15"), "only");
  });

  it("交易没带账号时走商家级时间轴", () => {
    assert.equal(resolve(cs, days, null, "2026-09-15"), "only");
  });
});
