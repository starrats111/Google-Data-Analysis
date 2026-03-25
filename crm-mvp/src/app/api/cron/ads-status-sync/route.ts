import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { syncUserCampaignStatuses } from "@/lib/google-ads/status-sync";

const CRON_SECRET = process.env.CRON_SECRET || "";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * GET /api/cron/ads-status-sync
 *
 * 每 10 分钟执行：从 Google Ads 拉取所有活跃用户的广告系列最新状态
 * 配合 vercel.json 或外部 cron 服务调用
 */
export async function GET(req: NextRequest) {
  if (CRON_SECRET && req.headers.get("authorization") !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();
  const log = (msg: string) => console.log(`[CRON ads-status ${new Date().toISOString()}] ${msg}`);

  try {
    // 查所有有 MCC 配置的活跃用户
    const users = await prisma.users.findMany({
      where: { status: "active", is_deleted: 0, role: "user" },
      select: { id: true, username: true },
    });

    log(`Starting status sync for ${users.length} users`);
    const allResults: Record<string, unknown> = {};
    let totalUpdated = 0;

    for (const user of users) {
      try {
        const results = await syncUserCampaignStatuses(user.id);
        const userUpdated = results.reduce((sum, r) => sum + r.updated, 0);
        totalUpdated += userUpdated;
        if (userUpdated > 0) {
          log(`  ${user.username}: ${userUpdated} campaigns updated`);
        }
        allResults[user.username] = results;
      } catch (e) {
        allResults[user.username] = { error: e instanceof Error ? e.message : String(e) };
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`Done in ${elapsed}s, ${totalUpdated} total updates`);

    return NextResponse.json({ ok: true, totalUpdated, elapsed: `${elapsed}s`, details: allResults });
  } catch (err) {
    log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
