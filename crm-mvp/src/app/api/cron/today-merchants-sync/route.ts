/**
 * GET /api/cron/today-merchants-sync
 *
 * 每 30 分钟（crontab: *\/30 * * * *）执行：
 * 读取所有 MCC 的 Google Sheet CampaignInfo Tab：
 *   1. 统计今日投放商家数，按 user_id 写入 system_configs 缓存
 *      （缓存 key：today_merchants_{userId}，value：JSON { count; date; synced_at }）
 *   2. 新广告快速回填：Sheet 近两日新建、CRM 尚无记录的系列立即补录进 campaigns，
 *      并自动关联商家。此前新广告只在每天 06:00 的 daily-sync 回填，
 *      用户上午在 Google 上的广告要等次日才出现在 CRM（yz03 投诉根因）。
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { fetchTodayMerchantsFromSheets, type CampaignInfoRow } from "@/lib/today-merchants-sheet";
import { parseCampaignNameFull, syncMerchantStatusForUser } from "@/lib/campaign-merchant-link";

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  const ts = new Date().toISOString();
  console.error(`[CRON today-merchants-sync ${ts}] ${msg}`);
}

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * 新广告快速回填：Sheet 近两日新建行 → campaigns 表。
 * - CRM 完全无该 gcid 行 → 补录（与 daily-sync 的「新campaign」补录同构）
 * - 仅有软删行且 Sheet 实时状态 ENABLED → 复活最早软删行（与 5d51b397 复活闸门一致）
 * - 有活跃行 → 跳过（daily-sync/status-sync 负责状态更新）
 * 补录后对涉及用户跑一次商家自动关联，让新广告立即出现在换链接/数据页并可换链。
 */
