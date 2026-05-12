import type { PlatformTransaction } from "@/lib/platform-api";

/**
 * 联盟平台返回的"原始 line items"聚合工具（A+C 方案，C-086 修订）。
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ 强制规约：所有写入 affiliate_transactions 的代码路径必须先经过本函数。│
 * │                                                                        │
 * │ 当前已强制走 aggregate 的入口（不要新增绕过路径）：                    │
 * │   1. /api/cron/daily-sync                                              │
 * │   2. /api/cron/txn-quick-sync                                          │
 * │   3. /api/user/data-center/sync                                        │
 * │   4. /api/user/data-center/sync-transactions                           │
 * │   5. /api/user/team/sync                                               │
 * │                                                                        │
 * │ 新接入联盟平台时，sync 代码必须：                                       │
 * │   const aggRes = aggregateRawTransactions(rawTxns);                    │
 * │   for (const txn of aggRes.aggregated) { await prisma.upsert(...) }    │
 * │                                                                        │
 * │ 即使漏调本函数，prisma.ts 的运行时闸门（C-081）也会兜底合并 line items │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * 背景：CG/MUI/EV/BSH/LH 等平台对一笔订单常会拆成多个 line items 分别返回，
 * 每条都有独立的 transaction_id。CRM 历史实现按 transaction_id 唯一键写入，
 * 导致同一笔订单在数据库里展开成 N 行，订单数被严重高估（C-079）。
 *
 * 本函数在写入数据库前对 API 原始返回做两层聚合：
 *  1. 同 transaction_id 内部去重（同一 id 重复返回时合并 commission/order_amount）
 *  2. 跨 transaction_id 聚合 line items
 *     - **C-086 起聚合 key = `(merchant_id, order_id)`**（保 order_id 时）
 *       fallback `(merchant_id, transaction_time)`（无 order_id 时，与 C-079 一致）
 *     - 1 个聚合组 = 1 个真实订单（与联盟平台后台 distinct order_id 口径对齐）
 *     - 选稳定主 id = 字典序最小的 transaction_id（与 API 返回顺序无关，幂等）
 *     - commission_amount = SUM, order_amount = SUM
 *     - status 按优先级取最高（已审核状态优先于待审核）
 *     - 被淘汰的 line items 不写入 DB（同步代码直接跳过它们）
 *
 * **C-086 起不再过滤 0/0 幽灵组**：平台后台显示 distinct order_id 时会包含整单
 * commission=0 amount=0 的 lead 订单（如 Rula 的"未转化"订单），CRM 必须保留以对齐
 * 平台后台单数。0/0 组写入时 is_deleted=0 / 正常计入订单数与 ROI 分母（金额为 0）。
 *
 * 注意：仅当 merchant_id 非空时才参与跨 id 聚合；merchant_id 缺失的保留原样
 * （fallback 按 transaction_id 自身去重），避免错聚不同商家的交易。
 */

/**
 * 品牌类型：经过 aggregateRawTransactions 处理后的"安全"交易。
 *
 * 用法（推荐）：函数签名声明参数为 AggregatedTransaction 时，调用方必须先调用
 * aggregateRawTransactions 才能得到该类型的实例，TS 编译器会强制规约。
 *
 * 注意：这是类型层提示而非运行时强制。运行时强制由 prisma.ts 闸门负责（C-081）。
 */
declare const AGGREGATED_BRAND: unique symbol;
export type AggregatedTransaction = PlatformTransaction & { readonly [AGGREGATED_BRAND]: true };
const STATUS_PRIORITY: Record<string, number> = {
  rejected: 4,
  paid: 3,
  approved: 2,
  pending: 1,
};

function pickHigherPriorityStatus(a: string, b: string): string {
  const pa = STATUS_PRIORITY[a] ?? 0;
  const pb = STATUS_PRIORITY[b] ?? 0;
  return pa >= pb ? a : b;
}

export interface AggregateResult {
  aggregated: AggregatedTransaction[];
  stats: {
    raw_count: number;
    after_id_dedup: number;
    after_line_items_merge: number;
    after_ghost_filter: number;
    merged_line_items: number;
    dropped_ghosts: number;
  };
}

