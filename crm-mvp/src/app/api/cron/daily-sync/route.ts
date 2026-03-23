import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";

const CRON_SECRET = process.env.CRON_SECRET || "";

function verifyCron(req: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  const auth = req.headers.get("authorization");
  return auth === `Bearer ${CRON_SECRET}`;
}

function log(msg: string) {
  console.log(`[CRON daily-sync ${new Date().toISOString()}] ${msg}`);
}

/**
 * GET /api/cron/daily-sync
 *
 * 每日 00:00 自动执行：
 * 1. 同步 MCC 广告数据（Sheet + API）
 * 2. 同步交易数据（各联盟平台）
 * 3. 同步违规/推荐商家（Google Sheet）
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 立即返回，后台异步执行
  doDailySync().catch(e => log(`FATAL: ${e instanceof Error ? e.message : String(e)}`));

  return NextResponse.json({ ok: true, message: "daily sync started in background" });
}

async function doDailySync() {
  const t0 = Date.now();

  try {
    log("Step 1: Syncing violation & recommendation merchants...");
    await syncMerchantSheet();

    log("Step 2: Syncing MCC ad data for all users...");
    await syncAllUsersMcc();

    log("Step 3: Syncing transaction data for all users...");
    await syncAllUsersTransactions();

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`All done in ${elapsed}s`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`FATAL: ${msg}`);
  }
}

// ── 违规 & 推荐商家同步（全局，不分用户） ──

async function syncMerchantSheet(): Promise<unknown> {
  try {
    const cfg = await prisma.sheet_configs.findFirst({
      where: { config_type: "merchant_sheet", is_deleted: 0 },
    });
    if (!cfg?.sheet_url) return { skipped: true, reason: "no sheet_url configured" };

    const { fetchViolations, fetchRecommendations, stripCountrySuffix } = await import("@/lib/merchant-sheet-sync");
    const batchTs = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

    // 违规
    let vioNew = 0, vioUpdated = 0, vioMarked = 0;
    const violations = await fetchViolations(cfg.sheet_url);
    const violationNames = new Set(violations.map(v => v.name.toLowerCase()));
    const violationBaseNames = new Set(violations.map(v => stripCountrySuffix(v.name).toLowerCase()));

    // 清除不再违规的商家
    const prevViolated = await prisma.user_merchants.findMany({
      where: { is_deleted: 0, violation_status: "violated" },
      select: { id: true, merchant_name: true },
    });
    for (const m of prevViolated) {
      const n = (m.merchant_name || "").toLowerCase();
      const b = stripCountrySuffix(m.merchant_name || "").toLowerCase();
      if (!violationNames.has(n) && !violationBaseNames.has(b)) {
        await prisma.user_merchants.update({ where: { id: m.id }, data: { violation_status: "normal", violation_time: null } });
      }
    }

    for (const v of violations) {
      let vtime: Date | null = null;
      if (v.time) {
        const raw = v.time.trim();
        if (/^\d{8}$/.test(raw)) vtime = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
        else { const d = new Date(raw); if (!isNaN(d.getTime())) vtime = d; }
      }
      const exists = await prisma.merchant_violations.findFirst({ where: { merchant_name: v.name, is_deleted: 0 } });
      if (exists) {
        await prisma.merchant_violations.update({
          where: { id: exists.id },
          data: { platform: v.platform || exists.platform, violation_reason: v.reason, violation_time: vtime || exists.violation_time, source: v.source || exists.source, upload_batch: `CRON-VIO-${batchTs}` },
        });
        vioUpdated++;
      } else {
        await prisma.merchant_violations.create({
          data: { merchant_name: v.name, platform: v.platform, merchant_domain: v.domain || null, violation_reason: v.reason, violation_time: vtime, source: v.source || null, upload_batch: `CRON-VIO-${batchTs}` },
        });
        vioNew++;
      }
      // 标记 user_merchants
      const baseName = stripCountrySuffix(v.name);
      const conds: any[] = [{ merchant_name: v.name }];
      if (baseName !== v.name) conds.push({ merchant_name: baseName });
      conds.push({ merchant_name: { startsWith: baseName + " " } });
      if (v.domain) conds.push({ merchant_url: { contains: v.domain } });
      const matched = await prisma.user_merchants.findMany({ where: { is_deleted: 0, OR: conds } });
      for (const m of matched) {
        if (m.violation_status !== "violated") {
          await prisma.user_merchants.update({ where: { id: m.id }, data: { violation_status: "violated", violation_time: vtime || new Date() } });
          vioMarked++;
        }
      }
    }

    // 推荐
    let recNew = 0, recSkipped = 0, recMarked = 0;
    const recommendations = await fetchRecommendations(cfg.sheet_url);
    for (const r of recommendations) {
      const exists = await prisma.merchant_recommendations.findFirst({ where: { merchant_name: r.name, is_deleted: 0 } });
      if (exists) { recSkipped++; continue; }
      await prisma.merchant_recommendations.create({
        data: { merchant_name: r.name, roi_reference: r.roi || null, commission_info: r.commission || null, settlement_info: r.settlement || null, remark: r.remark || null, share_time: r.time || null, upload_batch: `CRON-REC-${batchTs}` },
      });
      recNew++;
      const matched = await prisma.user_merchants.findMany({ where: { is_deleted: 0, merchant_name: r.name } });
      for (const m of matched) {
        if (m.recommendation_status !== "recommended") {
          await prisma.user_merchants.update({ where: { id: m.id }, data: { recommendation_status: "recommended", recommendation_time: new Date() } });
          recMarked++;
        }
      }
    }

    await prisma.sheet_configs.update({ where: { id: cfg.id }, data: { last_synced_at: new Date() } });
    log(`  Violations: ${violations.length} total, ${vioNew} new, ${vioUpdated} updated, ${vioMarked} marked`);
    log(`  Recommendations: ${recommendations.length} total, ${recNew} new, ${recSkipped} skipped, ${recMarked} marked`);
    return { violation: { total: violations.length, new: vioNew, updated: vioUpdated, marked: vioMarked }, recommendation: { total: recommendations.length, new: recNew, skipped: recSkipped, marked: recMarked } };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  Merchant sheet sync error: ${msg}`);
    return { error: msg };
  }
}

// ── 同步所有用户的 MCC 广告数据（Sheet + Google Ads API） ──

async function syncAllUsersMcc(): Promise<unknown> {
  const allMcc = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0, is_active: 1 },
  });

  const userMccMap = new Map<string, typeof allMcc>();
  for (const mcc of allMcc) {
    const uid = String(mcc.user_id);
    if (!userMccMap.has(uid)) userMccMap.set(uid, []);
    userMccMap.get(uid)!.push(mcc);
  }

  const results: Record<string, unknown> = {};

  for (const [userId, mccs] of userMccMap) {
    try {
      const uid = BigInt(userId);
      const { syncFromSheet } = await import("@/lib/sheet-sync");

      for (const mcc of mccs) {
        log(`  MCC ${mcc.mcc_name || mcc.mcc_id} for user ${userId}...`);

        try {
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const startStr = yesterday.toISOString().slice(0, 10);
          const endStr = new Date().toISOString().slice(0, 10);
          const rate = await fetchExchangeRate(mcc.currency);

          let sheetUpserted = 0;
          let apiUpserted = 0;

          // 1. Sheet 同步（昨天→今天）
          if (mcc.sheet_url) {
            const sheetResult = await syncFromSheet(mcc.sheet_url, startStr, endStr);
            if (sheetResult.success && sheetResult.rows.length > 0) {
              for (const row of sheetResult.rows) {
                if (!row.campaign_id) continue;
                const campaign = await prisma.campaigns.findFirst({
                  where: { user_id: uid, google_campaign_id: row.campaign_id, is_deleted: 0 },
                  select: { id: true },
                });
                if (!campaign) continue;

                const dateObj = new Date(row.date);
                const costUsd = Number((row.cost * rate).toFixed(2));

                await prisma.ads_daily_stats.upsert({
                  where: { uk_campaign_date: { campaign_id: campaign.id, date: dateObj } },
                  update: { cost: costUsd, clicks: row.clicks, impressions: row.impressions },
                  create: {
                    user_id: uid, campaign_id: campaign.id, date: dateObj,
                    cost: costUsd, clicks: row.clicks, impressions: row.impressions,
                    user_merchant_id: BigInt(0),
                  },
                });
                sheetUpserted++;
              }
            }
          }

          // 2. Google Ads API 同步今日数据
          if (mcc.service_account_json) {
            try {
              const { fetchTodayCampaignData } = await import("@/lib/google-ads");
              const credentials = {
                mcc_id: mcc.mcc_id,
                developer_token: mcc.developer_token || "",
                service_account_json: mcc.service_account_json,
              };
              const cids = await prisma.mcc_cid_accounts.findMany({
                where: { mcc_account_id: mcc.id, is_deleted: 0, status: "active" },
                take: 50,
              });
              const todayDate = new Date(endStr);

              for (const cid of cids) {
                try {
                  const data = await fetchTodayCampaignData(credentials, cid.customer_id);
                  for (const cd of data) {
                    const campaign = await prisma.campaigns.findFirst({
                      where: { user_id: uid, google_campaign_id: cd.campaign_id, is_deleted: 0 },
                      select: { id: true },
                    });
                    if (!campaign) continue;

                    await prisma.ads_daily_stats.upsert({
                      where: { uk_campaign_date: { campaign_id: campaign.id, date: todayDate } },
                      update: {
                        cost: Number((cd.cost_dollars * rate).toFixed(2)),
                        clicks: cd.clicks, impressions: cd.impressions,
                        data_source: "api",
                      },
                      create: {
                        user_id: uid, campaign_id: campaign.id, date: todayDate,
                        cost: Number((cd.cost_dollars * rate).toFixed(2)),
                        clicks: cd.clicks, impressions: cd.impressions,
                        user_merchant_id: BigInt(0), data_source: "api",
                      },
                    });
                    apiUpserted++;
                  }
                } catch (e) {
                  log(`    CID ${cid.customer_id} API error: ${e instanceof Error ? e.message : String(e)}`);
                }
              }
            } catch (e) {
              log(`    API sync error: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          results[`mcc_${mcc.mcc_id}`] = { sheetUpserted, apiUpserted, rate };
        } catch (e) {
          results[`mcc_${mcc.mcc_id}`] = { error: e instanceof Error ? e.message : String(e) };
        }
      }
    } catch (e) {
      results[`user_${userId}`] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return results;
}

// ── 同步所有用户的交易数据 ──

async function syncAllUsersTransactions(): Promise<unknown> {
  const users = await prisma.users.findMany({
    where: { is_deleted: 0, status: "active", role: { in: ["user", "leader"] } },
    select: { id: true, username: true },
  });

  const results: Record<string, unknown> = {};

  for (const user of users) {
    try {
      const userId = user.id;
      const conns = await prisma.platform_connections.findMany({
        where: { user_id: userId, is_deleted: 0, status: "connected" },
        select: { id: true, platform: true, account_name: true, api_key: true },
      });
      const validConns = conns.filter(c => c.api_key && c.api_key.length > 5);
      if (validConns.length === 0) {
        results[user.username] = { skipped: true, reason: "no connections" };
        continue;
      }

      log(`  Transactions for ${user.username} (${validConns.length} connections)...`);

      const { fetchAllTransactions } = await import("@/lib/platform-api");
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const startStr = sevenDaysAgo.toISOString().slice(0, 10);
      const endStr = new Date().toISOString().slice(0, 10);

      let totalSynced = 0;
      for (const conn of validConns) {
        const platform = normalizePlatformCode(conn.platform);
        try {
          const r = await fetchAllTransactions(platform, conn.api_key!, startStr, endStr);
          if (!r.transactions.length) continue;

          // 获取商家映射
          const merchants = await prisma.user_merchants.findMany({
            where: { user_id: userId, is_deleted: 0 },
            select: { id: true, merchant_id: true, platform: true },
          });
          const merchantMap = new Map(merchants.map(m => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m]));

          for (const txn of r.transactions) {
            if (!txn.transaction_id) continue;
            const mid = txn.merchant_id || "";
            const merchant = merchantMap.get(`${platform}_${mid}`);
            const umId = merchant ? merchant.id : BigInt(0);

            await prisma.affiliate_transactions.upsert({
              where: { platform_transaction_id: { platform, transaction_id: txn.transaction_id } },
              create: {
                user_id: userId, user_merchant_id: umId, platform_connection_id: conn.id,
                platform, merchant_id: mid, merchant_name: txn.merchant || "",
                transaction_id: txn.transaction_id, transaction_time: new Date(txn.transaction_time),
                order_amount: txn.order_amount || 0, commission_amount: txn.commission_amount || 0,
                currency: "USD", status: txn.status, raw_status: txn.raw_status || "",
              },
              update: {
                commission_amount: txn.commission_amount || 0,
                status: txn.status, raw_status: txn.raw_status || "",
                ...(umId !== BigInt(0) ? { user_merchant_id: umId } : {}),
              },
            });
            totalSynced++;
          }
        } catch (e) {
          log(`    ${conn.account_name || platform} error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (totalSynced > 0) {
        await linkTransactionsToMerchants(userId);
        const commUpdated = await updateDailyStatsCommission(userId, sevenDaysAgo);
        log(`    ${user.username}: updated ${commUpdated} commission records in ads_daily_stats`);
      }

      results[user.username] = { synced: totalSynced };
      log(`    ${user.username}: ${totalSynced} transactions synced`);
    } catch (e) {
      results[user.username] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return results;
}

// ── 复用的关联逻辑（简化版） ──

async function linkTransactionsToMerchants(userId: bigint) {
  await prisma.$executeRawUnsafe(`
    UPDATE affiliate_transactions t
    JOIN user_merchants m ON t.user_id = m.user_id AND t.merchant_id = m.merchant_id AND t.platform = m.platform
    SET t.user_merchant_id = m.id
    WHERE t.user_id = ? AND t.user_merchant_id = 0 AND t.is_deleted = 0 AND m.is_deleted = 0 AND t.merchant_id != ''
  `, userId);
  await prisma.$executeRawUnsafe(`
    UPDATE affiliate_transactions t
    JOIN user_merchants m ON t.user_id = m.user_id AND t.merchant_id = m.merchant_id
    SET t.user_merchant_id = m.id
    WHERE t.user_id = ? AND t.user_merchant_id = 0 AND t.is_deleted = 0 AND m.is_deleted = 0 AND t.merchant_id != ''
  `, userId);
}

/**
 * 将 affiliate_transactions 佣金回写到 ads_daily_stats（向后兼容，非前端主要读取源）
 */
