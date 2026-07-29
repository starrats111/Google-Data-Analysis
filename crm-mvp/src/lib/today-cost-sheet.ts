/**
 * 当日花费快速同步 — 从各 MCC 的 Google Sheet DailyData Tab 读「今天」的行写回 ads_daily_stats
 *
 * D-196 背景：
 * 花费此前只由每天 06:00 的 daily-sync 写一次，而那一轮要跑 4 个多小时、按用户名顺序爬，
 * 轮到某个用户时写下的是那一刻的快照，之后当天再花的钱一整天都不会补。
 * 佣金那边是 txn-quick-sync 每 30 分钟一轮，两条管道频率差了 48 倍，
 * 于是当天新起的系列必然呈现「有佣金没费用」（wj05 的 910-LH1-noflystore 实测：
 * Sheet 已经是 6 展示 / 4 点击 / $0.81，CRM 里还是 0）。
 *
 * 这里只补「今天」这一天，历史数据仍由 daily-sync 兜底重算，
 * 所以是纯增量修补，不改任何既有口径。
 */
import prisma from "@/lib/prisma";
import { todayCST } from "@/lib/date-utils";
import { syncFromSheet } from "@/lib/sheet-sync";
import { getExchangeRate } from "@/lib/exchange-rate";

export interface TodayCostResult {
  date: string;
  /** 参与同步的 MCC 数 */
  mccCount: number;
  /** 今天确实有行的 MCC 数 */
  mccWithData: number;
  /** 写入/更新的 ads_daily_stats 行数 */
  upserted: number;
  /** Sheet 里有、但 CRM 找不到对应 campaign 而跳过的行数 */
  skippedUnknown: number;
  errors: string[];
}

export async function syncTodayCostFromSheets(): Promise<TodayCostResult> {
  const today = todayCST();
  const out: TodayCostResult = {
    date: today,
    mccCount: 0,
    mccWithData: 0,
    upserted: 0,
    skippedUnknown: 0,
    errors: [],
  };

  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0, sheet_url: { not: null } },
    select: { id: true, mcc_id: true, user_id: true, currency: true, sheet_url: true },
  });
  out.mccCount = mccs.length;

  for (const mcc of mccs) {
    if (!mcc.sheet_url) continue;

    try {
      const res = await syncFromSheet(mcc.sheet_url, today, today);
      if (!res.success) {
        out.errors.push(`MCC ${mcc.mcc_id}: ${res.message || "读取失败"}`);
        continue;
      }
      const rows = res.rows.filter((r) => r.date === today && r.campaign_id);
      if (rows.length === 0) continue;
      out.mccWithData++;

      // 同一 gcid 在 Sheet 里可能有多行（广告级明细已在 syncFromSheet 聚合，这里再兜一次底）
      const byGcid = new Map<string, { cost: number; clicks: number; impressions: number }>();
      for (const r of rows) {
        const prev = byGcid.get(r.campaign_id);
        if (prev) {
          prev.cost += r.cost;
          prev.clicks += r.clicks;
          prev.impressions += r.impressions;
        } else {
          byGcid.set(r.campaign_id, { cost: r.cost, clicks: r.clicks, impressions: r.impressions });
        }
      }

      // 只认这个 MCC 名下未软删的 campaign。找不到的不补录——
      // 新系列补录是 backfillNewCampaigns 的职责，这里不重复造轮子也不绕过它的防回灌闸门。
      const campaigns = await prisma.campaigns.findMany({
        where: {
          user_id: mcc.user_id,
          mcc_id: mcc.id,
          is_deleted: 0,
          google_campaign_id: { in: [...byGcid.keys()] },
        },
        select: { id: true, google_campaign_id: true },
      });
      const idByGcid = new Map(campaigns.map((c) => [c.google_campaign_id!, c.id]));

      const rate = await getExchangeRate(mcc.currency, today);
      if (rate <= 0) {
        out.errors.push(`MCC ${mcc.mcc_id}: ${mcc.currency} 汇率不可用，跳过`);
        continue;
      }
      const dateObj = new Date(today);

      for (const [gcid, agg] of byGcid) {
        const campaignId = idByGcid.get(gcid);
        if (!campaignId) {
          out.skippedUnknown++;
          continue;
        }
        await prisma.ads_daily_stats.upsert({
          where: { campaign_id_date: { campaign_id: campaignId, date: dateObj } },
          update: { cost: agg.cost * rate, clicks: agg.clicks, impressions: agg.impressions },
          create: {
            user_id: mcc.user_id,
            campaign_id: campaignId,
            date: dateObj,
            cost: agg.cost * rate,
            clicks: agg.clicks,
            impressions: agg.impressions,
            user_merchant_id: BigInt(0),
          },
        });
        out.upserted++;
      }
    } catch (e) {
      out.errors.push(`MCC ${mcc.mcc_id}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
    }
  }

  return out;
}
