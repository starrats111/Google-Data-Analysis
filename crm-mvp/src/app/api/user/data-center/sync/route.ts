import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError, normalizePlatformCode } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { syncFromSheet } from "@/lib/sheet-sync";
import { cacheDelete } from "@/lib/cache";
import { todayCST, yesterdayCST, nowCST } from "@/lib/date-utils";

/**
 * POST /api/user/data-center/sync
 *
 * 2核2G 优化：
 * - 批量查询代替循环内单条查询（消除 N+1）
 * - 用 $transaction 批量写入
 * - 限制单次同步数据量
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json();
  const { type = "all", mcc_account_id } = body;

  if (!mcc_account_id) return apiError("缺少 mcc_account_id", 400);
  if (!["all", "ads", "platform"].includes(type)) {
    return apiError("type 必须是 all / ads / platform", 400);
  }

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: BigInt(mcc_account_id), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!mcc) return apiError("MCC 账户不存在", 404);

  const userId = BigInt(user.userId);
  const results: Record<string, unknown> = {};

  if (type === "all" || type === "ads") {
    results.ads = await syncAdsData(mcc, userId);
  }

  // 关联 campaigns 和 transactions 与 merchants
  await linkCampaignsToMerchants(userId);
  await linkTransactionsToMerchants(userId);

  if (type === "all" || type === "platform") {
    // 先清除错误的佣金数据，再重新按日期写入正确值
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    await prisma.ads_daily_stats.updateMany({
      where: { user_id: userId, date: { gte: thirtyDaysAgo } },
      data: { commission: 0, rejected_commission: 0, orders: 0 },
    });
    results.platform = await syncPlatformData(userId);
  }

  // 清除相关缓存
  cacheDelete(`mcc:${user.userId}`, true);

  return apiSuccess(serializeData(results));
}

/**
 * 广告数据同步 — 批量操作版
 */
