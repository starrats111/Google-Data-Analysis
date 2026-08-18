/**
 * 联盟佣金 → 广告系列 的时间归因（07 拍板 2026-08-04）
 *
 * 背景：联盟平台回传的交易只带 商家(MID) 与 联盟账号(platform_connection_id)，
 * 不含任何广告系列标识。旧口径（D-168）把同一 (商家,账号) 的佣金整坨投给「代表行」，
 * 代表行按「ENABLED 优先 → created_at 最近」选举，结果佣金经常落在一条从没提交过
 * Google、花费为 0 的草稿上，而真正花了钱跑出订单的那条系列显示佣金 0 / ROI -1。
 * 生产实证：SHEFIT(MID 8005326) 的 16 单 $96.07 全落在 DRAFT 草稿，真正花了 $26.16
 * 的 326 号系列颗粒无收。
 *
 * 新口径用「时间 + 花费」定位到具体系列：
 *   1. 候选集 = 该商家下 platform_connection_id 与交易一致的系列；为空则回退该商家全部系列。
 *   2. 在候选集里找「交易日当天或之前、最近一个真正花过钱的日子」，那天在跑的系列即归属对象。
 *      不限回溯窗口——广告停掉之后到账的延迟转化，仍算那条广告带来的。
 *   3. 同一天有多条系列都花了钱时，整笔归给当日花费最多的那条（佣金与订单都不拆小数）。
 *   4. 交易早于该商家所有花费记录时，回退到旧的代表行规则。
 *
 * D-251 同日交接特例（徐克提出、07 2026-08-18 拍板，覆盖第 3 条）：
 *   CID 被中止后换新 CID 续跑同一商家时，若「老系列的最后花费日」与「新系列的首个花费日」
 *   是同一天（同天停老上新），当天的佣金一律归老系列（当天的单大概率是老广告 cookie 期转化），
 *   新系列从次日起自然接管。判定完全基于花费日历：
 *   老 = 当天是其最后花费日、且此前投放过（first < 当天）；新 = 当天是其首个花费日。
 *   仅在「老、新同日都有花费」时触发；其余同日多系列花费仍按「当日花费最高者整拿」。
 *
 * 影响面（2026-08-04 生产实测）：12,006 个商家里 87% 只有一条系列，完全无变化；
 * 有多条系列且花过钱的分组 674 个，其中 87% 花费窗口不重叠、靠时间就唯一确定；
 * 需要「同日花费最多」兜底的只有 499 个日行，占全部 48,963 个「日×商家×账号」的 1.0%。
 */

/** 参与归因的广告系列（id 用 gcid 去重后的 primaryId） */
export interface AttributionCampaign {
  id: string;
  userMerchantId: string | null;
  platformConnectionId: string | null;
}

/** 一条「系列 × 日期」的花费记录，只需要真正花过钱的（cost > 0） */
export interface AttributionSpendDay {
  campaignId: string;
  /** CST 自然日，YYYY-MM-DD */
  date: string;
  cost: number;
}

/** 按 (商家, 联盟账号, CST 日) 聚合后的交易 */
export interface AttributionTxnGroup {
  merchantId: string;
  connId: string | null;
  /** CST 自然日，YYYY-MM-DD */
  date: string;
  commission: number;
  rejected: number;
  approved: number;
  paid: number;
  pending: number;
  orders: number;
}

export interface AttributedCommission {
  commission: number;
  rejected: number;
  approved: number;
  paid: number;
  pending: number;
  orders: number;
}

/** 时间轴上的一格：某天该组里花费最多的系列 */
interface TimelineEntry {
  date: string;
  campaignId: string;
}

export interface AttributionIndex {
  /** `${merchantId}|${connId}` → 按日期升序的时间轴 */
  strict: Map<string, TimelineEntry[]>;
  /** `${merchantId}` → 按日期升序的时间轴（该商家全部系列，含账号未回填的） */
  loose: Map<string, TimelineEntry[]>;
}

/** 组内某天的花费方：campaignId → 当日花费（同系列多行取最大，与旧口径一致，防 gcid 去重后的重复行翻倍） */
type DaySpenders = Map<string, number>;

function pushSpend(
  buckets: Map<string, Map<string, DaySpenders>>,
  key: string,
  day: AttributionSpendDay,
) {
  let byDate = buckets.get(key);
  if (!byDate) {
    byDate = new Map();
    buckets.set(key, byDate);
  }
  let spenders = byDate.get(day.date);
  if (!spenders) {
    spenders = new Map();
    byDate.set(day.date, spenders);
  }
  const prev = spenders.get(day.campaignId);
  if (prev === undefined || day.cost > prev) spenders.set(day.campaignId, day.cost);
}

/**
 * 同日多系列花费时选出当天的归属系列。
 * D-251：当天既是「老」的最后花费日（且老此前投过）、又是「新」的首个花费日 → 归老；
 * 其余情况维持「当日花费最高者整拿」（07 2026-08-04 拍板）。
 */