async function backfillNewCampaigns(
  rows: Array<CampaignInfoRow & { userId: string; mccDbId: string }>,
): Promise<{ created: number; resurrected: number; usersLinked: number; errors: string[] }> {
  const out = { created: 0, resurrected: 0, usersLinked: 0, errors: [] as string[] };
  if (rows.length === 0) return out;

  // 按 (userId, gcid) 去重（同一 gcid 可能出现在多张 Sheet）
  const byUser = new Map<string, Map<string, CampaignInfoRow & { mccDbId: string }>>();
  for (const r of rows) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, new Map());
    const m = byUser.get(r.userId)!;
    if (!m.has(r.campaignId)) m.set(r.campaignId, r);
  }

  const touchedUsers = new Set<string>();

  for (const [userId, rowByGcid] of byUser) {
    const uid = BigInt(userId);
    const gcids = [...rowByGcid.keys()];
    try {
      const existing = await prisma.campaigns.findMany({
        where: { user_id: uid, google_campaign_id: { in: gcids } },
        select: { id: true, google_campaign_id: true, is_deleted: true },
        orderBy: { id: "asc" },
      });
      const hasActive = new Set<string>();
      const earliestSoftDel = new Map<string, bigint>();
      for (const c of existing) {
        const g = c.google_campaign_id!;
        if (c.is_deleted === 0) hasActive.add(g);
        else if (!earliestSoftDel.has(g)) earliestSoftDel.set(g, c.id);
      }

      for (const [gcid, row] of rowByGcid) {
        if (hasActive.has(gcid)) continue;
        const gStatus = (row.status || "ENABLED").toUpperCase();

        const softId = earliestSoftDel.get(gcid);
        if (softId != null) {
          // 软删行：仅 Google 实时 ENABLED 才复活（防回灌豁免口径与 campaign-dedup 一致）
          if (gStatus !== "ENABLED") continue;
          await prisma.campaigns.update({
            where: { id: softId },
            data: {
              is_deleted: 0,
              status: "active",
              google_status: "ENABLED",
              customer_id: row.customerId || undefined,
              last_google_sync_at: new Date(),
            },
          });
          out.resurrected++;
          touchedUsers.add(userId);
          log(`  [复活] Sheet 实时 ENABLED 的软删系列 gcid=${gcid} campaign#${softId} (user ${userId})`);
          continue;
        }

        // 全新系列：补录
        const parsed = parseCampaignNameFull(row.campaignName || "");
        await prisma.campaigns.create({
          data: {
            user_id: uid,
            user_merchant_id: BigInt(0),
            google_campaign_id: gcid,
            mcc_id: BigInt(row.mccDbId),
            customer_id: row.customerId || null,
            campaign_name: row.campaignName || gcid,
            target_country: parsed?.country || "US",
            google_status: ["ENABLED", "PAUSED", "REMOVED"].includes(gStatus) ? gStatus : "ENABLED",
            last_google_sync_at: new Date(),
          },
        });
        out.created++;
        touchedUsers.add(userId);
        log(`  [新campaign] ${gcid} ${row.campaignName} (user ${userId}, from CampaignInfo)`);
      }
    } catch (e) {
      out.errors.push(`user ${userId}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  }

  // 商家自动关联：让新系列立即匹配商家（可换链/页面可见商家名）
  for (const userId of touchedUsers) {
    try {
      await syncMerchantStatusForUser(BigInt(userId));
      out.usersLinked++;
    } catch (e) {
      out.errors.push(`link user ${userId}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  }

  return out;
}

/**
 * 今日投放广告数：今日（CST）创建、且历史（今日之前）没出现过同名系列的广告数，按 gcid 去重。
 * 「历史同名」以 campaigns 表为准（含软删行）：同 user、同 campaign_name、
 * created_at 早于今日 CST 零点即视为历史已有，复用旧名字重开的系列不计入。
 */
async function countTodayNewAds(
  rows: Array<CampaignInfoRow & { userId: string; mccDbId: string }>,
  todayStr: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const todayStartCST = new Date(`${todayStr}T00:00:00+08:00`);

  // userId → (gcid → campaignName)，仅今日创建的行
  const byUser = new Map<string, Map<string, string>>();
  for (const r of rows) {
    if (r.creationDate !== todayStr) continue;
    if (!byUser.has(r.userId)) byUser.set(r.userId, new Map());
    const m = byUser.get(r.userId)!;
    if (!m.has(r.campaignId)) m.set(r.campaignId, r.campaignName || "");
  }

  for (const [userId, gcidToName] of byUser) {
    const names = [...new Set([...gcidToName.values()].filter(Boolean))];
    const historicalNames = new Set<string>();
    try {
      const BATCH = 300;
      for (let i = 0; i < names.length; i += BATCH) {
        const batch = names.slice(i, i + BATCH);
        const hist = await prisma.campaigns.findMany({
          where: {
            user_id: BigInt(userId),
            campaign_name: { in: batch },
            created_at: { lt: todayStartCST },
          },
          select: { campaign_name: true },
        });
        for (const h of hist) if (h.campaign_name) historicalNames.add(h.campaign_name);
      }
    } catch (e) {
      log(`今日投放广告 名称去重查询失败 (user ${userId}): ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }

    let count = 0;
    for (const [, name] of gcidToName) {
      if (name && historicalNames.has(name)) continue;
      count++;
    }
    out.set(userId, count);
  }

  return out;
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  log("开始同步今日投放商家...");

  try {
    const result = await fetchTodayMerchantsFromSheets();

    const syncedAt = new Date().toISOString();

    // 今日投放广告数（今日创建 + 历史无同名，按 gcid 去重）
    const adsByUser = await countTodayNewAds(result.recentRows, result.date);

    // 将结果写入 system_configs，每个 user_id 一条记录
    const writeOps: Promise<unknown>[] = [];
    const cachedUserIds = new Set([...result.byUser.keys(), ...adsByUser.keys()]);
    for (const userId of cachedUserIds) {
      const count = result.byUser.get(userId) ?? 0;
      const key = `today_merchants_${userId}`;
      const value = JSON.stringify({ count, ads_count: adsByUser.get(userId) ?? 0, date: result.date, synced_at: syncedAt });
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
      if (!cachedUserIds.has(userId)) {
        const key = `today_merchants_${userId}`;
        const value = JSON.stringify({ count: 0, ads_count: 0, date: result.date, synced_at: syncedAt });
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

    // 新广告快速回填（Sheet 近两日新建 → campaigns 表 + 自动关联商家）
    const backfill = await backfillNewCampaigns(result.recentRows);
    if (backfill.created > 0 || backfill.resurrected > 0) {
      log(`快速回填：新建 ${backfill.created}，复活 ${backfill.resurrected}，关联用户 ${backfill.usersLinked}`);
    }
    if (backfill.errors.length > 0) {
      log(`回填错误 (${backfill.errors.length}): ${backfill.errors.join("; ")}`);
    }

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
      users_updated: cachedUserIds.size,
      by_user: Object.fromEntries(result.byUser),
      today_ads_by_user: Object.fromEntries(adsByUser),
      backfill: {
        created: backfill.created,
        resurrected: backfill.resurrected,
        users_linked: backfill.usersLinked,
        errors: backfill.errors,
      },
      errors: result.errors,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`FATAL: ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
