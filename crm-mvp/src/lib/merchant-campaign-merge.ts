/**
 * 同商家广告系列汇总（费用 + 佣金 → 代表系列）
 *
 * 背景：数据看板里，花费来自 ads_daily_stats（按广告系列维度），佣金来自
 * affiliate_transactions（按商家 user_merchant_id 维度）。同一个商家往往对应多条
 * 广告系列（同商家不同时间新建、不同 google_campaign_id），旧口径下花费落在实际
 * 消耗的那条系列上、佣金整坨塞到另一条代表系列上，导致"有佣金却 0 花费 / 有花费却
 * 0 佣金"的分家现象。
 *
 * 现口径：把同一个商家的 花费/点击/展示/佣金 统一汇总到一条【代表广告系列】：
 *   1. 优先选【已启用 ENABLED】的系列；
 *   2. 有多条已启用时，取 created_at 日期最近的一条；
 *   3. 没有已启用时，回退到当前最高优先级状态（PAUSED 优于 REMOVED）里 created_at 最近的一条。
 * 同商家的其余系列（非代表）花费/点击/展示清零、佣金为 0。
 * 无商家（user_merchant_id 为空 / 0）的系列保持各自原始花费，不参与汇总。
 *
 * 注意：本工具只影响【逐行展示】口径；总览合计（totalCost/totalClicks）与按 MCC
 * 的花费分布应继续基于原始 per-campaign 统计，因为汇总只是把金额在同商家内重新
 * 归集，逐行求和后的总量不变。
 */

export interface MergeableCampaign {
  id: bigint;
  google_status: string | null;
  user_merchant_id: bigint | null;
  created_at?: Date | null;
}

export interface StatEntry {
  cost: number;
  clicks: number;
  impressions: number;
}

export interface MerchantMergeResult {
  /** primaryId(string) -> 该行【展示】用的统计（代表行携带商家汇总，其余同商家行清零） */
  displayStats: Map<string, StatEntry>;
  /** merchantId(string) -> 接收佣金的代表 primaryId(string) */
  commissionTarget: Map<string, string>;
  /** 全部代表 primaryId 集合（用于展示过滤时保留携带佣金/花费的代表行） */
  representativeIds: Set<string>;
}

const STATUS_TIER: Record<string, number> = { ENABLED: 0, PAUSED: 1, REMOVED: 2 };

function tierOf(c: MergeableCampaign): number {
  return STATUS_TIER[c.google_status || ""] ?? 2;
}

function pickRepresentative(group: MergeableCampaign[]): MergeableCampaign {
  const minTier = Math.min(...group.map(tierOf));
  const pool = group.filter((c) => tierOf(c) === minTier);
  return [...pool].sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    if (tb !== ta) return tb - ta; // created_at 最近的在前
    return Number(b.id) - Number(a.id); // 兜底：id 大的（较新）在前
  })[0];
}

export function mergeMerchantCampaigns(
  campaigns: MergeableCampaign[],
  statsByPrimaryId: Map<string, StatEntry>,
): MerchantMergeResult {
  const displayStats = new Map<string, StatEntry>();
  const commissionTarget = new Map<string, string>();
  const representativeIds = new Set<string>();

  const byMerchant = new Map<string, MergeableCampaign[]>();
  for (const c of campaigns) {
    const mid = c.user_merchant_id ? String(c.user_merchant_id) : "";
    if (!mid || mid === "0") {
      const pid = String(c.id);
      const s = statsByPrimaryId.get(pid);
      displayStats.set(pid, s ? { ...s } : { cost: 0, clicks: 0, impressions: 0 });
      continue;
    }
    if (!byMerchant.has(mid)) byMerchant.set(mid, []);
    byMerchant.get(mid)!.push(c);
  }

  for (const [mid, group] of byMerchant) {
    const rep = pickRepresentative(group);
    const repId = String(rep.id);
    const agg: StatEntry = { cost: 0, clicks: 0, impressions: 0 };
    for (const c of group) {
      const s = statsByPrimaryId.get(String(c.id));
      if (s) {
        agg.cost += s.cost;
        agg.clicks += s.clicks;
        agg.impressions += s.impressions;
      }
    }
    for (const c of group) {
      const pid = String(c.id);
      displayStats.set(pid, pid === repId ? agg : { cost: 0, clicks: 0, impressions: 0 });
    }
    commissionTarget.set(mid, repId);
    representativeIds.add(repId);
  }

  return { displayStats, commissionTarget, representativeIds };
}
