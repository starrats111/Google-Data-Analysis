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
 * D-345 账号维度不可信（2026-09-21 定位）：第 1 条的「候选集按 platform_connection_id 对齐」
 * 建立在「交易行的连接 = 赚这笔钱的联盟账号」这个前提上，而这个前提是错的：
 *   · 一个物理联盟号可以配多把 api_key、在 CRM 里成为多条连接（wj10 的 conn 90 aura-bloom
 *     与 conn 274 quiblo 的 final_url_suffix 里 irpid 都是 5227661，同一个 Impact publisher）；
 *   · `affiliate_transactions.platform_connection_id` 只在 create 时写入（txn-quick-sync 的
 *     update 子句刻意不改它），所以它记的是「哪把 key 先抓到这条」，不是「哪个号赚的」；
 *   · `user_merchants` 唯一键是 (user, platform, merchant_id)，**没有连接维度**，商家本身
 *     根本不按联盟账号切分，两侧的连接来自两个各自竞争的来源。
 * 实测 5,053 个 (用户,商家) 分组里 382 组的「交易连接」与「系列连接」根本对不上。后果有两种：
 *   a) 花钱的系列在 A 号、交易挂在 B 号 → 佣金落到 B 号下那条早已停投的系列上
 *      （wj10 的 928-clearstemskincare 花了 $415/1499 点击拿 0 佣金，全被 8 月就停投的
 *      1272 号拿走 $1073.73/189 单）；
 *   b) B 号下压根没有花费记录 → strict 时间轴回溯不到，退到代表行兜底，于是整坨佣金投给
 *      B 号组里「ENABLED 优先 → created_at 最近」选出来的那条，与花费时间毫无关系
 *      （wj10 的 1488-Lenovo 9/15 才第一次花钱，却拿到整个 9 月的 $988.60/35 单，
 *      其中 9/1~9/14 的 $787.41/28 单实际是 A 号的 1398 打出来的）。
 * 两种都不丢钱（代表行兜底一直在接），丢的是「哪条广告带来的」这个信息本身。
 * 修法：strict 时间轴只在「确实是最近一次为该商家花钱的账号」时保持权威——回溯不到、
 * 或商家级时间轴上存在更近的花费日时，一律让位给商家级时间轴。同一商家真的被两个账号
 * 同期投放时，两条时间轴的最近花费日相同，仍按 strict 走，D-168 的精确投行不受影响。
 *
 * D-346 重投放按系列名日期接管（07 2026-09-21 提出：「我八月十五号投了一个广告、八月二十号
 * 停掉，后面又重新投放，数据要跟着新的投放时间统计，前后不能混在一起」）：
 * 第 2 条的「最近一个花过钱的日子」在重投放场景下有个真空期——新系列名字写 0909、但因为
 * 审核/预算要到 0910 才真正跑出花费，0909 那天的单会回溯到上一条早就停投的系列头上。
 * 现在把接管点提前到系列名末段的 `-MMDD-` 日期（`parseCampaignNameDate`，年份用 created_at
 * 做锚、跨年按就近校正）。三个闸门缺一不可：
 *   1. 该系列自己【确实花过钱】。生产实测 19 组分歧里有 14 组的「按名字该归的那条」从没投放过
 *      （yz04 的 181-bellamiacollections 名字写 0901、零花费零点击，而 979 从 7/26 一直投到
 *      9/20 从没停过）——不设这道闸门就等于把 $3554 投给一条没跑过的系列，正是 D-211 要修的病；
 *   2. 名字日期【早于】它自己的首个花费日（晚于或等于时，花费日历本来就更准）；
 *   3. 那天【没有任何系列真的在花钱】（真花钱的日子仍由当日花费最高者整拿，D-168/D-251 不变）。
 * 并行投放不受影响：旧系列还在花钱的日子各有自己的格子，只有真空期才落到新系列名下。
 * 实测影响面（9 月）：4 组 6 单、$106，全部是「旧的确实停了、新的确实上了」的真重投放。
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
  /** D-346：系列名（用于解析投放日期段 -MMDD-MID）。缺省时该系列只按花费日划界 */
  campaignName?: string | null;
  /** D-346：建档时间，给名字里的 MMDD 补年份用 */
  createdAt?: Date | string | null;
}

/**
 * D-346：从系列名末段解析投放日期（`…-国家-MMDD-MID` 里的 MMDD）。
 * 名字里没有年份，用 createdAt 的年份做锚；若补出来的日期离建档日超过半年，
 * 说明跨年（如 12 月底建的名字写 0103），按年份 ±1 校正后取更近的那个。
 * 解析不出来返回 null —— 调用方退回纯花费口径，绝不猜。
 */
