import { NextRequest, NextResponse } from "next/server";
import { testConnection, trySwitchNode, refreshApiKey } from "@/lib/semrush-auto-fix";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const HEALTH_LOG_RETENTION_DAYS = 7;
const ADMIN_USER_ID = BigInt(1); // 管理员账号 user_id（系统默认 admin = id 1）
const ALERT_DEDUP_WINDOW_HOURS = 24;

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.error(`[CRON semrush-health ${new Date().toISOString()}] ${msg}`);
}

/**
 * GET /api/cron/semrush-health
 *
 * D-038c-v2 I1：cron 频率 04:00 → 每整点 `0 * * * *`（crontab 同时更新）
 *
 * 每次执行：
 * 1. 测试 SemRush 连接
 * 2. 连接正常 → 写 OK 日志，结束
 * 3. 连接异常 → 自动修复（切节点 / 刷 API Key）
 * 4. 修复失败 → 写失败日志 + 通知 admin（24h 同 errorType 去重，防刷屏）
 * 5. 清理 7 天前的健康日志
 */
export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runSemrushHealthCheck();

  // D-038c-v2 I1：写健康日志
  await writeHealthLog(result);

  // D-038c-v2 I1：失败时通知 admin（去重 24h）
  if (!result.healthy && !result.fixed) {
    await maybeNotifyAdmin(result);
  }

  // 清理 7 天前的旧日志（异步，不阻塞响应）
  void cleanupOldLogs().catch((err) => log(`清理旧日志失败: ${err instanceof Error ? err.message : err}`));

  const status = result.fixed || result.healthy ? 200 : 500;
  return NextResponse.json(result, { status });
}

interface HealthCheckResult {
  healthy: boolean;
  fixed: boolean;
  action: string;
  detail: string;
  errorType?: string;
  steps?: unknown[];
  retestSteps?: unknown[];
  newApiKey?: string;
  newNode?: string;
}

async function writeHealthLog(result: HealthCheckResult) {
  try {
    await prisma.semrush_health_logs.create({
      data: {
        overall: result.healthy ? "success" : "failure",
        error_type: result.errorType ?? (result.healthy ? "none" : "unknown"),
        details: JSON.stringify({
          action: result.action,
          detail: result.detail,
          fixed: result.fixed,
          steps: result.steps,
          retestSteps: result.retestSteps,
          newApiKey: result.newApiKey,
          newNode: result.newNode,
        }),
        alerted: 0,
      },
    });
  } catch (err) {
    log(`写健康日志失败: ${err instanceof Error ? err.message : err}`);
  }
}

async function maybeNotifyAdmin(result: HealthCheckResult) {
  try {
    const errorType = result.errorType ?? "unknown";
    // 24h 内同 errorType 去重
    const windowAgo = new Date(Date.now() - ALERT_DEDUP_WINDOW_HOURS * 60 * 60 * 1000);
    const recentSame = await prisma.notifications.findFirst({
      where: {
        user_id: ADMIN_USER_ID,
        type: "alert",
        title: { startsWith: "[SemRush]" },
        metadata: { contains: `"errorType":"${errorType}"` },
        created_at: { gte: windowAgo },
        is_deleted: 0,
      },
      orderBy: { created_at: "desc" },
    });
    if (recentSame) {
      log(`已在 24h 内推送过相同告警（errorType=${errorType}），跳过去重`);
      return;
    }
    await prisma.notifications.create({
      data: {
        user_id: ADMIN_USER_ID,
        type: "alert",
        title: `[SemRush] 3UE 健康检查失败（errorType=${errorType}）`,
        content:
          `${result.detail}\n\n` +
          `Action: ${result.action}\n` +
          `请尽快登录 dash.3ue.co 检查账号状态，或在后台 SemRush 配置中手动更新凭据。`,
        metadata: JSON.stringify({ errorType, action: result.action, ts: new Date().toISOString() }),
      },
    });
    // 标记最近写入的 health_log 已告警
    await prisma.semrush_health_logs.updateMany({
      where: { overall: "failure" },
      data: { alerted: 1 },
    });
    log(`已通知 admin (errorType=${errorType})`);
  } catch (err) {
    log(`通知 admin 失败: ${err instanceof Error ? err.message : err}`);
  }
}

