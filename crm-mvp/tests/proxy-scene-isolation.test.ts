/**
 * D-271 代理场景隔离契约测试。
 *
 * 为什么这条必须有测试：换链接与 AI 爬取共用 kyads_proxies 表后，隔离全靠选路 where 片段。
 * 2026-07-13 事故实证：AI 爬虫一旦混进换链接池，会把 kookeey 粘性会话并发额度挤爆
 * （Socks5 Authentication failed 连锁），而且是静默劣化——必须用测试把过滤契约锁死：
 *   - 换链接选路：认「换链接」与 null（历史行），绝不认「AI爬取」；
 *   - AI 选路：只认显式「AI爬取」，且按协议分流，绝不落到换链接行。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  SCENE_EXCHANGE,
  SCENE_AI,
  exchangeSceneWhere,
  aiSceneWhere,
  isExchangeSceneRow,
} from "../src/lib/suffix-engine/proxy-scene";

describe("D-271 场景过滤契约", () => {
  test("换链接 where：包含 换链接 与 null（历史行），绝不包含 AI爬取", () => {
    const where = exchangeSceneWhere();
    const allowed = where.OR.map((c) => c.usage_scene);
    assert.ok(allowed.includes(SCENE_EXCHANGE), "必须包含 换链接");
    assert.ok(allowed.includes(null), "必须包含 null（D-254 前的存量行）");
    assert.ok(!allowed.includes(SCENE_AI), "绝不允许包含 AI爬取——写漏=7-13 并发额度事故重演");
  });

  test("AI where：只认显式 AI爬取，且强制协议过滤", () => {
    for (const proto of ["socks5", "http"] as const) {
      const where = aiSceneWhere(proto);
      assert.equal(where.usage_scene, SCENE_AI);
      assert.equal(where.proxy_type, proto);
    }
  });

  test("两场景值互斥（路由键不允许重叠）", () => {
    assert.notEqual(SCENE_EXCHANGE, SCENE_AI);
  });

  test("isExchangeSceneRow：AI 行剔除、换链接/null/未知标签保留（告警聚合口径）", () => {
    assert.equal(isExchangeSceneRow({ scene: SCENE_AI }), false);
    assert.equal(isExchangeSceneRow({ usage_scene: SCENE_AI }), false);
    assert.equal(isExchangeSceneRow({ scene: SCENE_EXCHANGE }), true);
    assert.equal(isExchangeSceneRow({ scene: null }), true, "历史 null 行按换链接对待");
    // usage_scene 显式为 null（DB 原始行）也按换链接对待，不能误走 scene 分支
    assert.equal(isExchangeSceneRow({ usage_scene: null, scene: SCENE_AI }), true);
  });
});
