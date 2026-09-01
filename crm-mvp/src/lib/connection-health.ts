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
 *
 * D-220 区分「密钥真失效」与「本机拉不通」（2026-08-06 wj11 误报事故）：
 *   - 现象：wj11 五个连接全红「该连接 API Key 已失效」，07 重新配置无效。实测五个密钥
 *     全部有效（curl 直连各联盟接口均返回真实商家数据），全站另有 9 个连接同样被误标。
 *   - 真因：puppeteer 的 Chrome 堆积到 32 个吃掉 3.1GB，3.6G 机器被打穿，next-server
 *     1.67GB 进 swap，事件循环长时间冻结 → undici 的 10s 建连计时器被误触发，进程内
 *     所有 fetch 报 UND_ERR_CONNECT_TIMEOUT（同一时刻 curl 直连只要 40-220ms）。
 *     D-033 只数次数不看原因，3 次就把连接判死。
 *   - 对策：按错误性质分流——
 *       auth 类（invalid token / 401 / 403）：平台明确拒绝，维持 3 次切 error；
 *       transient 类（fetch failed / 超时 / 连接重置 / 5xx）：本机或对端瞬时问题，
 *         阈值放宽到 10 次，且一旦判定为**系统性故障**（5 分钟内 ≥3 个不同连接同时
 *         transient 失败 = 必然是本机问题，不可能多家联盟同时改密钥）连计数都不加，
 *         只记 last_error，让 UI 显示真实原因而不是甩锅给密钥。
 *
 * D-300 判据搬到 conn-failure-kind.ts（2026-08-29 RW「它又坏了」）：
 *   前端为了改文案手抄过一份正则，注释写着「与后端同源」，实际两边早就长歪了——
 *   Cloudflare 的 524、以及「网关返回 HTML 错误页 → resp.json() 抛 Unexpected token」
 *   两边都不认，于是又显示成「该连接 API Key 已失效」。判据只留一份纯函数模块
 *   （connection-health 顶部 import prisma，前端 import 不动），本文件 re-export 兼容旧调用点。
 */
import prisma from "@/lib/prisma";
import { classifyConnFailure } from "@/lib/conn-failure-kind";

export { classifyConnFailure, isNonKeyFailure } from "@/lib/conn-failure-kind";
export type { ConnFailureKind } from "@/lib/conn-failure-kind";

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

// ── D-220 失败分类（判据见 conn-failure-kind.ts） ──

/** 5 分钟内 ≥3 个不同连接同时 transient 失败 = 本机问题，不是各家联盟同时改了密钥 */
const SYSTEMIC_WINDOW_MS = 5 * 60_000;
const SYSTEMIC_MIN_CONNS = 3;
const SYSTEMIC_MAX_RECORDS = 2000;

const _recentTransient: Array<{ connId: string; at: number }> = [];

/** 记录本次 transient 失败并判断当前是否处于系统性故障中 */
function recordTransientAndDetectSystemic(connId: bigint): boolean {
  const now = Date.now();
  _recentTransient.push({ connId: connId.toString(), at: now });
  while (_recentTransient.length > 0 && now - _recentTransient[0].at > SYSTEMIC_WINDOW_MS) {
    _recentTransient.shift();
  }
  // 高频失败时数组可能涨得很快，留个硬上限防内存堆积（判定只看去重数，截断不影响结论）
  if (_recentTransient.length > SYSTEMIC_MAX_RECORDS) {
    _recentTransient.splice(0, _recentTransient.length - SYSTEMIC_MAX_RECORDS);
  }
  return new Set(_recentTransient.map((r) => r.connId)).size >= SYSTEMIC_MIN_CONNS;
}

/**
 * 同步失败：累计 consecutive_failures + 写 last_error + 达阈值切 status='error'
 *
 * D-033 策略：三次检测均失败才切 error（允许瞬态失败 + 自检误报）
 *   - 1-2 次失败：status 保持不变，UI 显示"验证中 N/3"黄色
 *   - 3 次失败：status → 'error'，连接-健康 cron 发通知
 *
 * D-220 按失败性质分流，见文件头注释。
 */
export async function markConnectionFailure(connId: bigint, errorMsg: string): Promise<void> {
  const raw = errorMsg || "未知错误";
  const kind = classifyConnFailure(raw);
  const systemic = kind === "transient" ? recordTransientAndDetectSystemic(connId) : false;

  const current = await prisma.platform_connections.findUnique({
    where: { id: connId },
    select: { consecutive_failures: true, status: true },
  });
  const prevFailures = current?.consecutive_failures ?? 0;

  // 系统性故障：本机拉不通，跟这条连接的密钥没关系——不累加、不改 status，
  // 只把真实原因写进 last_error，避免 UI 继续甩锅给「API Key 已失效」。
  if (systemic) {
    const note = `[系统性故障] ${raw}`.slice(0, 500);
    console.warn(
      `[D-220] connId=${connId} 判定为系统性故障（5分钟内多个连接同时网络失败），不计入失效次数：${raw.slice(0, 120)}`,
    );
    await prisma.platform_connections.update({
      where: { id: connId },
      data: { last_sync_attempt_at: new Date(), last_error: note },
    });
    return;
  }

  const newFailures = prevFailures + 1;
  // auth = 平台明确拒绝，3 次即判死；transient/unknown 放宽到 10 次，避免瞬时抖动误杀
  const threshold = kind === "auth" ? 3 : 10;
  const newStatus = newFailures >= threshold ? "error" : current?.status ?? "connected";

  await prisma.platform_connections.update({
    where: { id: connId },
    data: {
      last_sync_attempt_at: new Date(),
      last_error: raw.slice(0, 500),
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
  // D-220：红灯只认 status（由 markConnectionFailure 按失败性质分流后判定）。
  // 原先「次数 >= 3 即红」会绕过分流——网络类失败第 3 次就变红，与放宽到 10 次的策略打架。
  if (conn.status === "error") return "error";
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