async function cleanupOldLogs() {
  const cutoff = new Date(Date.now() - HEALTH_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await prisma.semrush_health_logs.deleteMany({
    where: { checked_at: { lt: cutoff } },
  });
  if (deleted.count > 0) {
    log(`已清理 ${deleted.count} 条 ${HEALTH_LOG_RETENTION_DAYS} 天前的旧日志`);
  }
}

async function runSemrushHealthCheck() {
  log("开始 SemRush 健康检查...");

  // ── Step 1: 初次连接测试 ──
  const testResult = await testConnection();
  log(`初次测试: overall=${testResult.overall}, errorType=${testResult.errorType ?? "none"}`);
  for (const s of testResult.steps) {
    log(`  [${s.status}] ${s.step}: ${s.detail}`);
  }

  if (testResult.overall === "success") {
    log("✅ SemRush 连接正常，无需处理");
    return {
      healthy: true,
      fixed: false,
      action: "none",
      detail: "SemRush 连接正常",
      steps: testResult.steps,
    };
  }

  // ── Step 2: 根据错误类型自动修复 ──
  const errorType = testResult.errorType ?? "unknown";
  log(`❌ 检测到错误: errorType=${errorType}，开始自动修复...`);

  // 节点问题：先尝试切换节点
  if (errorType === "node") {
    log("尝试切换节点...");
    const switchResult = await trySwitchNode();
    log(`节点切换结果: action=${switchResult.action}, detail=${switchResult.detail}`);

    if (switchResult.action === "switched_node") {
      // 切换成功后，再次验证连接
      const retest = await testConnection();
      log(`节点切换后重新验证: overall=${retest.overall}`);

      if (retest.overall === "success") {
        log(`✅ 已切换到节点 ${switchResult.newNode}，连接恢复正常`);
        return {
          healthy: true,
          fixed: true,
          action: "switched_node",
          detail: switchResult.detail,
          newNode: switchResult.newNode,
          steps: testResult.steps,
          retestSteps: retest.steps,
        };
      }

      // 切换节点后仍然失败，可能还有 API Key 问题，继续尝试刷新
      log("切换节点后仍失败，继续尝试刷新 API Key...");
    }
  }

  // API Key 问题（或节点切换后仍失败）：尝试刷新 API Key
  if (errorType === "apikey" || errorType === "node" || errorType === "unknown") {
    log("尝试刷新 API Key...");
    const refreshResult = await refreshApiKey();
    log(`API Key 刷新结果: action=${refreshResult.action}, detail=${refreshResult.detail}`);

    if (refreshResult.action === "refreshed_apikey" || refreshResult.action === "none") {
      // 刷新后再次验证（即使 Key 未变化，也验证一次）
      const retest = await testConnection();
      log(`API Key 刷新后重新验证: overall=${retest.overall}`);

      if (retest.overall === "success") {
        log(`✅ ${refreshResult.action === "refreshed_apikey" ? "API Key 已更新，" : ""}连接恢复正常`);
        return {
          healthy: true,
          fixed: refreshResult.action === "refreshed_apikey",
          action: refreshResult.action,
          detail: refreshResult.detail,
          newApiKey: refreshResult.newApiKey ? `...${refreshResult.newApiKey.slice(-8)}` : undefined,
          steps: testResult.steps,
          retestSteps: retest.steps,
        };
      }
    }

    // API Key 刷新失败
    log(`⚠️ API Key 刷新失败: ${refreshResult.detail}`);
  }

  // ── Step 3: 登录失败，无法自动修复 ──
  if (errorType === "login") {
    log("❌ 登录失败，需人工检查账号凭据");
    return {
      healthy: false,
      fixed: false,
      action: "failed",
      detail: "3UE 账号登录失败，请检查用户名和密码是否正确",
      errorType,
      steps: testResult.steps,
    };
  }

  // ── 所有修复手段均失败 ──
  log("❌ 所有自动修复均失败，需要人工介入");
  return {
    healthy: false,
    fixed: false,
    action: "failed",
    detail: `自动修复失败（errorType=${errorType}），请登录 dash.3ue.co 手动检查账号状态和凭据`,
    errorType,
    steps: testResult.steps,
  };
}
