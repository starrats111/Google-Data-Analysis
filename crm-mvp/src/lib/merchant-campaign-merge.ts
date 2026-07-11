/**
 * 同商家广告系列汇总（费用 + 佣金 → 代表系列）
 *
 * 背景：数据看板里，花费来自 ads_daily_stats（按广告系列维度），佣金来自
 * affiliate_transactions（按商家 user_merchant_id 维度）。同一个商家往往对应多条
 * 广告系列（同商家不同时间新建、不同 google_campaign_id），旧口径下花费落在实际
 * 消耗的那条系列上、佣金整坨塞到另一条代表系列上，导致"有佣金却 0 花费 / 有花费却
 * 0 佣金"的分家现象。
 *
 * D-168 起归集粒度细化为【商家 + 联盟账号】：同一个商家可能被同用户的多个联盟账号
 * 投放（如 C01 用 LH 1 号账号 wenjun3、K01 用 LH 2 号账号 novanest），旧口径按商家
 * 整体归集会把两个账号的花费/佣金都塞进一条代表行。现口径：
 *   1. 按 (user_merchant_id, platform_connection_id) 分组，每组独立选代表行并归集
 *      本组的 花费/点击/展示；
 *   2. 代表行选举规则不变：ENABLED 优先 → created_at 最近 → id 大；
 *   3. 佣金按交易的 (user_merchant_id, platform_connection_id) 精确投给对应组的
 *      代表行；交易连接在该商家下没有系列组时，回退投给商家级代表行。
 * 无商家（user_merchant_id 为空 / 0）的系列保持各自原始花费，不参与汇总。
 *
 * 注意：本工具只影响【逐行展示】口径；总览合计（totalCost/totalClicks）与按 MCC
 * 的花费分布应继续基于原始 per-campaign 统计，因为汇总只是把金额在组内重新归集，
 * 逐行求和后的总量不变。
 */

export interface MergeableCampaign {
  id: bigint;
  google_status: string | null;
  user_merchant_id: bigint | null;
  /** D-168：系列归属的联盟账号；NULL 视为独立分组（连接未知，不与已知账号混并） */
  platform_connection_id?: bigint | null;
  created_at?: Date | null;
}

export interface StatEntry {
  cost: number;
  clicks: number;
  impressions: number;
}

export interface MerchantMergeResult {
  /** primaryId(string) -> 该行【展示】用的统计（组代表行携带组内汇总，其余行清零） */
  displayStats: Map<string, StatEntry>;
  /**
   * 佣金投放目标：
   *   `${merchantId}:${connId}` -> 该 (商家,联盟账号) 组的代表 primaryId
   *   `${merchantId}`           -> 商家级代表 primaryId（交易连接无对应组时的回退）
   */
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

  // 商家 → 全部系列（商家级回退代表行用）；(商家,连接) → 组内系列
  const byMerchant = new Map<string, MergeableCampaign[]>();
  const byGroup = new Map<string, MergeableCampaign[]>();
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

    // 连接未知（NULL）的系列单独一组，不并入任何已知账号组
    const gkey = `${mid}|${c.platform_connection_id ? String(c.platform_connection_id) : "null"}`;
    if (!byGroup.has(gkey)) byGroup.set(gkey, []);
    byGroup.get(gkey)!.push(c);
  }

  // 每个 (商家,连接) 组：组内花费归集到组代表行，其余清零
  for (const [gkey, group] of byGroup) {
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
    const [mid, connPart] = gkey.split("|");
    if (connPart !== "null") commissionTarget.set(`${mid}:${connPart}`, repId);
    representativeIds.add(repId);
  }

  // 商家级回退代表行（交易连接在该商家下无系列组时投这里）
  for (const [mid, group] of byMerchant) {
    const rep = pickRepresentative(group);
    commissionTarget.set(mid, String(rep.id));
    representativeIds.add(String(rep.id));
  }

  return { displayStats, commissionTarget, representativeIds };
}

/** 交易佣金组（按 商家+联盟账号 聚合后的一组） */
export interface CommissionGroup {
  merchantId: string;
  /** 交易的 platform_connection_id；null 表示未知连接 */
  connId: string | null;
  commission: number;
  rejected: number;
  approved: number;
  orders: number;
}

/**
 * D-168：把按 (商家,连接) 聚合的佣金组投放到具体展示行。
 * 精确命中 (商家,连接) 组代表行 → 投该行；否则回退商家级代表行；多组落同行时累加。
 * 返回 rowId(string) → 佣金聚合。
 */
export function routeCommissionToRows(
  groups: CommissionGroup[],
  commissionTarget: Map<string, string>,
): Map<string, { commission: number; rejected: number; approved: number; orders: number }> {
  const byRow = new Map<string, { commission: number; rejected: number; approved: number; orders: number }>();
  for (const g of groups) {
    const target =
      (g.connId ? commissionTarget.get(`${g.merchantId}:${g.connId}`) : undefined) ??
      commissionTarget.get(g.merchantId);
    if (!target) continue;
    const entry = byRow.get(target) ?? { commission: 0, rejected: 0, approved: 0, orders: 0 };
    entry.commission += g.commission;
    entry.rejected += g.rejected;
    entry.approved += g.approved;
    entry.orders += g.orders;
    byRow.set(target, entry);
  }
  return byRow;
}
