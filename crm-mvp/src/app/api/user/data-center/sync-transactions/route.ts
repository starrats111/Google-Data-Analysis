import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError, normalizePlatformCode } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { nowCST, parseCSTDateStart, dateColumnStart } from "@/lib/date-utils";

/**
 * POST /api/user/data-center/sync-transactions
 *
 * 直接调用各联盟平台 API 拉取交易数据到 CRM
 * 使用 platform_connections 中配置的 API Key
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const userId = BigInt(user.userId);
  const body = await req.json().catch(() => ({}));

  const cstNow = nowCST();
  const DEFAULT_START = "2025-01-01";
  const startStr = body.days
    ? cstNow.subtract(body.days, "day").format("YYYY-MM-DD")
    : DEFAULT_START;
  const startDate = parseCSTDateStart(startStr);
  const statsStartDate = dateColumnStart(startStr);
  const endStr = cstNow.format("YYYY-MM-DD");

  try {
    // 1. 获取用户的所有平台连接
    const connections = await prisma.platform_connections.findMany({
      where: { user_id: userId, is_deleted: 0, status: "connected" },
      select: { id: true, platform: true, account_name: true, api_key: true },
    });

    const validConns = connections.filter((c) => c.api_key && c.api_key.length > 5);
    if (validConns.length === 0) {
      return apiError("没有可用的平台连接，请先在「个人设置 → 联盟平台连接」中配置 API Key", 400);
    }

    // 2. 获取商家映射（查询所有商家，不限 claimed，提升匹配率）
    const userMerchants = await prisma.user_merchants.findMany({
      where: { user_id: userId, is_deleted: 0 },
      select: { id: true, merchant_id: true, platform: true, merchant_name: true },
    });
    const merchantMap = new Map(
      userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m])
    );

    // 3. 并行拉取各平台交易（3 个平台并发）
    const { fetchAllTransactions } = await import("@/lib/platform-api");

    type FetchedConn = { conn: typeof validConns[0]; platform: string; label: string; transactions: any[]; error?: string };
    const fetched: FetchedConn[] = [];
    const FETCH_CONCURRENCY = 3;

    for (let fi = 0; fi < validConns.length; fi += FETCH_CONCURRENCY) {
      const batch = validConns.slice(fi, fi + FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (conn) => {
          const platform = normalizePlatformCode(conn.platform);
          const label = conn.account_name || platform;
          try {
            const r = await fetchAllTransactions(platform, conn.api_key!, startStr, endStr);
            return { conn, platform, label, transactions: r.transactions, error: r.error };
          } catch (err) {
            return { conn, platform, label, transactions: [] as any[], error: `${err instanceof Error ? err.message : String(err)}` };
          }
        })
      );
      fetched.push(...results);
    }

    // 顺序处理各平台数据（upsert 到数据库）
    const accountResults: { account_name: string; platform: string; synced: number; total_fetched: number; error?: string }[] = [];
    let totalSynced = 0;
    let totalSkipped = 0;

    for (const { conn, platform, label, transactions, error } of fetched) {
      if (error && transactions.length === 0) {
        accountResults.push({ account_name: label, platform, synced: 0, total_fetched: 0, error });
        continue;
      }
      if (transactions.length === 0) {
        accountResults.push({ account_name: label, platform, synced: 0, total_fetched: 0, error: error || undefined });
        continue;
      }

      const grouped = new Map<string, typeof transactions[0]>();
      for (const txn of transactions) {
        if (!txn.transaction_id) continue;
        const existing = grouped.get(txn.transaction_id);
        if (existing) {
          existing.commission_amount = (existing.commission_amount || 0) + (txn.commission_amount || 0);
          existing.order_amount = (existing.order_amount || 0) + (txn.order_amount || 0);
        } else {
          grouped.set(txn.transaction_id, { ...txn });
        }
      }
      const dedupedTxns = [...grouped.values()];

      // 自动创建缺失的 user_merchants（交易中有但商家表没有的）
      const missingMerchants = new Map<string, { merchantId: string; name: string }>();
      for (const txn of dedupedTxns) {
        const mid = txn.merchant_id || "";
        if (!mid) continue;
        const key = `${platform}_${mid}`;
        if (!merchantMap.has(key) && !missingMerchants.has(key)) {
          missingMerchants.set(key, { merchantId: mid, name: txn.merchant || "" });
        }
      }
      for (const [key, { merchantId, name }] of missingMerchants) {
        try {
          let existing = await prisma.user_merchants.findFirst({
            where: { user_id: userId, platform, merchant_id: merchantId, is_deleted: 0 },
            select: { id: true, merchant_id: true, platform: true, merchant_name: true },
          });
          if (!existing) {
            existing = await prisma.user_merchants.create({
              data: { user_id: userId, platform, merchant_id: merchantId, merchant_name: name, status: "available" },
              select: { id: true, merchant_id: true, platform: true, merchant_name: true },
            });
          }
          merchantMap.set(key, existing);
        } catch { /* ignore race condition */ }
      }

      let synced = 0;
      let skipped = 0;
      let cleaned = 0;

      // 预清理：如果交易有 order_id，先删除数据库中以该 order_id 作为 transaction_id 的旧记录
      // 这解决了历史代码用 order_id 而非 collabgrow_id 导致的重复问题
      const orderIdsToClean = dedupedTxns
        .filter((txn) => txn.order_id && txn.transaction_id !== txn.order_id)
        .map((txn) => txn.order_id!);
      if (orderIdsToClean.length > 0) {
        for (let ci = 0; ci < orderIdsToClean.length; ci += 200) {
          const batch = orderIdsToClean.slice(ci, ci + 200);
          const result = await prisma.affiliate_transactions.deleteMany({
            where: { platform, user_id: userId, transaction_id: { in: batch } },
          });
          cleaned += result.count;
        }
        if (cleaned > 0) {
          console.log(`[sync-txn] ${platform}/${label}: 清理了 ${cleaned} 条旧 order_id 格式记录`);
        }
      }

      for (let i = 0; i < dedupedTxns.length; i += 50) {
        const batch = dedupedTxns.slice(i, i + 50);
        const ops = batch.map((txn) => {
          const merchantId = txn.merchant_id || "";
          const txnId = txn.transaction_id;
          if (!txnId) { skipped++; return null; }

          const merchant = merchantMap.get(`${platform}_${merchantId}`);
          const userMerchantId = merchant ? merchant.id : BigInt(0);
          const merchantName = txn.merchant || merchant?.merchant_name || "";
          const newComm = txn.commission_amount || 0;
          const newAmt = txn.order_amount || 0;

          return prisma.affiliate_transactions.upsert({
            where: { platform_transaction_id: { platform, transaction_id: txnId } },
            create: {
              user_id: userId, user_merchant_id: userMerchantId, platform_connection_id: conn.id,
              platform, merchant_id: merchantId, merchant_name: merchantName, transaction_id: txnId,
              transaction_time: new Date(txn.transaction_time), order_amount: newAmt,
              commission_amount: newComm, currency: "USD", status: txn.status, raw_status: txn.raw_status || "",
            },
            update: {
              platform_connection_id: conn.id, merchant_id: merchantId,
              ...(userMerchantId !== BigInt(0) ? { user_merchant_id: userMerchantId } : {}),
              commission_amount: newComm,
              status: txn.status, raw_status: txn.raw_status || "",
              order_amount: newAmt,
              merchant_name: merchantName || undefined,
            },
          });
        }).filter(Boolean);

        await Promise.all(ops);
        synced += ops.length;
      }

      totalSynced += synced;
      totalSkipped += skipped;
      accountResults.push({ account_name: label, platform, synced, total_fetched: transactions.length, error: error || undefined });
    }

    // 4. 关联交易和 campaigns 到正确的商家
    await linkTransactionsToMerchants(userId);
    await linkCampaignsToMerchants(userId);
    await claimLinkedMerchants(userId);

    // 5. 先清零旧佣金，再按日期重新写入正确值
    await prisma.ads_daily_stats.updateMany({
      where: { user_id: userId, date: { gte: statsStartDate } },
      data: { commission: 0, rejected_commission: 0, orders: 0 },
    });
    const commissionUpdated = await updateDailyStatsCommission(userId, statsStartDate, startDate);

    const errors = accountResults.filter((r) => r.error);
    const msg = accountResults.map((r) =>
      `${r.account_name}: ${r.synced}条${r.error ? ` (${r.error})` : ""}`
    ).join("；");

    return apiSuccess(serializeData({
      synced: totalSynced,
      skipped: totalSkipped,
      commission_updated: commissionUpdated,
      accounts: accountResults,
      message: `交易同步完成 — ${msg}，更新 ${commissionUpdated} 条佣金`,
    }));
  } catch (err) {
    return apiError(`同步失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}

// ─── linkTransactionsToMerchants ───

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

  // 兜底匹配：仅 merchant_id（处理平台未精确匹配的情况）
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

// ─── updateDailyStatsCommission ───

async function updateDailyStatsCommission(userId: bigint, statsStartDate: Date, txnStartDate: Date): Promise<number> {
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

  // 预加载所有相关 daily_stats（消除 N+1）
  const allCampaignIds = allCampaigns.map(c => c.id);
  const allStats = allCampaignIds.length > 0 ? await prisma.ads_daily_stats.findMany({
    where: { campaign_id: { in: allCampaignIds }, date: { gte: statsStartDate } },
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

  return updated;
}
