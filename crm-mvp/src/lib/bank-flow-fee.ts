/**
 * R-07 银行流水 — 员工手续费分摊
 *
 * 口径（2026-07-07 与组长确认）：
 *   费率 = 该笔总手续费 ÷ 员工明细合计（应发口径，保证个人手续费加总 = 总手续费）
 *   个人手续费 = 员工明细金额 × 费率，四舍五入到分
 *   尾差（四舍五入导致的加总偏差）调整到明细金额最大的员工头上
 *   个人净到手 = 明细金额 − 个人手续费
 *
 * 前端弹窗、导出对账单共用。
 *
 * D-274.1（07 2026-08-24 拍板）：报表不允许出现负手续费——
 * 实际到账 > 明细合计（汇率快照略低于银行结汇价）时，用 absorbSurplus 把多到账的差额
 * 按金额占比摊进各员工明细（尾差调到金额最大的行），使明细合计 = 实际到账、手续费 = 0。
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/** 按明细金额比例分摊总手续费，返回与 amounts 等长的个人手续费数组 */
export function apportionFee(amounts: number[], totalFee: number): number[] {
  const base = amounts.reduce((s, a) => s + a, 0);
  if (amounts.length === 0 || base <= 0 || Math.abs(totalFee) < 0.005) {
    return amounts.map(() => 0);
  }
  const fees = amounts.map((a) => r2((totalFee * a) / base));
  const diff = r2(totalFee - fees.reduce((s, f) => s + f, 0));
  if (Math.abs(diff) >= 0.005) {
    let idx = 0;
    for (let i = 1; i < amounts.length; i++) {
      if (amounts[i] > amounts[idx]) idx = i;
    }
    fees[idx] = r2(fees[idx] + diff);
  }
  return fees;
}

/**
 * D-274.1：实际到账多于明细合计时，把差额按占比摊进明细金额，返回调整后的金额数组。
 * 明细合计 ≥ 实际到账（正常正手续费）或明细为空/全零时原样返回，不做任何调整。
 */
export function absorbSurplus(amounts: number[], totalAmount: number): number[] {
  const base = amounts.reduce((s, a) => s + (a || 0), 0);
  const surplus = r2(totalAmount - base);
  if (surplus < 0.005 || base <= 0) return amounts;
  const shares = apportionFee(amounts, surplus);
  return amounts.map((a, i) => r2((a || 0) + (shares[i] ?? 0)));
}
