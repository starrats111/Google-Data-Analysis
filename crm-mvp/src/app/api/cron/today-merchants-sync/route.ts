/**
 * GET /api/cron/today-merchants-sync
 *
 * 每小时整点（crontab: 0 * * * *）执行：
 * 读取所有 MCC 的 Google Sheet DailyData Tab，
 * 统计今日投放商家数，按 user_id 写入 system_configs 缓存。
 *
 * 缓存 key 格式：today_merchants_{userId}
 * 缓存 value：JSON { count: number; date: string; synced_at: string }
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { fetchTodayMerchantsFromSheets } from "@/lib/today-merchants-sheet";

const CRON_SECRET = process.env.CRON_SECRET || "";

function verifyCron(req: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${CRON_SECRET}`;
}

function log(msg: string) {
  const ts = new Date().toISOString();
  console.error(`[CRON today-merchants-sync ${ts}] ${msg}`);
}

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  log("开始同步今日投放商家...");

  try {
    const result = await fetchTodayMerchantsFromSheets();

    const syncedAt = new Date().toISOString();

    // 将结果写入 system_configs，每个 user_id 一条记录
    const writeOps: Promise<unknown>[] = [];
    for (const [userId, count] of result.byUser) {
      const key = `today_merchants_${userId}`;
      const value = JSON.stringify({ count, date: result.date, synced_at: syncedAt });
      writeOps.push(
        prisma.system_configs.upsert({
          where: { config_key: key },
          create: {
            config_key: key,
            config_value: value,
            description: `今日投放商家数缓存 (user ${userId})`,
            is_deleted: 0,
          },
          update: { config_value: value, is_deleted: 0 },
        })
      );
    }

    // 对于有 MCC 但今日无数据的用户，写入 count=0（避免显示旧缓存）
    const allMccUsers = await prisma.google_mcc_accounts.findMany({
      where: { is_deleted: 0, sheet_url: { not: null }, service_account_json: { not: null } },
      select: { user_id: true },
    });
    const allUserIds = new Set(allMccUsers.map((m) => String(m.user_id)));
    for (const userId of allUserIds) {
      if (!result.byUser.has(userId)) {
        const key = `today_merchants_${userId}`;
        const value = JSON.stringify({ count: 0, date: result.date, synced_at: syncedAt });
        writeOps.push(
          prisma.system_configs.upsert({
            where: { config_key: key },
            create: {
              config_key: key,
              config_value: value,
              description: `今日投放商家数缓存 (user ${userId})`,
              is_deleted: 0,
            },
            update: { config_value: value, is_deleted: 0 },
          })
        );
      }
    }

    await Promise.all(writeOps);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(
      `同步完成：${result.mccCount} 个MCC，${result.mccWithData} 个有今日数据，` +
      `${result.byUser.size} 个用户有投放商家，耗时 ${elapsed}s`
    );
    if (result.errors.length > 0) {
      log(`错误 (${result.errors.length}): ${result.errors.join("; ")}`);
    }

    return NextResponse.json({
      ok: true,
      date: result.date,
      elapsed_s: parseFloat(elapsed),
      mcc_total: result.mccCount,
      mcc_with_data: result.mccWithData,
      users_updated: result.byUser.size,
      by_user: Object.fromEntries(result.byUser),
      errors: result.errors,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`FATAL: ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
