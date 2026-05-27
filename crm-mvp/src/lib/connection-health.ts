/**
 * D-026 platform_connections 健康状态写库 helper
 *
 * 规约：所有调用平台 API 的代码路径（5 处 sync 入口 + test-connection API）
 * 在调用 fetchAllTransactions / fetchAllMerchants 后必须调用本 helper 写状态：
 *   - 成功（拿到数据）→ markConnectionSuccess
 *   - 成功但 0 数据 → markConnectionAttempted（仅刷新 last_sync_attempt_at）
 *   - 失败（error / token invalid）→ markConnectionFailure
 *   - 用户手动测试通过 → markConnectionUserVerified（强制覆盖自检失败历史）
 *
 * D-033 三次重试策略：
 *   - status 取值：connected | error | unverified | disconnected
 *   - 失败阈值：连续失败 >= 3 次才切 status='error' + 发通知
 *   - 中间状态（1-2 次失败）：status 保持不变，UI 显示"验证中 N/3"
 *   - 用户手动测试通过：consecutive_failures 清零 → 覆盖一切自检失败记录
 *     理由：用户测试代表 API 绝对可用，自检失败属于瞬态/自检 BUG
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
 * 同步失败：累计 consecutive_failures + 写 last_error + 达阈值切 status='error'
 *
 * D-033 策略：三次检测均失败才切 error（允许瞬态失败 + 自检误报）
 *   - 1-2 次失败：status 保持不变，UI 显示"验证中 N/3"黄色
 *   - 3 次失败：status → 'error'，连接-健康 cron 发通知
 */
export async function markConnectionFailure(connId: bigint, errorMsg: string): Promise<void> {
  const trimmed = (errorMsg || "未知错误").slice(0, 500);
  const current = await prisma.platform_connections.findUnique({
    where: { id: connId },
    select: { consecutive_failures: true, status: true },
  });
  const newFailures = (current?.consecutive_failures ?? 0) + 1;
  const FAILURE_THRESHOLD = 3; // D-033: 3 次连续失败才切 error
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
 * 用户手动测试通过：强制清零 consecutive_failures + 恢复 connected
 *
 * D-033：用户测试通过 = API 绝对可用，覆盖所有自检失败历史。
 * 与 markConnectionSuccess 相同效果，但加专属日志标识区分调用来源。
 */
export async function markConnectionUserVerified(connId: bigint): Promise<void> {
  const now = new Date();
  console.log(`[D-033][UserVerified] connId=${connId} 用户手动测试通过，清零 consecutive_failures → connected`);
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
  // D-033: >= 3 次连续失败 或 status='error' → 红色
  if (conn.status === "error" || (conn.consecutive_failures ?? 0) >= 3) return "error";
  // 1-2 次失败（正在重试）或 unverified 或 从未同步 → 黄色
  if (
    conn.status === "unverified" ||
    (conn.consecutive_failures ?? 0) >= 1 ||
    !conn.last_synced_at
  ) return "warn";
  // 超 24h 未成功同步 → 黄色
  const ageHours = (Date.now() - conn.last_synced_at.getTime()) / 3600000;
  if (ageHours > 24) return "warn";
  return "ok";
}
