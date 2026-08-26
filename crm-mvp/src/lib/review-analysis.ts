/**
 * D-245 复盘分析（组长）：已暂停系列「暂停前 7 天」数据口径与共用工具。
 *
 * 口径（07 于 2026-08-17 逐项拍板）：
 * - 暂停日期 = campaigns.paused_at（各暂停写点实时落库；存量为 backfill 近似值）；
 * - 7 天窗口 = 暂停日（CST）前 7 个完整投放日，**不含暂停当天**：
 *   例 8/15 暂停 → 窗口 8/08 ~ 8/14；
 * - 数据实时查 ads_daily_stats（佣金回传后 ROI 自动修正，不做快照）；
 * - 重新启用（→ENABLED）时 paused_at 被清空，系列自然移出复盘列表。
 *
 * AI 复盘点评缓存复用 ai_recommendations 表：
 *   recommendation_type = campaign_pause_review，scope_key = review_<暂停日>。
 *   scope_key 带暂停日期 → 同系列再次暂停后自动换新缓存，不会拿到旧点评。
 */
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import { dateColumnStart, dateColumnEndExclusive } from "@/lib/date-utils";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Asia/Shanghai";

export const REVIEW_RECOMMENDATION_TYPE = "campaign_pause_review";

export const PAUSE_SOURCE_LABELS: Record<string, string> = {
  manual: "手动暂停",
  spend_guard: "哨兵止损",
  ai_apply: "AI建议执行",
  sync: "同步发现(近似)",
  change_history: "谷歌记录(精确)",
  backfill: "历史回填(近似)",
};

/** 暂停时间为近似值的来源（UI 标 ≈）：sync=发现时刻（最多晚一天）、backfill=按最后消费日推算 */
export const APPROX_PAUSE_SOURCES = new Set(["sync", "backfill"]);

export interface PauseWindow {
  /** 暂停日（CST，YYYY-MM-DD） */
  pauseDateStr: string;
  /** 窗口首日（含） */
  startStr: string;
  /** 窗口末日（含，= 暂停日前一天） */
  endStr: string;
  /** ads_daily_stats.date 过滤下界（UTC 午夜对齐，含） */
  dateStart: Date;
  /** 上界（不含）= 暂停日当天 UTC 午夜 → 不含暂停当天 */
  dateEndExclusive: Date;
}

/** 暂停前 7 个完整投放日窗口（不含暂停当天） */
export function computePauseWindow(pausedAt: Date): PauseWindow {
  const pauseDay = dayjs(pausedAt).tz(TZ);
  const pauseDateStr = pauseDay.format("YYYY-MM-DD");
  const startStr = pauseDay.subtract(7, "day").format("YYYY-MM-DD");
  const endStr = pauseDay.subtract(1, "day").format("YYYY-MM-DD");
  return {
    pauseDateStr,
    startStr,
    endStr,
    dateStart: dateColumnStart(startStr),
    dateEndExclusive: dateColumnStart(pauseDateStr),
  };
}

export function buildReviewScopeKey(pauseDateStr: string): string {
  return `review_${pauseDateStr}`;
}

/** D-268 自定义窗口跨度上限（天），防止一次拉取过大范围 */
export const MAX_REVIEW_WINDOW_DAYS = 92;

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * D-268 眼睛弹窗自定义日期窗口：徐克 2026-08-21 需求，逐日明细不再锁死「暂停前 7 天」。
 * 校验格式 / 先后顺序 / 跨度上限，不合法返回 null（调用方回 400）。
 * pauseDateStr 仍取自 paused_at（标题展示与 AI 点评 scope 不随自定义窗口变化）。
 */
