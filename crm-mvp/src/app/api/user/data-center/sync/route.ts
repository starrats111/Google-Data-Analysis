import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError, normalizePlatformCode } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { syncFromSheet } from "@/lib/sheet-sync";
import { cacheDelete } from "@/lib/cache";
import { todayCST, yesterdayCST, nowCST, parseCSTDateStart, parseCSTDateEndExclusive, isTodayCST } from "@/lib/date-utils";
import { getExchangeRate, preloadRates } from "@/lib/exchange-rate";
import { autoLinkAndCreateMerchants, syncMerchantStatusFromCampaigns, parseCampaignNameFull } from "@/lib/campaign-merchant-link";

/**
 * POST /api/user/data-center/sync
 *
 * 统一同步入口：广告数据 + 联盟交易，一键完成
 * 首次同步自动从 MCC 创建时间起拉取历史数据
 * 支持 force_full_sync=true 强制全量重跑
 */
const TRANSACTION_FULL_SYNC_START = "2025-01-01";

function isValidDateString(value?: string): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json();
  const {
    type = "all",
    mcc_account_id,
    force_full_sync: forceFullSync = false,
    sync_start_date,
    sync_end_date,
  } = body;

  if (!["all", "ads", "platform"].includes(type)) {
    return apiError("type 必须是 all / ads / platform", 400);
  }

  if (sync_start_date && !isValidDateString(sync_start_date)) {
    return apiError("sync_start_date 格式必须为 YYYY-MM-DD", 400);
  }
  if (sync_end_date && !isValidDateString(sync_end_date)) {
    return apiError("sync_end_date 格式必须为 YYYY-MM-DD", 400);
  }
  if (sync_start_date && sync_end_date && sync_start_date > sync_end_date) {
    return apiError("开始时间不能晚于结束时间", 400);
  }

  const userId = BigInt(user.userId);
  const results: Record<string, unknown> = {};
  let mcc: {
    id: bigint;
    mcc_id: string;
    sheet_url: string | null;
    service_account_json: string | null;
    developer_token: string | null;
    currency: string;
    created_at: Date;
  } | null = null;

  if (type === "all" || type === "ads") {
    if (!mcc_account_id) return apiError("缺少 mcc_account_id", 400);
    mcc = await prisma.google_mcc_accounts.findFirst({
      where: { id: BigInt(mcc_account_id), user_id: userId, is_deleted: 0 },
    });
    if (!mcc) return apiError("MCC 账户不存在", 404);
    results.ads = await syncAdsData(mcc, userId, forceFullSync, sync_start_date, sync_end_date);
  }

  // 关联 campaigns 与 merchants（自动查找或创建商家，商家状态跟随广告系列）
  await autoLinkAndCreateMerchants(userId);
  await syncMerchantStatusFromCampaigns(userId);
  await linkTransactionsToMerchants(userId);

  // type=all 时同步联盟交易（合并原来独立的 sync-transactions 功能）
  if (type === "all" || type === "platform") {
    results.transactions = await syncTransactionsInline(userId, {
      startDate: sync_start_date,
      endDate: sync_end_date,
      forceFullSync,
    });
  }

  // 清除相关缓存
  cacheDelete(`mcc:${user.userId}`, true);

  return apiSuccess(serializeData(results));
}

/**
 * 广告数据同步
 * 首次同步：拉取 MCC 创建时间起的全部历史数据（Sheet + Google Ads API）
 * 后续同步：Sheet 近31天 + Google Ads API 今日
 * force_full_sync: 强制全量重新同步
 * sync_start_date: 指定起始日期（覆盖自动计算）
 * sync_end_date: 指定结束日期（覆盖自动计算）
 */
