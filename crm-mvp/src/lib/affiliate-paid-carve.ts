/**
 * RW/LH 已付剖分（口径A 配套）
 *
 * 背景：CG/PM 的交易API 带 paid_date，同步时已把已打款订单落进 status='paid' 桶；
 * 但 RW/LH/LB 的交易API 不返回打款状态，已打款订单仍停留在 approved/pending/rejected
 * （实证：LB paid 桶长期为 0，与支付API 差额 100%）。
 * 因此每次交易同步后，需要用「支付细节API」把已打款订单逐笔标记回 paid 桶，
 * 使结算页「已支付 = 交易表 paid 桶」对 RW/LH/LB 也精确成立（口径A）。
 *
 * 数据来源：affiliate_payments 里 status='paid' 的打款单号（withdrawal_id）→
 *           payment-detail-api 展开为行级 sign_id（= affiliate_transactions.transaction_id）。
 *
 * 安全约束（吸取此前对账事故教训）：
 *  - 只对**已存在且未删除**的交易行做 status→'paid' 更新；
 *  - 绝不复活软删行、绝不新建行、绝不改 commission_amount；
 *  - 按 (platform, transaction_id) 精确匹配（transaction_id 在平台内唯一），
 *    打款单证明该订单确已到账，故无论当前 status（含 rejected）一律归入 paid。
 */

import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";
import { fetchPaymentDetail } from "@/lib/payment-detail-api";

// RW/LH/LB 交易API 均不返回打款状态，需用支付细节API 剖分回 paid 桶。
const CARVE_PLATFORMS = new Set(["RW", "LH", "LB"]);

/** 该平台的 paid 桶是否由剖分维护（而非平台 API 自报）。 */
export function isCarvePlatform(platform: string): boolean {
  return CARVE_PLATFORMS.has(platform);
}

/**
 * D-333：把剖分平台被交易同步打回的 paid 行重新归位。
 *
 * RW/LH/LB 的交易API 永远不会返回 paid（这正是剖分存在的理由），所以交易同步的
 * update 路径无条件写 `status: txn.status` 时，会把剖分标好的 paid 行降级成
 * approved/pending。daily-sync 每天只剖分一次，而 txn-quick-sync 每 30 分钟、
 * 窗口 14 天地覆写一遍 —— 实测这三个平台 14 天窗口内的 paid 行数恰好是 0。
 *
 * 修法不能是「剖分平台一律不写 status」：那会连 approved↔pending↔rejected 的正常
 * 迁移一起冻住。这里只封堵 paid → 非 paid 这一个方向：同步照常写状态，写完把
 * 「支付明细证明已到账、却被这轮同步降级」的行重新标回 paid。
 *
 * 判定依据是 `affiliate_paid_signids` —— 剖分每次展开打款单明细时把行级 sign_id
 * 落库（D-333 新增表）。这些 sign_id 是剖分唯一的昂贵产出（逐打款单请求支付明细API），
 * 原先用完即丢；持久化之后，任何一轮交易同步都能零外部请求地自愈。
 *
 * 一条 set-based UPDATE 收工：不按 txnId 分批、不随本轮同步条数增长，
 * 在这台常年 swap 的小机器上代价可以忽略（见 [[crm-swap-thrash-loop]] 的教训）。
 *
 * @param platform 平台代码（非剖分平台直接返回 0）
 * @returns 重新标回 paid 的行数
 */
export async function restorePaidAfterSync(platform: string): Promise<number> {
  if (!CARVE_PLATFORMS.has(platform)) return 0;

  const affected = await prisma.$executeRawUnsafe(
    `UPDATE affiliate_transactions t
     JOIN affiliate_paid_signids s
       ON s.platform = t.platform AND s.sign_id = t.transaction_id
     SET t.status = 'paid'
     WHERE t.platform = ? AND t.is_deleted = 0 AND t.status <> 'paid'`,
    platform,
  );
  return Number(affected || 0);
}

export interface CarveResult {
  scanned_withdrawals: number;
  detail_signids: number;
  rows_marked_paid: number;
  errors: string[];
  by_platform: Record<string, { withdrawals: number; signids: number; marked: number }>;
}

/**
 * 对单个用户的 RW/LH 连接执行已付剖分。
 * @param dryRun true 时只统计可标记数量，不写库。
 */