async function syncAdsData(
  mcc: { id: bigint; mcc_id: string; sheet_url: string | null; service_account_json: string | null; developer_token: string | null; currency: string },
  userId: bigint
) {
  const todayStr = todayCST();
  const yesterdayStr = yesterdayCST();

  let sheetResult = { inserted: 0, updated: 0, message: "" };
  let apiResult = { inserted: 0, updated: 0, message: "" };

  // 1. Sheet 同步
  if (mcc.sheet_url) {
    const startStr = nowCST().subtract(31, "day").format("YYYY-MM-DD");

    const sheetData = await syncFromSheet(mcc.sheet_url, startStr, yesterdayStr);
    if (sheetData.success && sheetData.rows.length > 0) {
      sheetResult = await upsertSheetRowsBatch(sheetData.rows, mcc.id, userId);
    } else {
      sheetResult.message = sheetData.message || "Sheet 无数据";
    }
  } else {
    sheetResult.message = "未配置 Sheet URL";
  }

  // 2. API 同步今日数据
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
        take: 50, // 限制单次同步 CID 数量
      });

      // ─── 批量预加载所有 campaigns ───
      const existingCampaigns = await prisma.campaigns.findMany({
        where: { user_id: userId, mcc_id: mcc.id, is_deleted: 0 },
      });
      const campaignMap = new Map(existingCampaigns.map((c) => [c.google_campaign_id, c]));

      // 预加载商家索引，用于关联 campaign 与 merchant
      const apiMerchants = await prisma.user_merchants.findMany({
        where: { user_id: userId, is_deleted: 0, status: "claimed" },
        select: { id: true, platform: true, merchant_id: true },
      });
      const apiMerchantIndex = new Map(
        apiMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m.id])
      );

      let totalInserted = 0, totalUpdated = 0;

      for (const cid of cids) {
        try {
          const campaignData = await fetchTodayCampaignData(credentials, cid.customer_id);

          // ─── 批量处理每个 CID 的数据 ───
          const operations: (() => Promise<unknown>)[] = [];

          for (const cd of campaignData) {
            let campaign = campaignMap.get(cd.campaign_id);

            if (!campaign) {
              const parsed = parseCampaignName(cd.campaign_name);
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
              operations.push(() => prisma.campaigns.update({
                where: { id: campaign!.id },
                data: {
                  campaign_name: cd.campaign_name, daily_budget: cd.budget_dollars,
                  google_status: cd.campaign_status, last_google_sync_at: new Date(),
                },
              }));
            }

            // 批量 upsert 今日统计
            operations.push(async () => {
              const existing = await prisma.ads_daily_stats.findFirst({
                where: { campaign_id: campaign!.id, date: new Date(todayStr) },
              });
              if (existing) {
                await prisma.ads_daily_stats.update({
                  where: { id: existing.id },
                  data: { budget: cd.budget_dollars, cost: cd.cost_dollars, clicks: cd.clicks, impressions: cd.impressions, cpc: cd.cpc_dollars, conversions: cd.conversions, data_source: "api" },
                });
                totalUpdated++;
              } else {
                await prisma.ads_daily_stats.create({
                  data: { user_id: userId, user_merchant_id: BigInt(0), campaign_id: campaign!.id, date: new Date(todayStr), budget: cd.budget_dollars, cost: cd.cost_dollars, clicks: cd.clicks, impressions: cd.impressions, cpc: cd.cpc_dollars, conversions: cd.conversions, data_source: "api" },
                });
                totalInserted++;
              }
            });
          }

          // 批量执行（每 20 个一批，避免连接池耗尽）
          for (let i = 0; i < operations.length; i += 20) {
            const batch = operations.slice(i, i + 20);
            await Promise.all(batch.map((op) => op()));
          }

          // 批量更新 CID 状态（一次查询代替 N 次）
          const cidCustomerIds = campaignData.map((cd) => cd.customer_id);
          const enabledCids = campaignData.filter((cd) => cd.campaign_status === "ENABLED").map((cd) => cd.customer_id);
          if (cidCustomerIds.length > 0) {
            await prisma.mcc_cid_accounts.updateMany({
              where: { mcc_account_id: mcc.id, customer_id: { in: enabledCids } },
              data: { is_available: "N" },
            });
          }
        } catch (err) {
          console.error(`CID ${cid.customer_id} 同步失败:`, err);
        }
      }

      apiResult = { inserted: totalInserted, updated: totalUpdated, message: "API 同步完成" };
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
  userId: bigint
) {
  let inserted = 0, updated = 0;

  // ─── 1. 批量预加载所有相关 campaigns ───
  const uniqueCampaignIds = [...new Set(rows.map((r) => r.campaign_id))];
  const existingCampaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, google_campaign_id: { in: uniqueCampaignIds }, is_deleted: 0 },
  });
  const campaignMap = new Map(existingCampaigns.map((c) => [c.google_campaign_id, c]));

  // ─── 2. 创建缺失的 campaigns（批量），尝试从广告名解析商家关联 ───
  const missingIds = uniqueCampaignIds.filter((id) => !campaignMap.has(id));
  if (missingIds.length > 0) {
    const userMerchants = await prisma.user_merchants.findMany({
      where: { user_id: userId, is_deleted: 0, status: "claimed" },
      select: { id: true, platform: true, merchant_id: true },
    });
    const merchantIndex = new Map(
      userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m.id])
    );

    const firstRowByGid = new Map(rows.map((r) => [r.campaign_id, r]));
    for (const gid of missingIds) {
      const row = firstRowByGid.get(gid)!;
      const parsed = parseCampaignName(row.campaign_name);
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

  // ─── 4. 批量 upsert（每 20 条一批） ───
  for (let i = 0; i < rows.length; i += 20) {
    const batch = rows.slice(i, i + 20);
    const operations = batch.map((row) => {
      const campaign = campaignMap.get(row.campaign_id)!;
      const statsKey = `${campaign.id}_${row.date}`;
      const existingId = statsKeyMap.get(statsKey);

      if (existingId) {
        updated++;
        return prisma.ads_daily_stats.update({
          where: { id: existingId },
          data: { budget: row.budget, cost: row.cost, clicks: row.clicks, impressions: row.impressions, cpc: row.cpc, data_source: "sheet" },
        });
      } else {
        inserted++;
        return prisma.ads_daily_stats.create({
          data: { user_id: userId, user_merchant_id: BigInt(0), campaign_id: campaign.id, date: new Date(row.date), budget: row.budget, cost: row.cost, clicks: row.clicks, impressions: row.impressions, cpc: row.cpc, data_source: "sheet" },
        });
      }
    });

    await Promise.all(operations);
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
      return prisma.campaigns.update({
        where: { id: campaign.id },
        data: { campaign_name: row.campaign_name, customer_id: row.customer_id, daily_budget: row.budget, google_status: row.status, last_google_sync_at: new Date() },
      });
    });
  // 每 20 条一批
  for (let i = 0; i < updateOps.length; i += 20) {
    await Promise.all(updateOps.slice(i, i + 20));
  }

  return { inserted, updated, message: `Sheet 同步完成` };
}

