import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError, normalizePlatformCode } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { todayCST, yesterdayCST, nowCST, parseCSTDateStart } from "@/lib/date-utils";
import { getExchangeRate, preloadRates } from "@/lib/exchange-rate";

/**
 * POST /api/user/team/sync
 * 组长专用：批量同步所有组员的今日广告费用 + 近 7 天佣金数据
 * 设计原则：仅做增量/当日同步，不做全量历史同步，避免超时
 */
export const POST = withLeader(async (_req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");

  const teamId = BigInt(user.teamId);
  const members = await prisma.users.findMany({
    where: { team_id: teamId, is_deleted: 0, role: "user" },
    select: { id: true, username: true, display_name: true },
  });

  if (members.length === 0) {
    return apiSuccess({ members: [], message: "小组暂无成员" });
  }

  const memberResults: {
    user_id: string;
    username: string;
    display_name: string | null;
    ads: { synced: number; message: string };
    transactions: { synced: number; message: string };
  }[] = [];

  // 逐个成员同步（避免并发压垮服务器资源）
  for (const member of members) {
    const userId = member.id;
    const [adsResult, txnResult] = await Promise.allSettled([
      syncTodayAdsForUser(userId),
      syncRecentTransactionsForUser(userId, 7),
    ]);

    memberResults.push({
      user_id: String(userId),
      username: member.username,
      display_name: member.display_name,
      ads:
        adsResult.status === "fulfilled"
          ? adsResult.value
          : { synced: 0, message: `广告同步失败: ${adsResult.reason}` },
      transactions:
        txnResult.status === "fulfilled"
          ? txnResult.value
          : { synced: 0, message: `佣金同步失败: ${txnResult.reason}` },
    });
  }

  const totalAdsSynced = memberResults.reduce((s, r) => s + r.ads.synced, 0);
  const totalTxnSynced = memberResults.reduce((s, r) => s + r.transactions.synced, 0);

  return apiSuccess(
    serializeData({
      members: memberResults,
      summary: {
        member_count: members.length,
        ads_synced: totalAdsSynced,
        txn_synced: totalTxnSynced,
      },
      synced_at: new Date(),
    })
  );
});

/**
 * 同步指定用户今日的 Google Ads 广告费用
 * 仅拉取 yesterday ~ today 的数据（与数据中心同步口径一致）
 */
