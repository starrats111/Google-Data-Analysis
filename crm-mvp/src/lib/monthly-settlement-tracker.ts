import prisma from "@/lib/prisma";
import { sqlTxnMonth } from "@/lib/report-metrics";

/**
 * 月度结算追踪 — 核心逻辑
 *
 * 与日级 ads_daily_stats 不同，monthly_settlement_status 关注「该月是否已结算」：
 *   - 该月所有交易 pending_count = 0 → is_settled = 1（联盟平台已对账完毕）
 *   - 仍有 pending → is_settled = 0，daily-sync 每天继续拉取该月数据校对
 *
 * 「已结算」定义（07 拍板）：
 *   pending_count = 0 即视为已结算（即使 paid_count = 0、approved_count > 0 也算）
 *   理由：联盟平台 approved 之后到 paid 中间是平台打款流程，不影响数据准确性
 *   被 rejected 的也算结清（钱不会再变化）
 *
 * ── 快照表只驱动同步，不供展示（D-294，2026-08-28）─────────────────────────
 * monthly_settlement_status 是 daily-sync 每天刷一次的快照，它的用途只剩两个：
 * 决定「哪个月还要继续去平台拉数据」（listUnsettledMonthsForUser）和记 settled_at。
 * 界面展示一律走 getMonthlyProgressLive 实时算。
 * 起因：daily-sync 2026-08-26 起连续三天在 Step 1 爆堆被 pm2 重启，快照停在 8-25，
 * 而交易表由独立的 txn-quick-sync 保持实时 → 结算进度卡比实际少了 $7808.37。
 * 展示依赖每日快照，等于把「某个 cron 挂没挂」的风险直接暴露成错数字。
 *
 * ── 时间口径 ──────────────────────────────────────────────────────────────
 * 按 CST（东八区）归月（C-084 推翻 C-080），与 CG/MUI/EV 等平台后台本地日期归档
 * 1:1 对齐（实测 wj02 CG 5/1-5/12 CST 切 = 平台 $3729.28 1:1 命中）。
 * 具体表达式统一走 report-metrics 的 sqlTxnMonth()：LH 入库已是北京时间钟面、
 * 不得再 +8，其余平台是真 UTC 才 +8。D-294 前本文件写死一律 +8，把 LH 上月末
 * 最后 8 小时的单错算进下个月（实测 2026-08 团队 1 多算 10 单 / $28.77）。
 */

export interface MonthSummary {
  month: string;                      // YYYY-MM
  total_count: number;
  total_amount: number;
  pending_count: number;
  pending_amount: number;
  approved_count: number;
  approved_amount: number;
  paid_count: number;
  paid_amount: number;
  rejected_count: number;
  rejected_amount: number;
  is_settled: boolean;
  settled_at: string | null;          // ISO
  last_synced_at: string | null;
  settled_amount: number;             // approved + paid + rejected（"不再变化"的部分）
  settle_progress: number;            // 0-100, settled_amount / total_amount * 100
}

/**
 * 四个状态桶的 SQL 片段（金额 + 单数），与「结算查询」汇总逐字同源。
 *
 * 审核中口径取 `NOT IN (approved, rejected, paid)` 而非 `= 'pending'`：
 * 同步层 normalizeTxnStatus 目前只会写出这四个值（2026-08-28 全表实测确认），
 * 但用补集写法能保证四段金额恒等于 total_amount（进度条不会凑不满），
 * 且万一将来冒出新状态值，该月会留在「未结算」继续被 daily-sync 拉取校对，
 * 而不是被误判成结清后再也不管。
 */
const SQL_STATUS_BUCKETS = `
      SUM(CASE WHEN status NOT IN ('approved','rejected','paid') THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN status NOT IN ('approved','rejected','paid') THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS pending_amount,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
      SUM(CASE WHEN status = 'approved' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS approved_amount,
      SUM(CASE WHEN status = 'paid'     THEN 1 ELSE 0 END) AS paid_count,
      SUM(CASE WHEN status = 'paid'     THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS paid_amount,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS rejected_amount`;

