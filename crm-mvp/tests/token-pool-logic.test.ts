import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  remainingQuotaOf,
  isTokenUsableForMcc,
  isDailyQuotaExhausted,
  type TokenQuotaMeta,
} from "../src/lib/google-ads/token-pool-logic";

function meta(overrides: Partial<TokenQuotaMeta> = {}): TokenQuotaMeta {
  return {
    healthStatus: "ok",
    mccAccess: {},
    detectedQuota: null,
    dailyQuota: 15000,
    todayRequests: 0,
    ...overrides,
  };
}

describe("remainingQuotaOf", () => {
  it("无元数据（环境变量/MCC 自带凭证）返回 -1 兜底", () => {
    assert.equal(remainingQuotaOf(undefined), -1);
  });

  it("未触顶过时用组长预设额度", () => {
    assert.equal(remainingQuotaOf(meta({ dailyQuota: 15000, todayRequests: 4000 })), 11000);
  });

  it("实测额度优先于组长预设", () => {
    assert.equal(
      remainingQuotaOf(meta({ detectedQuota: 10000, dailyQuota: 15000, todayRequests: 4000 })),
      6000,
    );
  });

  it("超用时可为负数（排序时自然靠后）", () => {
    assert.equal(remainingQuotaOf(meta({ detectedQuota: 100, todayRequests: 150 })), -50);
  });
});

describe("isTokenUsableForMcc", () => {
  it("实时 denied 对立即生效，优先于一切", () => {
    assert.equal(isTokenUsableForMcc(meta(), true, "1234567890"), false);
  });

  it("无元数据视为可用（不设限）", () => {
    assert.equal(isTokenUsableForMcc(undefined, false, "1234567890"), true);
  });

  it("invalid 健康状态被踢出", () => {
    assert.equal(isTokenUsableForMcc(meta({ healthStatus: "invalid" }), false, "1"), false);
  });

  it("limited（每日额度耗尽）不直接踢出，由冷却与额度判定控制", () => {
    assert.equal(isTokenUsableForMcc(meta({ healthStatus: "limited" }), false, "1"), true);
  });

  it("对指定 MCC denied 的凭证跳过，其它 MCC 不受影响", () => {
    const m = meta({ mccAccess: { "111": "denied", "222": "ok" } });
    assert.equal(isTokenUsableForMcc(m, false, "111"), false);
    assert.equal(isTokenUsableForMcc(m, false, "222"), true);
    assert.equal(isTokenUsableForMcc(m, false, "333"), true);
  });

  it("当日用量触顶实测额度后跳过；仅组长预设额度不触发跳过", () => {
    assert.equal(isTokenUsableForMcc(meta({ detectedQuota: 100, todayRequests: 100 }), false, "1"), false);
    assert.equal(isTokenUsableForMcc(meta({ dailyQuota: 100, todayRequests: 200 }), false, "1"), true);
  });
});

describe("isDailyQuotaExhausted", () => {
  it("RESOURCE_EXHAUSTED + 长 retryDelay 判为每日耗尽", () => {
    assert.equal(isDailyQuotaExhausted(86400, "RESOURCE_EXHAUSTED"), true);
  });

  it("RESOURCE_EXHAUSTED + 错误体提到 daily/quota 也判为每日耗尽", () => {
    assert.equal(isDailyQuotaExhausted(30, "RESOURCE_EXHAUSTED: daily limit reached"), true);
    assert.equal(isDailyQuotaExhausted(undefined, "RESOURCE_EXHAUSTED quota exceeded"), true);
  });

  it("RESOURCE_TEMPORARILY_EXHAUSTED（短时 QPS 限流）不算每日耗尽", () => {
    assert.equal(isDailyQuotaExhausted(86400, "RESOURCE_TEMPORARILY_EXHAUSTED"), false);
  });

  it("短 retryDelay 且错误体无每日配额字样不算（普通 QPS 限流）", () => {
    assert.equal(isDailyQuotaExhausted(30, "RESOURCE_EXHAUSTED: too many requests"), false);
  });

  it("空错误体不算", () => {
    assert.equal(isDailyQuotaExhausted(86400, undefined), false);
    assert.equal(isDailyQuotaExhausted(86400, ""), false);
  });
});
