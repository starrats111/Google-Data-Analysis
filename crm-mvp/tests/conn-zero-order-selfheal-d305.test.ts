/**
 * D-305：「调通但 0 单」必须让连接翻篇（2026-09-01，D-303 收尾时挖出来的）。
 *
 * 旧实现在这个分支上只刷 last_sync_attempt_at，于是**任何进过 error 的连接，
 * 只要之后没再出过单，就永久钉死在红色异常态**，界面一直念那条过期的错误。
 * D-303 修完 RW 后 45 条自愈 38 条，剩 6 条全卡在这——拿它们的 Key 直接打 RW
 * 接口，6 条全回 `code=0 Success` 但 0 行，密钥完全正常，卡片却还写着
 * 「该连接 API Key 已失效」。
 *
 * 回归点有两个方向，缺一不可：
 *   ① 该清的必须清（status/last_error/consecutive_failures），否则永远红着；
 *   ② last_synced_at 绝对不许动——那字段是「上次真拿到数据」，
 *      0 单冒充成功会让人以为数据是新的，比红着更危险。
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

import prisma from "../src/lib/prisma";
import { markConnectionReachable, markConnectionSuccess } from "../src/lib/connection-health";

type UpdateArg = { where: { id: bigint }; data: Record<string, unknown> };

const realUpdate = prisma.platform_connections.update;
afterEach(() => { prisma.platform_connections.update = realUpdate; });

/** 截下写库参数，不真连数据库 */
function captureUpdate(): UpdateArg[] {
  const calls: UpdateArg[] = [];
  prisma.platform_connections.update = (async (arg: UpdateArg) => {
    calls.push(arg);
    return {};
  }) as unknown as typeof prisma.platform_connections.update;
  return calls;
}

describe("D-305 调通但 0 单要自愈", () => {
  test("清掉过期故障态：status 回 connected、last_error 清空、失败计数归零", async () => {
    const calls = captureUpdate();
    await markConnectionReachable(BigInt(123));

    assert.equal(calls.length, 1);
    const { data } = calls[0];
    assert.equal(data.status, "connected", "不翻篇的话，没出单的连接会永久红着");
    assert.equal(data.last_error, null, "过期的错误必须清掉，否则界面继续骂密钥");
    assert.equal(data.consecutive_failures, 0);
  });

  test("绝不谎报 last_synced_at——0 单不是「拿到数据」", async () => {
    const calls = captureUpdate();
    await markConnectionReachable(BigInt(123));

    assert.ok(!("last_synced_at" in calls[0].data), "0 单冒充同步成功，会让人以为数据是新的");
    assert.ok(calls[0].data.last_sync_attempt_at instanceof Date, "尝试时间仍要刷新");
  });

  test("对照：真拿到数据时才写 last_synced_at", async () => {
    const calls = captureUpdate();
    await markConnectionSuccess(BigInt(123));

    assert.ok(calls[0].data.last_synced_at instanceof Date);
    assert.equal(calls[0].data.status, "connected");
  });

  test("现场那 6 条的状态机：error + 过期错误 → 一次「通了但 0 单」即复原", async () => {
    const calls = captureUpdate();
    await markConnectionReachable(BigInt(143)); // wj111 vitahaven

    const { where, data } = calls[0];
    assert.equal(where.id, BigInt(143));
    // 复原后 UI 不再走 health==='error' 分支，那条 RW 1003 的陈年错误也不会再显示
    assert.equal(data.status, "connected");
    assert.equal(data.last_error, null);
  });
});