/**
 * 从广告系列名中提取平台代码和商家 MID
 * 广告名格式: 序号-平台-商家名-国家-日期-MID
 * 例如: 003-RW-deltachildren-US-0126-117904
 */
function parseCampaignName(name: string): { platform: string; mid: string } | null {
  if (!name) return null;
  const parts = name.split("-");
  if (parts.length < 4) return null;
  const rawPlatform = parts[1]?.trim();
  const mid = parts[parts.length - 1]?.trim();
  if (!rawPlatform || !mid || !/^\d+$/.test(mid)) return null;
  return { platform: normalizePlatformCode(rawPlatform), mid };
}

/**
 * 关联 campaigns 与 user_merchants — 修复 user_merchant_id = 0 的记录
 * 从广告系列名解析平台和 MID，匹配 user_merchants
 */
async function linkCampaignsToMerchants(userId: bigint) {
  const unlinked = await prisma.campaigns.findMany({
    where: { user_id: userId, user_merchant_id: BigInt(0), is_deleted: 0, google_campaign_id: { not: null } },
    select: { id: true, campaign_name: true },
    take: 500,
  });
  if (unlinked.length === 0) return 0;

  const userMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0, status: "claimed" },
    select: { id: true, platform: true, merchant_id: true },
  });
  const merchantIndex = new Map(
    userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m.id])
  );

  let linked = 0;
  const updates: Promise<unknown>[] = [];

  for (const c of unlinked) {
    const parsed = parseCampaignName(c.campaign_name || "");
    if (!parsed) continue;

    const merchantId = merchantIndex.get(`${parsed.platform}_${parsed.mid}`);
    if (!merchantId) continue;

    updates.push(
      prisma.campaigns.update({
        where: { id: c.id },
        data: { user_merchant_id: merchantId },
      })
    );
    linked++;

    if (updates.length >= 20) {
      await Promise.all(updates.splice(0));
    }
  }

  if (updates.length > 0) await Promise.all(updates);
  return linked;
}

/**
 * 关联 affiliate_transactions 与 user_merchants
 * 1. 先规范化已有交易的 platform 字段
 * 2. 精确匹配: normalized_platform + merchant_id
 * 3. 仅 merchant_id 兜底匹配
 */
async function linkTransactionsToMerchants(userId: bigint) {
  const userMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0, status: "claimed" },
    select: { id: true, platform: true, merchant_id: true },
  });
  if (userMerchants.length === 0) return;

  // 先规范化已有交易的 platform 字段
  await normalizeExistingTransactionPlatforms(userId);

  for (const m of userMerchants) {
    const normalizedPlatform = normalizePlatformCode(m.platform);

    const r1 = await prisma.affiliate_transactions.updateMany({
      where: { user_id: userId, platform: normalizedPlatform, merchant_id: m.merchant_id, user_merchant_id: BigInt(0), is_deleted: 0 },
      data: { user_merchant_id: m.id },
    });

    if (normalizedPlatform !== m.platform) {
      await prisma.affiliate_transactions.updateMany({
        where: { user_id: userId, platform: m.platform, merchant_id: m.merchant_id, user_merchant_id: BigInt(0), is_deleted: 0 },
        data: { user_merchant_id: m.id },
      });
    }

    if (r1.count === 0) {
      await prisma.affiliate_transactions.updateMany({
        where: { user_id: userId, merchant_id: m.merchant_id, user_merchant_id: BigInt(0), is_deleted: 0 },
        data: { user_merchant_id: m.id },
      });
    }
  }
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

