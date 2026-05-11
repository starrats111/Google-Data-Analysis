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
 * affiliate_transactions DATETIME 列专用：UTC 日期零点。
 *
 * C-080 起从 CST 视角改回 UTC 视角：
 *   - 联盟平台后台（CG/LB/PM/MUI/EV/UltraInfluence/Engagevantage 等）对日期范围的解释
 *     用的是 UTC（实测 wj07 MUI 5/1-5/11 按 UTC 切日 95 笔与平台 1:1 命中）。
 *   - 用户浏览器虽然显示北京时间，但平台后台 SQL 后端按 UTC 归日。
 *   - 故 affiliate_transactions 的查询边界也按 UTC 切日，与平台后台 100% 对齐。
 *   - 注：ads_daily_stats.date 仍按 Google Ads MCC 时区（CST）归日；
 *     佣金回写到 ads_daily_stats 时按 UTC 切日，可能与 cost 错 8 小时（边缘订单 < 2%）。
 *
 * 例：parseTxnDateStart("2026-05-01") → 2026-05-01T00:00:00.000Z（UTC 5/1 0 点）。
 */
export function parseTxnDateStart(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

/**
 * affiliate_transactions DATETIME 列专用：UTC 次日零点（独占上界）。
 * 与 parseTxnDateStart 配对，覆盖整个 UTC 自然日。
 */
export function parseTxnDateEndExclusive(dateStr: string): Date {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * affiliate_transactions 专用：UTC 当月月初零点（"本月"默认起点）。
 * 例：当前 2026-05-09 → UTC 2026-05-01 00:00:00。
 */
export function txnStartOfMonthUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}