export function parseCampaignNameDate(
  campaignName: string | null | undefined,
  createdAt: Date | string | null | undefined,
): string | null {
  if (!campaignName || !createdAt) return null;
  const m = campaignName.match(/-(\d{2})(\d{2})-\d+\s*$/);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) return null;
  const createdKey = toDateKey(created);
  const baseYear = Number(createdKey.slice(0, 4));

  const mmdd = `${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const candidates = [baseYear - 1, baseYear, baseYear + 1].map((y) => `${y}-${mmdd}`);
  const createdMs = Date.parse(`${createdKey}T00:00:00Z`);
  let best: string | null = null;
  let bestGap = Infinity;
  for (const cand of candidates) {
    const ms = Date.parse(`${cand}T00:00:00Z`);
    if (Number.isNaN(ms)) continue; // 2/30 之类的非法日期
    const gap = Math.abs(ms - createdMs);
    if (gap < bestGap) {
      bestGap = gap;
      best = cand;
    }
  }
  return best;
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

/**
 * D-346：在 [from, before) 里找第一个不在 occupied 里的自然日；找不到返回 null。
 * 上限是该系列自己的首个花费日——到了那天花费日历自然接管，不必再插格。
 */
function firstFreeDay(from: string, before: string, occupied: Set<string>): string | null {
  const limitMs = Date.parse(`${before}T00:00:00Z`);
  let ms = Date.parse(`${from}T00:00:00Z`);
  if (Number.isNaN(ms) || Number.isNaN(limitMs)) return null;
  while (ms < limitMs) {
    const day = new Date(ms).toISOString().slice(0, 10);
    if (!occupied.has(day)) return day;
    ms += 86400000;
  }
  return null;
}

function toSortedTimeline(
  buckets: Map<string, Map<string, DaySpenders>>,
  metaById: Map<string, AttributionCampaign>,
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

    // D-346：重投放的接管点提前到「系列名里的投放日期」。
    // 两个前置条件（其余情况维持纯花费口径）：
    //   1. 该系列自己确实花过钱——从没投放的系列不参选（否则佣金又落回零花费草稿，见文件头 D-211）；
    //   2. 名字日期早于它的首个花费日——晚于/等于时花费日历本来就更准。
    // 落格位置：从名字日期起往后找【第一个没有任何系列真花钱】的日子。真花钱的日子一律由
    // 当日花费最高者整拿（D-168/D-251 不变），所以名字日期当天若旧系列还在投，接管顺延到次日。
    // 并行投放天然不受影响：旧系列一直没停时 [名字日期, 自己首个花费日) 全被占满，一格都插不进去。
    const occupied = new Set(list.map((e) => e.date));
    for (const id of range.keys()) {
      const meta = metaById.get(id);
      if (!meta) continue;
      const nameDate = parseCampaignNameDate(meta.campaignName, meta.createdAt);
      if (!nameDate) continue;
      const firstSpend = range.get(id)!.first;
      if (nameDate >= firstSpend) continue;
      const slot = firstFreeDay(nameDate, firstSpend, occupied);
      if (!slot) continue;
      list.push({ date: slot, campaignId: id });
      occupied.add(slot);
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

  return {
    strict: toSortedTimeline(strictBuckets, metaById),
    loose: toSortedTimeline(looseBuckets, metaById),
  };
}

/** 二分查找 date <= target 的最后一格（连日期一起返回，D-345 要比较两条时间轴谁更近）；找不到返回 null */
function findLatestOnOrBefore(timeline: TimelineEntry[], target: string): TimelineEntry | null {
  let lo = 0;
  let hi = timeline.length - 1;
  let found: TimelineEntry | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timeline[mid].date <= target) {
      found = timeline[mid];
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
  const strictTl = connId ? index.strict.get(`${merchantId}|${connId}`) : undefined;
  const looseTl = index.loose.get(merchantId);

  const strictHit = strictTl ? findLatestOnOrBefore(strictTl, date) : null;
  const looseHit = looseTl ? findLatestOnOrBefore(looseTl, date) : null;

  // D-345：本账号时间轴回溯不到、或已经过期（另一个账号在更近的日子还在为这个商家花钱）时，
  // 一律让位给商家级时间轴。详见文件头「账号维度不可信」一节。
  const hit = !strictHit
    ? looseHit
    : looseHit && looseHit.date > strictHit.date
      ? looseHit
      : strictHit;

  return (
    hit?.campaignId ??
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
