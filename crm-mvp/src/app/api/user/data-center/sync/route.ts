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
  await claimLinkedMerchants(userId);
  await linkTransactionsToMerchants(userId);

  if (type === "all" || type === "platform") {
    const thirtyDaysAgo = nowCST().subtract(30, "day").toDate();
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
      const { fetchTodayCampaignData, listMccChildAccounts } = await import("@/lib/google-ads");
      const credentials = {
        mcc_id: mcc.mcc_id,
        developer_token: mcc.developer_token || "",
        service_account_json: mcc.service_account_json,
      };

      let cids = await prisma.mcc_cid_accounts.findMany({
        where: { mcc_account_id: mcc.id, is_deleted: 0, status: "active" },
        take: 50,
      });

      // 如果 CID 表为空，直接从 MCC API 获取所有子账户
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

      // ─── 批量预加载所有 campaigns ───
      const existingCampaigns = await prisma.campaigns.findMany({
        where: { user_id: userId, mcc_id: mcc.id, is_deleted: 0 },
      });
      const campaignMap = new Map(existingCampaigns.map((c) => [c.google_campaign_id, c]));

      // 预加载商家索引，用于关联 campaign 与 merchant
      const apiMerchants = await prisma.user_merchants.findMany({
        where: { user_id: userId, is_deleted: 0 },
        select: { id: true, platform: true, merchant_id: true },
      });
      const apiMerchantIndex = new Map(
        apiMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m.id])
      );

      let totalInserted = 0, totalUpdated = 0;

      // ─── 并行拉取所有 CID 数据（3 个并发） ───
      const cidDataMap = new Map<string, Awaited<ReturnType<typeof fetchTodayCampaignData>>>();
      const CID_CONCURRENCY = 3;
      for (let ci = 0; ci < cids.length; ci += CID_CONCURRENCY) {
        const batch = cids.slice(ci, ci + CID_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (cid) => {
            try {
              return { id: cid.customer_id, data: await fetchTodayCampaignData(credentials, cid.customer_id) };
            } catch (err) {
              console.error(`CID ${cid.customer_id} 同步失败:`, err);
              return { id: cid.customer_id, data: [] as Awaited<ReturnType<typeof fetchTodayCampaignData>> };
            }
          })
        );
        for (const r of results) cidDataMap.set(r.id, r.data);
      }

      // ─── 预加载今日 daily_stats（消除循环内 findFirst） ───
      const todayDate = new Date(todayStr);
      const existingTodayStats = await prisma.ads_daily_stats.findMany({
        where: { user_id: userId, date: todayDate, data_source: "api" },
        select: { id: true, campaign_id: true },
      });
      const todayStatsMap = new Map(existingTodayStats.map(s => [String(s.campaign_id), s.id]));

      // ─── 顺序处理（维护 campaignMap 一致性）───
      for (const cid of cids) {
        const campaignData = cidDataMap.get(cid.customer_id) || [];
        if (campaignData.length === 0) continue;

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
              data: { campaign_name: cd.campaign_name, daily_budget: cd.budget_dollars, google_status: cd.campaign_status, last_google_sync_at: new Date() },
            }));
          }

          const statsData = { budget: cd.budget_dollars, cost: cd.cost_dollars, clicks: cd.clicks, impressions: cd.impressions, cpc: cd.cpc_dollars, conversions: cd.conversions, data_source: "api" as const };
          const existingStatsId = todayStatsMap.get(String(campaign.id));
          if (existingStatsId) {
            operations.push(() => prisma.ads_daily_stats.update({ where: { id: existingStatsId }, data: statsData }));
            totalUpdated++;
          } else {
            operations.push(() => prisma.ads_daily_stats.create({
              data: { user_id: userId, user_merchant_id: BigInt(0), campaign_id: campaign!.id, date: todayDate, ...statsData },
            }).then(s => { todayStatsMap.set(String(campaign!.id), s.id); }));
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

      // ─── 全量同步所有广告系列状态（含已暂停/已移除）— 批量操作 ───
      try {
        const { fetchAllCampaignStatuses } = await import("@/lib/google-ads");
        const cidSet = new Set([
          ...cids.map((c) => c.customer_id),
          ...apiDiscoveredCids,
          ...[...campaignMap.values()].map((c) => c.customer_id).filter(Boolean) as string[],
        ]);
        const allCidIds = [...cidSet];
        console.log(`[Sync] 全量同步 CID 列表: ${allCidIds.length} 个`);
        const allStatuses = await fetchAllCampaignStatuses(credentials, allCidIds);

        // 分离更新和创建操作
        const statusUpdateOps: (() => Promise<unknown>)[] = [];
        const statusCreateOps: Array<{ cs: typeof allStatuses[0]; merchantId: bigint }> = [];

        for (const cs of allStatuses) {
          const existing = campaignMap.get(cs.campaign_id);
          if (existing) {
            if (existing.google_status !== cs.status || existing.campaign_name !== cs.name) {
              statusUpdateOps.push(() => prisma.campaigns.update({
                where: { id: existing.id },
                data: { google_status: cs.status, campaign_name: cs.name, daily_budget: cs.budget_dollars, last_google_sync_at: new Date() },
              }));
            }
          } else {
            const parsed = parseCampaignName(cs.name);
            const merchantId = parsed ? (apiMerchantIndex.get(`${parsed.platform}_${parsed.mid}`) || BigInt(0)) : BigInt(0);
            statusCreateOps.push({ cs, merchantId });
          }
        }

        // 批量执行更新（每 50 条并发）
        for (let i = 0; i < statusUpdateOps.length; i += 50) {
          await Promise.all(statusUpdateOps.slice(i, i + 50).map(fn => fn()));
        }

        // 批量创建新广告系列（每 30 条并发）
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
      where: { user_id: userId, is_deleted: 0 },
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
 * 支持两种格式：
 *   破折号: 003-RW-deltachildren-US-0126-117904
 *   空格:   011 CG cellFilter JS 0320 8000389
 */
function parseCampaignName(name: string): { platform: string; mid: string } | null {
  if (!name) return null;
  const parts = name.split(/[-\s]+/);
  if (parts.length < 4) return null;
  const rawPlatform = parts[1]?.trim();
  const mid = parts[parts.length - 1]?.trim();
  if (!rawPlatform || !mid || !/^\d+$/.test(mid)) return null;
  return { platform: normalizePlatformCode(rawPlatform), mid };
}

/**
 * 关联 campaigns 与 user_merchants — 修复 user_merchant_id = 0 的记录
 * 从广告系列名解析平台和 MID，匹配 user_merchants
 * 匹配成功时同时将商家标记为 claimed，使其出现在"我的商家"
 */
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

    updates.push(
      prisma.campaigns.update({
        where: { id: c.id },
        data: { user_merchant_id: merchant.id },
      })
    );

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

    if (updates.length >= 20) {
      await Promise.all(updates.splice(0));
    }
  }

  if (updates.length > 0) await Promise.all(updates);
  return linked;
}

