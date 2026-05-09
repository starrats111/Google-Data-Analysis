import prisma from "@/lib/prisma";

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
 * 时间口径：transaction_time 按 UTC 存储，按 DATE_FORMAT(transaction_time, '%Y-%m') 分组
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
      DATE_FORMAT(transaction_time, '%Y-%m') AS month,
      COUNT(*) AS total_count,
      SUM(CAST(commission_amount AS DECIMAL(14,4))) AS total_amount,
      SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) AS pending_count,
      SUM(CASE WHEN status = 'pending'  THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS pending_amount,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
      SUM(CASE WHEN status = 'approved' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS approved_amount,
      SUM(CASE WHEN status = 'paid'     THEN 1 ELSE 0 END) AS paid_count,
      SUM(CASE WHEN status = 'paid'     THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS paid_amount,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
      SUM(CASE WHEN status = 'rejected' THEN CAST(commission_amount AS DECIMAL(14,4)) ELSE 0 END) AS rejected_amount
    FROM affiliate_transactions
    WHERE user_id = ? AND is_deleted = 0
    GROUP BY DATE_FORMAT(transaction_time, '%Y-%m')
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
  const firstTxn = await prisma.$queryRawUnsafe<{ first_month: string | null }[]>(`
    SELECT DATE_FORMAT(MIN(transaction_time), '%Y-%m') AS first_month
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
 * 读取某用户所有月份的进度展示数据（前端结算进度卡用）
 * 返回按月份倒序，最新月在前。
 */
export async function getMonthlyProgressForUser(userId: bigint): Promise<MonthSummary[]> {
  const rows = await prisma.monthly_settlement_status.findMany({
    where: { user_id: userId, is_deleted: 0 },
    orderBy: { month: "desc" },
  });

  return rows.map((r) => {
    const totalAmt = Number(r.total_amount);
    const settledAmt =
      Number(r.approved_amount) + Number(r.paid_amount) + Number(r.rejected_amount);
    const progress = totalAmt > 0 ? +((settledAmt / totalAmt) * 100).toFixed(2) : 0;
    return {
      month: r.month,
      total_count: r.total_count,
      total_amount: +Number(r.total_amount).toFixed(2),
      pending_count: r.pending_count,
      pending_amount: +Number(r.pending_amount).toFixed(2),
      approved_count: r.approved_count,
      approved_amount: +Number(r.approved_amount).toFixed(2),
      paid_count: r.paid_count,
      paid_amount: +Number(r.paid_amount).toFixed(2),
      rejected_count: r.rejected_count,
      rejected_amount: +Number(r.rejected_amount).toFixed(2),
      is_settled: r.is_settled === 1,
      settled_at: r.settled_at?.toISOString() ?? null,
      last_synced_at: r.last_synced_at?.toISOString() ?? null,
      settled_amount: +settledAmt.toFixed(2),
      settle_progress: progress,
    };
  });
}

/** 形如 "2026-05"（按服务器 UTC+8 计算，与平台展示口径一致） */
function formatMonthCST(date: Date): string {
  // 服务器进程时区已是 UTC+8（PM2 启动），直接 toLocaleDateString 也行；
  // 但更稳妥地用 UTC 时间 + 8 小时偏移
  const cst = new Date(date.getTime() + 8 * 3600_000);
  const y = cst.getUTCFullYear();
  const m = String(cst.getUTCMonth() + 1).padStart(2, "0");
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
 * 把 "YYYY-MM" 转为 [start, endExclusive] 的 UTC Date 对象，用于 affiliate_transactions
 * 时间字段按 UTC 存储的边界过滤。
 */
export function monthRangeToUtcDates(monthStr: string): { start: Date; endExclusive: Date } {
  const [y, m] = monthStr.split("-").map((x) => parseInt(x, 10));
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const endExclusive = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, 0, 0, 0));
  return { start, endExclusive };
}

/**
 * 把 "YYYY-MM" 转为前端展示用的 ["YYYY-MM-01", "YYYY-MM-末日 或 今日"] 字符串，
 * 用于平台 API 拉取（API 多用日期字符串入参）。
 *
 * 当月直接用今天作为 end，避免拉到未来日期。
 */
export function monthRangeToApiDateStrings(monthStr: string, now: Date): { startStr: string; endStr: string } {
  const cst = new Date(now.getTime() + 8 * 3600_000);
  const todayStr = `${cst.getUTCFullYear()}-${String(cst.getUTCMonth() + 1).padStart(2, "0")}-${String(cst.getUTCDate()).padStart(2, "0")}`;

  const [y, m] = monthStr.split("-").map((x) => parseInt(x, 10));
  const startStr = `${y}-${String(m).padStart(2, "0")}-01`;

  // 该月最末日
  const lastDay = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 0)).getUTCDate();
  const endOfMonthStr = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

  // 若是当月，上限改为今天；否则用末日
  const endStr = endOfMonthStr > todayStr ? todayStr : endOfMonthStr;
  return { startStr, endStr };
}