export function aggregateRawTransactions(raw: PlatformTransaction[]): AggregateResult {
  const rawCount = raw.length;

  const byTxnId = new Map<string, PlatformTransaction>();
  for (const t of raw) {
    if (!t.transaction_id) continue;
    const exist = byTxnId.get(t.transaction_id);
    if (exist) {
      exist.commission_amount = (exist.commission_amount || 0) + (t.commission_amount || 0);
      exist.order_amount = (exist.order_amount || 0) + (t.order_amount || 0);
      exist.status = pickHigherPriorityStatus(exist.status, t.status);
    } else {
      byTxnId.set(t.transaction_id, { ...t });
    }
  }
  const afterIdDedup = byTxnId.size;

  type Group = {
    rep: PlatformTransaction;
    sumCommission: number;
    sumAmount: number;
    bestStatus: string;
    rawStatus: string;
    lineCount: number;
  };
  const groups = new Map<string, Group>();
  const noMerchantId: PlatformTransaction[] = [];

  for (const t of byTxnId.values()) {
    const mid = t.merchant_id || "";
    if (!mid) {
      noMerchantId.push(t);
      continue;
    }
    // C-086: 优先按 order_id 聚合（与平台后台 distinct order_id 口径对齐）。
    // 若 API 未返回 order_id（部分老平台），降级回 C-079 的 transaction_time 维度。
    const orderKey = (t.order_id && t.order_id.trim()) || "";
    const key = orderKey ? `${mid}|oid:${orderKey}` : `${mid}|t:${t.transaction_time}`;
    const g = groups.get(key);
    if (g) {
      g.sumCommission += (t.commission_amount || 0);
      g.sumAmount += (t.order_amount || 0);
      g.bestStatus = pickHigherPriorityStatus(g.bestStatus, t.status);
      g.rawStatus = pickHigherPriorityStatus(g.bestStatus, t.status) === t.status ? (t.raw_status || g.rawStatus) : g.rawStatus;
      g.lineCount++;
      if (t.transaction_id < g.rep.transaction_id) {
        g.rep = t;
      }
    } else {
      groups.set(key, {
        rep: t,
        sumCommission: t.commission_amount || 0,
        sumAmount: t.order_amount || 0,
        bestStatus: t.status,
        rawStatus: t.raw_status || "",
        lineCount: 1,
      });
    }
  }

  let mergedLineItems = 0;
  const afterLineMerge: PlatformTransaction[] = [];
  for (const g of groups.values()) {
    if (g.lineCount > 1) mergedLineItems += (g.lineCount - 1);
    afterLineMerge.push({
      ...g.rep,
      commission_amount: g.sumCommission,
      order_amount: g.sumAmount,
      status: g.bestStatus,
      raw_status: g.rawStatus,
    });
  }
  for (const t of noMerchantId) afterLineMerge.push(t);

  // C-086: 不再过滤整单 0/0 ghost。
  // 平台后台显示 distinct order_id 时本就包含整单 commission=0 amount=0 的 lead 订单
  // （如 Rula 的"未转化"订单），CRM 必须保留这些行以对齐平台后台单数与 ROI 分母。
  // 仍统计 ghost 数（dropped_ghosts 这里改为"保留的 ghost 组数"用于日志诊断）。
  const aggregated: AggregatedTransaction[] = [];
  let ghostKeptCount = 0;
  for (const t of afterLineMerge) {
    const c = t.commission_amount || 0;
    const a = t.order_amount || 0;
    if (c === 0 && a === 0) {
      ghostKeptCount++;
    }
    aggregated.push(t as AggregatedTransaction);
  }

  return {
    aggregated,
    stats: {
      raw_count: rawCount,
      after_id_dedup: afterIdDedup,
      after_line_items_merge: afterLineMerge.length,
      after_ghost_filter: aggregated.length,
      merged_line_items: mergedLineItems,
      dropped_ghosts: ghostKeptCount,
    },
  };
}
