/**
 * D-026 platform_connections 健康状态写库 helper
 *
 * 规约：所有调用平台 API 的代码路径（5 处 sync 入口 + test-connection API）
 * 在调用 fetchAllTransactions / fetchAllMerchants 后必须调用本 helper 写状态：
 *   - 成功（拿到数据）→ markConnectionSuccess
 *   - 成功但 0 数据 → markConnectionAttempted（仅刷新 last_sync_attempt_at）
 *   - 失败（error / token invalid）→ markConnectionFailure
 *
 * 设计目标（D-026）：
 *   - 解决 API 错误完全静默（cron 失败无 log、status 永远绿、last_synced_at 永远 NULL）
 *   - status 取值：connected | error | unverified | disconnected
 *   - 07 决策阈值：连续失败 >=1 次（第一次失败就切红）
 */
import prisma from "@/lib/prisma";

/** 同步成功且有数据：写 last_synced_at + 清空 error + 恢复 connected */
export async function markConnectionSuccess(connId: bigint): Promise<void> {
  const now = new Date();
  await prisma.platform_connections.update({
    where: { id: connId },
    data: {
      last_sync_attempt_at: now,
      last_synced_at: now,
      last_error: null,
      consecutive_failures: 0,
      status: "connected",
    },
  });
}

/**
 * 同步成功但 0 数据：仅刷新 last_sync_attempt_at，不动 status / last_error
 *
 * 注意：低活跃账号 + 短窗口可能合法地返回 0 单，不应判失败。
 */
export async function markConnectionAttempted(connId: bigint): Promise<void> {
  await prisma.platform_connections.update({
    where: { id: connId },
    data: { last_sync_attempt_at: new Date() },
  });
}

/**
 * 同步失败：累计 consecutive_failures + 写 last_error + 阈值切 status='error'
 *
 * 07 决策：阈值 = 1 次（最严格，第一次失败就切红）
 */
export async function markConnectionFailure(connId: bigint, errorMsg: string): Promise<void> {
  const trimmed = (errorMsg || "未知错误").slice(0, 500);
  // 读当前 consecutive_failures，决定是否切 status
  const current = await prisma.platform_connections.findUnique({
    where: { id: connId },
    select: { consecutive_failures: true, status: true },
  });
  const newFailures = (current?.consecutive_failures ?? 0) + 1;
  const FAILURE_THRESHOLD = 1; // D-026 07 决策：1 次失败就切 error
  const newStatus = newFailures >= FAILURE_THRESHOLD ? "error" : current?.status ?? "connected";

  await prisma.platform_connections.update({
    where: { id: connId },
    data: {
      last_sync_attempt_at: new Date(),
      last_error: trimmed,
      consecutive_failures: newFailures,
      status: newStatus,
    },
  });
}

/**
 * 计算连接健康状态用于 UI 展示（不写库，纯计算）。
 * 返回三态供前端 Tag 颜色映射。
 */
export type ConnHealthLevel = "ok" | "warn" | "error";

export function computeHealthLevel(conn: {
  status: string;
  last_synced_at: Date | null;
  last_error: string | null;
  consecutive_failures: number;
}): ConnHealthLevel {
  if (conn.status === "error" || (conn.consecutive_failures ?? 0) >= 1) return "error";
  if (conn.status === "unverified") return "warn";
  if (!conn.last_synced_at) return "warn"; // 从未同步过
  const ageHours = (Date.now() - conn.last_synced_at.getTime()) / 3600000;
  if (ageHours > 24) return "warn"; // 超 24h 未成功同步
  return "ok";
}
