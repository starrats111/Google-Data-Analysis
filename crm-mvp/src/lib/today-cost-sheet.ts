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
  /** D-202：回写了预算/CPC 的 campaigns 行数 */
  metaUpdated: number;
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
    metaUpdated: 0,
    errors: [],
  };

  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0, sheet_url: { not: null } },
    select: { id: true, mcc_id: true, mcc_name: true, user_id: true, currency: true, sheet_url: true },
  });
  out.mccCount = mccs.length;

  for (const mcc of mccs) {
    if (!mcc.sheet_url) continue;

    try {
      const res = await syncFromSheet(mcc.sheet_url, today, today);
      if (!res.success) {
        out.errors.push(`MCC ${mcc.mcc_id}: ${res.message || "读取失败"}`);
        // D-266 批四：被封/结构未识别属重大危险 → 全员弹窗（库级 24h 去重，瞬态失败不报）
        try {
          const { broadcastSheetFailure } = await import("@/lib/system-broadcast");
          await broadcastSheetFailure(mcc.id, mcc.mcc_id, mcc.mcc_name, res.message || "");
        } catch { /* 告警失败不影响同步主流程 */ }
        continue;
      }
      const rows = res.rows.filter((r) => r.date === today && r.campaign_id);
      if (rows.length === 0) continue;
      out.mccWithData++;

      // 同一 gcid 在 Sheet 里可能有多行（广告级明细已在 syncFromSheet 聚合，这里再兜一次底）
      // D-202：顺带保留 Budget / 明确出价列，用于回写 campaigns（回填系列的预算此前
      // 一直是表默认值 $2.00，要等次日 06:00 daily-sync 才对齐）
      const byGcid = new Map<string, { cost: number; clicks: number; impressions: number; budget: number; cpcBid: number; isBudget: number | null; isRank: number | null; qs: number | null }>();
      for (const r of rows) {
        const prev = byGcid.get(r.campaign_id);
        if (prev) {
          prev.cost += r.cost;
          prev.clicks += r.clicks;
          prev.impressions += r.impressions;
          if (r.budget > prev.budget) prev.budget = r.budget;
          if (r.cpc_bid > 0) prev.cpcBid = r.cpc_bid;
          if (r.is_budget != null) prev.isBudget = r.is_budget;
          if (r.is_rank != null) prev.isRank = r.is_rank;
          if (r.quality_score != null) prev.qs = r.quality_score;
        } else {
          byGcid.set(r.campaign_id, {
            cost: r.cost, clicks: r.clicks, impressions: r.impressions,
            budget: r.budget, cpcBid: r.cpc_bid,
            isBudget: r.is_budget, isRank: r.is_rank, qs: r.quality_score,
          });
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
        select: { id: true, google_campaign_id: true, daily_budget: true, max_cpc_limit: true },
      });
      const campaignByGcid = new Map(campaigns.map((c) => [c.google_campaign_id!, c]));

      const rate = await getExchangeRate(mcc.currency, today);
      if (rate <= 0) {
        out.errors.push(`MCC ${mcc.mcc_id}: ${mcc.currency} 汇率不可用，跳过`);
        continue;
      }
      const dateObj = new Date(today);

      for (const [gcid, agg] of byGcid) {
        const campaign = campaignByGcid.get(gcid);
        if (!campaign) {
          out.skippedUnknown++;
          continue;
        }
        const campaignId = campaign.id;

        // D-202：预算/CPC 回写。预算取 Sheet Budget 列（账户币种，口径与 daily-sync 的
        // HM-D50 回写一致，不做汇率换算）；CPC 只认明确的出价列，缺列的表保持 NULL，
        // 不能拿平均 CPC 冒充最高出价。
        const budgetChanged = agg.budget > 0 && Number(campaign.daily_budget ?? 0) !== agg.budget;
        const cpcChanged = agg.cpcBid > 0 && Number(campaign.max_cpc_limit ?? 0) !== agg.cpcBid;
        if (budgetChanged || cpcChanged) {
          try {
            await prisma.campaigns.update({
              where: { id: campaignId },
              data: {
                ...(budgetChanged ? { daily_budget: agg.budget } : {}),
                ...(cpcChanged ? { max_cpc_limit: agg.cpcBid } : {}),
                last_google_sync_at: new Date(),
              },
            });
            out.metaUpdated++;
          } catch (e) {
            out.errors.push(`MCC ${mcc.mcc_id} gcid ${gcid} 预算回写失败: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
          }
        }

        // D-264：IS/QS 走 Sheet，只在有值时写（null 不覆盖既有值）
        const metricPatch = {
          ...(agg.isBudget != null ? { is_budget: agg.isBudget } : {}),
          ...(agg.isRank != null ? { is_rank: agg.isRank } : {}),
          ...(agg.qs != null ? { quality_score: agg.qs } : {}),
        };
        await prisma.ads_daily_stats.upsert({
          where: { campaign_id_date: { campaign_id: campaignId, date: dateObj } },
          // is_deleted 归零：campaign 已复活（上面只查 is_deleted=0 的系列）但花费行还停留在
          // 软删态时，唯一键会命中那一行；不清标记的话花费写进去了却依然不可见
          // data_source 必须显式写：API 路径会把标签改成 api 且从不改回，
          // 不在 update 里重置的话，Sheet 明明是本行的真实来源却永久显示为 api（D-198）
          update: { cost: agg.cost * rate, clicks: agg.clicks, impressions: agg.impressions, is_deleted: 0, data_source: "sheet", ...metricPatch },
          create: {
            user_id: mcc.user_id,
            campaign_id: campaignId,
            date: dateObj,
            cost: agg.cost * rate,
            clicks: agg.clicks,
            impressions: agg.impressions,
            user_merchant_id: BigInt(0),
            data_source: "sheet",
            ...metricPatch,
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