function pickDayWinner(
  date: string,
  spenders: DaySpenders,
  range: Map<string, { first: string; last: string }>,
) {
  const maxBySpend = (ids: string[]): string =>
    ids.reduce((best, id) => ((spenders.get(id) ?? 0) > (spenders.get(best) ?? 0) ? id : best));

  const ids = [...spenders.keys()];
  if (ids.length === 1) return ids[0];

  const enders = ids.filter((id) => {
    const r = range.get(id)!;
    return r.last === date && r.first < date;
  });
  const hasStarter = ids.some((id) => range.get(id)!.first === date);
  if (enders.length > 0 && hasStarter) return maxBySpend(enders);

  return maxBySpend(ids);
}

function toSortedTimeline(
  buckets: Map<string, Map<string, DaySpenders>>,
): Map<string, TimelineEntry[]> {
  const out = new Map<string, TimelineEntry[]>();
  for (const [key, byDate] of buckets) {
    // 组内每条系列的首个/最后花费日（D-251 交接判定依据）
    const range = new Map<string, { first: string; last: string }>();
    for (const [date, spenders] of byDate) {
      for (const id of spenders.keys()) {
        const r = range.get(id);
        if (!r) range.set(id, { first: date, last: date });
        else {
          if (date < r.first) r.first = date;
          if (date > r.last) r.last = date;
        }
      }
    }
    const list: TimelineEntry[] = [];
    for (const [date, spenders] of byDate) {
      list.push({ date, campaignId: pickDayWinner(date, spenders, range) });
    }
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    out.set(key, list);
  }
  return out;
}

/**
 * 构建归因索引。
 * @param campaigns   候选系列（必须是【未经视图筛选】的全量集合，否则佣金会随筛选条件漂移）
 * @param spendDays   这些系列的【全历史】花费日历，只需 cost > 0 的记录
 */
export function buildAttributionIndex(
  campaigns: AttributionCampaign[],
  spendDays: AttributionSpendDay[],
): AttributionIndex {
  const metaById = new Map<string, AttributionCampaign>();
  for (const c of campaigns) {
    if (c.userMerchantId && c.userMerchantId !== "0") metaById.set(c.id, c);
  }

  const strictBuckets = new Map<string, Map<string, DaySpenders>>();
  const looseBuckets = new Map<string, Map<string, DaySpenders>>();

  for (const day of spendDays) {
    if (!(day.cost > 0)) continue;
    const meta = metaById.get(day.campaignId);
    if (!meta || !meta.userMerchantId) continue;

    pushSpend(looseBuckets, meta.userMerchantId, day);
    if (meta.platformConnectionId) {
      pushSpend(strictBuckets, `${meta.userMerchantId}|${meta.platformConnectionId}`, day);
    }
  }

  return { strict: toSortedTimeline(strictBuckets), loose: toSortedTimeline(looseBuckets) };
}

/** 二分查找 date <= target 的最后一格；找不到返回 null */
function findLatestOnOrBefore(timeline: TimelineEntry[], target: string): string | null {
  let lo = 0;
  let hi = timeline.length - 1;
  let found: string | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].date <= target) {
      found = timeline[mid].campaignId;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * 定位单组交易（商家 + 联盟账号 + 日）应归属的广告系列。
 * @param fallbackTarget 旧的代表行映射（`${mid}:${conn}` / `${mid}`），仅在时间轴上回溯不到时使用
 */
export function resolveAttributionTarget(
  index: AttributionIndex,
  fallbackTarget: Map<string, string>,
  merchantId: string,
  connId: string | null,
  date: string,
): string | null {
  const timeline =
    (connId ? index.strict.get(`${merchantId}|${connId}`) : undefined) ??
    index.loose.get(merchantId);

  return (
    (timeline ? findLatestOnOrBefore(timeline, date) : null) ??
    (connId ? fallbackTarget.get(`${merchantId}:${connId}`) : undefined) ??
    fallbackTarget.get(merchantId) ??
    null
  );
}

/**
 * 为一批交易定位归属的广告系列。
 * @returns campaignId → 佣金聚合
 */
export function attributeCommissionToCampaigns(
  groups: AttributionTxnGroup[],
  index: AttributionIndex,
  fallbackTarget: Map<string, string>,
): Map<string, AttributedCommission> {
  const byRow = new Map<string, AttributedCommission>();

  for (const g of groups) {
    const target = resolveAttributionTarget(index, fallbackTarget, g.merchantId, g.connId, g.date);
    if (!target) continue;

    const entry = byRow.get(target) ?? {
      commission: 0, rejected: 0, approved: 0, paid: 0, pending: 0, orders: 0,
    };
    entry.commission += g.commission;
    entry.rejected += g.rejected;
    entry.approved += g.approved;
    entry.paid += g.paid;
    entry.pending += g.pending;
    entry.orders += g.orders;
    byRow.set(target, entry);
  }

  return byRow;
}

/** Prisma 的 Date（@db.Date，UTC 午夜）→ YYYY-MM-DD */
export function toDateKey(d: Date | string): string {
  return d instanceof Date ? d.toISOString().split("T")[0] : String(d).split("T")[0];
}