async function updateDailyStatsCommission(userId: bigint, startDate: Date): Promise<number> {
  await prisma.ads_daily_stats.updateMany({
    where: { user_id: userId, date: { gte: startDate } },
    data: { commission: 0, rejected_commission: 0, orders: 0 },
  });

  const txnAgg = await prisma.$queryRawUnsafe<
    { user_merchant_id: bigint; txn_date: string; total_commission: number; rejected_commission: number; order_count: number }[]
  >(`
    SELECT
      user_merchant_id,
      DATE(transaction_time) as txn_date,
      SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
      COUNT(*) as order_count
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0 AND transaction_time >= ?
    GROUP BY user_merchant_id, DATE(transaction_time)
  `, userId, startDate);

  if (!txnAgg || txnAgg.length === 0) return 0;

  const merchantIds = [...new Set(txnAgg.map(t => t.user_merchant_id))].filter(id => id && id !== BigInt(0));
  if (merchantIds.length === 0) return 0;

  const allCampaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, user_merchant_id: { in: merchantIds }, is_deleted: 0 },
    select: { id: true, user_merchant_id: true, google_status: true, updated_at: true },
  });

  const STATUS_PRIORITY: Record<string, number> = { ENABLED: 0, PAUSED: 1, REMOVED: 2 };
  allCampaigns.sort((a, b) => {
    const pa = STATUS_PRIORITY[a.google_status || ""] ?? 2;
    const pb = STATUS_PRIORITY[b.google_status || ""] ?? 2;
    if (pa !== pb) return pa - pb;
    return b.updated_at.getTime() - a.updated_at.getTime();
  });

  const campaignsByMerchant = new Map<string, bigint[]>();
  for (const c of allCampaigns) {
    const key = String(c.user_merchant_id);
    if (!campaignsByMerchant.has(key)) campaignsByMerchant.set(key, []);
    campaignsByMerchant.get(key)!.push(c.id);
  }

  let updated = 0;
  for (const agg of txnAgg) {
    if (!agg.user_merchant_id || agg.user_merchant_id === BigInt(0)) continue;
    const campaignIds = campaignsByMerchant.get(String(agg.user_merchant_id));
    if (!campaignIds?.length) continue;

    const txnDateStr = String(agg.txn_date).split("T")[0];
    const commData = {
      commission: Number(agg.total_commission),
      rejected_commission: Number(agg.rejected_commission),
      orders: Number(agg.order_count),
    };

    for (const cid of campaignIds) {
      const existing = await prisma.ads_daily_stats.findFirst({
        where: { campaign_id: cid, date: new Date(txnDateStr) },
        select: { id: true },
      });
      if (existing) {
        await prisma.ads_daily_stats.update({ where: { id: existing.id }, data: commData });
        updated++;
        break;
      }
    }
  }

  return updated;
}

async function fetchExchangeRate(currency: string): Promise<number> {
  if (!currency || currency.toUpperCase() === "USD") return 1;
  try {
    const resp = await fetch(`https://open.er-api.com/v6/latest/${currency.toUpperCase()}`, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return 1;
    const data = await resp.json();
    const rate = data.rates?.USD;
    return (rate && rate > 0) ? rate : 1;
  } catch {
    return 1;
  }
}
