/**
 * 「今日投放广告数」的判定核心（纯函数，不碰 DB）。
 *
 * 口径见 today-merchants-sync 的 countTodayNewAds 注释。这里只抽出可测的判定部分：
 * 取数（campaigns 今日行、更早的同 gcid 行、历史同名）由调用方做。
 *
 * D-366 的要点：库内分支的 `created_at` 是**入库时间**，不是广告在 Google 上的创建时间。
 * 补录路径（CampaignInfo 补录 / daily-sync Sheet 补录）把老系列第一次写进库时，
 * 行上盖的是「今天」，于是「今日投放」把别人几周前就在跑的广告算成今天新投的。
 * 判据：gcid 在 Google 全局唯一 —— 今日之前任何人名下已有同 gcid 行，这条就不是今天新投的。
 */

/** campaigns 表今日（CST）新建且已提交 Google 的行 */
export interface TodayDbCampaign {
  userId: string;
  gcid: string;
  campaignName: string;
}

/** Sheet CampaignInfo 的今日行（CreationDateCST = 今日，Google 侧真实创建日） */
export interface TodaySheetCampaign {
  userId: string;
  gcid: string;
  campaignName: string;
}

export interface TodayNewAdsInput {
  /** 库内今日入库行 */
  dbRows: TodayDbCampaign[];
  /** 今日之前已存在同 gcid 行的 gcid 集合（不分 user，含软删行） */
  preexistingGcids: Set<string>;
  /** Sheet 今日行 */
  sheetRows: TodaySheetCampaign[];
  /** userId → 该 user 今日之前用过的系列名集合（复用旧名重开不算新投） */
  historicalNamesByUser: Map<string, Set<string>>;
}

export interface TodayNewAdsResult {
  /** userId → 今日投放广告数 */
  countByUser: Map<string, number>;
  /** 被判为补录影子而剔除的行数（用于日志对账） */
  backfillSkipped: number;
}

export function computeTodayNewAds(input: TodayNewAdsInput): TodayNewAdsResult {
  const { dbRows, preexistingGcids, sheetRows, historicalNamesByUser } = input;

  // userId → (gcid → campaignName)
  const byUser = new Map<string, Map<string, string>>();
  let backfillSkipped = 0;

  // ① 库内今日入库行，剔除补录影子
  for (const c of dbRows) {
    if (preexistingGcids.has(c.gcid)) {
      backfillSkipped++;
      continue;
    }
    if (!byUser.has(c.userId)) byUser.set(c.userId, new Map());
    byUser.get(c.userId)!.set(c.gcid, c.campaignName || "");
  }

  // ② Sheet 今日行补充。同 gcid 已被 ① 收录时不覆盖：历史同名要拿库里的名字去比，
  //    Sheet 上的名字可能已被 Google 后台改过（D-225 回写前后不一致）。
  //    注意不对 ② 套 preexistingGcids：Sheet 的 CreationDateCST 本身就是 Google 侧
  //    真实创建日，它说今天建的就是今天建的，不需要再用入库时间去纠正。
  for (const r of sheetRows) {
    if (!byUser.has(r.userId)) byUser.set(r.userId, new Map());
    const m = byUser.get(r.userId)!;
    if (!m.has(r.gcid)) m.set(r.gcid, r.campaignName || "");
  }

  const countByUser = new Map<string, number>();
  for (const [userId, gcidToName] of byUser) {
    const historicalNames = historicalNamesByUser.get(userId) ?? new Set<string>();
    let count = 0;
    for (const [, name] of gcidToName) {
      if (name && historicalNames.has(name)) continue;
      count++;
    }
    countByUser.set(userId, count);
  }

  return { countByUser, backfillSkipped };
}
