import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * D-029 P2：广告系列状态漂移检测
 *
 * 实证背景（campaign id=3719, 003-CG2-f1arcade-US-0327）：
 *   5/21 用户 CRM 点暂停 → DB google_status=PAUSED
 *   5/22-5/25 该 campaign 仍有 clicks > 0 / cost > 0
 *   → Google Ads 端实际仍 ENABLED，DB 数据失同步 4 天
 *
 * 思路：不调 Google Ads API（避免配额开销），改为**本地数据矛盾检测**。
 *   逻辑：DB google_status='PAUSED' 的 campaign，
 *         如果在 last_google_sync_at 之后仍有 ads_daily_stats.cost > 0，
 *         一定存在状态漂移（PAUSED 广告不可能产生 cost）。
 *
 * 调度：每 30 分钟一次（cron `*\/30 * * * *`，可手动改成 0 H * * * 更稀疏）。
 *
 * 输出：
 *   - 检测到 drift → 发 notifications（type='alert'）给所属用户
 *   - 同 user × 同 campaign 24h 内只发一条避免噪音
 *
 * D-029 P2.6 修复（2026-05-27 实证误报）：
 *   - `s.date > DATE(c.last_google_sync_at)` 严格大于（之前 >= 含歧义）
 *     原因：ads_daily_stats 按天聚合，无法区分暂停当天 00:00-暂停时刻的合法 cost
 *     vs 暂停时刻-23:59 的真漂移。改 > 后只看暂停日次日及以后的 cost。
 *   - `last_google_sync_at < NOW() - 24h`（之前 6h）
 *     原因：6h 太短，刚暂停几小时就被检测，跨"暂停日"边界制造假阳性。
 *     24h 给一整天让真漂移浮出，误报率近 0。
 */
function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.error(`[CRON campaign-status-drift ${new Date().toISOString()}] ${msg}`);
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  log("开始广告系列状态漂移检测...");

  // 找出 PAUSED 但近 7 天内有花费的 campaign
  // (last_google_sync_at IS NULL 视为未知，跳过；阈值 cost ≥ 0.5 USD 避免微小残留)
  type DriftRow = {
    campaign_id: bigint;
    user_id: bigint;
    mcc_id: bigint | null;
    customer_id: string | null;
    google_campaign_id: string | null;
    campaign_name: string | null;
    google_status: string;
    last_google_sync_at: Date | null;
    drift_cost: string; // decimal as string
    drift_clicks: bigint | number;
    drift_days: bigint | number;
    drift_latest_date: Date;
  };
  const rows: DriftRow[] = await prisma.$queryRawUnsafe(`
    SELECT
      c.id AS campaign_id,
      c.user_id,
      c.mcc_id,
      c.customer_id,
      c.google_campaign_id,
      c.campaign_name,
      c.google_status,
      c.last_google_sync_at,
      ROUND(SUM(s.cost), 2) AS drift_cost,
      SUM(s.clicks) AS drift_clicks,
      COUNT(*) AS drift_days,
      MAX(s.date) AS drift_latest_date
    FROM campaigns c
    JOIN ads_daily_stats s
      ON s.campaign_id = c.id
     AND s.is_deleted = 0
     AND s.date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
     AND (
       c.last_google_sync_at IS NULL
       OR s.date > DATE(c.last_google_sync_at)
     )
     AND s.cost > 0
    WHERE c.is_deleted = 0
      AND c.google_status = 'PAUSED'
      AND c.last_google_sync_at IS NOT NULL
      AND c.last_google_sync_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)
    GROUP BY c.id, c.user_id, c.mcc_id, c.customer_id, c.google_campaign_id,
             c.campaign_name, c.google_status, c.last_google_sync_at
    HAVING drift_cost >= 0.5
    ORDER BY drift_cost DESC
    LIMIT 200
  `);

  log(`扫描到漂移嫌疑 ${rows.length} 条`);

  let notifsCreated = 0;
  const userIdsAlerted = new Set<string>();
  const dupCutoff = new Date(Date.now() - 24 * 3600 * 1000);

  for (const r of rows) {
    const userId = typeof r.user_id === "bigint" ? r.user_id : BigInt(r.user_id as unknown as string);
    const campaignName = r.campaign_name || `campaign#${r.campaign_id.toString()}`;

    // 同一 user × 同 campaign 24h 内只发一条
    const titlePrefix = `广告状态可能未同步：${campaignName}`;
    const recentDup = await prisma.notifications.count({
      where: {
        user_id: userId,
        type: "alert",
        title: titlePrefix,
        created_at: { gte: dupCutoff },
        is_deleted: 0,
      },
    });
    if (recentDup > 0) continue;

    const driftCost = Number(r.drift_cost);
    const driftClicks = Number(r.drift_clicks);
    const driftDays = Number(r.drift_days);
    const since = r.last_google_sync_at
      ? r.last_google_sync_at.toISOString().slice(0, 10)
      : "未知";

    const content = [
      `广告系列「${campaignName}」在 CRM 中显示为「已暂停」，`,
      `但自 ${since} 起的 ${driftDays} 天内仍产生了 $${driftCost.toFixed(2)} 花费 / ${driftClicks} 点击。`,
      `这说明 Google Ads 端实际未真正暂停（可能 MCC 服务账号已失效，或广告被远程恢复）。`,
      ``,
      `建议操作：`,
      `1. 检查「个人设置 → MCC 管理」中相关 MCC 的 Service Account JSON 是否有效；`,
      `2. 直接到 Google Ads 后台核实并手动暂停该广告系列；`,
      `3. 在 CRM「数据中心」重新点击「暂停」并观察返回结果。`,
      ``,
      `CID: ${r.customer_id || "未知"}, Google Campaign ID: ${r.google_campaign_id || "未知"}`,
    ].join("\n");

    const metadata = JSON.stringify({
      source: "D-029 P2 campaign-status-drift",
      campaign_id: r.campaign_id.toString(),
      google_campaign_id: r.google_campaign_id,
      customer_id: r.customer_id,
      mcc_id: r.mcc_id?.toString() ?? null,
      drift_cost: driftCost,
      drift_clicks: driftClicks,
      drift_days: driftDays,
      drift_since: since,
      drift_latest_date: r.drift_latest_date?.toISOString?.() ?? null,
    }, (_, v) => (typeof v === "bigint" ? v.toString() : v));

    await prisma.notifications.create({
      data: {
        user_id: userId,
        type: "alert",
        title: titlePrefix,
        content,
        metadata,
      },
    });
    notifsCreated++;
    userIdsAlerted.add(userId.toString());
  }

  const elapsed = Date.now() - startedAt;
  const result = {
    ok: true,
    scanned: rows.length,
    notifications_created: notifsCreated,
    users_alerted: userIdsAlerted.size,
    elapsed_ms: elapsed,
  };
  if (notifsCreated > 0) {
    const { sendAlert } = await import("@/lib/alert");
    void sendAlert({
      level: "warning",
      title: "发现广告系列状态漂移（CRM 已暂停但 Google 仍在跑）",
      content: `本轮发现 ${notifsCreated} 条漂移（涉及 ${userIdsAlerted.size} 个用户），已写站内通知，请到 Google Ads 后台核实暂停。`,
      source: "cron/campaign-status-drift",
    });
  }
  log(`完成：${JSON.stringify(result)}`);
  return NextResponse.json(result);
}
