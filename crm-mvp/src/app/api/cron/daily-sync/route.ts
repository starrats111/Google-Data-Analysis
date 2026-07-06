import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";
import { getExchangeRate, preloadRates } from "@/lib/exchange-rate";
import { nowCST, dateColumnStart, parseTxnDateStart } from "@/lib/date-utils";
import { autoRepairPublishedArticles } from "@/lib/article-auto-repair";
import { getRedirectedMerchantKeys } from "@/lib/merchant-ownership-rules";
import { sqlAffiliateTxnValidPlatformConnection } from "@/lib/affiliate-transaction-sql";
import { aggregateRawTransactions } from "@/lib/affiliate-txn-aggregate";
import { markConnectionSuccess, markConnectionAttempted, markConnectionFailure } from "@/lib/connection-health";
import { resolveMainConnectionMap } from "@/lib/payment-main-connection";

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  const ts = new Date().toISOString();
  console.error(`[CRON daily-sync ${ts}] ${msg}`);
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

  try {
    await doDailySync();
    return NextResponse.json({ ok: true, message: "daily sync completed" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`FATAL: ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
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

    log("Step 3.5: Syncing payment/withdrawal data for all users...");
    await syncAllUsersPayments();

    log("Step 3.6: Carving RW/LH/LB paid bucket from payment details...");
    await carvePaidForAllUsers();

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
    log(`  Fetched ${violations.length} violations from sheet`);
    const violationNames = new Set(violations.map(v => v.name.toLowerCase()));
    const violationBaseNames = new Set(violations.map(v => stripCountrySuffix(v.name).toLowerCase()));

    // 批量清除不再违规的商家
    const prevViolated = await prisma.user_merchants.findMany({
      where: { is_deleted: 0, violation_status: "violated" },
      select: { id: true, merchant_name: true },
    });
    const idsToUnmark = prevViolated
      .filter((m) => {
        const n = (m.merchant_name || "").toLowerCase();
        const b = stripCountrySuffix(m.merchant_name || "").toLowerCase();
        return !violationNames.has(n) && !violationBaseNames.has(b);
      })
      .map((m) => m.id);
    if (idsToUnmark.length > 0) {
      await prisma.user_merchants.updateMany({
        where: { id: { in: idsToUnmark } },
        data: { violation_status: "normal", violation_time: null },
      });
      log(`  Unmarked ${idsToUnmark.length} merchants no longer violated`);
    }

    // 预加载现有违规记录
    const existingViolations = await prisma.merchant_violations.findMany({
      where: { is_deleted: 0 },
      select: { id: true, merchant_name: true, platform: true, merchant_domain: true, violation_time: true, source: true },
    });
    const existingMap = new Map(existingViolations.map((v) => [v.merchant_name, v]));

    // 预加载 user_merchants
    const allUserMerchants = await prisma.user_merchants.findMany({
      where: { is_deleted: 0 },
      select: { id: true, merchant_name: true, merchant_url: true, violation_status: true },
    });

    for (const v of violations) {
      let vtime: Date | null = null;
      if (v.time) {
        const raw = v.time.trim();
        if (/^\d{8}$/.test(raw)) vtime = new Date(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`);
        else { const d = new Date(raw); if (!isNaN(d.getTime())) vtime = d; }
      }
      const exists = existingMap.get(v.name);
      if (exists) {
        await prisma.merchant_violations.update({
          where: { id: exists.id },
          data: { platform: v.platform || exists.platform, violation_reason: v.reason, violation_time: vtime || exists.violation_time, source: v.source || exists.source, upload_batch: `CRON-VIO-${batchTs}` },
        });
        vioUpdated++;
      } else {
        const created = await prisma.merchant_violations.create({
          data: { merchant_name: v.name, platform: v.platform, merchant_domain: v.domain || null, violation_reason: v.reason, violation_time: vtime, source: v.source || null, upload_batch: `CRON-VIO-${batchTs}` },
        });
        existingMap.set(v.name, { id: created.id, merchant_name: v.name, platform: v.platform, merchant_domain: v.domain || null, violation_time: vtime, source: v.source || null });
        vioNew++;
      }

      // 在内存中匹配 user_merchants，用 updateMany 批量更新
      const baseName = stripCountrySuffix(v.name);
      const nameL = v.name.toLowerCase();
      const baseL = baseName.toLowerCase();
      const basePrefix = baseL + " ";
      const toMark = allUserMerchants.filter((m) => {
        if (m.violation_status === "violated") return false;
        const mn = (m.merchant_name || "").toLowerCase();
        if (mn === nameL) return true;
        if (baseName !== v.name && mn === baseL) return true;
        if (mn.startsWith(basePrefix)) return true;
        if (v.domain && m.merchant_url && m.merchant_url.includes(v.domain)) return true;
        return false;
      });
      if (toMark.length > 0) {
        await prisma.user_merchants.updateMany({
          where: { id: { in: toMark.map((m) => m.id) } },
          data: { violation_status: "violated", violation_time: vtime || new Date() },
        });
        for (const m of toMark) m.violation_status = "violated";
        vioMarked += toMark.length;
      }
    }

    // 推荐
    let recNew = 0, recSkipped = 0, recMarked = 0;
    const recommendations = await fetchRecommendations(cfg.sheet_url);
    log(`  Fetched ${recommendations.length} recommendations from sheet`);

    const existingRecs = await prisma.merchant_recommendations.findMany({
      where: { is_deleted: 0 },
      select: { merchant_name: true },
    });
    const existingRecNames = new Set(existingRecs.map((r) => r.merchant_name));

    for (const r of recommendations) {
      if (existingRecNames.has(r.name)) { recSkipped++; continue; }
      await prisma.merchant_recommendations.create({
        data: { merchant_name: r.name, roi_reference: r.roi || null, commission_info: r.commission || null, settlement_info: r.settlement || null, remark: r.remark || null, share_time: r.time || null, upload_batch: `CRON-REC-${batchTs}` },
      });
      existingRecNames.add(r.name);
      recNew++;

      const matched = await prisma.user_merchants.findMany({
        where: { is_deleted: 0, merchant_name: r.name, recommendation_status: { not: "recommended" } },
        select: { id: true },
      });
      if (matched.length > 0) {
        await prisma.user_merchants.updateMany({
          where: { id: { in: matched.map((m) => m.id) } },
          data: { recommendation_status: "recommended", recommendation_time: new Date() },
        });
        recMarked += matched.length;
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

          // 1. Sheet 同步（近31天，截止昨日——今日数据不完整，只用于统计投放商家数，不计入费用）
          if (mcc.sheet_url) {
            const sheetResult = await syncFromSheet(mcc.sheet_url, startStr, yesterdayStr);
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
                    // 防回灌：先查所有同 gcid 行（含已软删）。
                    // 若已存在软删行，说明被刻意清洗（如 C-095），跳过不要 INSERT 新行；
                    // 完全无任何同 gcid 行时才补录。
                    const existingAny = await prisma.campaigns.findFirst({
                      where: { user_id: uid, google_campaign_id: gcid },
                      select: { id: true, google_campaign_id: true, customer_id: true, is_deleted: true },
                      orderBy: { id: "desc" },
                    });
                    if (existingAny && existingAny.is_deleted === 1) {
                      log(`  [跳过软删 gcid] ${gcid}（避免回灌已清洗的 campaign）`);
                      continue;
                    }
                    let newC: { id: bigint; google_campaign_id: string | null; customer_id: string | null } | null =
                      existingAny ? { id: existingAny.id, google_campaign_id: existingAny.google_campaign_id, customer_id: existingAny.customer_id } : null;
                    if (!newC) {
                      newC = await prisma.campaigns.create({
                        data: {
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
                      log(`  [新campaign] ${gcid} ${sample.campaign_name} (from Sheet)`);
                    }
                    campaignByGcid.set(gcid, { id: newC.id, google_campaign_id: gcid, customer_id: newC.customer_id });
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
                        try {
                          const existingAny = await prisma.campaigns.findFirst({
                            where: { user_id: uid, google_campaign_id: cd.campaign_id },
                            select: { id: true, google_campaign_id: true, customer_id: true, is_deleted: true },
                            orderBy: { id: "desc" },
                          });
                          if (existingAny && existingAny.is_deleted === 1) {
                            log(`  [跳过软删 gcid] ${cd.campaign_id}（避免回灌已清洗的 campaign）`);
                            continue;
                          }
                          let newC: { id: bigint; google_campaign_id: string | null; customer_id: string | null } | null = null;
                          if (!existingAny) {
                            newC = await prisma.campaigns.create({
                              data: {
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
                            log(`  [新campaign] ${cd.campaign_id} ${cd.campaign_name} (from API)`);
                          } else {
                            await prisma.campaigns.update({
                              where: { id: existingAny.id },
                              data: { customer_id: cd.customer_id || undefined, google_status: cd.campaign_status },
                            });
                            newC = { id: existingAny.id, google_campaign_id: existingAny.google_campaign_id, customer_id: existingAny.customer_id };
                          }
                          campaign = { id: newC.id, google_campaign_id: cd.campaign_id, customer_id: newC.customer_id };
                          campaignByGcid.set(cd.campaign_id, campaign);
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

                // ── D-040 v3 S1：显式拉本月 REMOVED 且有花费的 campaign，入库为独立 REMOVED 行 ──
                // GAQL `FROM campaign` 默认过滤 REMOVED，导致后台删除/重发广告的花费永远进不了 CRM，
                // CRM 总花费长期低于 GAds 后台。这里把本月有花费的 REMOVED 显式拉回，作为 google_status=REMOVED 行入库。
                try {
                  const { fetchRemovedCampaignData } = await import("@/lib/google-ads");
                  const monthStartStr = cstNow.startOf("month").format("YYYY-MM-DD");
                  for (let ci = 0; ci < cids.length; ci += CID_CONCURRENCY) {
                    const batch = cids.slice(ci, ci + CID_CONCURRENCY);
                    const removedResults = await Promise.all(batch.map(async (cid) => {
                      try {
                        return await fetchRemovedCampaignData(credentials, cid.customer_id, monthStartStr, endStr);
                      } catch (err) {
                        log(`    [REMOVED] CID ${cid.customer_id} err: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`);
                        return [];
                      }
                    }));
                    for (const data of removedResults) {
                      for (const cd of data) {
                        let campaign = campaignByGcid.get(cd.campaign_id);
                        if (!campaign) {
                          try {
                            const existingAny = await prisma.campaigns.findFirst({
                              where: { user_id: uid, google_campaign_id: cd.campaign_id },
                              select: { id: true, google_campaign_id: true, customer_id: true, is_deleted: true },
                              orderBy: { id: "desc" },
                            });
                            // 防回灌：被刻意清洗的软删行不重建
                            if (existingAny && existingAny.is_deleted === 1) continue;
                            if (existingAny) {
                              await prisma.campaigns.update({
                                where: { id: existingAny.id },
                                data: { google_status: "REMOVED", status: "paused", last_google_sync_at: new Date() },
                              });
                              campaign = { id: existingAny.id, google_campaign_id: cd.campaign_id, customer_id: existingAny.customer_id };
                            } else {
                              const newC = await prisma.campaigns.create({
                                data: {
                                  user_id: uid, user_merchant_id: BigInt(0),
                                  google_campaign_id: cd.campaign_id, mcc_id: mcc.id,
                                  customer_id: cd.customer_id, campaign_name: cd.campaign_name,
                                  daily_budget: cd.budget_dollars, target_country: "US",
                                  status: "paused", google_status: "REMOVED",
                                  last_google_sync_at: new Date(),
                                },
                              });
                              log(`  [REMOVED入库] ${cd.campaign_id} ${cd.campaign_name} cost=$${cd.cost_dollars}`);
                              campaign = { id: newC.id, google_campaign_id: cd.campaign_id, customer_id: newC.customer_id };
                            }
                            campaignByGcid.set(cd.campaign_id, campaign);
                          } catch (e) {
                            log(`  [REMOVED入库失败] ${cd.campaign_id}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
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
                            cpc: cd.cpc_dollars * rate, data_source: "api", user_merchant_id: BigInt(0),
                          },
                        });
                        apiUpserted++;
                      }
                    }
                  }
                } catch (e) {
                  log(`    REMOVED 同步失败: ${e instanceof Error ? e.message : String(e)}`);
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

// ── 同步所有用户的广告系列状态（数据源：Google Sheet CampaignInfo，零 API 配额消耗） ──
// 旧版对每个 MCC 的全部 CID 逐个发 GAQL（fetchAllCampaignStatuses），
// 是共享 Developer Token explorer 配额被打爆的主因之一。状态统一改读
// Google Ads 统一脚本维护的 Sheet；仅 D-034 漂移重暂停仍需 API mutate（量极小）。

async function syncAllCampaignStatuses(): Promise<unknown> {
  const allMcc = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0, is_active: 1 },
  });

  const { readCampaignInfoStatuses } = await import("@/lib/sheet-status-sync");
  const results: Record<string, unknown> = {};

  for (const mcc of allMcc) {
    try {
      const sheetMap = await readCampaignInfoStatuses(mcc.sheet_url);
      if (!sheetMap) {
        results[`mcc_${mcc.mcc_id}`] = { skipped: true, reason: "无可用 CampaignInfo Sheet" };
        continue;
      }

      log(`  MCC ${mcc.mcc_name || mcc.mcc_id}: syncing ${sheetMap.size} campaign statuses from Sheet...`);

      // D-034 漂移重暂停需要 mutate API，仅在凭据齐全时可用
      const credentials = mcc.service_account_json && mcc.developer_token ? {
        mcc_id: mcc.mcc_id,
        developer_token: mcc.developer_token,
        service_account_json: mcc.service_account_json,
      } : null;

      // 与旧版 fetchAllCampaignStatuses 返回结构对齐，下游逻辑（D-034/复活闸门/CID可用性）原样保留
      const statuses = [...sheetMap.entries()].map(([gcid, cs]) => ({
        campaign_id: gcid,
        status: cs.status,
        name: cs.name,
        customer_id: cs.customerId,
      }));
      let updated = 0;

      // D-034：预加载该 MCC 下所有「CRM 已暂停」的 campaign
      // 目的：在 Google Ads 返回 ENABLED 时，检测 PAUSED→ENABLED 漂移，自动重试暂停，
      //        失败时立即通知用户（而不是悄无声息地把 DB 改回 ENABLED）
      const pausedCampaigns = await prisma.campaigns.findMany({
        where: { user_id: mcc.user_id, mcc_id: mcc.id, is_deleted: 0, google_status: "PAUSED" },
        select: { id: true, google_campaign_id: true, customer_id: true, campaign_name: true },
      });
      const pausedByGcid = new Map(pausedCampaigns.map((c) => [c.google_campaign_id, c]));

      for (const s of statuses) {
        // D-034：检测 PAUSED→ENABLED 漂移
        if (s.status === "ENABLED" && pausedByGcid.has(s.campaign_id)) {
          const existing = pausedByGcid.get(s.campaign_id)!;
          log(`  [D-034] 检测到 PAUSED→ENABLED 漂移 campaign_id=${existing.id} gcid=${s.campaign_id}，尝试自动重新暂停...`);

          let rePauseOk = false;
          if (!credentials) {
            log(`  [D-034] MCC 未配置服务账号/Token，无法自动重新暂停 campaign_id=${existing.id}`);
          } else {
            try {
              const { updateCampaignStatus } = await import("@/lib/google-ads");
              const rp = await updateCampaignStatus(
                credentials,
                (existing.customer_id || "").replace(/-/g, ""),
                s.campaign_id,
                "PAUSED",
              );
              if (rp.success) {
                rePauseOk = true;
                log(`  [D-034] 自动重新暂停成功 campaign_id=${existing.id} gcid=${s.campaign_id}`);
              } else {
                log(`  [D-034] 自动重新暂停失败（API返回失败）campaign_id=${existing.id}: ${rp.message}`);
              }
            } catch (err) {
              log(`  [D-034] 自动重新暂停异常 campaign_id=${existing.id}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
            }
          }

          if (rePauseOk) {
            // 重新暂停成功：保持 PAUSED，仅刷新同步时间
            await prisma.campaigns.update({
              where: { id: existing.id },
              data: { last_google_sync_at: new Date() },
            });
          } else {
            // 重新暂停失败：同步真实状态（ENABLED），并立即发系统通知
            await prisma.campaigns.update({
              where: { id: existing.id },
              data: { google_status: "ENABLED", last_google_sync_at: new Date() },
            });
            updated++;

            const dupCutoff24h = new Date(Date.now() - 24 * 3600 * 1000);
            const alertTitle = `广告状态同步异常：${existing.campaign_name || `campaign#${existing.id}`}`;
            const dupCount = await prisma.notifications.count({
              where: {
                user_id: mcc.user_id,
                type: "alert",
                title: alertTitle,
                created_at: { gte: dupCutoff24h },
                is_deleted: 0,
              },
            });
            if (dupCount === 0) {
              const alertContent = [
                `广告系列「${existing.campaign_name}」在 CRM 已标记为「暂停」，`,
                `但 Google Ads 端反查显示仍处于「启用」状态，系统自动重新暂停失败。`,
                ``,
                `可能原因：`,
                `1. MCC 服务账号已失效或失去该 CID 的管理权限；`,
                `2. Google Ads 账号存在合规问题，限制了外部操作；`,
                `3. 网络 / API 临时异常（可尝试在 CRM「数据中心」重新点击「暂停」）。`,
                ``,
                `CID: ${existing.customer_id || "未知"}, Google Campaign ID: ${s.campaign_id}`,
              ].join("\n");
              await prisma.notifications.create({
                data: {
                  user_id: mcc.user_id,
                  type: "alert",
                  title: alertTitle,
                  content: alertContent,
                  metadata: JSON.stringify({
                    source: "D-034 syncAllCampaignStatuses",
                    campaign_id: existing.id.toString(),
                    google_campaign_id: s.campaign_id,
                    customer_id: existing.customer_id,
                    mcc_id: mcc.id.toString(),
                  }),
                },
              });
              log(`  [D-034] 已发告警通知 user_id=${mcc.user_id} campaign=${existing.campaign_name}`);
            }
          }
        } else {
          // 正常情况：直接同步状态
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

          // 复活闸门：Google 实时 ENABLED 但 CRM 无活跃行（被误删/迁移遗漏的活广告）→ 复活。
          // 商家可在多 MCC / 多 CG 账号合法重复投放；只要 Google 说 ENABLED 就以其为准，
          // 否则订单进来 CRM 失明、无法补刷（"只有订单没有点击"）。仅认 ENABLED，PAUSED/REMOVED 不复活。
          // result.count===0 已保证无活跃孪生行；同 gcid 若有多条软删行只复活最早一条，避免重建重复行（C-095 双计）。
          if (result.count === 0 && s.status === "ENABLED") {
            const softRow = await prisma.campaigns.findFirst({
              where: { user_id: mcc.user_id, google_campaign_id: s.campaign_id, is_deleted: 1 },
              orderBy: { id: "asc" },
              select: { id: true, campaign_name: true },
            });
            if (softRow) {
              await prisma.campaigns.update({
                where: { id: softRow.id },
                data: {
                  is_deleted: 0,
                  google_status: "ENABLED",
                  status: "active",
                  customer_id: s.customer_id || undefined,
                  last_google_sync_at: new Date(),
                },
              });
              updated++;
              log(`  [复活] Google 实时 ENABLED 的软删活广告 gcid=${s.campaign_id} campaign#${softRow.id} cid=${s.customer_id}`);
            }
          }
        }
      }

      // 更新 CID 可用状态（Sheet 行缺 CustomerId 时跳过，避免误改）
      const cidHasEnabled = new Map<string, boolean>();
      for (const s of statuses) {
        if (!s.customer_id) continue;
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
      // D-030：包含 status='error' 但已退避 12h 的连接（daily-sync 每天一次，
      //   退避窗口应至少跨过 1 个 cron 周期 + 缓冲）。
      //   实证：5/26 wj07 EV / 12 个 CG / MUI 504 连接因一次失败 status=error
      //   后被本 cron 永久跳过，需手动 SQL 干预。
      const backoffCutoff = new Date(Date.now() - 12 * 60 * 60 * 1000);
      const conns = await prisma.platform_connections.findMany({
        where: {
          user_id: userId,
          is_deleted: 0,
          OR: [
            { status: "connected" },
            {
              status: "error",
              OR: [
                { last_sync_attempt_at: null },
                { last_sync_attempt_at: { lt: backoffCutoff } },
              ],
            },
          ],
        },
        select: { id: true, platform: true, account_name: true, api_key: true },
      });
      const validConns = conns
        .filter((c) => c.api_key && c.api_key.length > 5)
        .sort((a, b) => Number(b.id) - Number(a.id));
      if (validConns.length === 0) {
        results[user.username] = { skipped: true, reason: "no connections" };
        continue;
      }

      log(`  Transactions for ${user.username} (${validConns.length} connections)...`);

      const { fetchAllTransactions } = await import("@/lib/platform-api");
      const { listUnsettledMonthsForUser, recomputeMonthlySettlementForUser } = await import("@/lib/monthly-settlement-tracker");
      // C-084：联盟交易同步按 CST 切日，与平台后台口径一致（推翻 C-080）
      const cstNow = nowCST();

      // 月度结算驱动：找出该用户「最早未结算月」作为同步起点
      // 已结算月（pending = 0）跳过不再请求平台 API，节省调用次数
      // 极端兜底：若用户尚无任何 monthly_settlement_status 记录，按 365 天向前拉
      const unsettledMonths = await listUnsettledMonthsForUser(userId);
      let startStr: string;
      if (unsettledMonths.length > 0) {
        startStr = `${unsettledMonths[0]}-01`;
      } else {
        startStr = cstNow.subtract(365, "day").format("YYYY-MM-DD");
      }
      const syncStart = parseTxnDateStart(startStr);
      const statsSyncStart = dateColumnStart(startStr);
      const endStr = cstNow.format("YYYY-MM-DD");

      log(`    range: ${startStr} → ${endStr} (${unsettledMonths.length} unsettled month(s))`);

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
          // D-026: 显式 log + 写库（替代 silent continue）
          if (r.error) {
            log(`    ${conn.account_name || platform} [${platform}] ERROR: ${r.error}`);
            await markConnectionFailure(conn.id, r.error);
            if (r.transactions.length === 0) continue;
          } else if (r.transactions.length === 0) {
            await markConnectionAttempted(conn.id);
            continue;
          } else {
            await markConnectionSuccess(conn.id);
          }

          // C-079：line items 聚合 + 0/0 幽灵过滤
          const aggRes = aggregateRawTransactions(r.transactions);
          const aggregatedTxns = aggRes.aggregated;
          if (aggRes.stats.merged_line_items > 0 || aggRes.stats.dropped_ghosts > 0) {
            log(`    ${user.username} ${platform}: raw=${aggRes.stats.raw_count} → ${aggregatedTxns.length} (merged=${aggRes.stats.merged_line_items}, dropped=${aggRes.stats.dropped_ghosts})`);
          }

          // 预清理：删除数据库中以 order_id 作为 transaction_id 的旧记录（防重复）
          const orderIdsToClean = aggregatedTxns
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

          // C-088：软删被合并掉的历史子行（同一订单的非代表 line item id），
          // 收敛 RW 等"拒原行+建新行"残留的陈旧行，避免一笔订单重复计数 / 状态错乱。
          if (aggRes.absorbedTxnIds.length > 0) {
            for (let ci = 0; ci < aggRes.absorbedTxnIds.length; ci += 200) {
              const batch = aggRes.absorbedTxnIds.slice(ci, ci + 200);
              await prisma.affiliate_transactions.updateMany({
                where: { platform, user_id: userId, transaction_id: { in: batch }, is_deleted: 0 },
                data: { is_deleted: 1 },
              });
            }
          }

          for (const txn of aggregatedTxns) {
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
                // C-082：transaction_time 必须随 sync 刷新为 API 的 order_time，
                // 修复历史 commit 1788f95f 导致的 last_update_time 写错。
                transaction_time: new Date(txn.transaction_time),
                commission_amount: txn.commission_amount || 0,
                status: txn.status, raw_status: txn.raw_status || "",
                order_amount: txn.order_amount || 0,
                merchant_name: txn.merchant || undefined,
                is_deleted: 0,
                // 不覆盖 platform_connection_id：保留首次写入的联盟账号归属
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
                    // 防止 API Key 共享时跨用户抢注：
                    // 若该商家在其他用户下存在且有关联的 campaign，则跳过当前用户的新建，
                    // 交易将由商家真正归属的用户同步写入。
                    const otherMerchant = await prisma.user_merchants.findFirst({
                      where: {
                        platform, merchant_id: mid, is_deleted: 0,
                        user_id: { not: userId },
                        status: { in: ["claimed", "paused", "running"] },
                      },
                      select: { id: true, user_id: true },
                    });
                    const claimedByOther = otherMerchant
                      ? await prisma.campaigns.findFirst({
                          where: { user_merchant_id: otherMerchant.id, is_deleted: 0 },
                          select: { id: true },
                        })
                      : null;
                    if (claimedByOther) {
                      // 跳过：让真正拥有该商家的用户来写交易
                      continue;
                    }
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
                merchant_id: mid,
                merchant_name: merchantName || undefined,
                // C-082：transaction_time 必须随 sync 刷新为 API 的 order_time，
                // 修复历史 commit 1788f95f 导致的 last_update_time 写错。
                transaction_time: new Date(txn.transaction_time),
                order_amount: txn.order_amount || 0,
                commission_amount: txn.commission_amount || 0,
                status: txn.status,
                raw_status: txn.raw_status || "",
                is_deleted: 0,
                ...(umId !== BigInt(0) ? { user_merchant_id: umId } : {}),
                // 不覆盖 platform_connection_id：同平台多 Key 时按连接 id 降序先同步，避免后写抢走「按账号」统计
              },
            });
            totalSynced++;
          }
        } catch (e) {
          log(`    ${conn.account_name || platform} error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (totalSynced > 0) {
        try {
          await linkTransactionsToMerchants(userId);
        } catch (e) {
          log(`    ${user.username} linkTransactions error: ${e instanceof Error ? e.message : String(e)}`);
        }
        try {
          await linkCampaignsToMerchants(userId);
        } catch (e) {
          log(`    ${user.username} linkCampaigns error: ${e instanceof Error ? e.message : String(e)}`);
        }
        try {
          await claimLinkedMerchants(userId);
        } catch (e) {
          log(`    ${user.username} claimMerchants error: ${e instanceof Error ? e.message : String(e)}`);
        }

        let reassigned: { targetUserId: number; count: number }[] = [];
        try {
          reassigned = await reassignTransactionsByRules(userId);
        } catch (e) {
          log(`    ${user.username} reassign error: ${e instanceof Error ? e.message : String(e)}`);
        }

        try {
          const commUpdated = await updateDailyStatsCommission(userId, statsSyncStart, syncStart);
          log(`    ${user.username}: updated ${commUpdated} commission records in ads_daily_stats`);
          for (const r of reassigned) {
            const targetCommUpdated = await updateDailyStatsCommission(BigInt(r.targetUserId), statsSyncStart, syncStart);
            log(`    → reassigned ${r.count} txns to user ${r.targetUserId}, updated ${targetCommUpdated} commission records`);
          }
        } catch (e) {
          log(`    ${user.username} updateCommission error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // 无论 totalSynced 是否大于 0，都要重算月份结算状态：
      // 即使本轮没有新交易，已有交易 status 可能被联盟平台改了（pending → approved）
      // 而 affiliate_transactions 已被前面的 upsert 写入，重算后才会反映到 monthly_settlement_status
      let monthsUpdated = 0;
      try {
        monthsUpdated = await recomputeMonthlySettlementForUser(userId);
      } catch (e) {
        log(`    ${user.username} recomputeMonthlySettlement error: ${e instanceof Error ? e.message : String(e)}`);
      }

      results[user.username] = { synced: totalSynced, months_recomputed: monthsUpdated };
      log(`    ${user.username}: ${totalSynced} transactions synced, ${monthsUpdated} months recomputed`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`    ${user.username} sync FAILED: ${msg}`);
      results[user.username] = { error: msg };
    }
  }
  return results;
}

// ── D-072 同步所有用户的支付/打款数据 ──

async function syncAllUsersPayments(): Promise<unknown> {
  const { fetchPlatformPayments, platformSupportsPayments } = await import("@/lib/payment-api");
  const cstNow = nowCST();
  // 每日滚动窗口：拉近 120 天的打款记录刷新（历史首次回填用手动「同步支付」按钮）
  const startStr = cstNow.subtract(120, "day").format("YYYY-MM-DD");
  const endStr = cstNow.format("YYYY-MM-DD");

  const users = await prisma.users.findMany({
    where: { is_deleted: 0, status: "active", role: { in: ["user", "leader"] } },
    select: { id: true, username: true },
  });

  const results: Record<string, unknown> = {};
  // 病灶根除：联盟支付接口按 api_key（账号级）返回，同一物理账号(api_key)即使被
  // 配置成多条连接 / 挂在不同成员名下，也只能同步一次，否则同一打款单会重复入库。
  const syncedAccounts = new Set<string>();

  for (const user of users) {
    try {
      const conns = await prisma.platform_connections.findMany({
        where: { user_id: user.id, is_deleted: 0, status: "connected" },
        select: { id: true, user_id: true, platform: true, account_name: true, api_key: true, created_at: true },
      });
      // 同主账号(同 user+平台+账号名)多连接 → 打款统一写主连接，避免账户级打款单按 api_key 重复入库
      const mainConnMap = await resolveMainConnectionMap(conns);
      const validConns = conns.filter(
        (c) => c.api_key && c.api_key.length > 5 && platformSupportsPayments(normalizePlatformCode(c.platform)),
      ).filter((c) => {
        const key = `${normalizePlatformCode(c.platform)}::${c.api_key}`;
        if (syncedAccounts.has(key)) return false;
        syncedAccounts.add(key);
        return true;
      });
      if (validConns.length === 0) continue;

      let synced = 0;
      let paidAmount = 0;
      for (const conn of validConns) {
        const platform = normalizePlatformCode(conn.platform);
        try {
          const { payments, error } = await fetchPlatformPayments(platform, conn.api_key!, startStr, endStr);
          if (error) {
            log(`    [pay] ${user.username} ${platform} ERROR: ${error}`);
            continue;
          }
          const mainConnId = mainConnMap.get(String(conn.id)) ?? conn.id;
          for (const p of payments) {
            if (p.status === "paid") paidAmount += p.amount;
            await prisma.affiliate_payments.upsert({
              where: {
                platform_platform_connection_id_payment_no: {
                  platform,
                  platform_connection_id: mainConnId,
                  payment_no: p.payment_no,
                },
              },
              create: {
                user_id: user.id, platform, platform_connection_id: mainConnId, payment_no: p.payment_no,
                source_kind: p.source_kind,
                paid_date: p.paid_date ? new Date(p.paid_date) : null,
                request_date: p.request_date ? new Date(p.request_date) : null,
                amount: p.amount, gross_amount: p.gross_amount ?? null, currency: p.currency,
                status: p.status, raw_status: p.raw_status || null, payment_type: p.payment_type ?? null,
                raw_json: p.raw_json || null,
              },
              update: {
                source_kind: p.source_kind,
                paid_date: p.paid_date ? new Date(p.paid_date) : null,
                request_date: p.request_date ? new Date(p.request_date) : null,
                amount: p.amount, gross_amount: p.gross_amount ?? null,
                status: p.status, raw_status: p.raw_status || null, payment_type: p.payment_type ?? null,
                raw_json: p.raw_json || null, is_deleted: 0,
              },
            });
            synced++;
          }
        } catch (e) {
          log(`    [pay] ${user.username} ${platform} error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (synced > 0) {
        results[user.username] = { payments_synced: synced, paid_amount: +paidAmount.toFixed(2) };
        log(`    [pay] ${user.username}: ${synced} payment records, $${paidAmount.toFixed(2)} paid`);
      }
    } catch (e) {
      results[user.username] = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  return results;
}

// ── RW/LH/LB 已付剖分（口径A 配套，交易+支付同步后执行） ──

async function carvePaidForAllUsers(): Promise<void> {
  const { markPaidFromPaymentDetails } = await import("@/lib/affiliate-paid-carve");
  const users = await prisma.users.findMany({
    where: { is_deleted: 0, status: "active", role: { in: ["user", "leader"] } },
    select: { id: true, username: true },
  });
  let totalMarked = 0;
  for (const user of users) {
    try {
      const carve = await markPaidFromPaymentDetails(user.id);
      totalMarked += carve.rows_marked_paid;
      if (carve.rows_marked_paid > 0 || carve.errors.length > 0) {
        log(`  [carve] ${user.username}: 标记 ${carve.rows_marked_paid} 笔 paid（明细 ${carve.detail_signids} 行）${carve.errors.length ? `，错误 ${carve.errors.length}` : ""}`);
      }
    } catch (e) {
      log(`  [carve] ${user.username} error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log(`  [carve] 全部完成：共标记 ${totalMarked} 笔 paid`);
}

// ── 复用的关联逻辑（简化版） ──

/**
 * MySQL 死锁（错误 1213）重试封装。
 * 并发 cron + 手动 sync 同时操作同一用户行时可能产生死锁，重试 3 次即可消除。
 */
async function executeRawRetry(sql: string, ...params: unknown[]): Promise<number> {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await prisma.$executeRawUnsafe(sql, ...params);
    } catch (e) {
      const isDeadlock =
        e instanceof Error &&
        (e.message.includes("1213") || e.message.toLowerCase().includes("deadlock"));
      if (isDeadlock && attempt < MAX_RETRIES) {
        const delayMs = attempt * 600;
        log(`  [deadlock] retry ${attempt}/${MAX_RETRIES - 1} in ${delayMs}ms`);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw e;
    }
  }
  return 0;
}

async function linkTransactionsToMerchants(userId: bigint) {
  await normalizeExistingTransactionPlatforms(userId);

  await executeRawRetry(`
    UPDATE affiliate_transactions t
    JOIN user_merchants m ON t.user_id = m.user_id AND t.merchant_id = m.merchant_id AND t.platform = m.platform
    SET t.user_merchant_id = m.id
    WHERE t.user_id = ? AND t.user_merchant_id = 0 AND t.is_deleted = 0 AND m.is_deleted = 0 AND t.merchant_id != ''
  `, userId);
  await executeRawRetry(`
    UPDATE affiliate_transactions t
    JOIN user_merchants m ON t.user_id = m.user_id AND t.merchant_id = m.merchant_id
    SET t.user_merchant_id = m.id
    WHERE t.user_id = ? AND t.user_merchant_id = 0 AND t.is_deleted = 0 AND m.is_deleted = 0 AND t.merchant_id != ''
  `, userId);
  await executeRawRetry(`
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
      DATE_FORMAT(CONVERT_TZ(transaction_time, '+00:00', '+08:00'), '%Y-%m-%d') as txn_date,
      SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
      COUNT(*) as order_count
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0 AND transaction_time >= ?
      AND ${sqlAffiliateTxnValidPlatformConnection("affiliate_transactions")}
    GROUP BY user_merchant_id, DATE_FORMAT(CONVERT_TZ(transaction_time, '+00:00', '+08:00'), '%Y-%m-%d')
  `, userId, txnStartDate);

  if (!txnAgg || txnAgg.length === 0) return 0;

  const merchantIds = [...new Set(txnAgg.map(t => t.user_merchant_id))].filter(id => id && id !== BigInt(0));
  if (merchantIds.length === 0) return 0;

  // C-095 RC-3：排除挂在已删 MCC 下的 campaigns，避免幽灵 stats 双重写入
  const deletedMccs = await prisma.google_mcc_accounts.findMany({
    where: { user_id: userId, is_deleted: 1 },
    select: { id: true },
  });
  const deletedMccIds = deletedMccs.map((m) => m.id);

  const allCampaigns = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      user_merchant_id: { in: merchantIds },
      is_deleted: 0,
      ...(deletedMccIds.length > 0
        ? { OR: [{ mcc_id: null }, { mcc_id: { notIn: deletedMccIds } }] }
        : {}),
    },
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
