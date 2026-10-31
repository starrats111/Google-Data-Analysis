/**
 * D-374：商家结算率表（丰度/邮政群里定期分享）解析
 *
 * 表头格式（第1行即表头，无需跳行）：
 * 平台 / 商家名称 / MID / 订单数 / 总佣金($) / 结算率 / 拒付高(备注) / 是否已申请 /
 * 是否已重上广告 / 备注 / 是否值得候选 / 拒付率 / 拒付($) / 已确认($) / 已支付($) / 待审核($) / 订单金额($)
 *
 * 按表头文本定位列（不用固定列序），结算率为 0 或空的行跳过（无参考价值）。
 */

export interface SettlementRecord {
  platform: string;
  merchant_name: string;
  mid: string | null;
  order_count: number | null;
  total_commission: number | null;
  settlement_rate: number;
  chargeback_rate: number | null;
  chargeback_amount: number | null;
  confirmed_amount: number | null;
  paid_amount: number | null;
  pending_amount: number | null;
  order_amount: number | null;
  remark: string | null;
}

function safeStr(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function safeNum(v: unknown): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "" || s === "-" || s === "N/A") return null;
  const n = parseFloat(s.replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? null : n;
}

const HEADER_KEYS = {
  platform: ["平台"],
  merchant_name: ["商家名称"],
  mid: ["MID"],
  order_count: ["订单数"],
  total_commission: ["总佣金"],
  settlement_rate: ["结算率"],
  remark: ["备注"],
  chargeback_rate: ["拒付率"],
  chargeback_amount: ["拒付("],
  confirmed_amount: ["已确认("],
  paid_amount: ["已支付("],
  pending_amount: ["待审核("],
  order_amount: ["订单金额("],
} as const;

type FieldKey = keyof typeof HEADER_KEYS;

function findColIdx(headerRow: (unknown | null)[], keys: readonly string[]): number {
  for (let i = 0; i < headerRow.length; i++) {
    const text = String(headerRow[i] || "").trim();
    if (keys.some((k) => text.startsWith(k))) return i;
  }
  return -1;
}

export function parseSettlementExcelRows(rows: unknown[][]): SettlementRecord[] {
  if (rows.length < 2) return [];
  const headerRow = (rows[0] as (unknown | null)[]) || [];

  const colIdx: Partial<Record<FieldKey, number>> = {};
  for (const key of Object.keys(HEADER_KEYS) as FieldKey[]) {
    const idx = findColIdx(headerRow, HEADER_KEYS[key]);
    if (idx >= 0) colIdx[key] = idx;
  }
  // 平台/商家名称/结算率是必须字段，缺任一列视为表头不匹配，返回空
  if (colIdx.platform == null || colIdx.merchant_name == null || colIdx.settlement_rate == null) {
    return [];
  }

  const results: SettlementRecord[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as (unknown | null)[];
    if (!row || row.length === 0) continue;

    const platform = safeStr(row[colIdx.platform!]);
    const merchantName = safeStr(row[colIdx.merchant_name!]);
    const settlementRate = safeNum(row[colIdx.settlement_rate!]);
    if (!platform || !merchantName || merchantName.length < 2) continue;
    if (settlementRate == null || settlementRate === 0) continue; // 过滤结算率=0或空的行

    results.push({
      platform: platform.toUpperCase(),
      merchant_name: merchantName,
      mid: colIdx.mid != null ? safeStr(row[colIdx.mid]) : null,
      order_count: colIdx.order_count != null ? (safeNum(row[colIdx.order_count]) ?? null) : null,
      total_commission: colIdx.total_commission != null ? safeNum(row[colIdx.total_commission]) : null,
      settlement_rate: settlementRate,
      chargeback_rate: colIdx.chargeback_rate != null ? safeNum(row[colIdx.chargeback_rate]) : null,
      chargeback_amount: colIdx.chargeback_amount != null ? safeNum(row[colIdx.chargeback_amount]) : null,
      confirmed_amount: colIdx.confirmed_amount != null ? safeNum(row[colIdx.confirmed_amount]) : null,
      paid_amount: colIdx.paid_amount != null ? safeNum(row[colIdx.paid_amount]) : null,
      pending_amount: colIdx.pending_amount != null ? safeNum(row[colIdx.pending_amount]) : null,
      order_amount: colIdx.order_amount != null ? safeNum(row[colIdx.order_amount]) : null,
      remark: colIdx.remark != null ? safeStr(row[colIdx.remark]) : null,
    });
  }
  return results;
}