/**
 * 重新计算某个用户从 affiliate_transactions 实时聚合每月统计，
 * 并 upsert 到 monthly_settlement_status。
 *
 * @returns 受影响的月份数（含已存在记录的更新和新增记录）
 */
export async function recomputeMonthlySettlementForUser(userId: bigint): Promise<number> {
  // 步骤 1：从 affiliate_transactions 按月聚合状态分布
  const monthRows = await prisma.$queryRawUnsafe<{
    month: string;
    total_count: bigint;
    total_amount: number;
    pending_count: bigint;
    pending_amount: number;
    approved_count: bigint;
    approved_amount: number;
    paid_count: bigint;
    paid_amount: number;
    rejected_count: bigint;
    rejected_amount: number;
  }[]>(`
    SELECT
      ${sqlTxnMonth("affiliate_transactions")} AS month,
      COUNT(*) AS total_count,
      SUM(CAST(commission_amount AS DECIMAL(14,4))) AS total_amount,
      ${SQL_STATUS_BUCKETS}
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0
    GROUP BY month
  `, userId);

  if (!monthRows.length) return 0;

  const now = new Date();

  // 步骤 2：读取已存在的状态行（拿 settled_at），避免重复设置
  const existing = await prisma.monthly_settlement_status.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { month: true, is_settled: true, settled_at: true },
  });
  const existingMap = new Map(existing.map((e) => [e.month, e]));

  let updated = 0;
  for (const row of monthRows) {
    const pendingCount = Number(row.pending_count || 0);
    const isSettled = pendingCount === 0;
    const prev = existingMap.get(row.month);

    // settled_at 时间戳：第一次从 0 → 1 时记，后续保持不变
    let settledAt: Date | null = prev?.settled_at ?? null;
    if (isSettled && !prev?.is_settled) {
      settledAt = now;
    } else if (!isSettled) {
      settledAt = null; // 状态回退（极少，但保留逻辑）
    }

    await prisma.monthly_settlement_status.upsert({
      where: { user_id_month: { user_id: userId, month: row.month } },
      create: {
        user_id: userId,
        month: row.month,
        total_count: Number(row.total_count || 0),
        total_amount: Number(row.total_amount || 0),
        pending_count: pendingCount,
        pending_amount: Number(row.pending_amount || 0),
        approved_count: Number(row.approved_count || 0),
        approved_amount: Number(row.approved_amount || 0),
        paid_count: Number(row.paid_count || 0),
        paid_amount: Number(row.paid_amount || 0),
        rejected_count: Number(row.rejected_count || 0),
        rejected_amount: Number(row.rejected_amount || 0),
        is_settled: isSettled ? 1 : 0,
        settled_at: settledAt,
        last_synced_at: now,
      },
      update: {
        total_count: Number(row.total_count || 0),
        total_amount: Number(row.total_amount || 0),
        pending_count: pendingCount,
        pending_amount: Number(row.pending_amount || 0),
        approved_count: Number(row.approved_count || 0),
        approved_amount: Number(row.approved_amount || 0),
        paid_count: Number(row.paid_count || 0),
        paid_amount: Number(row.paid_amount || 0),
        rejected_count: Number(row.rejected_count || 0),
        rejected_amount: Number(row.rejected_amount || 0),
        is_settled: isSettled ? 1 : 0,
        settled_at: settledAt,
        last_synced_at: now,
        is_deleted: 0,
      },
    });
    updated++;
  }

  return updated;
}

/**
 * 列出某用户「需要同步」的月份字符串（YYYY-MM）：
 *   - 用户最早交易月份起 → 当前月（含）
 *   - 排除已 is_settled = 1 的月份
 *   - 当前月始终包含（哪怕暂时没 pending，新订单可能随时进来）
 *
 * 返回月份按升序。
 */
