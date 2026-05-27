import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";

dayjs.extend(utc);
dayjs.extend(timezone);

export const TZ = "Asia/Shanghai";

/** 格式化日期时间为中文格式（东八区） */
export function formatDateTime(date: string | Date | null | undefined): string {
  if (!date) return "-";
  return new Date(date).toLocaleString("zh-CN", { timeZone: TZ });
}

/** 格式化纯日期为中文格式（东八区） */
export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "-";
  return new Date(date).toLocaleDateString("zh-CN", { timeZone: TZ });
}

/** 格式化日期为月/日（东八区） */
export function formatMonthDay(date: string | Date | null | undefined): string {
  if (!date) return "-";
  return new Date(date).toLocaleDateString("zh-CN", { timeZone: TZ, month: "2-digit", day: "2-digit" });
}

/** 获取东八区的今天日期字符串 YYYY-MM-DD */
export function todayCST(): string {
  return dayjs().tz(TZ).format("YYYY-MM-DD");
}

/** 获取东八区的昨天日期字符串 YYYY-MM-DD */
export function yesterdayCST(): string {
  return dayjs().tz(TZ).subtract(1, "day").format("YYYY-MM-DD");
}

/** 获取东八区当前时间的 dayjs 实例 */
export function nowCST() {
  return dayjs().tz(TZ);
}

/** 获取 UTC 今天日期字符串 YYYY-MM-DD（与联盟平台后台日期归档一致） */
export function todayUTC(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** 获取 UTC 当前时间的 dayjs 实例 */
export function nowUTC() {
  return dayjs.utc();
}

/** 解析东八区日期字符串为当天起始时间 */
export function parseCSTDateStart(dateStr: string): Date {
  return dayjs.tz(`${dateStr} 00:00:00`, TZ).toDate();
}

/** 解析东八区日期字符串为次日零点（独占上界） */
export function parseCSTDateEndExclusive(dateStr: string): Date {
  return dayjs.tz(`${dateStr} 00:00:00`, TZ).add(1, "day").toDate();
}

/** 判断给定日期字符串是否为东八区今天 */
export function isTodayCST(dateStr: string, now = nowCST()): boolean {
  return dateStr === now.format("YYYY-MM-DD");
}

/**
 * 用于 MySQL DATE 列比较的日期（UTC 午夜）。
 * Prisma 对 DATE 列按 UTC 日期部分比较，不能用 CST 偏移量，否则日期会偏移一天。
 */
export function dateColumnStart(dateStr: string): Date {
  return new Date(dateStr + "T00:00:00.000Z");
}

/** DATE 列专用：次日 UTC 午夜（独占上界） */
export function dateColumnEndExclusive(dateStr: string): Date {
  const d = new Date(dateStr + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/** DATE 列专用：东八区"今天"对应的次日 UTC 午夜（确保包含今天数据） */
export function dateColumnTodayEndExclusive(): Date {
  const todayStr = dayjs().tz(TZ).format("YYYY-MM-DD");
  return dateColumnEndExclusive(todayStr);
}

/** 获取东八区月初的 dayjs 实例 */
export function startOfMonthCST() {
  return dayjs().tz(TZ).startOf("month");
}

/**
 * affiliate_transactions DATETIME 列专用：CST（东八区）日期零点对应的 UTC 时间。
 *
 * C-084 起从 UTC 视角改回 CST 视角（推翻 C-080）：
 *   - 实测 wj02 CG 5/1-5/12：CST 切日 462 单 / $3729.28 = 平台后台 100% 命中；
 *     UTC 切日只有 305 单 / $3565.50，差 7 行 / $163.78（边界 UTC 4/30 16:00-23:59）。
 *   - C-080 当时只用 wj07 MUI 验证，恰巧那段时间 UTC/CST 边界无数据，导致片面结论。
 *   - 此次以 CG 验证（数据量最大）反证：联盟平台后台按本地 CST 切日，CRM 也用 CST。
 *   - 注：ads_daily_stats.date 仍按 Google Ads MCC 时区（CST）归日；
 *     佣金回写到 ads_daily_stats 时按 CST 切日，与 cost 同 CST 时间口径，**完全对齐**。
 *
 * 例（北京时间）：parseTxnDateStart("2026-05-01") → CST 2026-05-01 00:00:00 = UTC 2026-04-30T16:00:00.000Z。
 */
export function parseTxnDateStart(dateStr: string): Date {
  return dayjs.tz(`${dateStr} 00:00:00`, TZ).toDate();
}

/**
 * affiliate_transactions DATETIME 列专用：CST 次日零点（独占上界）对应的 UTC 时间。
 * 与 parseTxnDateStart 配对，覆盖整个 CST 自然日。
 *
 * 例：parseTxnDateEndExclusive("2026-05-01") → CST 2026-05-02 00:00:00 = UTC 2026-05-01T16:00:00.000Z。
 */
export function parseTxnDateEndExclusive(dateStr: string): Date {
  return dayjs.tz(`${dateStr} 00:00:00`, TZ).add(1, "day").toDate();
}

/**
 * affiliate_transactions 专用：CST 当月月初零点（"本月"默认起点）对应的 UTC 时间。
 * 例：当前 2026-05-09 → CST 2026-05-01 00:00:00 = UTC 2026-04-30T16:00:00.000Z。
 *
 * 函数名仍叫 txnStartOfMonthUTC 是为了避免大范围改名，但语义已改为 CST 月初；
 * 函数返回值仍是 Date 对象（UTC 时间戳），与 transaction_time 列存储语义一致。
 */
export function txnStartOfMonthUTC(): Date {
  return dayjs().tz(TZ).startOf("month").toDate();
}

/**
 * affiliate_transactions 专用：CST 下月月初零点（"本月"结束边界）对应的 UTC 时间。
 * 例：当前 2026-05-09 → CST 2026-06-01 00:00:00 = UTC 2026-05-31T16:00:00.000Z。
 *
 * 注意：不能用 txnStartOfMonthUTC().getUTCMonth()+1 来计算，
 * 因为 txnStartOfMonthUTC() 返回的 UTC 时间实际上是上月末日（UTC 月份比 CST 月份早1），
 * 直接对 UTC 月份 +1 会只得到 8 小时的窗口，导致佣金数据严重丢失。
 */
export function txnNextMonthStartUTC(): Date {
  return dayjs().tz(TZ).startOf("month").add(1, "month").toDate();
}