async function syncAdsData(
  mcc: { id: bigint; mcc_id: string; sheet_url: string | null; service_account_json: string | null; developer_token: string | null; currency: string; created_at: Date },
  userId: bigint,
  forceFullSync = false,
  syncStartDate?: string,
  syncEndDate?: string,
) {
  const todayStr = todayCST();
  const yesterdayStr = yesterdayCST();
  const cstNow = nowCST();
  const customRange = !!(syncStartDate || syncEndDate);

  let sheetResult = { inserted: 0, updated: 0, message: "" };
  let apiResult = { inserted: 0, updated: 0, message: "" };

  // 检测是否首次同步：该 MCC 在 ads_daily_stats 中是否有数据
  const existingStatsCount = forceFullSync ? 0 : await prisma.ads_daily_stats.count({
    where: {
      user_id: userId,
      campaign_id: {
        in: (await prisma.campaigns.findMany({
          where: { user_id: userId, mcc_id: mcc.id, is_deleted: 0 },
          select: { id: true },
        })).map(c => c.id),
      },
    },
  });
  const isFirstSync = existingStatsCount === 0;

  // 动态起始日期：用户指定 > MCC 创建时间 > 默认31天
  const mccCreatedStr = mcc.created_at.toISOString().split("T")[0];
  const defaultHistoryStart = isFirstSync ? mccCreatedStr : cstNow.subtract(31, "day").format("YYYY-MM-DD");
  const historyStart = syncStartDate || defaultHistoryStart;
  const historyEnd = syncEndDate || ((forceFullSync || customRange) ? todayStr : yesterdayStr);
  const sheetEnd = historyEnd > yesterdayStr ? yesterdayStr : historyEnd;
  const includeTodayApi = historyEnd >= todayStr;
  const apiHistoryEnd = includeTodayApi ? yesterdayStr : historyEnd;

  // 预加载汇率快照到缓存
  await preloadRates(mcc.currency, historyStart, historyEnd);

  // 1. Sheet 同步
  if (mcc.sheet_url) {
    if (sheetEnd >= historyStart) {
      console.log(`[Sync] Sheet 同步范围: ${historyStart} → ${sheetEnd} (${forceFullSync || customRange || isFirstSync ? "指定/全量" : "增量"})`);
      const sheetData = await syncFromSheet(mcc.sheet_url, historyStart, sheetEnd);
      if (sheetData.success && sheetData.rows.length > 0) {
        sheetResult = await upsertSheetRowsBatch(sheetData.rows, mcc.id, userId, mcc.currency);
      } else {
        sheetResult.message = sheetData.message || "Sheet 无数据";
      }
    } else {
      sheetResult.message = "所选时间范围内无需同步 Sheet 数据";
    }
  } else {
    sheetResult.message = "未配置 Sheet URL";
  }

  // 2. Google Ads API 同步
  if (mcc.service_account_json) {
    try {
      const { fetchTodayCampaignData, fetchCampaignDataByDateRange, listMccChildAccounts } = await import("@/lib/google-ads");
      const credentials = {
        mcc_id: mcc.mcc_id,
        developer_token: mcc.developer_token || "",
        service_account_json: mcc.service_account_json,
      };

      const cids = await prisma.mcc_cid_accounts.findMany({
        where: { mcc_account_id: mcc.id, is_deleted: 0, status: "active" },
        take: 50,
      });

      let apiDiscoveredCids: string[] = [];
      if (cids.length === 0) {
        try {
          const childAccounts = await listMccChildAccounts(credentials);
          apiDiscoveredCids = childAccounts.map((c) => c.customer_id);
          console.log(`[Sync] CID 表为空，从 MCC API 发现 ${apiDiscoveredCids.length} 个子账户`);
        } catch (err) {
          console.error("[Sync] 从 MCC 获取子账户失败:", err);
        }
      }

      const existingCampaigns = await prisma.campaigns.findMany({
        where: { user_id: userId, mcc_id: mcc.id, is_deleted: 0 },
      });
      const campaignMap = new Map(existingCampaigns.map((c) => [c.google_campaign_id, c]));

      const apiMerchants = await prisma.user_merchants.findMany({
        where: { user_id: userId, is_deleted: 0 },
        select: { id: true, platform: true, merchant_id: true },
      });
      const apiMerchantIndex = new Map(
        apiMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m.id])
      );

      let totalInserted = 0, totalUpdated = 0;

      // ─── 历史范围同步：首次同步 / 指定时间 / 全量同步 ───
      const shouldSyncHistory = cids.length > 0 && apiHistoryEnd >= historyStart && (isFirstSync || forceFullSync || customRange);
      if (shouldSyncHistory) {
        console.log(`[Sync] 历史范围同步：拉取 ${historyStart} → ${apiHistoryEnd} 的广告数据`);
        const CID_CONCURRENCY = 2;
        for (let ci = 0; ci < cids.length; ci += CID_CONCURRENCY) {
          const batch = cids.slice(ci, ci + CID_CONCURRENCY);
          for (const cid of batch) {
            try {
              const historyData = await fetchCampaignDataByDateRange(
                credentials, cid.customer_id, historyStart, apiHistoryEnd
              );
              console.log(`[Sync] CID ${cid.customer_id} 历史数据: ${historyData.length} 条`);

              for (const cd of historyData) {
                let campaign = campaignMap.get(cd.campaign_id);
                if (!campaign) {
                  const parsed = parseCampaignNameFull(cd.campaign_name);
                  const merchantId = parsed ? (apiMerchantIndex.get(`${parsed.platform}_${parsed.mid}`) || BigInt(0)) : BigInt(0);
                  campaign = await prisma.campaigns.create({
                    data: {
                      user_id: userId, user_merchant_id: merchantId,
                      google_campaign_id: cd.campaign_id, mcc_id: mcc.id,
                      customer_id: cd.customer_id, campaign_name: cd.campaign_name,
                      daily_budget: cd.budget_dollars, target_country: "US",
                      google_status: cd.campaign_status, last_google_sync_at: new Date(),
                    },
                  });
                  campaignMap.set(cd.campaign_id, campaign);
                } else if (!campaign.customer_id && cd.customer_id) {
                  await prisma.campaigns.update({
                    where: { id: campaign.id },
                    data: { customer_id: cd.customer_id },
                  });
                  campaign.customer_id = cd.customer_id;
                }

                const dateObj = new Date(cd.date);
                const dateRate = await getExchangeRate(mcc.currency, cd.date);
                if (dateRate <= 0) {
                  console.warn(`[Sync] 跳过 campaign ${cd.campaign_id} ${cd.date}：汇率不可用`);
                  continue;
                }
                const statsData = {
                  budget: cd.budget_dollars * dateRate,
                  cost: cd.cost_dollars * dateRate,
                  clicks: cd.clicks, impressions: cd.impressions,
                  cpc: cd.cpc_dollars * dateRate,
                  conversions: cd.conversions, data_source: "api" as const,
                };

                await prisma.ads_daily_stats.upsert({
                  where: { campaign_id_date: { campaign_id: campaign.id, date: dateObj } },
                  update: statsData,
                  create: { user_id: userId, user_merchant_id: BigInt(0), campaign_id: campaign.id, date: dateObj, ...statsData },
                });
                totalInserted++;
              }
            } catch (err) {
              console.error(`[Sync] CID ${cid.customer_id} 历史同步失败:`, err);
            }
          }
        }
      }

      // ─── 近期数据同步（含今日）：用昨天~今天的日期范围替代 DURING TODAY，修复时区偏移 ───
      const cidDataMap = new Map<string, Awaited<ReturnType<typeof fetchTodayCampaignData>>>();
      const recentStatsMap = new Map<string, bigint>();

      if (includeTodayApi) {
        const CID_CONCURRENCY = 3;
        for (let ci = 0; ci < cids.length; ci += CID_CONCURRENCY) {
          const batch = cids.slice(ci, ci + CID_CONCURRENCY);
          const results = await Promise.all(
            batch.map(async (cid) => {
              try {
                return { id: cid.customer_id, data: await fetchTodayCampaignData(credentials, cid.customer_id, { startDate: yesterdayStr, endDate: todayStr }) };
              } catch (err) {
                console.error(`CID ${cid.customer_id} 同步失败:`, err);
                return { id: cid.customer_id, data: [] as Awaited<ReturnType<typeof fetchTodayCampaignData>> };
              }
            })
          );
          for (const r of results) cidDataMap.set(r.id, r.data);
        }

        const recentDates = [new Date(yesterdayStr), new Date(todayStr)];
        const existingRecentStats = await prisma.ads_daily_stats.findMany({
          where: { user_id: userId, date: { in: recentDates } },
          select: { id: true, campaign_id: true, date: true },
        });
        for (const stat of existingRecentStats) {
          const dateKey = stat.date.toISOString().split("T")[0];
          recentStatsMap.set(`${stat.campaign_id}_${dateKey}`, stat.id);
        }
      }

      for (const cid of cids) {
        const campaignData = cidDataMap.get(cid.customer_id) || [];
        if (!includeTodayApi || campaignData.length === 0) continue;

        const operations: (() => Promise<unknown>)[] = [];

        for (const cd of campaignData) {
          let campaign = campaignMap.get(cd.campaign_id);

          if (!campaign) {
            const parsed = parseCampaignNameFull(cd.campaign_name);
            const merchantId = parsed ? (apiMerchantIndex.get(`${parsed.platform}_${parsed.mid}`) || BigInt(0)) : BigInt(0);
            campaign = await prisma.campaigns.create({
              data: {
                user_id: userId, user_merchant_id: merchantId,
                google_campaign_id: cd.campaign_id, mcc_id: mcc.id,
                customer_id: cd.customer_id, campaign_name: cd.campaign_name,
                daily_budget: cd.budget_dollars, target_country: "US",
                google_status: cd.campaign_status, last_google_sync_at: new Date(),
              },
            });
            campaignMap.set(cd.campaign_id, campaign);
          } else {
            const updateData: Record<string, unknown> = {
              daily_budget: cd.budget_dollars, google_status: cd.campaign_status, last_google_sync_at: new Date(),
            };
            if (!campaign.customer_id && cd.customer_id) {
              updateData.customer_id = cd.customer_id;
              campaign.customer_id = cd.customer_id;
            }
            operations.push(() => prisma.campaigns.update({
              where: { id: campaign!.id },
              data: updateData,
            }));
          }

          const dataDate = cd.date;
          const dateRate = await getExchangeRate(mcc.currency, dataDate);
          if (dateRate <= 0) {
            console.warn(`[Sync] 跳过 campaign ${cd.campaign_id} ${dataDate}：汇率不可用`);
            continue;
          }
          const dateObj = new Date(dataDate);
          const statsData = { budget: cd.budget_dollars * dateRate, cost: cd.cost_dollars * dateRate, clicks: cd.clicks, impressions: cd.impressions, cpc: cd.cpc_dollars * dateRate, conversions: cd.conversions, data_source: "api" as const };
          const statsKey = `${campaign.id}_${dataDate}`;
          const existingStatsId = recentStatsMap.get(statsKey);
          if (existingStatsId) {
            operations.push(() => prisma.ads_daily_stats.update({ where: { id: existingStatsId }, data: statsData }));
            totalUpdated++;
          } else {
            operations.push(() => prisma.ads_daily_stats.create({
              data: { user_id: userId, user_merchant_id: BigInt(0), campaign_id: campaign!.id, date: dateObj, ...statsData },
            }).then(s => { recentStatsMap.set(`${campaign!.id}_${dataDate}`, s.id); }));
            totalInserted++;
          }
        }

        for (let i = 0; i < operations.length; i += 30) {
          await Promise.all(operations.slice(i, i + 30).map(op => op()));
        }

        const enabledCids = campaignData.filter(cd => cd.campaign_status === "ENABLED").map(cd => cd.customer_id);
        if (enabledCids.length > 0) {
          await prisma.mcc_cid_accounts.updateMany({
            where: { mcc_account_id: mcc.id, customer_id: { in: enabledCids } },
            data: { is_available: "N" },
          });
        }
      }

      // ─── 全量同步所有广告系列状态 ───
      try {
        const { fetchAllCampaignStatuses } = await import("@/lib/google-ads");
        const cidSet = new Set([
          ...cids.map((c) => c.customer_id),
          ...apiDiscoveredCids,
          ...[...campaignMap.values()].map((c) => c.customer_id).filter(Boolean) as string[],
        ]);
        const allCidIds = [...cidSet];
        console.log(`[Sync] 全量同步 CID 列表: ${allCidIds.length} 个`);
        const { statuses: allStatuses, disabledCids } = await fetchAllCampaignStatuses(credentials, allCidIds);

        // 对于被停用的 CID，将其下所有 campaign 标记为 PAUSED
        if (disabledCids.length > 0) {
          console.log(`[Sync] 停用的 CID: ${disabledCids.join(", ")}，将其 campaign 标记为 PAUSED`);
          await prisma.campaigns.updateMany({
            where: { user_id: userId, customer_id: { in: disabledCids }, is_deleted: 0, google_status: { not: "PAUSED" } },
            data: { google_status: "PAUSED", last_google_sync_at: new Date() },
          });
        }

        const statusUpdateOps: (() => Promise<unknown>)[] = [];
        const statusCreateOps: Array<{ cs: typeof allStatuses[0]; merchantId: bigint }> = [];

        for (const cs of allStatuses) {
          const existing = campaignMap.get(cs.campaign_id);
          if (existing) {
            const needsUpdate = existing.google_status !== cs.status || existing.campaign_name !== cs.name || (!existing.customer_id && cs.customer_id);
            if (needsUpdate) {
              const updateData: Record<string, unknown> = {
                google_status: cs.status, campaign_name: cs.name, daily_budget: cs.budget_dollars, last_google_sync_at: new Date(),
              };
              if (!existing.customer_id && cs.customer_id) {
                updateData.customer_id = cs.customer_id;
              }
              statusUpdateOps.push(() => prisma.campaigns.update({
                where: { id: existing.id },
                data: updateData,
              }));
            }
          } else {
            const parsed = parseCampaignNameFull(cs.name);
            const merchantId = parsed ? (apiMerchantIndex.get(`${parsed.platform}_${parsed.mid}`) || BigInt(0)) : BigInt(0);
            statusCreateOps.push({ cs, merchantId });
          }
        }

        for (let i = 0; i < statusUpdateOps.length; i += 50) {
          await Promise.all(statusUpdateOps.slice(i, i + 50).map(fn => fn()));
        }

        for (let i = 0; i < statusCreateOps.length; i += 30) {
          const batch = statusCreateOps.slice(i, i + 30);
          const results = await Promise.all(batch.map(({ cs, merchantId }) =>
            prisma.campaigns.create({
              data: {
                user_id: userId, user_merchant_id: merchantId,
                google_campaign_id: cs.campaign_id, mcc_id: mcc.id,
                customer_id: cs.customer_id, campaign_name: cs.name,
                daily_budget: cs.budget_dollars, target_country: "US",
                google_status: cs.status, last_google_sync_at: new Date(),
              },
            })
          ));
          for (const newCampaign of results) {
            campaignMap.set(newCampaign.google_campaign_id!, newCampaign);
          }
          totalInserted += results.length;
        }
      } catch (err) {
        console.error("全量状态同步失败:", err);
      }

      apiResult = { inserted: totalInserted, updated: totalUpdated, message: `API 同步完成${(isFirstSync || forceFullSync || customRange) ? `（${historyStart} → ${historyEnd}）` : ""}` };
    } catch (err) {
      apiResult.message = `API 同步失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    apiResult.message = "未配置服务账号";
  }

  return { sheet: sheetResult, api: apiResult };
}

/**
 * Sheet 数据批量 upsert — 消除 N+1
 */
async function upsertSheetRowsBatch(
  rows: { date: string; campaign_id: string; campaign_name: string; customer_id: string; cost: number; budget: number; clicks: number; impressions: number; cpc: number; status: string }[],
  mccId: bigint,
  userId: bigint,
  currency: string = "USD",
) {
  let inserted = 0, updated = 0;

  // ─── 1. 批量预加载所有相关 campaigns（存在重复时优先选有 customer_id 的） ───
  const uniqueCampaignIds = [...new Set(rows.map((r) => r.campaign_id))];
  const existingCampaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, google_campaign_id: { in: uniqueCampaignIds }, is_deleted: 0 },
  });
  const campaignMap = new Map<string | null, typeof existingCampaigns[0]>();
  for (const c of existingCampaigns) {
    const existing = campaignMap.get(c.google_campaign_id);
    if (!existing || (!existing.customer_id && c.customer_id) || (!existing.customer_id === !c.customer_id && Number(c.id) > Number(existing.id))) {
      campaignMap.set(c.google_campaign_id, c);
    }
  }

  // ─── 2. 创建缺失的 campaigns（批量），尝试从广告名解析商家关联 ───
  const missingIds = uniqueCampaignIds.filter((id) => !campaignMap.has(id));
  if (missingIds.length > 0) {
    const userMerchants = await prisma.user_merchants.findMany({
      where: { user_id: userId, is_deleted: 0 },
      select: { id: true, platform: true, merchant_id: true },
    });
    const merchantIndex = new Map(
      userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m.id])
    );

    const firstRowByGid = new Map(rows.map((r) => [r.campaign_id, r]));
    for (const gid of missingIds) {
      const row = firstRowByGid.get(gid)!;
      const parsed = parseCampaignNameFull(row.campaign_name);
      const merchantId = parsed ? (merchantIndex.get(`${parsed.platform}_${parsed.mid}`) || BigInt(0)) : BigInt(0);

      const campaign = await prisma.campaigns.create({
        data: {
          user_id: userId, user_merchant_id: merchantId,
          google_campaign_id: gid, mcc_id: mccId,
          customer_id: row.customer_id, campaign_name: row.campaign_name,
          daily_budget: row.budget, target_country: "US",
          google_status: row.status, last_google_sync_at: new Date(),
        },
      });
      campaignMap.set(gid, campaign);
    }
  }

  // ─── 3. 批量预加载已有的 daily_stats ───
  const campaignDbIds = [...campaignMap.values()].map((c) => c.id);
  const dates = [...new Set(rows.map((r) => r.date))];
  const existingStats = await prisma.ads_daily_stats.findMany({
    where: {
      campaign_id: { in: campaignDbIds },
      date: { in: dates.map((d) => new Date(d)) },
    },
    select: { id: true, campaign_id: true, date: true },
  });
  const statsKeyMap = new Map(
    existingStats.map((s) => [`${s.campaign_id}_${s.date.toISOString().split("T")[0]}`, s.id])
  );

  // ─── 4. 批量 upsert（每 20 条一批，按日期获取汇率） ───
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    await Promise.all(batch.map(async (row) => {
      const campaign = campaignMap.get(row.campaign_id)!;
      const statsKey = `${campaign.id}_${row.date}`;
      const existingId = statsKeyMap.get(statsKey);

      const rate = await getExchangeRate(currency, row.date);
      if (rate <= 0) {
        console.warn(`[Sheet] 跳过 ${row.campaign_id} ${row.date}：汇率不可用`);
        return;
      }
      const convertedCost = row.cost * rate;
      const convertedBudget = row.budget * rate;
      const convertedCpc = row.cpc * rate;

      if (existingId) {
        updated++;
        await prisma.ads_daily_stats.update({
          where: { id: existingId },
          data: { budget: convertedBudget, cost: convertedCost, clicks: row.clicks, impressions: row.impressions, cpc: convertedCpc, data_source: "sheet" },
        });
      } else {
        inserted++;
        await prisma.ads_daily_stats.create({
          data: { user_id: userId, user_merchant_id: BigInt(0), campaign_id: campaign.id, date: new Date(row.date), budget: convertedBudget, cost: convertedCost, clicks: row.clicks, impressions: row.impressions, cpc: convertedCpc, data_source: "sheet" },
        });
      }
    }));
  }

  // ─── 5. 批量更新 CID 状态 ───
  const enabledCids = [...new Set(rows.filter((r) => r.status === "ENABLED").map((r) => r.customer_id))].filter(Boolean);
  if (enabledCids.length > 0) {
    await prisma.mcc_cid_accounts.updateMany({
      where: { mcc_account_id: mccId, customer_id: { in: enabledCids } },
      data: { is_available: "N" },
    });
  }

  // 更新已有 campaigns 的信息（批量）
  const latestRowByCampaign = new Map<string, typeof rows[0]>();
  for (const row of rows) {
    latestRowByCampaign.set(row.campaign_id, row); // 取最后一条
  }
  const updateOps = [...latestRowByCampaign.entries()]
    .filter(([gid]) => !missingIds.includes(gid))
    .map(([gid, row]) => {
      const campaign = campaignMap.get(gid)!;
      const updateData: Record<string, unknown> = {
        campaign_name: row.campaign_name, daily_budget: row.budget,
        google_status: row.status, last_google_sync_at: new Date(),
      };
      if (row.customer_id) updateData.customer_id = row.customer_id;
      return prisma.campaigns.update({
        where: { id: campaign.id },
        data: updateData,
      });
    });
  // 每 20 条一批
  for (let i = 0; i < updateOps.length; i += 20) {
    await Promise.all(updateOps.slice(i, i + 20));
  }

  return { inserted, updated, message: `Sheet 同步完成` };
}



/**
 * 关联 affiliate_transactions 与 user_merchants
 * 1. 先规范化已有交易的 platform 字段
 * 2. 精确匹配: normalized_platform + merchant_id
 * 3. 仅 merchant_id 兜底匹配
 * 4. 按商家名称兜底匹配（merchant_id 为空时）
 */
async function linkTransactionsToMerchants(userId: bigint) {
  await normalizeExistingTransactionPlatforms(userId);

  // 精确匹配：platform + merchant_id（单条 SQL 替代 N 次循环）
  await prisma.$executeRawUnsafe(`
    UPDATE affiliate_transactions t
    JOIN user_merchants m
      ON t.user_id = m.user_id AND t.merchant_id = m.merchant_id AND t.platform = m.platform
    SET t.user_merchant_id = m.id
    WHERE t.user_id = ? AND t.user_merchant_id = 0 AND t.is_deleted = 0 AND m.is_deleted = 0
      AND t.merchant_id != ''
  `, userId);

  // 兜底匹配：仅 merchant_id
  await prisma.$executeRawUnsafe(`
    UPDATE affiliate_transactions t
    JOIN user_merchants m
      ON t.user_id = m.user_id AND t.merchant_id = m.merchant_id
    SET t.user_merchant_id = m.id
    WHERE t.user_id = ? AND t.user_merchant_id = 0 AND t.is_deleted = 0 AND m.is_deleted = 0
      AND t.merchant_id != ''
  `, userId);

  // 兜底匹配：按商家名称（merchant_id 为空时尝试用名称匹配）
  await prisma.$executeRawUnsafe(`
    UPDATE affiliate_transactions t
    JOIN user_merchants m
      ON t.user_id = m.user_id AND t.merchant_name = m.merchant_name AND t.platform = m.platform
    SET t.user_merchant_id = m.id
    WHERE t.user_id = ? AND t.user_merchant_id = 0 AND t.is_deleted = 0 AND m.is_deleted = 0
      AND t.merchant_name != ''
  `, userId);
}

/**
 * 批量规范化已有交易的 platform 字段
 */
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

async function updateDailyStatsCommissionByRange(userId: bigint, startDate: Date, endExclusive: Date): Promise<number> {
  // 使用 DATE_FORMAT 返回字符串（避免 Date 对象在 UTC+8 服务器上 String() 产生本地格式导致解析错误）
  const txnAgg = await prisma.$queryRawUnsafe<
    { user_merchant_id: bigint; txn_date: string; total_commission: number; rejected_commission: number; order_count: number }[]
  >(`
    SELECT 
      user_merchant_id,
      DATE_FORMAT(transaction_time, '%Y-%m-%d') as txn_date,
      SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
      COUNT(*) as order_count
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0 AND transaction_time >= ? AND transaction_time < ?
    GROUP BY user_merchant_id, DATE_FORMAT(transaction_time, '%Y-%m-%d')
  `, userId, startDate, endExclusive);

  if (!txnAgg || txnAgg.length === 0) return 0;

  // 强制转换为 BigInt，避免 MariaDB 驱动对小数值返回 number 类型导致 Prisma 类型校验失败
  const merchantIds = [...new Set(txnAgg.map((t) => BigInt(String(t.user_merchant_id ?? 0))))]
    .filter((id) => id !== BigInt(0));
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

  const allCampaignIds = allCampaigns.map((c) => c.id);

  // 使用原始 SQL + DATE_FORMAT 读取日期字符串，避免 Date 对象时区转换导致的日期偏差
  type StatsRow = { id: bigint; campaign_id: bigint; date_str: string };
  const allStatsRaw: StatsRow[] = allCampaignIds.length > 0
    ? await prisma.$queryRawUnsafe<StatsRow[]>(
        `SELECT id, campaign_id, DATE_FORMAT(date, '%Y-%m-%d') as date_str
         FROM ads_daily_stats
         WHERE campaign_id IN (${allCampaignIds.map(() => "?").join(",")})
           AND date >= ? AND date < ?`,
        ...allCampaignIds, startDate, endExclusive
      )
    : [];

  const statsMap = new Map<string, bigint>();
  for (const s of allStatsRaw) {
    statsMap.set(
      `${BigInt(String(s.campaign_id ?? 0))}_${s.date_str}`,
      BigInt(String(s.id ?? 0))
    );
  }

  const ops: (() => Promise<unknown>)[] = [];
  let updated = 0;

  for (const agg of txnAgg) {
    const umid = BigInt(String(agg.user_merchant_id ?? 0));
    if (umid === BigInt(0)) continue;

    const campaignIds = campaignsByMerchant.get(String(umid));
    if (!campaignIds?.length) continue;

    // txn_date 现在始终是 "YYYY-MM-DD" 字符串（来自 DATE_FORMAT）
    const txnDateStr = String(agg.txn_date);
    const commData = {
      commission: Number(agg.total_commission),
      rejected_commission: Number(agg.rejected_commission),
      orders: Number(agg.order_count),
    };

    let wrote = false;
    for (const cid of campaignIds) {
      const statsId = statsMap.get(`${cid}_${txnDateStr}`);
      if (statsId) {
        if (!wrote) {
          ops.push(() => prisma.ads_daily_stats.update({ where: { id: statsId }, data: commData }));
          wrote = true;
          updated++;
        } else {
          ops.push(() => prisma.ads_daily_stats.update({ where: { id: statsId }, data: { commission: 0, rejected_commission: 0, orders: 0 } }));
        }
      }
    }

    if (!wrote) {
      ops.push(() => prisma.ads_daily_stats.create({
        data: {
          user_id: userId,
          user_merchant_id: umid,
          campaign_id: campaignIds[0],
          date: new Date(`${txnDateStr}T00:00:00.000Z`),
          cost: 0,
          clicks: 0,
          impressions: 0,
          ...commData,
        },
      }).catch(() => {}));
      updated++;
    }
  }

  for (let i = 0; i < ops.length; i += 50) {
    await Promise.all(ops.slice(i, i + 50).map((fn) => fn()));
  }

  return updated;
}

/**
 * 内联交易同步 — 从各联盟平台 API 拉取最新交易数据
 * 替代独立的 sync-transactions 接口，合并到主同步流程
 */
async function syncTransactionsInline(
  userId: bigint,
  options: { startDate?: string; endDate?: string; forceFullSync?: boolean } = {},
) {
  try {
    const connections = await prisma.platform_connections.findMany({
      where: { user_id: userId, is_deleted: 0, status: "connected" },
      select: { id: true, platform: true, account_name: true, api_key: true },
    });
    const validConns = connections.filter((c) => c.api_key && c.api_key.length > 5);
    if (validConns.length === 0) return { synced: 0, message: "无可用平台连接" };

    const cstNow = nowCST();

    // 检测首次交易同步：是否有该用户的交易数据
    const existingTxnCount = await prisma.affiliate_transactions.count({
      where: { user_id: userId, is_deleted: 0 },
    });
    const isFirstTxnSync = existingTxnCount === 0;
    const customRange = !!(options.startDate || options.endDate);
    const startStr = options.startDate
      || (options.forceFullSync
        ? TRANSACTION_FULL_SYNC_START
        : isFirstTxnSync
          ? cstNow.subtract(365, "day").format("YYYY-MM-DD")
          : cstNow.subtract(120, "day").format("YYYY-MM-DD"));
    const endStr = options.endDate || cstNow.format("YYYY-MM-DD");
    const startDate = parseCSTDateStart(startStr);
    const endExclusive = isTodayCST(endStr, cstNow) ? cstNow.toDate() : parseCSTDateEndExclusive(endStr);

    console.log(`[Sync] 交易同步范围: ${startStr} → ${endStr} (${options.forceFullSync ? "手动全量" : customRange ? "指定时间" : isFirstTxnSync ? "首次-全量" : "增量120天"})`);

    const userMerchants = await prisma.user_merchants.findMany({
      where: { user_id: userId, is_deleted: 0 },
      select: { id: true, merchant_id: true, platform: true, merchant_name: true },
    });
    const merchantMap = new Map(
      userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m])
    );

    const { fetchAllTransactions } = await import("@/lib/platform-api");
    let totalSynced = 0;
    const errors: string[] = [];

    for (const conn of validConns) {
      const platform = normalizePlatformCode(conn.platform);
      const label = conn.account_name || platform;
      try {
        const r = await fetchAllTransactions(platform, conn.api_key!, startStr, endStr);
        if (r.error) errors.push(`${label}: ${r.error}`);
        if (r.transactions.length === 0) continue;

        const dedupedTxns = r.transactions.filter((t) => !!t.transaction_id);

        // 诊断日志：打印 API 拉取总览，帮助验证佣金准确性
        const apiTotalComm = dedupedTxns.reduce((s, t) => s + (t.commission_amount || 0), 0);
        const apiTotalOrder = dedupedTxns.reduce((s, t) => s + (t.order_amount || 0), 0);
        const zeroCommCount = dedupedTxns.filter((t) => t.commission_amount === 0 && t.order_amount > 0).length;
        console.log(`[SyncDiag] ${label}: ${dedupedTxns.length} 条交易, 总佣金=$${apiTotalComm.toFixed(2)}, 总订单额=$${apiTotalOrder.toFixed(2)}, 零佣金但有订单额=${zeroCommCount} 条`);

        // 自动创建缺失的 user_merchants
        for (const txn of dedupedTxns) {
          const mid = txn.merchant_id || "";
          if (!mid) continue;
          const key = `${platform}_${mid}`;
          if (!merchantMap.has(key)) {
            try {
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
              merchantMap.set(key, existing);
            } catch { /* race condition */ }
          }
        }

        // 批量 upsert 交易
        for (let i = 0; i < dedupedTxns.length; i += 50) {
          const batch = dedupedTxns.slice(i, i + 50);
          const ops = batch.map((txn) => {
            const mid = txn.merchant_id || "";
            const txnId = txn.transaction_id;
            if (!txnId) return null;
            const merchant = merchantMap.get(`${platform}_${mid}`);
            const userMerchantId = merchant ? merchant.id : BigInt(0);
            const merchantName = txn.merchant || merchant?.merchant_name || "";

            return prisma.affiliate_transactions.upsert({
              where: { platform_transaction_id: { platform, transaction_id: txnId } },
              create: {
                user_id: userId, user_merchant_id: userMerchantId, platform_connection_id: conn.id,
                platform, merchant_id: mid, merchant_name: merchantName, transaction_id: txnId,
                transaction_time: new Date(txn.transaction_time), order_amount: txn.order_amount || 0,
                commission_amount: txn.commission_amount || 0, currency: "USD",
                status: txn.status, raw_status: txn.raw_status || "",
              },
              update: {
                platform_connection_id: conn.id, merchant_id: mid,
                ...(userMerchantId !== BigInt(0) ? { user_merchant_id: userMerchantId } : {}),
                commission_amount: txn.commission_amount || 0,
                status: txn.status, raw_status: txn.raw_status || "",
                order_amount: txn.order_amount || 0,
                merchant_name: merchantName || undefined,
                is_deleted: 0,
              },
            });
          }).filter(Boolean);
          await Promise.all(ops);
          totalSynced += ops.length;
        }
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 关联交易和 campaigns 到正确的商家（自动创建缺失商家，状态跟随广告）
    await linkTransactionsToMerchants(userId);
    await autoLinkAndCreateMerchants(userId);
    await syncMerchantStatusFromCampaigns(userId);

    await prisma.ads_daily_stats.updateMany({
      where: { user_id: userId, date: { gte: startDate, lt: endExclusive } },
      data: { commission: 0, rejected_commission: 0, orders: 0 },
    });
    const commissionUpdated = await updateDailyStatsCommissionByRange(userId, startDate, endExclusive);

    const msg = errors.length > 0 ? `同步 ${totalSynced} 条，${errors.length} 个错误` : `同步 ${totalSynced} 条`;
    return { synced: totalSynced, errors, commission_updated: commissionUpdated, message: `${msg}，更新 ${commissionUpdated} 条佣金` };
  } catch (err) {
    return { synced: 0, message: `交易同步失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}
