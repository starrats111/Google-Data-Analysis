import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";
import { getExchangeRate, preloadRates } from "@/lib/exchange-rate";
import { nowCST, parseCSTDateStart, dateColumnStart } from "@/lib/date-utils";
import { autoRepairPublishedArticles } from "@/lib/article-auto-repair";
import { getRedirectedMerchantKeys } from "@/lib/merchant-ownership-rules";

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
 * 每日 06:00 自动执行：
 * 1. 同步违规/推荐商家（Google Sheet）
 * 2. 同步 MCC 广告数据（Sheet + API）
 * 3. 同步广告系列状态 & 商家状态
 * 4. 同步交易数据（各联盟平台）
 * 5. 自动修复已发布文章
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

    log("Step 2.5: Syncing campaign statuses from Google Ads API...");
    await syncAllCampaignStatuses();

    log("Step 2.6: Syncing merchant statuses from campaign statuses...");
    await syncAllMerchantStatuses();

    log("Step 3: Syncing transaction data for all users...");
    await syncAllUsersTransactions();

    log("Step 4: Auto-repairing published articles...");
    await autoRepairPublishedArticles({ limit: 50 });

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

// ── 同步所有用户的 MCC 广告数据（Sheet 近 31 天 + API 近 2 天补数据） ──

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
          const cstNow = nowCST();
          // 扩大至 31 天：覆盖完整一个自然月，防止 Sheet 脚本偶发失败导致历史数据永久缺失
          const startStr = cstNow.subtract(31, "day").format("YYYY-MM-DD");
          const endStr = cstNow.format("YYYY-MM-DD");
          const yesterdayStr = cstNow.subtract(1, "day").format("YYYY-MM-DD");
          await preloadRates(mcc.currency, startStr, endStr);

          let sheetUpserted = 0;

          // 1. Sheet 同步（近7天）
          if (mcc.sheet_url) {
            const sheetResult = await syncFromSheet(mcc.sheet_url, startStr, endStr);
            if (sheetResult.success && sheetResult.rows.length > 0) {
              const gcids = [...new Set(sheetResult.rows.map(r => r.campaign_id).filter(Boolean))];
              const existingCampaigns = gcids.length > 0
                ? await prisma.campaigns.findMany({
                    where: { user_id: uid, google_campaign_id: { in: gcids as string[] }, is_deleted: 0 },
                    select: { id: true, google_campaign_id: true, customer_id: true },
                    orderBy: { id: "desc" },
                  })
                : [];
              const campaignByGcid = new Map<string, (typeof existingCampaigns)[0]>();
              for (const c of existingCampaigns) {
                if (!c.google_campaign_id) continue;
                const existing = campaignByGcid.get(c.google_campaign_id);
                if (!existing || (!existing.customer_id && c.customer_id)) {
                  campaignByGcid.set(c.google_campaign_id, c);
                }
              }

              // 新广告系列自动创建：Sheet 中出现但 DB 中不存在的 campaign，
              // 说明是手动同步后在 Google Ads 里新建的广告系列，需要补录进 DB。
              const missingGcids = gcids.filter(id => id && !campaignByGcid.has(id));
              if (missingGcids.length > 0) {
                const firstRowByGcid = new Map<string, typeof sheetResult.rows[0]>();
                for (const row of sheetResult.rows) {
                  if (row.campaign_id && !firstRowByGcid.has(row.campaign_id)) {
                    firstRowByGcid.set(row.campaign_id, row);
                  }
                }
                for (const gcid of missingGcids) {
                  const sample = firstRowByGcid.get(gcid);
                  if (!sample) continue;
                  try {
                    const newC = await prisma.campaigns.upsert({
                      where: { google_campaign_id: gcid } as never,
                      update: {},
                      create: {
                        user_id: uid, user_merchant_id: BigInt(0),
                        google_campaign_id: gcid, mcc_id: mcc.id,
                        customer_id: sample.customer_id || null,
                        campaign_name: sample.campaign_name,
                        daily_budget: sample.budget,
                        target_country: "US",
                        google_status: sample.status,
                        last_google_sync_at: new Date(),
                      },
                    });
                    campaignByGcid.set(gcid, { id: newC.id, google_campaign_id: gcid, customer_id: newC.customer_id });
                    log(`  [新campaign] ${gcid} ${sample.campaign_name} (from Sheet)`);
                  } catch (e) {
                    log(`  [新campaign创建失败] ${gcid}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
                  }
                }
              }

              for (const row of sheetResult.rows) {
                if (!row.campaign_id) continue;
                const campaign = campaignByGcid.get(row.campaign_id);
                if (!campaign) continue;

                const dateObj = new Date(row.date);
                const rate = await getExchangeRate(mcc.currency, row.date);
                if (rate <= 0) {
                  log(`  跳过 ${row.campaign_id} ${row.date}：汇率不可用`);
                  continue;
                }
                const costUsd = row.cost * rate;

                await prisma.ads_daily_stats.upsert({
                  where: { campaign_id_date: { campaign_id: campaign.id, date: dateObj } },
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

          // 2. API 补数据（近 2 天：昨天+今天），弥补 Sheet 延迟
          let apiUpserted = 0;
          if (mcc.service_account_json) {
            try {
              const { fetchCampaignDataByDateRange } = await import("@/lib/google-ads");
              const credentials = {
                mcc_id: mcc.mcc_id,
                developer_token: mcc.developer_token || "",
                service_account_json: mcc.service_account_json,
              };

              const cids = await prisma.mcc_cid_accounts.findMany({
                where: { mcc_account_id: mcc.id, is_deleted: 0, status: "active" },
                take: 50,
              });

              if (cids.length > 0) {
                const existingCampaigns = await prisma.campaigns.findMany({
                  where: { user_id: uid, mcc_id: mcc.id, is_deleted: 0 },
                  select: { id: true, google_campaign_id: true, customer_id: true },
                });
                const campaignByGcid = new Map<string, (typeof existingCampaigns)[0]>();
                for (const c of existingCampaigns) {
                  if (!c.google_campaign_id) continue;
                  const existing = campaignByGcid.get(c.google_campaign_id);
                  if (!existing || (!existing.customer_id && c.customer_id)) {
                    campaignByGcid.set(c.google_campaign_id, c);
                  }
                }

                log(`    API 补数据 ${yesterdayStr} → ${endStr}, ${cids.length} CIDs`);
                const CID_CONCURRENCY = 3;
                for (let ci = 0; ci < cids.length; ci += CID_CONCURRENCY) {
                  const batch = cids.slice(ci, ci + CID_CONCURRENCY);
                  const batchResults = await Promise.all(batch.map(async (cid) => {
                    try {
                      return await fetchCampaignDataByDateRange(credentials, cid.customer_id, yesterdayStr, endStr);
                    } catch (err) {
                      log(`    CID ${cid.customer_id} API err: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
                      return [];
                    }
                  }));

                  for (const data of batchResults) {
                    for (const cd of data) {
                      let campaign = campaignByGcid.get(cd.campaign_id);
                      if (!campaign) {
                        // API 发现了 DB 中不存在的新广告系列，自动补录
                        try {
                          const newC = await prisma.campaigns.upsert({
                            where: { google_campaign_id: cd.campaign_id } as never,
                            update: { customer_id: cd.customer_id || undefined, google_status: cd.campaign_status },
                            create: {
                              user_id: uid, user_merchant_id: BigInt(0),
                              google_campaign_id: cd.campaign_id, mcc_id: mcc.id,
                              customer_id: cd.customer_id,
                              campaign_name: cd.campaign_name,
                              daily_budget: cd.budget_dollars,
                              target_country: "US",
                              google_status: cd.campaign_status,
                              last_google_sync_at: new Date(),
                            },
                          });
                          campaign = { id: newC.id, google_campaign_id: cd.campaign_id, customer_id: newC.customer_id };
                          campaignByGcid.set(cd.campaign_id, campaign);
                          log(`  [新campaign] ${cd.campaign_id} ${cd.campaign_name} (from API)`);
                        } catch (e) {
                          log(`  [新campaign创建失败] ${cd.campaign_id}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
                          continue;
                        }
                      }

                      const dateObj = new Date(cd.date);
                      const rate = await getExchangeRate(mcc.currency, cd.date);
                      if (rate <= 0) continue;

                      const costUsd = cd.cost_dollars * rate;
                      await prisma.ads_daily_stats.upsert({
                        where: { campaign_id_date: { campaign_id: campaign.id, date: dateObj } },
                        update: { cost: costUsd, clicks: cd.clicks, impressions: cd.impressions, cpc: cd.cpc_dollars * rate, data_source: "api" },
                        create: {
                          user_id: uid, campaign_id: campaign.id, date: dateObj,
                          cost: costUsd, clicks: cd.clicks, impressions: cd.impressions,
                          cpc: cd.cpc_dollars * rate,
                          data_source: "api", user_merchant_id: BigInt(0),
                        },
                      });
                      apiUpserted++;
                    }
                  }
                }
              }
            } catch (e) {
              log(`    API 补数据失败: ${e instanceof Error ? e.message : String(e)}`);
            }
          }

          results[`mcc_${mcc.mcc_id}`] = { sheetUpserted, apiUpserted };
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

// ── 同步所有用户的广告系列状态（从 Google Ads API） ──

async function syncAllCampaignStatuses(): Promise<unknown> {
  const allMcc = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0, is_active: 1, service_account_json: { not: null } },
  });

  const results: Record<string, unknown> = {};

  for (const mcc of allMcc) {
    try {
      if (!mcc.service_account_json) continue;

      const { fetchAllCampaignStatuses } = await import("@/lib/google-ads");
      const credentials = {
        mcc_id: mcc.mcc_id,
        developer_token: mcc.developer_token || "",
        service_account_json: mcc.service_account_json,
      };

      const cids = await prisma.mcc_cid_accounts.findMany({
        where: { mcc_account_id: mcc.id, is_deleted: 0, status: "active" },
      });
      if (cids.length === 0) continue;

      const customerIds = cids.map((c) => c.customer_id);
      log(`  MCC ${mcc.mcc_name || mcc.mcc_id}: syncing statuses for ${customerIds.length} CIDs...`);

      const { statuses, disabledCids } = await fetchAllCampaignStatuses(credentials, customerIds);
      let updated = 0;

      // 对于被停用的 CID，将其下所有 campaign 标记为 PAUSED
      if (disabledCids.length > 0) {
        const r = await prisma.campaigns.updateMany({
          where: { user_id: mcc.user_id, customer_id: { in: disabledCids }, is_deleted: 0, google_status: { not: "PAUSED" } },
          data: { google_status: "PAUSED", last_google_sync_at: new Date() },
        });
        updated += r.count;
      }

      for (const s of statuses) {
        const result = await prisma.campaigns.updateMany({
          where: {
            user_id: mcc.user_id,
            google_campaign_id: s.campaign_id,
            is_deleted: 0,
          },
          data: {
            google_status: s.status,
            last_google_sync_at: new Date(),
          },
        });
        updated += result.count;
      }

      // 更新 CID 可用状态
      const cidHasEnabled = new Map<string, boolean>();
      for (const s of statuses) {
        if (s.status === "ENABLED") {
          cidHasEnabled.set(s.customer_id, true);
        } else if (!cidHasEnabled.has(s.customer_id)) {
          cidHasEnabled.set(s.customer_id, false);
        }
      }
      for (const [customerId, hasEnabled] of cidHasEnabled) {
        await prisma.mcc_cid_accounts.updateMany({
          where: { mcc_account_id: mcc.id, customer_id: customerId },
          data: { is_available: hasEnabled ? "N" : "Y", last_synced_at: new Date() },
        });
      }

      results[`mcc_${mcc.mcc_id}`] = { statuses: statuses.length, updated };
      log(`  MCC ${mcc.mcc_name || mcc.mcc_id}: ${statuses.length} campaigns, ${updated} updated`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results[`mcc_${mcc.mcc_id}`] = { error: msg };
      log(`  MCC ${mcc.mcc_name || mcc.mcc_id} status sync error: ${msg}`);
    }
  }
  return results;
}

// ── 广告状态同步后，更新所有用户的商家状态 ──

async function syncAllMerchantStatuses(): Promise<void> {
  const { syncMerchantStatusForUser } = await import("@/lib/campaign-merchant-link");

  const users = await prisma.users.findMany({
    where: { is_deleted: 0, status: "active", role: { in: ["user", "leader"] } },
    select: { id: true, username: true },
  });

  let totalLinked = 0;
  let totalUpdated = 0;

  for (const user of users) {
    try {
      const { linked, merchantsUpdated } = await syncMerchantStatusForUser(user.id);
      totalLinked += linked;
      totalUpdated += merchantsUpdated;
      if (linked > 0 || merchantsUpdated > 0) {
        log(`  ${user.username}: linked ${linked}, status updated ${merchantsUpdated}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  ${user.username} merchant sync error: ${msg}`);
    }
  }

  log(`  Merchant sync total: linked ${totalLinked}, status updated ${totalUpdated}`);
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
      const cstNow = nowCST();
      const startStr = cstNow.subtract(180, "day").format("YYYY-MM-DD");
      const syncStart = parseCSTDateStart(startStr);
      const statsSyncStart = dateColumnStart(startStr);
      const endStr = cstNow.format("YYYY-MM-DD");

      const userMerchants = await prisma.user_merchants.findMany({
        where: { user_id: userId, is_deleted: 0 },
        select: { id: true, merchant_id: true, platform: true, merchant_name: true },
      });
      const merchantMap = new Map(
        userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m])
      );

      // 硬编码的商家归属重定向规则
      const redirectRules = getRedirectedMerchantKeys(userId);

      let totalSynced = 0;
      for (const conn of validConns) {
        const platform = normalizePlatformCode(conn.platform);
        try {
          const r = await fetchAllTransactions(platform, conn.api_key!, startStr, endStr);
          if (!r.transactions.length) continue;

          // 预清理：删除数据库中以 order_id 作为 transaction_id 的旧记录（防重复）
          const orderIdsToClean = r.transactions
            .filter((txn) => txn.order_id && txn.transaction_id !== txn.order_id)
            .map((txn) => txn.order_id!);
          if (orderIdsToClean.length > 0) {
            for (let ci = 0; ci < orderIdsToClean.length; ci += 200) {
              const batch = orderIdsToClean.slice(ci, ci + 200);
              await prisma.affiliate_transactions.deleteMany({
                where: { platform, user_id: userId, transaction_id: { in: batch } },
              });
            }
          }

          for (const txn of r.transactions) {
            if (!txn.transaction_id) continue;
            const mid = txn.merchant_id || "";
            const merchantKey = `${platform}_${mid}`;

            // 检查硬编码归属规则：将交易直接写入目标用户
            const rule = redirectRules.get(merchantKey);
            if (rule) {
              await prisma.affiliate_transactions.upsert({
                where: { platform_transaction_id: { platform, transaction_id: txn.transaction_id } },
                create: {
                  user_id: BigInt(rule.target_user_id),
                  user_merchant_id: BigInt(rule.target_user_merchant_id),
                  campaign_id: BigInt(rule.target_campaign_id),
                  platform_connection_id: conn.id,
                  platform, merchant_id: mid, merchant_name: txn.merchant || "",
                  transaction_id: txn.transaction_id, transaction_time: new Date(txn.transaction_time),
                  order_amount: txn.order_amount || 0, commission_amount: txn.commission_amount || 0,
                  currency: "USD", status: txn.status, raw_status: txn.raw_status || "",
                },
                update: {
                  user_id: BigInt(rule.target_user_id),
                  user_merchant_id: BigInt(rule.target_user_merchant_id),
                  campaign_id: BigInt(rule.target_campaign_id),
                  commission_amount: txn.commission_amount || 0,
                  status: txn.status, raw_status: txn.raw_status || "",
                  order_amount: txn.order_amount || 0,
                  merchant_name: txn.merchant || undefined,
                  is_deleted: 0,
                },
              });
              totalSynced++;
              continue;
            }

            if (mid && !merchantMap.has(merchantKey)) {
              try {
                const wasExcluded = await prisma.user_merchants.findFirst({
                  where: { user_id: userId, platform, merchant_id: mid, status: "excluded" },
                  select: { id: true },
                });
                if (!wasExcluded) {
                  let existing = await prisma.user_merchants.findFirst({
                    where: { user_id: userId, platform, merchant_id: mid, is_deleted: 0 },
                    select: { id: true, merchant_id: true, platform: true, merchant_name: true },
                  });
                  if (!existing) {
                    existing = await prisma.user_merchants.create({
                      data: { user_id: userId, platform, merchant_id: mid, merchant_name: txn.merchant || "", status: "available" },
                      select: { id: true, merchant_id: true, platform: true, merchant_name: true },
                    });
                  }
                  merchantMap.set(merchantKey, existing);
                }
              } catch {
                // ignore race condition
              }
            }

            const merchant = merchantMap.get(merchantKey);
            const umId = merchant ? merchant.id : BigInt(0);
            const merchantName = txn.merchant || merchant?.merchant_name || "";

            await prisma.affiliate_transactions.upsert({
              where: { platform_transaction_id: { platform, transaction_id: txn.transaction_id } },
              create: {
                user_id: userId, user_merchant_id: umId, platform_connection_id: conn.id,
                platform, merchant_id: mid, merchant_name: merchantName,
                transaction_id: txn.transaction_id, transaction_time: new Date(txn.transaction_time),
                order_amount: txn.order_amount || 0, commission_amount: txn.commission_amount || 0,
                currency: "USD", status: txn.status, raw_status: txn.raw_status || "",
              },
              update: {
                platform_connection_id: conn.id,
                merchant_id: mid,
                merchant_name: merchantName || undefined,
                order_amount: txn.order_amount || 0,
                commission_amount: txn.commission_amount || 0,
                status: txn.status,
                raw_status: txn.raw_status || "",
                is_deleted: 0,
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
        await linkCampaignsToMerchants(userId);
        await claimLinkedMerchants(userId);

        // 按规则将特定商家的交易转移给实际投放人
        const reassigned = await reassignTransactionsByRules(userId);

        const commUpdated = await updateDailyStatsCommission(userId, statsSyncStart, syncStart);
        log(`    ${user.username}: updated ${commUpdated} commission records in ads_daily_stats`);

        // 转移后更新目标用户的佣金聚合
        for (const r of reassigned) {
          const targetCommUpdated = await updateDailyStatsCommission(BigInt(r.targetUserId), statsSyncStart, syncStart);
          log(`    → reassigned ${r.count} txns to user ${r.targetUserId}, updated ${targetCommUpdated} commission records`);
        }
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
  await normalizeExistingTransactionPlatforms(userId);

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
  await prisma.$executeRawUnsafe(`
    UPDATE affiliate_transactions t
    JOIN user_merchants m ON t.user_id = m.user_id AND t.merchant_name = m.merchant_name AND t.platform = m.platform
    SET t.user_merchant_id = m.id
    WHERE t.user_id = ? AND t.user_merchant_id = 0 AND t.is_deleted = 0 AND m.is_deleted = 0 AND t.merchant_name != ''
  `, userId);
}

async function normalizeExistingTransactionPlatforms(userId: bigint) {
  const distinctPlatforms = await prisma.$queryRawUnsafe<{ platform: string }[]>(
    "SELECT DISTINCT platform FROM affiliate_transactions WHERE user_id = ? AND is_deleted = 0",
    userId
  );
  for (const row of distinctPlatforms) {
    const normalized = normalizePlatformCode(row.platform);
    if (normalized !== row.platform) {
      await prisma.affiliate_transactions.updateMany({
        where: { user_id: userId, platform: row.platform, is_deleted: 0 },
        data: { platform: normalized },
      });
    }
  }
}

function parseCampaignName(name: string): { platform: string; mid: string } | null {
  if (!name) return null;
  const parts = name.split(/[-\s]+/);
  if (parts.length < 4) return null;
  const rawPlatform = parts[1]?.trim();
  const mid = parts[parts.length - 1]?.trim();
  if (!rawPlatform || !mid || !/^\d+$/.test(mid)) return null;
  return { platform: normalizePlatformCode(rawPlatform), mid };
}

async function linkCampaignsToMerchants(userId: bigint) {
  const unlinked = await prisma.campaigns.findMany({
    where: { user_id: userId, user_merchant_id: BigInt(0), is_deleted: 0, google_campaign_id: { not: null } },
    select: { id: true, campaign_name: true },
    take: 500,
  });
  if (unlinked.length === 0) return 0;

  const userMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, merchant_id: true, status: true },
  });
  const merchantIndex = new Map(
    userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m])
  );

  let linked = 0;
  const updates: Promise<unknown>[] = [];
  const claimedMerchantIds = new Set<bigint>();

  for (const c of unlinked) {
    const parsed = parseCampaignName(c.campaign_name || "");
    if (!parsed) continue;
    const merchant = merchantIndex.get(`${parsed.platform}_${parsed.mid}`);
    if (!merchant) continue;

    updates.push(prisma.campaigns.update({ where: { id: c.id }, data: { user_merchant_id: merchant.id } }));

    if (merchant.status !== "claimed" && !claimedMerchantIds.has(merchant.id)) {
      claimedMerchantIds.add(merchant.id);
      updates.push(
        prisma.user_merchants.update({
          where: { id: merchant.id },
          data: { status: "claimed", claimed_at: new Date() },
        })
      );
    }

    linked++;
    if (updates.length >= 20) await Promise.all(updates.splice(0));
  }

  if (updates.length > 0) await Promise.all(updates);
  return linked;
}

async function claimLinkedMerchants(userId: bigint) {
  const linkedMerchantIds = await prisma.campaigns.findMany({
    where: { user_id: userId, is_deleted: 0, user_merchant_id: { not: BigInt(0) }, google_campaign_id: { not: null } },
    select: { user_merchant_id: true },
    distinct: ["user_merchant_id"],
  });

  if (linkedMerchantIds.length === 0) return 0;

  const ids = linkedMerchantIds.map((c) => c.user_merchant_id);
  const result = await prisma.user_merchants.updateMany({
    where: { id: { in: ids }, user_id: userId, is_deleted: 0, status: { not: "claimed" } },
    data: { status: "claimed", claimed_at: new Date() },
  });

  return result.count;
}

/**
 * 将 affiliate_transactions 佣金回写到 ads_daily_stats（向后兼容，非前端主要读取源）
 */
async function updateDailyStatsCommission(userId: bigint, statsStartDate: Date, txnStartDate: Date): Promise<number> {
  await prisma.ads_daily_stats.updateMany({
    where: { user_id: userId, date: { gte: statsStartDate } },
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
  `, userId, txnStartDate);

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
    const dateObj = new Date(txnDateStr);
    const commData = {
      commission: Number(agg.total_commission),
      rejected_commission: Number(agg.rejected_commission),
      orders: Number(agg.order_count),
    };

    let wrote = false;
    for (const cid of campaignIds) {
      const existing = await prisma.ads_daily_stats.findFirst({
        where: { campaign_id: cid, date: dateObj },
        select: { id: true },
      });
      if (existing) {
        await prisma.ads_daily_stats.update({ where: { id: existing.id }, data: commData });
        wrote = true;
        updated++;
        break;
      }
    }

    if (!wrote) {
      await prisma.ads_daily_stats.upsert({
        where: { campaign_id_date: { campaign_id: campaignIds[0], date: dateObj } },
        update: commData,
        create: {
          user_id: userId,
          user_merchant_id: BigInt(String(agg.user_merchant_id)),
          campaign_id: campaignIds[0],
          date: dateObj,
          cost: 0, clicks: 0, impressions: 0,
          ...commData,
        },
      });
      updated++;
    }
  }

  return updated;
}

// ─── 交易转移规则 ───

interface ReassignRule {
  source_user_id: number;
  target_user_id: number;
  platform: string;
  merchant_id: string;
  target_user_merchant_id: number;
  target_campaign_id: number;
}

async function reassignTransactionsByRules(sourceUserId: bigint) {
  const cfg = await prisma.system_configs.findFirst({
    where: { config_key: "transaction_reassignment_rules", is_deleted: 0 },
  });
  if (!cfg?.config_value) return [];

  let rules: ReassignRule[];
  try { rules = JSON.parse(cfg.config_value); } catch { return []; }

  const applicable = rules.filter(r => BigInt(r.source_user_id) === sourceUserId);
  if (applicable.length === 0) return [];

  const results: { targetUserId: number; count: number }[] = [];

  for (const rule of applicable) {
    const result = await prisma.affiliate_transactions.updateMany({
      where: {
        user_id: BigInt(rule.source_user_id),
        platform: rule.platform,
        merchant_id: rule.merchant_id,
        is_deleted: 0,
      },
      data: {
        user_id: BigInt(rule.target_user_id),
        user_merchant_id: BigInt(rule.target_user_merchant_id),
        campaign_id: BigInt(rule.target_campaign_id),
      },
    });

    // Fix previously-reassigned transactions whose user_merchant_id
    // was overwritten by the sync upsert back to the source user's merchant
    const fixResult = await prisma.affiliate_transactions.updateMany({
      where: {
        user_id: BigInt(rule.target_user_id),
        platform: rule.platform,
        merchant_id: rule.merchant_id,
        user_merchant_id: { not: BigInt(rule.target_user_merchant_id) },
        is_deleted: 0,
      },
      data: {
        user_merchant_id: BigInt(rule.target_user_merchant_id),
        campaign_id: BigInt(rule.target_campaign_id),
      },
    });

    const total = result.count + fixResult.count;
    if (total > 0) {
      log(`  reassign: ${result.count} new + ${fixResult.count} fixed ${rule.platform}/${rule.merchant_id} txns for user ${rule.source_user_id} → ${rule.target_user_id}`);
      results.push({ targetUserId: rule.target_user_id, count: total });
    }
  }

  return results;
}