export function computeCustomWindow(
  startStr: string,
  endStr: string,
  pauseDateStr: string,
): PauseWindow | null {
  if (!DATE_STR_RE.test(startStr) || !DATE_STR_RE.test(endStr)) return null;
  const start = dayjs(startStr);
  const end = dayjs(endStr);
  if (!start.isValid() || !end.isValid() || end.isBefore(start)) return null;
  if (end.diff(start, "day") + 1 > MAX_REVIEW_WINDOW_DAYS) return null;
  return {
    pauseDateStr,
    startStr,
    endStr,
    dateStart: dateColumnStart(startStr),
    dateEndExclusive: dateColumnEndExclusive(endStr),
  };
}

/** 逐日行（对齐眼睛弹窗 DailyRow 字段命名） */
export interface ReviewDailyRow {
  date: string;
  impressions: number;
  clicks: number;
  spend: number;
  orders: number;
  commission: number;
  rejectedCommission: number;
  avgCpc: number;
  roi: number | null;
  /** 当日预算（USD，Sheet 逐日快照）；当天未采集为 null，不用当前预算冒充 */
  budget: number | null;
  /** IS_Bgt / IS_Rnk 当日值（0-1 分数）；未采集为 null */
  isBudget: number | null;
  isRank: number | null;
}

export interface ReviewTotals {
  impressions: number;
  clicks: number;
  cost: number;
  orders: number;
  commission: number;
  rejected_commission: number;
}

/** 原始日表行（Prisma ads_daily_stats 子集，Decimal 已转 number 前的形态） */
export interface RawStatRow {
  date: Date;
  impressions: number | null;
  clicks: number | null;
  cost: unknown;
  orders: number | null;
  commission: unknown;
  rejected_commission: unknown;
  /** 可选：眼睛弹窗需要，AI 点评调用方不查（保持 undefined 即可） */
  budget?: unknown;
  is_budget?: unknown;
  is_rank?: unknown;
}

/** 把窗口内的日表行补齐为完整逐日序列（缺日补零行，图表/表格不断档；天数由窗口决定，D-268） */
export function buildDailyRows(window: PauseWindow, stats: RawStatRow[]): ReviewDailyRow[] {
  const byDate = new Map<string, RawStatRow>();
  for (const s of stats) byDate.set(s.date.toISOString().slice(0, 10), s);
  const rows: ReviewDailyRow[] = [];
  const dayCount = dayjs(window.endStr).diff(dayjs(window.startStr), "day") + 1;
  for (let i = 0; i < dayCount; i += 1) {
    const dateStr = dayjs(window.startStr).add(i, "day").format("YYYY-MM-DD");
    const s = byDate.get(dateStr);
    const spend = Number(s?.cost || 0);
    const clicks = Number(s?.clicks || 0);
    const commission = Number(s?.commission || 0);
    rows.push({
      date: dateStr,
      impressions: Number(s?.impressions || 0),
      clicks,
      spend: Number(spend.toFixed(2)),
      orders: Number(s?.orders || 0),
      commission: Number(commission.toFixed(2)),
      rejectedCommission: Number(Number(s?.rejected_commission || 0).toFixed(2)),
      avgCpc: clicks > 0 ? Number((spend / clicks).toFixed(4)) : 0,
      roi: spend > 0 ? Number(((commission - spend) / spend).toFixed(2)) : null,
      // 缺日/未采集一律 null（前端显示「—」），不造数
      budget: s?.budget == null ? null : Number(Number(s.budget).toFixed(2)),
      isBudget: s?.is_budget == null ? null : Number(s.is_budget),
      isRank: s?.is_rank == null ? null : Number(s.is_rank),
    });
  }
  return rows;
}

export function sumTotals(rows: ReviewDailyRow[]): ReviewTotals {
  return {
    impressions: rows.reduce((s, r) => s + r.impressions, 0),
    clicks: rows.reduce((s, r) => s + r.clicks, 0),
    cost: Number(rows.reduce((s, r) => s + r.spend, 0).toFixed(2)),
    orders: rows.reduce((s, r) => s + r.orders, 0),
    commission: Number(rows.reduce((s, r) => s + r.commission, 0).toFixed(2)),
    rejected_commission: Number(rows.reduce((s, r) => s + r.rejectedCommission, 0).toFixed(2)),
  };
}