export async function listUnsettledMonthsForUser(userId: bigint): Promise<string[]> {
  // 步骤 1：找出该用户最早交易月份
  // 月份串按 YYYY-MM 定长，字典序最小 = 时间最早，可直接对表达式取 MIN
  const firstTxn = await prisma.$queryRawUnsafe<{ first_month: string | null }[]>(`
    SELECT MIN(${sqlTxnMonth("affiliate_transactions")}) AS first_month
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0
  `, userId);

  const firstMonth = firstTxn[0]?.first_month;
  if (!firstMonth) {
    // 该用户尚无任何交易：只返回当前月
    return [formatMonthCST(new Date())];
  }

  // 步骤 2：列出 firstMonth → 当前月 的所有月份
  const allMonths = enumerateMonthsInclusive(firstMonth, formatMonthCST(new Date()));

  // 步骤 3：剔除已结算月份
  const settled = await prisma.monthly_settlement_status.findMany({
    where: { user_id: userId, is_deleted: 0, is_settled: 1 },
    select: { month: true },
  });
  const settledSet = new Set(settled.map((s) => s.month));

  // 当前月始终保留（即使暂时被标记结算，下条新交易又会拉回未结算）
  const currentMonth = formatMonthCST(new Date());
  return allMonths.filter((m) => m === currentMonth || !settledSet.has(m));
}

/**
 * 实时读取月份进度展示数据（前端结算进度卡用），按月份倒序，最新月在前。
 *
 * D-294：从「读 monthly_settlement_status 快照」改为直接聚合 affiliate_transactions，
 * 与结算查询汇总 / 按月份表 / 数据中心佣金卡同源同口径，页面刷新即最新，
 * 不再受 daily-sync 当天跑没跑成的影响。
 *
 * 返回值里 last_synced_at 改取该月交易行的 MAX(updated_at)，即「这个月的数据最近
 * 一次从平台同步下来是什么时候」，比原来的快照刷新时间更贴近这个字段的字面意思。
 *
 * @param userIds 要合并统计的用户；组长视角传全组成员，普通用户传自己一个
 *   - 多人时按月合并，is_settled = 该月全组都没有 pending（与原组长聚合语义一致）
 *   - settled_at 只在单人时给（"第一次结清于何时"是快照记的历史事实，
 *     多人合并没有意义，与改造前组长视角一律返回 null 保持一致）
 */
export async function getMonthlyProgressLive(userIds: bigint[]): Promise<MonthSummary[]> {
  if (userIds.length === 0) return [];

  const placeholders = userIds.map(() => "?").join(",");
  const rows = await prisma.$queryRawUnsafe<{
    month: string;
    total_count: bigint;
    total_amount: number;
    pending_count: bigint;
    pending_amount: number;
    approved_count: bigint;
    approved_amount: number;
    paid_count: bigint;
    paid_amount: number;
    rejected_count: bigint;
    rejected_amount: number;
    last_synced_at: Date | null;
  }[]>(`
    SELECT
      ${sqlTxnMonth("affiliate_transactions")} AS month,
      COUNT(*) AS total_count,
      SUM(CAST(commission_amount AS DECIMAL(14,4))) AS total_amount,
      ${SQL_STATUS_BUCKETS},
      MAX(updated_at) AS last_synced_at
    FROM affiliate_transactions
    WHERE user_id IN (${placeholders}) AND is_deleted = 0
    GROUP BY month
    ORDER BY month DESC
  `, ...userIds);

  // settled_at 实时算不出来（它记的是「第一次从未结清翻成结清」的时刻），仍取快照表
  const settledAtMap = new Map<string, Date | null>();
  if (userIds.length === 1) {
    const snaps = await prisma.monthly_settlement_status.findMany({
      where: { user_id: userIds[0], is_deleted: 0 },
      select: { month: true, settled_at: true },
    });
    for (const s of snaps) settledAtMap.set(s.month, s.settled_at);
  }

  return rows.map((r) => {
    const totalAmt = Number(r.total_amount || 0);
    const pendingCount = Number(r.pending_count || 0);
    const settledAmt =
      Number(r.approved_amount || 0) + Number(r.paid_amount || 0) + Number(r.rejected_amount || 0);
    const isSettled = pendingCount === 0;
    return {
      month: r.month,
      total_count: Number(r.total_count || 0),
      total_amount: +totalAmt.toFixed(2),
      pending_count: pendingCount,
      pending_amount: +Number(r.pending_amount || 0).toFixed(2),
      approved_count: Number(r.approved_count || 0),
      approved_amount: +Number(r.approved_amount || 0).toFixed(2),
      paid_count: Number(r.paid_count || 0),
      paid_amount: +Number(r.paid_amount || 0).toFixed(2),
      rejected_count: Number(r.rejected_count || 0),
      rejected_amount: +Number(r.rejected_amount || 0).toFixed(2),
      is_settled: isSettled,
      // 实时判定已结清、但快照还没来得及记下时刻 → 不编时间，留空
      settled_at: isSettled ? (settledAtMap.get(r.month)?.toISOString() ?? null) : null,
      last_synced_at: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null,
      settled_amount: +settledAmt.toFixed(2),
      settle_progress: totalAmt > 0 ? +((settledAmt / totalAmt) * 100).toFixed(2) : 0,
    };
  });
}

