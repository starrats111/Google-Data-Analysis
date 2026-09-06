import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * D-321 「CRM 已移除，Google 还在花钱」巡检
 *
 * 立项背景：D-321 给拒登广告加了本地移除 + 防覆盖——员工点「拒登」后 CRM 把状态锁成
 * 「已移除」，同步不再跟随 Google。防覆盖是把双刃剑：成员要是忘了去 Google 后台移除，
 * 这条广告实际还在烧钱，CRM 却显示已移除，员工再也不会注意到它（花费按 gcid 回灌，
 * 与状态无关，所以钱照扣、报表照记，只有人看不见）。这条巡检就是兜这个底。
 *
 * 触发：每日 10:00 CST（crontab `0 10 * * *`）
 *
 * 判定：本地移除（remove_source 非空）之后的日期还有花费 > 0，且落在最近 LOOKBACK_DAYS 天内。
 *   只认「移除日之后」的花费——移除当天早些时候的花费是合法历史，不是漏网。
 *
 * 参数：?dry=1 只查不通知；?days=N 改回看天数（默认 3）
 */

const LOOKBACK_DAYS = 3;

interface Row {
  id: bigint;
  user_id: bigint;
  username: string;
  campaign_name: string | null;
  customer_id: string | null;
  removed_at: Date;
  cost_after: string | number;
  last_date: Date;
  days_spent: bigint | number;
}

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.error(`[CRON removed-still-spending ${new Date().toISOString()}] ${msg}`);
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const days = Math.min(Math.max(Number(url.searchParams.get("days")) || LOOKBACK_DAYS, 1), 30);
  const startedAt = Date.now();

  // 库里 removed_at 是 UTC（Prisma 写入口径），ads_daily_stats.date 是 CST 自然日，
  // 比较前把 removed_at 换算成北京时间再取日期；CURDATE() 在生产机上返回北京时间。
  const rows = await prisma.$queryRawUnsafe<Row[]>(
    `SELECT c.id, c.user_id, u.username, c.campaign_name, c.customer_id, c.removed_at,
            ROUND(SUM(d.cost), 2) AS cost_after, MAX(d.date) AS last_date, COUNT(*) AS days_spent
       FROM campaigns c
       JOIN users u ON u.id = c.user_id AND u.is_deleted = 0
       JOIN ads_daily_stats d ON d.campaign_id = c.id AND d.is_deleted = 0
      WHERE c.is_deleted = 0
        AND c.remove_source IS NOT NULL
        AND d.cost > 0
        AND d.date > DATE(CONVERT_TZ(c.removed_at, '+00:00', '+08:00'))
        AND d.date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY c.id, c.user_id, u.username, c.campaign_name, c.customer_id, c.removed_at
      ORDER BY SUM(d.cost) DESC`,
    days,
  );

  log(`本地已移除但近 ${days} 天仍有花费的广告：${rows.length} 条${dry ? "（dry run）" : ""}`);

  let notifsCreated = 0;
  const details = rows.map((r) => ({
    campaign_id: r.id.toString(),
    username: r.username,
    campaign_name: r.campaign_name,
    customer_id: r.customer_id,
    cost_after_removal: Number(r.cost_after),
    last_spend_date: new Date(r.last_date).toISOString().slice(0, 10),
    days_spent: Number(r.days_spent),
  }));

  for (const r of rows) {
    const cost = Number(r.cost_after);
    const lastDate = new Date(r.last_date).toISOString().slice(0, 10);
    log(`  ${r.username} campaign#${r.id}「${r.campaign_name}」移除后仍花费 $${cost.toFixed(2)}，最近 ${lastDate}`);
    if (dry) continue;

    const title = `已移除的广告还在花钱：${r.campaign_name || `campaign#${r.id}`}`;
    // 24 小时内同标题只发一条，避免天天刷屏
    const dup = await prisma.notifications.count({
      where: {
        user_id: r.user_id, type: "alert", title, is_deleted: 0,
        created_at: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
      },
    });
    if (dup > 0) continue;

    const content = [
      `广告系列「${r.campaign_name || `campaign#${r.id}`}」你已经在 CRM 里标记为「已移除」（记了拒登），`,
      `但它在 Google Ads 那边还在跑：移除之后仍产生花费 $${cost.toFixed(2)}，最近一次是 ${lastDate}。`,
      ``,
      `CRM 标记只管我们这边的账，不会动 Google——请到 Google Ads 后台把这条广告移除，钱才会真正停。`,
      `如果是打算改文案重投，请在「商家」页用「重发此条」，别在 Google 后台直接改。`,
      ``,
      `CID: ${r.customer_id || "未知"}`,
    ].join("\n");

    await prisma.notifications.create({
      data: {
        user_id: r.user_id,
        type: "alert",
        title,
        content,
        metadata: JSON.stringify({
          source: "D-321 removed-still-spending",
          campaign_id: r.id.toString(),
          customer_id: r.customer_id,
          cost_after_removal: cost,
          last_spend_date: lastDate,
        }),
      },
    });
    notifsCreated++;
  }

  return NextResponse.json({
    ok: true,
    dry,
    lookback_days: days,
    found: rows.length,
    notifications_created: notifsCreated,
    details,
    elapsed_ms: Date.now() - startedAt,
  });
}
