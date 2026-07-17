/**
 * C-180 银行流水 — 混平台明细按平台拆分
 *
 * 背景：BSH 和 CG 的钱一起提现，银行只到账一笔总额。登记时明细可混含多个平台的行，
 * 保存时按平台拆成多条流水（各自独立编辑/删除），拆分出的条目共享 txn_group，
 * 导出「账户交易明细清单」时按组合并回一笔与真实银行对账。
 *
 * 拆分口径（2026-07-16 与 07 确认）：
 *   手续费不分平台 —— 全部明细行统一按金额比例分摊（apportionFee 口径），
 *   每平台到账金额 = 该平台明细合计 − 该平台各行分摊手续费之和，
 *   各平台到账之和 = 银行实际到账总额（分尾差调整到明细合计最大的平台）。
 *
 * 纯函数，前端拆分预览与后端保存共用。
 */

import { apportionFee } from "@/lib/bank-flow-fee";

export interface SplitBreakdownItem {
  userId: string;
  username: string;
  displayName: string;
  platform: string;
  account: string;
  amount: number;
  /** 该行来源批次日（平台实际打款日），手动添加/预填时随行携带，用于防重复预填 */
  sourceDate?: string | null;
}

export interface PlatformSplitGroup {
  platform: string;
  items: SplitBreakdownItem[];
  /** 该平台明细合计 */
  expected: number;
  /** 拆分后该平台实际到账 */
  amount: number;
  /** 该平台分摊手续费 = expected − amount */
  fee: number;
  /** 该平台行的批次日（唯一时取该日；多批次取最早；无则回退 fallbackSourceDate） */
  sourceDate: string | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 按明细行平台分组拆分一笔银行到账。
 * @param items 员工明细行（platform 为空的行归入 fallbackPlatform）
 * @param totalAmount 银行实际到账总额
 * @param fallbackPlatform 表单选择的平台（明细为空/行无平台时兜底）
 * @param fallbackSourceDate 表单级预填批次日（行未携带 sourceDate 时对 fallbackPlatform 组兜底）
 */
export function splitByPlatform(
  items: SplitBreakdownItem[],
  totalAmount: number,
  fallbackPlatform: string,
  fallbackSourceDate: string | null = null,
): PlatformSplitGroup[] {
  const norm = (p: string | null | undefined) => (p || "").trim().toUpperCase() || fallbackPlatform;

  if (items.length === 0) {
    return [{
      platform: fallbackPlatform,
      items: [],
      expected: 0,
      amount: r2(totalAmount),
      fee: r2(-totalAmount),
      sourceDate: fallbackSourceDate,
    }];
  }

  // 手续费全量统一分摊（不分平台），再按行归属聚到各平台
  const totalExpected = r2(items.reduce((s, it) => s + (it.amount || 0), 0));
  const totalFee = r2(totalExpected - totalAmount);
  const fees = apportionFee(items.map((it) => it.amount || 0), totalFee);

  const byPlat = new Map<string, { items: SplitBreakdownItem[]; expected: number; feeSum: number }>();
  const order: string[] = [];
  items.forEach((it, idx) => {
    const plat = norm(it.platform);
    let g = byPlat.get(plat);
    if (!g) {
      g = { items: [], expected: 0, feeSum: 0 };
      byPlat.set(plat, g);
      order.push(plat);
    }
    g.items.push(it);
    g.expected += it.amount || 0;
    g.feeSum += fees[idx] ?? 0;
  });
  // 表单选择的平台排最前（列表/编辑时的"主平台"直觉）
  order.sort((a, b) => (a === fallbackPlatform ? -1 : 0) - (b === fallbackPlatform ? -1 : 0));

  const groups: PlatformSplitGroup[] = order.map((plat) => {
    const g = byPlat.get(plat)!;
    const dates = [...new Set(g.items.map((it) => it.sourceDate || "").filter(Boolean))].sort();
    return {
      platform: plat,
      items: g.items,
      expected: r2(g.expected),
      amount: r2(g.expected - g.feeSum),
      fee: 0, // 占位，尾差调整后统一计算
      sourceDate: dates.length > 0 ? dates[0] : (plat === fallbackPlatform ? fallbackSourceDate : null),
    };
  });

  // 分尾差：各平台到账之和必须 = 银行实际到账总额，偏差调整到明细合计最大的平台
  const diff = r2(totalAmount - groups.reduce((s, g) => s + g.amount, 0));
  if (Math.abs(diff) >= 0.005) {
    let idx = 0;
    for (let i = 1; i < groups.length; i++) {
      if (groups[i].expected > groups[idx].expected) idx = i;
    }
    groups[idx].amount = r2(groups[idx].amount + diff);
  }
  for (const g of groups) g.fee = r2(g.expected - g.amount);
  return groups;
}
