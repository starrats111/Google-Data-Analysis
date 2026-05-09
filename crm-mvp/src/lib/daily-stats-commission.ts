import prisma from "@/lib/prisma";
import { sqlAffiliateTxnValidPlatformConnection } from "@/lib/affiliate-transaction-sql";

/**
 * 将 affiliate_transactions 中的佣金回写到 ads_daily_stats。
 *
 * 用于让"数据中心-广告系列"页面的 commission/orders/rejected_commission 列
 * 与联盟平台后台保持一致。
 *
 * 行为：
 *   1. 将 [startDate, endExclusive) 区间内属于该用户的 ads_daily_stats 的佣金/订单字段
 *      先全部清零（避免历史残留）。
 *   2. 按 user_merchant_id + 日期聚合 affiliate_transactions，将聚合结果写回到该商家
 *      下「最优」的一条 campaign 行（优先 ENABLED，次 PAUSED，最后 REMOVED；同状态
 *      取 updated_at 最新）。
 *   3. 同一商家有多条 campaign 时，主行写入聚合值，其余行清零（避免重复计算）。
 *   4. 该商家在该日期完全没有 ads_daily_stats 行时，自动 upsert 一行（cost=0）。
 *
 * @param userId         需要纠正的用户 ID
 * @param startDate      开始时间（含，UTC Date 对象，对齐 ads_daily_stats.date 列的 00:00:00 UTC）
 * @param endExclusive   结束时间（不含，UTC Date 对象）
 * @returns 受影响的行数
 */
export async function applyAffiliateCommissionToDailyStats(
  userId: bigint,
  startDate: Date,
  endExclusive: Date,
): Promise<number> {
  // 第 1 步：先把区间内本用户所有 ads_daily_stats 的 commission/rejected/orders 清零
  // 这样后续遍历到的行覆盖即可；遍历不到的行（联盟侧已撤单）也能正确显示为 0
  await prisma.ads_daily_stats.updateMany({
    where: { user_id: userId, is_deleted: 0, date: { gte: startDate, lt: endExclusive } },
    data: { commission: 0, rejected_commission: 0, orders: 0 },
  });

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
      AND ${sqlAffiliateTxnValidPlatformConnection("affiliate_transactions")}
    GROUP BY user_merchant_id, DATE_FORMAT(transaction_time, '%Y-%m-%d')
  `, userId, startDate, endExclusive);

  if (!txnAgg || txnAgg.length === 0) return 0;

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
        }
      }
    }

    if (!wrote) {
      const dateObj = new Date(`${txnDateStr}T00:00:00.000Z`);
      ops.push(() => prisma.ads_daily_stats.upsert({
        where: { campaign_id_date: { campaign_id: campaignIds[0], date: dateObj } },
        update: commData,
        create: {
          user_id: userId,
          user_merchant_id: umid,
          campaign_id: campaignIds[0],
          date: dateObj,
          cost: 0,
          clicks: 0,
          impressions: 0,
          ...commData,
        },
      }));
      updated++;
    }
  }

  // 限流：每批 50 条并行写，避免一次创建太多 prisma 连接
  for (let i = 0; i < ops.length; i += 50) {
    await Promise.all(ops.slice(i, i + 50).map((fn) => fn()));
  }

  return updated;
}
