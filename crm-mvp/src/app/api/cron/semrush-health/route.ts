import { NextRequest, NextResponse } from "next/server";
import { testConnection, trySwitchNode, refreshApiKey } from "@/lib/semrush-auto-fix";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const CRON_SECRET = process.env.CRON_SECRET || "";

function verifyCron(req: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  return req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

function log(msg: string) {
  console.error(`[CRON semrush-health ${new Date().toISOString()}] ${msg}`);
}

/**
 * GET /api/cron/semrush-health
 *
 * 每天 04:00 (服务器时间 CST) 自动执行：
 * 1. 测试 SemRush 连接
 * 2. 连接正常 → 跳过，记录 OK
 * 3. 连接异常 → 分析错误类型：
 *    - 节点问题 → 自动遍历节点 1-10，切换到可用节点
 *    - API Key 问题 → 自动登录 3UE，从页面提取最新 API Key 并更新 DB
 *    - 两者均失败 → 记录最终错误日志
 */
export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await runSemrushHealthCheck();
  const status = result.fixed || result.healthy ? 200 : 500;
  return NextResponse.json(result, { status });
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
