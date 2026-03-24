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

/** 获取东八区月初的 dayjs 实例 */
export function startOfMonthCST() {
  return dayjs().tz(TZ).startOf("month");
}
