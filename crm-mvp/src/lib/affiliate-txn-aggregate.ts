import type { PlatformTransaction } from "@/lib/platform-api";

/**
 * 联盟平台返回的"原始 line items"聚合工具（A 方案）。
 *
 * 背景：CG/MUI/EV/BSH/LH 等平台对一笔订单常会拆成多个 line items 分别返回，
 * 每条都有独立的 transaction_id。CRM 历史实现按 transaction_id 唯一键写入，
 * 导致同一笔订单在数据库里展开成 N 行，订单数被严重高估（C-079）。
 *
 * 本函数在写入数据库前对 API 原始返回做两层聚合：
 *  1. 同 transaction_id 内部去重（同一 id 重复返回时合并 commission/order_amount）
 *  2. 同 (merchant_id, transaction_time) 跨 transaction_id 聚合 line items
 *     - 选稳定主 id = 字典序最小的 transaction_id（与 API 返回顺序无关，幂等）
 *     - commission_amount = SUM, order_amount = SUM
 *     - status 按优先级取最高（已审核状态优先于待审核）
 *     - 被淘汰的 line items 不写入 DB（同步代码直接跳过它们）
 *
 * 同时过滤 0/0 幽灵行（commission_amount=0 AND order_amount=0），防止再次产生。
 *
 * 注意：仅当 merchant_id 非空时才参与跨 id 聚合；merchant_id 缺失的保留原样
 * （fallback 按 transaction_id 自身去重），避免错聚不同商家的交易。
 */
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
  aggregated: PlatformTransaction[];
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
    const key = `${mid}|${t.transaction_time}`;
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

  const aggregated: PlatformTransaction[] = [];
  let droppedGhosts = 0;
  for (const t of afterLineMerge) {
    const c = t.commission_amount || 0;
    const a = t.order_amount || 0;
    if (c === 0 && a === 0) {
      droppedGhosts++;
      continue;
    }
    aggregated.push(t);
  }

  return {
    aggregated,
    stats: {
      raw_count: rawCount,
      after_id_dedup: afterIdDedup,
      after_line_items_merge: afterLineMerge.length,
      after_ghost_filter: aggregated.length,
      merged_line_items: mergedLineItems,
      dropped_ghosts: droppedGhosts,
    },
  };
}
