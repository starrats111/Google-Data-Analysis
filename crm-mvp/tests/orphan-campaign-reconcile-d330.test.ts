import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  splitOrphanCampaigns,
  type DeadCidPair,
  type ReconcileCandidate,
} from "../src/lib/google-ads/orphan-campaign-reconcile";

/**
 * D-330：CID 撤销后其旗下系列永久从 Sheet CampaignInfo 消失，Sheet 驱动的状态同步
 * （`if (!sheetRow) continue`）会永久跳过它们 → CRM 冻结在「已启用」，点同步多次无效。
 * 这里测的是回停对账的纯判定部分。
 */

const pair = (mcc: number, cid: string): DeadCidPair => ({ mcc_id: BigInt(mcc), customer_id: cid });

const camp = (
  id: number,
  mcc: number | null,
  cid: string | null,
  googleStatus: string | null,
): ReconcileCandidate => ({
  id: BigInt(id),
  mcc_id: mcc == null ? null : BigInt(mcc),
  customer_id: cid,
  google_status: googleStatus,
});

describe("splitOrphanCampaigns", () => {
  test("CID 已撤销且仍显示 ENABLED → 进回停组（本次要修的主场景）", () => {
    const r = splitOrphanCampaigns([pair(1, "1234567890")], [camp(100, 1, "1234567890", "ENABLED")]);
    assert.deepEqual(r.toPause.map((c) => c.id), [BigInt(100)]);
    assert.deepEqual(r.toAlign, []);
  });

  test("Google 侧已 PAUSED 但内部状态漂移 → 进拉平组，不覆盖 paused_at", () => {
    const r = splitOrphanCampaigns([pair(1, "1234567890")], [camp(101, 1, "1234567890", "PAUSED")]);
    assert.deepEqual(r.toPause, []);
    assert.deepEqual(r.toAlign.map((c) => c.id), [BigInt(101)]);
  });

  test("CID 正常（不在 deadPairs）→ 一个都不动", () => {
    const r = splitOrphanCampaigns([pair(1, "1234567890")], [camp(102, 1, "9999999999", "ENABLED")]);
    assert.deepEqual(r.toPause, []);
    assert.deepEqual(r.toAlign, []);
  });

  test("同一 CID 挂在不同 MCC 下：只命中被撤销那个 MCC 的系列", () => {
    const r = splitOrphanCampaigns(
      [pair(1, "1234567890")],
      [camp(103, 1, "1234567890", "ENABLED"), camp(104, 2, "1234567890", "ENABLED")],
    );
    assert.deepEqual(r.toPause.map((c) => c.id), [BigInt(103)]);
  });

  test("带横杠的 customer_id 归一后仍能匹配", () => {
    const r = splitOrphanCampaigns([pair(1, "1234567890")], [camp(105, 1, "123-456-7890", "ENABLED")]);
    assert.deepEqual(r.toPause.map((c) => c.id), [BigInt(105)]);
  });

  test("customer_id / mcc_id 缺失的行一律跳过（无法确定归属，不瞎停）", () => {
    const r = splitOrphanCampaigns(
      [pair(1, "1234567890")],
      [camp(106, 1, null, "ENABLED"), camp(107, null, "1234567890", "ENABLED")],
    );
    assert.deepEqual(r.toPause, []);
    assert.deepEqual(r.toAlign, []);
  });

  test("google_status 大小写/空值：小写 enabled 视为在投，null 归拉平组", () => {
    const r = splitOrphanCampaigns(
      [pair(1, "1234567890")],
      [camp(108, 1, "1234567890", "enabled"), camp(109, 1, "1234567890", null)],
    );
    assert.deepEqual(r.toPause.map((c) => c.id), [BigInt(108)]);
    assert.deepEqual(r.toAlign.map((c) => c.id), [BigInt(109)]);
  });

  test("deadPairs 为空 → 空结果（幂等：没有被撤销的 CID 就不该有任何写入）", () => {
    const r = splitOrphanCampaigns([], [camp(110, 1, "1234567890", "ENABLED")]);
    assert.deepEqual(r.toPause, []);
    assert.deepEqual(r.toAlign, []);
  });

  test("多个撤销 CID + 混合状态：分组互斥且覆盖全部命中行", () => {
    const r = splitOrphanCampaigns(
      [pair(1, "1111111111"), pair(1, "2222222222")],
      [
        camp(201, 1, "1111111111", "ENABLED"),
        camp(202, 1, "2222222222", "PAUSED"),
        camp(203, 1, "3333333333", "ENABLED"), // CID 正常
      ],
    );
    assert.deepEqual(r.toPause.map((c) => c.id), [BigInt(201)]);
    assert.deepEqual(r.toAlign.map((c) => c.id), [BigInt(202)]);
  });
});
