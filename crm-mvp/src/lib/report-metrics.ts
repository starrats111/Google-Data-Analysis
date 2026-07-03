/**
 * 财务报表统一口径层（收支报表 / 佣金详情 / 结算查询 共用）
 *
 * 设计目标：一切以联盟平台后台显示为准（2026-07 拍板）。
 * 本模块为纯函数（不 import prisma / next），server route 与 client 组件均可引用。
 *
 * ── 时区口径（阶段 0 逐平台实测结论，2026-07-02）─────────────────────────────
 * 所有平台后台均按北京时间（UTC+8）显示交易时间，但入库存储约定分两类：
 *
 * 1. 真 UTC 存储（RW/CG/PM/BSH/CF/LB + MUI/EV）：
 *    交易 API 提供 Unix 秒（order_time 或 ori_order_time），入库为真 UTC 瞬时。
 *    还原平台钟面 = CONVERT_TZ(transaction_time, '+00:00', '+08:00')。
 *    实证：CG vitahaven 6/14-6/30 按此口径 $1433.72+$15.08(换绑残留)=$1448.80 与后台分文不差；
 *          RW 逐笔比对（CRM 12:44:02Z = 后台 20:44:02）成立。
 *
 * 2. CST 钟面存储（仅 LH）：
 *    LH 交易 API 只返回 "YYYY-MM-DD HH:MM:SS" 字符串、无 Unix 字段，实测该字符串是
 *    北京时间钟面（report_time 与当前 CST 同步、晚于当时 UTC，不可能是 UTC）。
 *    同步层 parseTimestamp 将其按 UTC 原样入库 → 库内值已经等于平台后台钟面。
 *    还原平台钟面 = 直接取 transaction_time，不得再 +8（否则双重偏移 8 小时）。
 *    刻意不改同步、不迁历史：避免新旧数据混杂，展示层按本表还原即可全量对齐。
 *    ⚠️ 若未来 LH 同步改为真 UTC 入库，必须同时回刷历史并把 LH 从此名单移除。
 */

/** 库内 transaction_time 已是平台钟面（无需 +8）的平台 */
export const CST_FACE_PLATFORMS = ["LH"] as const;

const cstFaceInList = CST_FACE_PLATFORMS.map((p) => `'${p}'`).join(",");

/**
 * SQL 表达式：把 transaction_time 还原为「平台后台本地时间」。
 * @param alias affiliate_transactions 的表别名（含尾点由调用方省略，传 "t" 即可）
 */
export function sqlTxnLocalTime(alias: string): string {
  return `CASE WHEN ${alias}.platform IN (${cstFaceInList}) THEN ${alias}.transaction_time ELSE CONVERT_TZ(${alias}.transaction_time, '+00:00', '+08:00') END`;
}

/** SQL 表达式：按平台后台本地时间归月（'%Y-%m'） */
export function sqlTxnMonth(alias: string): string {
  return `DATE_FORMAT(${sqlTxnLocalTime(alias)}, '%Y-%m')`;
}

/** SQL 表达式：按平台后台本地时间归日（'%Y-%m-%d'） */
export function sqlTxnDay(alias: string): string {
  return `DATE_FORMAT(${sqlTxnLocalTime(alias)}, '%Y-%m-%d')`;
}

/**
 * SQL 条件 + 参数：按「平台后台自然日」过滤 [startDate, endDateExclusive)。
 * 真 UTC 平台用 UTC 瞬时边界（CST 零点 -8h），CST 钟面平台用字符串字面边界。
 *
 * @param alias 表别名
 * @param startDate 起始日 "YYYY-MM-DD"（含）
 * @param endDateExclusive 结束日 "YYYY-MM-DD"（不含，独占上界）
 * @returns { cond, params } — cond 内含 4 个 ? 占位，params 按序展开
 */
export function sqlTxnRange(
  alias: string,
  startDate: string,
  endDateExclusive: string,
): { cond: string; params: unknown[] } {
  const cond = `(
    (${alias}.platform IN (${cstFaceInList}) AND ${alias}.transaction_time >= ? AND ${alias}.transaction_time < ?)
    OR (${alias}.platform NOT IN (${cstFaceInList}) AND ${alias}.transaction_time >= ? AND ${alias}.transaction_time < ?)
  )`;
  const params: unknown[] = [
    `${startDate} 00:00:00`,
    `${endDateExclusive} 00:00:00`,
    // CST 零点对应的 UTC 瞬时（-8h）
    new Date(`${startDate}T00:00:00+08:00`),
    new Date(`${endDateExclusive}T00:00:00+08:00`),
  ];
  return { cond, params };
}

/** "YYYY-MM-DD"（含）→ 独占上界 "YYYY-MM-DD"（+1 天） */
export function nextDayStr(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────
// 打款/结算金额口径：一律显示平台毛额（与平台后台逐笔一致）
// gross_amount 为空的历史行/平台回退净额 amount。
// 例：RW 提现 9961 后台显示 $245.67(毛)，净额 $245.65，手续费 $0.02。
// ─────────────────────────────────────────────────────────────

/** 打款展示金额 = 毛额优先，空则回退净额 */
export function paymentDisplayAmount(
  amount: number | null | undefined,
  grossAmount: number | null | undefined,
): number {
  const gross = Number(grossAmount);
  if (grossAmount != null && !isNaN(gross) && gross > 0) return gross;
  const net = Number(amount);
  return isNaN(net) ? 0 : net;
}

// ─────────────────────────────────────────────────────────────
// 收支报表共享汇总（服务端导出 Excel 与前端表格同源，杜绝口径漂移）
// ─────────────────────────────────────────────────────────────

export type PlatStat = { total: number; rejected: number; active: number };
/** data[month][userId][platform] */
export type MonthData = Record<string, Record<string, Record<string, PlatStat>>>;
/** adSpend[month][userId] */
export type SpendData = Record<string, Record<string, number>>;
export type ReportMetricKey = "adSpend" | "total" | "rejected" | "active" | "net";

/** 收支报表平台固定展示顺序 */
export const REPORT_PLATFORM_ORDER = ["RW", "LH", "CG", "LB", "PM", "CF", "BSH", "MUI", "EV"];

/**
 * 收支报表指标汇总：
 * - net（净收益）= 有效佣金 − 广告费；广告费无平台维度，platform 非空时不扣
 * - adSpend 仅在 platform === null（全平台汇总）时返回实际值
 */
export function sumReportStat(
  key: ReportMetricKey,
  months: string[],
  userIds: string[],
  platform: string | null,
  data: MonthData,
  spend: SpendData,
): number {
  if (key === "net") {
    return (
      sumReportStat("active", months, userIds, platform, data, spend) -
      (platform === null ? sumReportStat("adSpend", months, userIds, null, data, spend) : 0)
    );
  }
  let acc = 0;
  for (const m of months) {
    for (const uid of userIds) {
      if (key === "adSpend") {
        if (platform !== null) continue;
        acc += spend[m]?.[uid] || 0;
        continue;
      }
      const ud = data[m]?.[uid];
      if (!ud) continue;
      const plats = platform ? [platform] : Object.keys(ud);
      for (const p of plats) {
        if (key === "total") acc += ud[p]?.total || 0;
        if (key === "rejected") acc += ud[p]?.rejected || 0;
        if (key === "active") acc += ud[p]?.active || 0;
      }
    }
  }
  return acc;
}

/** 界面统一的日期口径说明文案 */
export const TXN_TZ_NOTE = "日期口径：按各联盟平台后台显示时间（北京时间 UTC+8）切日，与平台后台一致";