export async function markPaidFromPaymentDetails(
  userId: bigint,
  opts: { dryRun?: boolean } = {},
): Promise<CarveResult> {
  const dryRun = !!opts.dryRun;
  const result: CarveResult = {
    scanned_withdrawals: 0,
    detail_signids: 0,
    rows_marked_paid: 0,
    errors: [],
    by_platform: {},
  };

  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0, status: "connected" },
    select: { id: true, platform: true, account_name: true, api_key: true },
  });
  const carveConns = conns.filter(
    (c) => c.api_key && c.api_key.length > 5 && CARVE_PLATFORMS.has(normalizePlatformCode(c.platform)),
  );
  if (carveConns.length === 0) return result;

  // 同一物理账号(api_key)可能被配置成多条连接，按 (platform, api_key) 去重避免重复拉取明细
  const seenAccounts = new Set<string>();
  // 每个平台收集到的已付 sign_id（去重）
  const signIdsByPlatform = new Map<string, Set<string>>();

  for (const conn of carveConns) {
    const platform = normalizePlatformCode(conn.platform);
    const acctKey = `${platform}::${conn.api_key}`;
    if (seenAccounts.has(acctKey)) continue;
    seenAccounts.add(acctKey);

    if (!result.by_platform[platform]) {
      result.by_platform[platform] = { withdrawals: 0, signids: 0, marked: 0 };
    }

    // 该账号下所有已付打款单号（去重）
    const paidRows = await prisma.$queryRawUnsafe<{ payment_no: string }[]>(
      `SELECT DISTINCT payment_no FROM affiliate_payments
       WHERE platform = ? AND platform_connection_id = ? AND is_deleted = 0
         AND status = 'paid' AND payment_no IS NOT NULL AND payment_no != ''`,
      platform,
      conn.id,
    );

    for (const { payment_no } of paidRows) {
      result.scanned_withdrawals++;
      result.by_platform[platform].withdrawals++;
      const { items, error } = await fetchPaymentDetail(platform, conn.api_key!, payment_no);
      if (error) {
        result.errors.push(`${platform}/${conn.account_name || conn.id}/${payment_no}: ${error}`);
        continue;
      }
      if (!signIdsByPlatform.has(platform)) signIdsByPlatform.set(platform, new Set());
      const set = signIdsByPlatform.get(platform)!;
      for (const it of items) {
        if (it.signId) set.add(it.signId);
      }
    }
  }

  // 逐平台把匹配到的 sign_id 对应交易行标记为 paid
  for (const [platform, signSet] of signIdsByPlatform) {
    const signIds = [...signSet];
    result.detail_signids += signIds.length;
    result.by_platform[platform].signids = signIds.length;
    if (signIds.length === 0) continue;

    // D-333：把 sign_id 落库。这是剖分唯一的昂贵产出（逐打款单请求支付明细API），
    // 原先用完即丢，导致下一轮交易同步把 paid 打回后无从恢复。持久化之后
    // restorePaidAfterSync() 可以零外部请求地自愈。INSERT IGNORE 保证幂等。
    if (!dryRun) {
      for (let i = 0; i < signIds.length; i += 500) {
        const batch = signIds.slice(i, i + 500);
        const values = batch.map(() => "(?,?)").join(",");
        const params: string[] = [];
        for (const sid of batch) params.push(platform, sid);
        await prisma.$executeRawUnsafe(
          `INSERT IGNORE INTO affiliate_paid_signids (platform, sign_id) VALUES ${values}`,
          ...params,
        );
      }
    }

    let marked = 0;
    for (let i = 0; i < signIds.length; i += 500) {
      const batch = signIds.slice(i, i + 500);
      const ph = batch.map(() => "?").join(",");
      if (dryRun) {
        const rows = await prisma.$queryRawUnsafe<{ cnt: bigint }[]>(
          `SELECT COUNT(*) cnt FROM affiliate_transactions
           WHERE platform = ? AND is_deleted = 0 AND status <> 'paid'
             AND transaction_id IN (${ph})`,
          platform,
          ...batch,
        );
        marked += Number(rows[0]?.cnt || 0);
      } else {
        const affected = await prisma.$executeRawUnsafe(
          `UPDATE affiliate_transactions
           SET status = 'paid'
           WHERE platform = ? AND is_deleted = 0 AND status <> 'paid'
             AND transaction_id IN (${ph})`,
          platform,
          ...batch,
        );
        marked += Number(affected || 0);
      }
    }
    result.by_platform[platform].marked = marked;
    result.rows_marked_paid += marked;
  }

  return result;
}
