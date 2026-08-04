import prisma from "@/lib/prisma";
import { sqlAffiliateTxnValidPlatformConnection } from "@/lib/affiliate-transaction-sql";
import {
  buildAttributionIndex, resolveAttributionTarget, toDateKey,
  type AttributionSpendDay,
} from "@/lib/commission-attribution";

/**
 * 将 affiliate_transactions 中的佣金回写到 ads_daily_stats。
 *
 * 用于让"数据中心-广告系列"页面的 commission/orders/rejected_commission 列
 * 与联盟平台后台保持一致。
 *
 * 行为：
 *   1. 将 [startDate, endExclusive) 区间内属于该用户的 ads_daily_stats 的佣金/订单字段
 *      先全部清零（避免历史残留）。
 *   2. 按 user_merchant_id + platform_connection_id + 日期聚合 affiliate_transactions（D-167：
 *      交易的 platform_connection_id 记录了「哪个联盟账号赚到这笔佣金」，是账号归属的权威来源）。
 *   3. 写回目标系列的选择（D-211，与数据中心同一套归因，见 commission-attribution.ts）：
 *      a. 候选集：同商家下 platform_connection_id 与交易一致的 campaign（同商家多账号投放时
 *         佣金精确流向对应账号的系列，如 wenjun3 的 C01 与 novanest 的 K01 各归各）；
 *         该连接在商家下没有系列时回退该商家全部系列。
 *      b. 在候选集里找「交易日当天或之前、最近一次真正花过钱」的系列——不限回溯窗口，
 *         广告停投后才到账的延迟转化仍算那条广告的。同日多条花钱取当日花费最高的。
 *      c. 交易日早于该商家全部花费记录时，才退回旧的「商家级最优行」（优先 ENABLED，
 *         次 PAUSED，最后 REMOVED；同状态取 updated_at 最新）。
 *   4. 多个聚合组落到同一 campaign+日期时累加（不互相覆盖）。
 *   5. 该商家在该日期完全没有 ads_daily_stats 行时，自动 upsert 一行（cost=0）。
 *
 * 时间口径（C-084 推翻 C-080）：按 CST 切日聚合 affiliate_transactions 并写入 ads_daily_stats.date，
 * 与联盟平台后台日期归档对齐（实测 wj02 CG 5/1-5/12 CST 切 = 平台 $3729.28 1:1 命中）。
 * ads_daily_stats.cost 也按 CST 归日（Google Ads MCC 时区），与 commission 同 CST 口径，
 * **完全对齐，无 8h 错位**。
 *
 * @param userId         需要纠正的用户 ID
 * @param startDate      开始时间（含，UTC Date 对象，但代表 CST 自然日的起始点）
 * @param endExclusive   结束时间（不含，UTC Date 对象，但代表 CST 自然日的次日起始点）
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
    { user_merchant_id: bigint; platform_connection_id: bigint | null; txn_date: string; total_commission: number; rejected_commission: number; order_count: number }[]
  >(`
    SELECT 
      user_merchant_id,
      platform_connection_id,
      DATE_FORMAT(CONVERT_TZ(transaction_time, '+00:00', '+08:00'), '%Y-%m-%d') as txn_date,
      SUM(CAST(commission_amount AS DECIMAL(12,2))) as total_commission,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(12,2)) ELSE 0 END) as rejected_commission,
      COUNT(*) as order_count
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0 AND transaction_time >= ? AND transaction_time < ?
      AND ${sqlAffiliateTxnValidPlatformConnection("affiliate_transactions")}
    GROUP BY user_merchant_id, platform_connection_id, DATE_FORMAT(CONVERT_TZ(transaction_time, '+00:00', '+08:00'), '%Y-%m-%d')
  `, userId, startDate, endExclusive);

  if (!txnAgg || txnAgg.length === 0) return 0;

  const merchantIds = [...new Set(txnAgg.map((t) => BigInt(String(t.user_merchant_id ?? 0))))]
    .filter((id) => id !== BigInt(0));
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
    select: { id: true, user_merchant_id: true, google_status: true, updated_at: true, platform_connection_id: true },
  });

  const STATUS_PRIORITY: Record<string, number> = { ENABLED: 0, PAUSED: 1, REMOVED: 2 };
  allCampaigns.sort((a, b) => {
    const pa = STATUS_PRIORITY[a.google_status || ""] ?? 2;
    const pb = STATUS_PRIORITY[b.google_status || ""] ?? 2;
    if (pa !== pb) return pa - pb;
    return b.updated_at.getTime() - a.updated_at.getTime();
  });

  const campaignsByMerchant = new Map<string, bigint[]>();
  // D-167：商家+联盟连接 二级索引，同商家多账号投放时按交易的 platform_connection_id 精确归属
  const campaignsByMerchantConn = new Map<string, bigint[]>();
  for (const c of allCampaigns) {
    const key = String(c.user_merchant_id);
    if (!campaignsByMerchant.has(key)) campaignsByMerchant.set(key, []);
    campaignsByMerchant.get(key)!.push(c.id);
    if (c.platform_connection_id) {
      const connKey = `${key}_${c.platform_connection_id}`;
      if (!campaignsByMerchantConn.has(connKey)) campaignsByMerchantConn.set(connKey, []);
      campaignsByMerchantConn.get(connKey)!.push(c.id);
    }
  }

  const allCampaignIds = allCampaigns.map((c) => c.id);

  // D-211：全历史花费日历 + 归因索引。回溯必须跨出本次重算区间——广告 7 月停投、
  // 8 月才到账的佣金，仍要落回 7 月那条真正花了钱的系列上。
  const spendCalendarRows = allCampaignIds.length > 0
    ? await prisma.ads_daily_stats.findMany({
        where: { campaign_id: { in: allCampaignIds }, is_deleted: 0, cost: { gt: 0 } } as never,
        select: { campaign_id: true, date: true, cost: true },
      })
    : [];
  const spendCalendar: AttributionSpendDay[] = spendCalendarRows.map((s) => ({
    campaignId: String(s.campaign_id),
    date: toDateKey(s.date),
    cost: Number(s.cost || 0),
  }));
  const attributionIndex = buildAttributionIndex(
    allCampaigns.map((c) => ({
      id: String(c.id),
      userMerchantId: c.user_merchant_id ? String(c.user_merchant_id) : null,
      platformConnectionId: c.platform_connection_id ? String(c.platform_connection_id) : null,
    })),
    spendCalendar,
  );
  // 回溯不到时的兜底：沿用旧的「商家级 / (商家,连接) 级最优行」（allCampaigns 已按状态+updated_at 排好序）
  const fallbackTarget = new Map<string, string>();
  for (const [key, ids] of campaignsByMerchantConn) {
    const [mid, conn] = key.split("_");
    fallbackTarget.set(`${mid}:${conn}`, String(ids[0]));
  }
  for (const [mid, ids] of campaignsByMerchant) {
    fallbackTarget.set(mid, String(ids[0]));
  }

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

  // D-167：先按目标 campaign+日期 累加（多个连接分组回退到同一主行时不能互相覆盖），再统一写库
  type AccEntry = { campaignId: bigint; umid: bigint; dateStr: string; commission: number; rejected_commission: number; orders: number };
  const acc = new Map<string, AccEntry>();

  for (const agg of txnAgg) {
    const umid = BigInt(String(agg.user_merchant_id ?? 0));
    if (umid === BigInt(0)) continue;

    const connId = agg.platform_connection_id ? String(agg.platform_connection_id) : null;
    const txnDateStr = String(agg.txn_date);
    // D-211：按花费时间轴定位到具体系列，回溯不到才退回代表行
    const target = resolveAttributionTarget(attributionIndex, fallbackTarget, String(umid), connId, txnDateStr);
    if (!target) continue;
    const targetId = BigInt(target);

    const accKey = `${targetId}_${txnDateStr}`;
    const entry = acc.get(accKey) ?? {
      campaignId: targetId, umid, dateStr: txnDateStr,
      commission: 0, rejected_commission: 0, orders: 0,
    };
    entry.commission += Number(agg.total_commission);
    entry.rejected_commission += Number(agg.rejected_commission);
    entry.orders += Number(agg.order_count);
    acc.set(accKey, entry);
  }

  const ops: (() => Promise<unknown>)[] = [];
  let updated = 0;

  for (const entry of acc.values()) {
    const commData = {
      commission: entry.commission,
      rejected_commission: entry.rejected_commission,
      orders: entry.orders,
    };
    const statsId = statsMap.get(`${entry.campaignId}_${entry.dateStr}`);
    if (statsId) {
      ops.push(() => prisma.ads_daily_stats.update({ where: { id: statsId }, data: commData }));
    } else {
      const dateObj = new Date(`${entry.dateStr}T00:00:00.000Z`);
      ops.push(() => prisma.ads_daily_stats.upsert({
        where: { campaign_id_date: { campaign_id: entry.campaignId, date: dateObj } },
        update: commData,
        create: {
          user_id: userId,
          user_merchant_id: entry.umid,
          campaign_id: entry.campaignId,
          date: dateObj,
          cost: 0,
          clicks: 0,
          impressions: 0,
          ...commData,
        },
      }));
    }
    updated++;
  }

  // 限流：每批 50 条并行写，避免一次创建太多 prisma 连接
  for (let i = 0; i < ops.length; i += 50) {
    await Promise.all(ops.slice(i, i + 50).map((fn) => fn()));
  }

  return updated;
}
