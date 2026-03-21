import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError, normalizePlatformCode } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { nowCST } from "@/lib/date-utils";

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
  const { days = 30 } = await req.json().catch(() => ({}));

  const cstNow = nowCST();
  const startDate = cstNow.subtract(days, "day").toDate();
  const startStr = cstNow.subtract(days, "day").format("YYYY-MM-DD");
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

    // 2. 获取商家映射
    const userMerchants = await prisma.user_merchants.findMany({
      where: { user_id: userId, is_deleted: 0, status: "claimed" },
      select: { id: true, merchant_id: true, platform: true, merchant_name: true },
    });
    const merchantMap = new Map(
      userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m])
    );

    // 3. 逐个平台连接拉取交易
    const { fetchAllTransactions } = await import("@/lib/platform-api");
    const accountResults: {
      account_name: string;
      platform: string;
      synced: number;
      total_fetched: number;
      error?: string;
    }[] = [];

    let totalSynced = 0;
    let totalSkipped = 0;

    for (const conn of validConns) {
      const platform = normalizePlatformCode(conn.platform);
      const label = conn.account_name || platform;

      try {
        const result = await fetchAllTransactions(platform, conn.api_key!, startStr, endStr);

        if (result.error) {
          accountResults.push({
            account_name: label, platform, synced: 0,
            total_fetched: result.transactions.length, error: result.error,
          });
        }

        if (result.transactions.length === 0) {
          accountResults.push({
            account_name: label, platform, synced: 0, total_fetched: 0,
            error: result.error || undefined,
          });
          continue;
        }

        // 按 transaction_id 去重求和（移植自旧平台，同一笔订单可能出现多行）
        const grouped = new Map<string, typeof result.transactions[0]>();
        for (const txn of result.transactions) {
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

        // upsert 交易数据
        let synced = 0;
        let skipped = 0;

        for (let i = 0; i < dedupedTxns.length; i += 20) {
          const batch = dedupedTxns.slice(i, i + 20);
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
              where: {
                platform_transaction_id: { platform, transaction_id: txnId },
              },
              create: {
                user_id: userId,
                user_merchant_id: userMerchantId,
                platform_connection_id: conn.id,
                platform,
                merchant_id: merchantId,
                merchant_name: merchantName,
                transaction_id: txnId,
                transaction_time: new Date(txn.transaction_time),
                order_amount: newAmt,
                commission_amount: newComm,
                currency: "USD",
                status: txn.status,
                raw_status: txn.raw_status || "",
              },
              update: {
                platform_connection_id: conn.id,
                ...(newComm > 0 ? { commission_amount: newComm } : {}),
                status: txn.status,
                raw_status: txn.raw_status || "",
                ...(newAmt > 0 ? { order_amount: newAmt } : {}),
                merchant_name: merchantName || undefined,
              },
            });
          }).filter(Boolean);

          await Promise.all(ops);
          synced += ops.length;
        }

        totalSynced += synced;
        totalSkipped += skipped;
        accountResults.push({
          account_name: label, platform, synced, total_fetched: result.transactions.length,
          error: result.error || undefined,
        });
      } catch (err) {
        accountResults.push({
          account_name: label, platform, synced: 0, total_fetched: 0,
          error: `${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // 4. 关联交易和 campaigns 到正确的商家
    await linkTransactionsToMerchants(userId);
    await linkCampaignsToMerchants(userId);

    // 5. 先清零旧佣金，再按日期重新写入正确值
    await prisma.ads_daily_stats.updateMany({
      where: { user_id: userId, date: { gte: startDate } },
      data: { commission: 0, rejected_commission: 0, orders: 0 },
    });
    const commissionUpdated = await updateDailyStatsCommission(userId, startDate);

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
  const userMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, merchant_id: true },
  });

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
  const parts = name.split("-");
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
  if (unlinked.length === 0) return;

  const userMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, merchant_id: true },
  });
  const merchantIndex = new Map(
    userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m.id])
  );

  const updates: Promise<unknown>[] = [];
  for (const c of unlinked) {
    const parsed = parseCampaignName(c.campaign_name || "");
    if (!parsed) continue;
    const merchantId = merchantIndex.get(`${parsed.platform}_${parsed.mid}`);
    if (!merchantId) continue;
    updates.push(prisma.campaigns.update({ where: { id: c.id }, data: { user_merchant_id: merchantId } }));
    if (updates.length >= 20) await Promise.all(updates.splice(0));
  }
  if (updates.length > 0) await Promise.all(updates);
}

// ─── updateDailyStatsCommission ───

async function updateDailyStatsCommission(userId: bigint, startDate: Date): Promise<number> {
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
  `, userId, startDate);

  if (!txnAgg || txnAgg.length === 0) return 0;

  let updated = 0;

  for (const agg of txnAgg) {
    if (!agg.user_merchant_id || agg.user_merchant_id === BigInt(0)) continue;

    const campaigns = await prisma.campaigns.findMany({
      where: { user_id: userId, user_merchant_id: agg.user_merchant_id, is_deleted: 0 },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    if (campaigns.length === 0) continue;

    const txnDate = new Date(agg.txn_date);
    const commData = {
      commission: Number(agg.total_commission),
      rejected_commission: Number(agg.rejected_commission),
      orders: Number(agg.order_count),
    };

    let wrote = false;
    for (const c of campaigns) {
      const existing = await prisma.ads_daily_stats.findFirst({
        where: { campaign_id: c.id, date: txnDate },
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
            user_merchant_id: agg.user_merchant_id,
            campaign_id: campaigns[0].id,
            date: txnDate,
            cost: 0, clicks: 0, impressions: 0,
            ...commData,
          },
        });
        updated++;
      } catch { /* 并发冲突忽略 */ }
    }
  }

  return updated;
}