/** 形如 "2026-05"（按 CST/东八区计算，与联盟平台后台月度归档一致；C-084 推翻 C-080） */
function formatMonthCST(date: Date): string {
  const dt = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** 列出 [from, to] 之间的所有月份字符串（含两端，升序） */
function enumerateMonthsInclusive(from: string, to: string): string[] {
  const [fy, fm] = from.split("-").map((x) => parseInt(x, 10));
  const [ty, tm] = to.split("-").map((x) => parseInt(x, 10));
  const out: string[] = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/**
 * 把 "YYYY-MM" 转为 [start, endExclusive] 的 UTC Date 对象，
 * 但代表 CST 月初/次月月初的边界，用于 affiliate_transactions 时间字段过滤
 * （transaction_time 按 UTC 存储，但比较时按 CST 月归档语义）。
 * C-084 起改 CST，与联盟平台后台月度归档对齐。
 *
 * 例：monthRangeToUtcDates("2026-05") → start=UTC 2026-04-30 16:00:00 (= CST 5/1 0:00),
 *     endExclusive=UTC 2026-05-31 16:00:00 (= CST 6/1 0:00)
 */
export function monthRangeToUtcDates(monthStr: string): { start: Date; endExclusive: Date } {
  const [y, m] = monthStr.split("-").map((x) => parseInt(x, 10));
  // CST 月初 = UTC 当月 1 日 -8h
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0) - 8 * 60 * 60 * 1000);
  const endExclusive = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 0, 0, 0) - 8 * 60 * 60 * 1000);
  return { start, endExclusive };
}

/**
 * 把 "YYYY-MM" 转为前端展示用的 ["YYYY-MM-01", "YYYY-MM-末日 或 今日"] 字符串，
 * 用于平台 API 拉取（API 多用日期字符串入参）。
 *
 * 当月直接用今天作为 end，避免拉到未来日期。
 * C-084 起 "今天" 按 CST 计算（推翻 C-080），与平台后台日期归档一致。
 */
export function monthRangeToApiDateStrings(monthStr: string, now: Date): { startStr: string; endStr: string } {
  const cstNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const todayStr = `${cstNow.getUTCFullYear()}-${String(cstNow.getUTCMonth() + 1).padStart(2, "0")}-${String(cstNow.getUTCDate()).padStart(2, "0")}`;

  const [y, m] = monthStr.split("-").map((x) => parseInt(x, 10));
  const startStr = `${y}-${String(m).padStart(2, "0")}-01`;

  // 该月最末日
  const lastDay = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 0)).getUTCDate();
  const endOfMonthStr = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  // 若是当月，上限改为今天；否则用末日
  const endStr = endOfMonthStr > todayStr ? todayStr : endOfMonthStr;
  return { startStr, endStr };
}