/**
 * 平台佣金数据同步 — 按商家+日期聚合
 * 每个商家+日期只写入一个 campaign 的 daily_stats，避免多 campaign 翻倍
 */
async function syncPlatformData(userId: bigint) {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const txnAgg = await prisma.$queryRawUnsafe<
      { user_merchant_id: bigint; txn_date: string; total_commission: number; rejected_commission: number; order_count: number }[]
    >(`
      SELECT 
        user_merchant_id,
        DATE(transaction_time) as txn_date,
        SUM(CASE WHEN status IN ('approved','pending','paid') THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as total_commission,
        SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
        COUNT(*) as order_count
      FROM affiliate_transactions
      WHERE user_id = ? AND is_deleted = 0 AND transaction_time >= ?
      GROUP BY user_merchant_id, DATE(transaction_time)
    `, userId, thirtyDaysAgo);

    if (!txnAgg || txnAgg.length === 0) return { updated: 0, message: "无交易数据" };

    const merchantIds = [...new Set(txnAgg.map((t) => t.user_merchant_id))].filter((id) => id && id !== BigInt(0));
    if (merchantIds.length === 0) return { updated: 0, message: "无可匹配的商家" };

    const campaigns = await prisma.campaigns.findMany({
      where: { user_id: userId, user_merchant_id: { in: merchantIds }, is_deleted: 0 },
      select: { id: true, user_merchant_id: true },
      orderBy: { id: "asc" },
    });

    const campaignsByMerchant = new Map<string, bigint[]>();
    for (const c of campaigns) {
      const key = String(c.user_merchant_id);
      if (!campaignsByMerchant.has(key)) campaignsByMerchant.set(key, []);
      campaignsByMerchant.get(key)!.push(c.id);
    }

    let updated = 0;

    for (const agg of txnAgg) {
      if (!agg.user_merchant_id || agg.user_merchant_id === BigInt(0)) continue;

      const campaignIds = campaignsByMerchant.get(String(agg.user_merchant_id));
      if (!campaignIds?.length) continue;

      const txnDate = new Date(agg.txn_date);
      const commData = {
        commission: Number(agg.total_commission),
        rejected_commission: Number(agg.rejected_commission),
        orders: Number(agg.order_count),
      };

      // 找到该日期第一条有 daily_stats 的 campaign，只写入它
      let wrote = false;
      for (const cid of campaignIds) {
        const existing = await prisma.ads_daily_stats.findFirst({
          where: { campaign_id: cid, date: txnDate },
        });
        if (existing) {
          if (!wrote) {
            await prisma.ads_daily_stats.update({ where: { id: existing.id }, data: commData });
            wrote = true;
            updated++;
          } else {
            await prisma.ads_daily_stats.update({ where: { id: existing.id }, data: { commission: 0, rejected_commission: 0, orders: 0 } });
          }
        }
      }

      if (!wrote) {
        try {
          await prisma.ads_daily_stats.create({
            data: {
              user_id: userId,
              user_merchant_id: BigInt(0),
              campaign_id: campaignIds[0],
              date: txnDate,
              cost: 0, clicks: 0, impressions: 0,
              ...commData,
            },
          });
          updated++;
        } catch { /* 并发冲突忽略 */ }
      }
    }

    return { updated, message: `平台佣金已合并 ${updated} 条` };
  } catch (err) {
    return { updated: 0, message: `平台数据同步失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}