/**
 * 将所有已关联广告系列但尚未 claimed 的商家标记为 claimed
 * 确保所有在投广告的商家都出现在"我的商家"中
 */
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
 * 关联 affiliate_transactions 与 user_merchants
 * 1. 先规范化已有交易的 platform 字段
 * 2. 精确匹配: normalized_platform + merchant_id
 * 3. 仅 merchant_id 兜底匹配
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
  `, userId);

  // 兜底匹配：仅 merchant_id
  await prisma.$executeRawUnsafe(`
    UPDATE affiliate_transactions t
    JOIN user_merchants m
      ON t.user_id = m.user_id AND t.merchant_id = m.merchant_id
    SET t.user_merchant_id = m.id
    WHERE t.user_id = ? AND t.user_merchant_id = 0 AND t.is_deleted = 0 AND m.is_deleted = 0
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

/**
 * 平台佣金数据同步 — 按商家+日期聚合
 * 每个商家+日期只写入一个 campaign 的 daily_stats，避免多 campaign 翻倍
 */
async function syncPlatformData(userId: bigint) {
  try {
    const thirtyDaysAgo = nowCST().subtract(30, "day").toDate();

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

    // 预加载所有相关 daily_stats（消除 N+1）
    const allCampaignIds = campaigns.map(c => c.id);
    const allStats = allCampaignIds.length > 0 ? await prisma.ads_daily_stats.findMany({
      where: { campaign_id: { in: allCampaignIds }, date: { gte: thirtyDaysAgo } },
      select: { id: true, campaign_id: true, date: true },
    }) : [];

    const statsMap = new Map<string, bigint>();
    for (const s of allStats) {
      statsMap.set(`${s.campaign_id}_${s.date.toISOString().split("T")[0]}`, s.id);
    }

    // 收集所有操作，批量执行
    const ops: (() => Promise<unknown>)[] = [];
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
            user_id: userId, user_merchant_id: agg.user_merchant_id, campaign_id: campaignIds[0],
            date: new Date(agg.txn_date), cost: 0, clicks: 0, impressions: 0, ...commData,
          },
        }).catch(() => {}));
        updated++;
      }
    }

    // 批量执行（每 50 条并发）
    for (let i = 0; i < ops.length; i += 50) {
      await Promise.all(ops.slice(i, i + 50).map(fn => fn()));
    }

    return { updated, message: `平台佣金已合并 ${updated} 条` };
  } catch (err) {
    return { updated: 0, message: `平台数据同步失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}
