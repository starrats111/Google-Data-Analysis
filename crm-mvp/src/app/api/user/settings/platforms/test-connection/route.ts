import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError, normalizePlatformCode } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { markConnectionUserVerified, markConnectionFailure } from "@/lib/connection-health";
import { classifyConnFailure } from "@/lib/conn-failure-kind";
import dayjs from "dayjs";

/**
 * D-300 探活预算（2026-08-29 RW kaizenflowshop「它又坏了」）：
 *   现象：编辑弹窗点「测试连接」，红框写「服务响应超时（HTTP 524）：平台 API 响应过慢」，
 *   而卡片上另挂着「该连接 API Key 已失效 / RW: Unexpected token ... is not valid JSON」。
 *   两条都是我方链路的问题，密钥实际有效——但保存前必须测试通过，于是人被卡死在这。
 *   真因：默认拉取口径是「每页 120s × 3 次尝试」，撞上 RW 慢的时候整个请求 >100s，
 *   先被我方 Cloudflare 掐成 HTML 524，浏览器拿不到 JSON。
 *   对策：探活只要首页、只试一次、70s 封顶（RW 实测单页 ~38s，留近一倍余量），
 *   结论必定在网关掐断之前返回。
 */
const PROBE_OPTS = { timeoutMs: 70_000, maxRetries: 0, maxPages: 1 } as const;

/**
 * 失败文案按性质给：只有平台明确拒绝凭据时才让人去重配密钥。
 * D-303：原来 auth 之外一律说「平台侧慢或网络不通」，撞上 RW 改参数口径（1003）时
 * 这句话是错的——那不是慢，是平台压根不收我们的请求，重试多少次都一样。
 */
function suggestFor(errorMsg: string): string {
  switch (classifyConnFailure(errorMsg)) {
    case "auth":
      return "API Key 已失效，请到平台后台重新生成并复制粘贴";
    case "platform":
      return "平台拒绝了我们的请求（接口口径变了或在限流），重配 API Key 和重试都没有用，请把这条错误发给管理员。";
    case "transient":
      return "平台侧慢或网络不通，重配 API Key 没有用。稍后重试即可；若持续如此请联系管理员查平台状态。";
    default:
      return "还没法断定是密钥、平台还是网络的问题，请把这条错误发给管理员；只有你确认平台后台那把 Key 换过，才需要重配。";
  }
}

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
  const { platform: rawPlatform, conn_id } = body;
  let apiKey = body.api_key;

  // 既有连接重测：从 DB 读 api_key
  let connFromDb: { id: bigint; api_key: string | null; platform: string } | null = null;
  if (conn_id) {
    connFromDb = await prisma.platform_connections.findFirst({
      where: { id: BigInt(conn_id), user_id: BigInt(user.userId), is_deleted: 0 },
      select: { id: true, api_key: true, platform: true },
    });
    if (!connFromDb) return apiError("连接不存在或无权限");
    if (!apiKey) apiKey = connFromDb.api_key ?? undefined;
  }

  const platform = normalizePlatformCode(rawPlatform || connFromDb?.platform || "");
  if (!platform) return apiError("平台代码不能为空");
  if (!apiKey || apiKey.length < 5) return apiError("API Key 不能为空");

  // 调真实交易 API：昨天到今天 1 天窗口，且只取首页（见 PROBE_OPTS）
  const yesterday = dayjs().subtract(1, "day").format("YYYY-MM-DD");
  const today = dayjs().format("YYYY-MM-DD");

  const startMs = Date.now();
  const { fetchAllTransactions } = await import("@/lib/platform-api");

  try {
    const r = await fetchAllTransactions(platform, apiKey, yesterday, today, PROBE_OPTS);
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
        kind: classifyConnFailure(r.error),
        suggest: suggestFor(r.error),
      }, "API 连接测试失败");
    }

    // 成功：用户手动测试通过 = API 绝对可用，强制清零 consecutive_failures
    // D-033: 即使自检（auto-sync）之前失败过，用户手动验证通过也代表 API 没问题，
    //         是我们自检的瞬态/网络问题，不应保留失败计数。
    if (connFromDb) {
      await markConnectionUserVerified(connFromDb.id);
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
    const full = `${platform}: ${msg}`;
    return apiSuccess({
      ok: false,
      error: full,
      elapsed_ms: Date.now() - startMs,
      kind: classifyConnFailure(full),
      suggest: suggestFor(full),
    }, "API 连接测试失败");
  }
}