async function syncTodayAdsForUser(userId: bigint): Promise<{ synced: number; message: string }> {
  const todayStr = todayCST();
  const yesterdayStr = yesterdayCST();

  // 获取该用户所有有效 MCC 账户
  const mccAccounts = await prisma.google_mcc_accounts.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: {
      id: true,
      mcc_id: true,
      currency: true,
      service_account_json: true,
      developer_token: true,
    },
  });

  if (mccAccounts.length === 0) return { synced: 0, message: "无 MCC 账户" };

  let totalSynced = 0;
  const errors: string[] = [];

  for (const mcc of mccAccounts) {
    if (!mcc.service_account_json) continue;

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

      if (cids.length === 0) continue;

      // 预加载汇率
      await preloadRates(mcc.currency, yesterdayStr, todayStr);

      // 获取该 MCC 下所有已知 campaigns
      const existingCampaigns = await prisma.campaigns.findMany({
        where: { user_id: userId, mcc_id: mcc.id, is_deleted: 0 },
        select: { id: true, google_campaign_id: true, customer_id: true },
      });
      const campaignMap = new Map(existingCampaigns.map((c) => [c.google_campaign_id, c]));

      // 预加载最近两天的 stats 记录（用于 upsert 判断）
      const recentDates = [new Date(yesterdayStr), new Date(todayStr)];
      const existingStats = await prisma.ads_daily_stats.findMany({
        where: {
          user_id: userId,
          date: { in: recentDates },
        },
        select: { id: true, campaign_id: true, date: true },
      });
      const recentStatsMap = new Map<string, bigint>();
      for (const stat of existingStats) {
        const dateKey = stat.date.toISOString().split("T")[0];
        recentStatsMap.set(`${stat.campaign_id}_${dateKey}`, stat.id);
      }

      // 并发拉取各 CID 今日数据
      const CID_CONCURRENCY = 3;
      const cidDataMap = new Map<string, Awaited<ReturnType<typeof fetchTodayCampaignData>>>();

      for (let ci = 0; ci < cids.length; ci += CID_CONCURRENCY) {
        const batch = cids.slice(ci, ci + CID_CONCURRENCY);
        const results = await Promise.all(
          batch.map(async (cid) => {
            try {
              return {
                id: cid.customer_id,
                data: await fetchTodayCampaignData(credentials, cid.customer_id, {
                  startDate: yesterdayStr,
                  endDate: todayStr,
                }),
              };
            } catch (err) {
              errors.push(`CID ${cid.customer_id}: ${err instanceof Error ? err.message : String(err)}`);
              return {
                id: cid.customer_id,
                data: [] as Awaited<ReturnType<typeof fetchTodayCampaignData>>,
              };
            }
          })
        );
        for (const r of results) cidDataMap.set(r.id, r.data);
      }

      // 写入 ads_daily_stats
      const ops: (() => Promise<unknown>)[] = [];

      for (const cid of cids) {
        const campaignData = cidDataMap.get(cid.customer_id) || [];
        for (const cd of campaignData) {
          const campaign = campaignMap.get(cd.campaign_id);
          if (!campaign) continue; // 只更新已知 campaigns，不在此处创建新记录

          const dataDate = cd.date;
          const dateRate = await getExchangeRate(mcc.currency, dataDate);
          if (dateRate <= 0) continue;

          const statsData = {
            budget: cd.budget_dollars * dateRate,
            cost: cd.cost_dollars * dateRate,
            clicks: cd.clicks,
            impressions: cd.impressions,
            cpc: cd.cpc_dollars * dateRate,
            conversions: cd.conversions,
            data_source: "api" as const,
          };

          const statsKey = `${campaign.id}_${dataDate}`;
          const existingStatsId = recentStatsMap.get(statsKey);
          if (existingStatsId) {
            ops.push(() =>
              prisma.ads_daily_stats.update({ where: { id: existingStatsId }, data: statsData })
            );
          } else {
            ops.push(() =>
              prisma.ads_daily_stats
                .create({
                  data: {
                    user_id: userId,
                    user_merchant_id: BigInt(0),
                    campaign_id: campaign.id,
                    date: new Date(dataDate),
                    ...statsData,
                  },
                })
                .then((s) => {
                  recentStatsMap.set(`${campaign.id}_${dataDate}`, s.id);
                })
            );
          }
          totalSynced++;
        }
      }

      // 批量执行（每 30 条一批）
      for (let i = 0; i < ops.length; i += 30) {
        await Promise.all(ops.slice(i, i + 30).map((op) => op()));
      }
    } catch (err) {
      errors.push(`MCC ${mcc.mcc_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const msg =
    errors.length > 0
      ? `同步 ${totalSynced} 条，${errors.length} 个错误`
      : totalSynced > 0
        ? `今日广告数据同步完成，更新 ${totalSynced} 条`
        : "无广告数据更新";

  return { synced: totalSynced, message: msg };
}

/**
 * 同步指定用户最近 N 天的联盟佣金数据
 */
async function syncRecentTransactionsForUser(
  userId: bigint,
  days: number = 7
): Promise<{ synced: number; message: string }> {
  const cstNow = nowCST();
  const startStr = cstNow.subtract(days, "day").format("YYYY-MM-DD");
  const endStr = cstNow.format("YYYY-MM-DD");
  const startDate = parseCSTDateStart(startStr);
  const endDate = cstNow.toDate();
  // DATE 列用 UTC 午夜作为比较起点（与数据中心口径一致）
  const statsStartDate = new Date(startStr + "T00:00:00.000Z");

  const connections = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0, status: "connected" },
    select: { id: true, platform: true, account_name: true, api_key: true },
  });

  const validConns = connections.filter((c) => c.api_key && c.api_key.length > 5);
  if (validConns.length === 0) return { synced: 0, message: "无平台连接" };

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

      // 自动补充缺失商家
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
                data: {
                  user_id: userId,
                  platform,
                  merchant_id: mid,
                  merchant_name: txn.merchant || "",
                  status: "available",
                },
                select: { id: true, merchant_id: true, platform: true, merchant_name: true },
              });
            }
            merchantMap.set(key, existing);
          } catch { /* 忽略并发冲突 */ }
        }
      }

      // 批量 upsert 交易
      for (let i = 0; i < dedupedTxns.length; i += 50) {
        const batch = dedupedTxns.slice(i, i + 50);
        const ops = batch
          .map((txn) => {
            const mid = txn.merchant_id || "";
            const txnId = txn.transaction_id;
            if (!txnId) return null;
            const merchant = merchantMap.get(`${platform}_${mid}`);
            const userMerchantId = merchant ? merchant.id : BigInt(0);
            const merchantName = txn.merchant || merchant?.merchant_name || "";

            return prisma.affiliate_transactions.upsert({
              where: { platform_transaction_id: { platform, transaction_id: txnId } },
              create: {
                user_id: userId,
                user_merchant_id: userMerchantId,
                platform_connection_id: conn.id,
                platform,
                merchant_id: mid,
                merchant_name: merchantName,
                transaction_id: txnId,
                transaction_time: new Date(txn.transaction_time),
                order_amount: txn.order_amount || 0,
                commission_amount: txn.commission_amount || 0,
                currency: "USD",
                status: txn.status,
                raw_status: txn.raw_status || "",
              },
              update: {
                platform_connection_id: conn.id,
                merchant_id: mid,
                ...(userMerchantId !== BigInt(0) ? { user_merchant_id: userMerchantId } : {}),
                commission_amount: txn.commission_amount || 0,
                status: txn.status,
                raw_status: txn.raw_status || "",
                order_amount: txn.order_amount || 0,
                merchant_name: merchantName || undefined,
                is_deleted: 0,
              },
            });
          })
          .filter(Boolean);
        await Promise.all(ops);
        totalSynced += ops.length;
      }
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 重新计算该时间段的佣金写入 ads_daily_stats
  await updateCommissionForUser(userId, statsStartDate, startDate, endDate);

  const msg =
    errors.length > 0
      ? `同步 ${totalSynced} 条，${errors.length} 个错误`
      : totalSynced > 0
        ? `近 ${days} 天佣金同步完成，更新 ${totalSynced} 条`
        : "无佣金数据更新";

  return { synced: totalSynced, message: msg };
}

/**
 * 将 affiliate_transactions 中的佣金重新写入 ads_daily_stats
 * （清零旧数据后按交易聚合写入，保证口径一致）
 */
async function updateCommissionForUser(
  userId: bigint,
  statsStartDate: Date,
  txnStartDate: Date,
  txnEndDate: Date
): Promise<void> {
  // 清零旧佣金
  await prisma.ads_daily_stats.updateMany({
    where: { user_id: userId, date: { gte: statsStartDate } },
    data: { commission: 0, rejected_commission: 0, orders: 0 },
  });

  // 按商家+日期聚合交易
  const txnAgg = await prisma.$queryRawUnsafe<
    { user_merchant_id: bigint; txn_date: string; total_commission: number; rejected_commission: number; order_count: number }[]
  >(
    `SELECT
      user_merchant_id,
      DATE_FORMAT(transaction_time, '%Y-%m-%d') as txn_date,
      SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
      COUNT(*) as order_count
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0
      AND transaction_time >= ? AND transaction_time < ?
    GROUP BY user_merchant_id, DATE_FORMAT(transaction_time, '%Y-%m-%d')`,
    userId,
    txnStartDate,
    txnEndDate
  );

  if (!txnAgg || txnAgg.length === 0) return;

  const merchantIds = [...new Set(txnAgg.map((t) => BigInt(String(t.user_merchant_id ?? 0))))].filter(
    (id) => id !== BigInt(0)
  );
  if (merchantIds.length === 0) return;

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
  type StatsRow = { id: bigint; campaign_id: bigint; date_str: string };
  const allStatsRaw: StatsRow[] =
    allCampaignIds.length > 0
      ? await prisma.$queryRawUnsafe<StatsRow[]>(
          `SELECT id, campaign_id, DATE_FORMAT(date, '%Y-%m-%d') as date_str
           FROM ads_daily_stats
           WHERE campaign_id IN (${allCampaignIds.map(() => "?").join(",")})
             AND date >= ?`,
          ...allCampaignIds,
          statsStartDate
        )
      : [];

  const statsMap = new Map<string, bigint>();
  for (const s of allStatsRaw) {
    statsMap.set(`${BigInt(String(s.campaign_id ?? 0))}_${s.date_str}`, BigInt(String(s.id ?? 0)));
  }

  const ops: (() => Promise<unknown>)[] = [];

  for (const agg of txnAgg) {
    const umid = BigInt(String(agg.user_merchant_id ?? 0));
    if (umid === BigInt(0)) continue;

    const campaignIds = campaignsByMerchant.get(String(umid));
    if (!campaignIds?.length) continue;

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
        } else {
          ops.push(() =>
            prisma.ads_daily_stats.update({
              where: { id: statsId },
              data: { commission: 0, rejected_commission: 0, orders: 0 },
            })
          );
        }
      }
    }

    if (!wrote) {
      ops.push(() =>
        prisma.ads_daily_stats
          .create({
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
          })
          .catch(() => {})
      );
    }
  }

  for (let i = 0; i < ops.length; i += 50) {
    await Promise.all(ops.slice(i, i + 50).map((fn) => fn()));
  }
}
