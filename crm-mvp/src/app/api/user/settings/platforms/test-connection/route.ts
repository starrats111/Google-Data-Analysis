import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError, normalizePlatformCode } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { markConnectionSuccess, markConnectionFailure } from "@/lib/connection-health";
import dayjs from "dayjs";

/**
 * D-026 POST /api/user/settings/platforms/test-connection
 *
 * 测试一个平台连接的 API Key 是否有效（用 1 天窗口的真实交易接口拉）。
 *
 * 支持两种调用方式：
 *   1. 新建/编辑前预测试（无 conn_id）：传 platform + api_key (+ channel_id)，纯探活
 *   2. 既有连接重测（带 conn_id）：自动读 DB 里的 api_key，成功后清空 last_error 状态
 *
 * 返回：
 *   { ok: true,  msg: "API 连接成功，拉到 N 条交易样本" }
 *   { ok: false, error: "MUI: Invalid token", suggest: "请检查 API Key 是否正确" }
 *
 * 07 决策：
 *   - 测试窗口 = 昨天到今天（1 天），3 秒内可返回
 *   - 保存前必须测试通过（前端拦截）
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  let body: { platform?: string; api_key?: string; channel_id?: string; conn_id?: string };
  try {
    body = await req.json();
  } catch {
    return apiError("请求体格式错误");
  }
  const { platform: rawPlatform, channel_id, conn_id } = body;
  let apiKey = body.api_key;

  // 既有连接重测：从 DB 读 api_key
  let connFromDb: { id: bigint; api_key: string | null; platform: string; channel_id: string | null } | null = null;
  if (conn_id) {
    connFromDb = await prisma.platform_connections.findFirst({
      where: { id: BigInt(conn_id), user_id: BigInt(user.userId), is_deleted: 0 },
      select: { id: true, api_key: true, platform: true, channel_id: true },
    });
    if (!connFromDb) return apiError("连接不存在或无权限");
    if (!apiKey) apiKey = connFromDb.api_key ?? undefined;
  }

  const platform = normalizePlatformCode(rawPlatform || connFromDb?.platform || "");
  if (!platform) return apiError("平台代码不能为空");
  if (!apiKey || apiKey.length < 5) return apiError("API Key 不能为空");

  // AD 平台需要 channel_id
  const finalChannelId = channel_id || connFromDb?.channel_id || "";
  if (platform === "AD" && !finalChannelId) {
    return apiError("AD 平台必须提供 channel_id");
  }

  // 调真实交易 API：昨天到今天 1 天窗口
  const yesterday = dayjs().subtract(1, "day").format("YYYY-MM-DD");
  const today = dayjs().format("YYYY-MM-DD");

  const startMs = Date.now();
  const { fetchAllTransactions } = await import("@/lib/platform-api");

  try {
    const r = await fetchAllTransactions(platform, apiKey, yesterday, today);
    const elapsedMs = Date.now() - startMs;

    if (r.error) {
      // 失败：如果是既有连接，写失败状态
      if (connFromDb) {
        await markConnectionFailure(connFromDb.id, r.error);
      }
      return apiSuccess({
        ok: false,
        error: r.error,
        elapsed_ms: elapsedMs,
        suggest: r.error.toLowerCase().includes("invalid token") || r.error.toLowerCase().includes("unauthor")
          ? "API Key 已失效，请到平台后台重新生成并复制粘贴"
          : "请检查 API Key、网络连接及平台账号状态",
      }, "API 连接测试失败");
    }

    // 成功：如果是既有连接，写成功状态（清空 last_error + 恢复 connected）
    if (connFromDb) {
      await markConnectionSuccess(connFromDb.id);
    }

    return apiSuccess({
      ok: true,
      sample_count: r.transactions.length,
      elapsed_ms: elapsedMs,
      msg: r.transactions.length > 0
        ? `API 连接成功，拉到 ${r.transactions.length} 条最近 1 天的交易样本`
        : "API 连接成功（最近 1 天无新交易，但 token 有效）",
    }, "API 连接测试通过");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (connFromDb) {
      await markConnectionFailure(connFromDb.id, msg);
    }
    return apiSuccess({
      ok: false,
      error: `${platform}: ${msg}`,
      elapsed_ms: Date.now() - startMs,
      suggest: "请检查网络或稍后重试",
    }, "API 连接测试失败");
  }
}
