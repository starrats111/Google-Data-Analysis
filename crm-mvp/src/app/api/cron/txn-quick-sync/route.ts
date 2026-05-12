import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";
import { nowCST, dateColumnStart, dateColumnEndExclusive } from "@/lib/date-utils";
import { getRedirectedMerchantKeys } from "@/lib/merchant-ownership-rules";
import { applyAffiliateCommissionToDailyStats } from "@/lib/daily-stats-commission";
import { aggregateRawTransactions } from "@/lib/affiliate-txn-aggregate";

/** 快速同步的时间窗口（天）：覆盖所有状态活跃中的订单 */
const QUICK_SYNC_DAYS = 14;

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  const ts = new Date().toISOString();
  console.error(`[CRON txn-quick-sync ${ts}] ${msg}`);
}

/**
 * 将用户交易版本戳写入 system_configs，供前端轮询感知变化。
 * key 格式：txn_version_{userId}
 */
async function updateTxnVersion(userId: bigint, ts: string): Promise<void> {
  const key = `txn_version_${userId}`;
  await prisma.system_configs.upsert({
    where: { config_key: key },
    create: { config_key: key, config_value: ts, description: `交易数据版本戳 (user ${userId})`, is_deleted: 0 },
    update: { config_value: ts, is_deleted: 0 },
  });
}

/**
 * 获取用户当前 affiliate_transactions 的最新 updated_at（用于变更检测）
 */
async function getMaxUpdatedAt(userId: bigint): Promise<string> {
  const row = await prisma.affiliate_transactions.findFirst({
    where: { user_id: userId, is_deleted: 0 },
    orderBy: { updated_at: "desc" },
    select: { updated_at: true },
  });
  return row?.updated_at?.toISOString() ?? "1970-01-01T00:00:00.000Z";
}

/**
 * GET /api/cron/txn-quick-sync
 *
 * 每 10 分钟执行：快速同步全部用户过去 14 天的交易数据。
 * 有变动时更新 system_configs 中的版本戳，前端通过轮询感知并局部刷新。
 * 失败时静默跳过，不影响现有 daily-sync。
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  log("开始快速交易同步...");

  const users = await prisma.users.findMany({
    where: { is_deleted: 0, status: "active", role: { in: ["user", "leader"] } },
    select: { id: true, username: true },
  });

  // C-084：联盟交易同步按 CST 切日，与平台后台口径一致（推翻 C-080，wj02 CG 实测对齐）
  const cstNow = nowCST();
  const startStr = cstNow.subtract(QUICK_SYNC_DAYS, "day").format("YYYY-MM-DD");
  const endStr = cstNow.format("YYYY-MM-DD");

  // 用于 ads_daily_stats 佣金回写的 UTC 边界（DATE 列按 UTC 日期对齐 ads_daily_stats.date）
  const statsRangeStart = dateColumnStart(startStr);
  const statsRangeEnd = dateColumnEndExclusive(endStr);

  const results: Record<string, unknown> = {};
  let totalChanged = 0;
  let totalCommissionUpdated = 0;

  for (const user of users) {
    const userId = user.id;
    try {
      const conns = await prisma.platform_connections.findMany({
        where: { user_id: userId, is_deleted: 0, status: "connected" },
        select: { id: true, platform: true, account_name: true, api_key: true },
      });
      const validConns = conns
        .filter((c) => c.api_key && c.api_key.length > 5)
        .sort((a, b) => Number(b.id) - Number(a.id));

      if (validConns.length === 0) {
        results[user.username] = { skipped: true };
        continue;
      }

      // 变更检测：记录同步前的最新 updated_at
      const beforeTs = await getMaxUpdatedAt(userId);

      const { fetchAllTransactions } = await import("@/lib/platform-api");
      const userMerchants = await prisma.user_merchants.findMany({
        where: { user_id: userId, is_deleted: 0 },
        select: { id: true, merchant_id: true, platform: true, merchant_name: true },
      });
      const merchantMap = new Map(
        userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m])
      );
      const redirectRules = getRedirectedMerchantKeys(userId);

      let upserted = 0;
      const platformStats: Record<string, number> = {};

      for (const conn of validConns) {
        const platform = normalizePlatformCode(conn.platform);
        try {
          const r = await fetchAllTransactions(platform, conn.api_key!, startStr, endStr);
          if (r.error && r.transactions.length === 0) continue;
          if (!r.transactions.length) continue;

          // C-079：line items 聚合 + 0/0 幽灵过滤
          const aggRes = aggregateRawTransactions(r.transactions);
          const aggregatedTxns = aggRes.aggregated;
          if (aggRes.stats.merged_line_items > 0 || aggRes.stats.dropped_ghosts > 0) {
            log(`  ${user.username} ${platform}: raw=${aggRes.stats.raw_count} → ${aggregatedTxns.length} (merged=${aggRes.stats.merged_line_items}, dropped=${aggRes.stats.dropped_ghosts})`);
          }

          for (const txn of aggregatedTxns) {
            if (!txn.transaction_id) continue;
            const mid = txn.merchant_id || "";
            const merchantKey = `${platform}_${mid}`;

            // 归属重定向规则
            const rule = redirectRules.get(merchantKey);
            if (rule) {
              await prisma.affiliate_transactions.upsert({
                where: { platform_transaction_id: { platform, transaction_id: txn.transaction_id } },
                create: {
                  user_id: BigInt(rule.target_user_id),
                  user_merchant_id: BigInt(rule.target_user_merchant_id),
                  campaign_id: BigInt(rule.target_campaign_id),
                  platform_connection_id: conn.id,
                  platform, merchant_id: mid, merchant_name: txn.merchant || "",
                  transaction_id: txn.transaction_id,
                  transaction_time: new Date(txn.transaction_time),
                  order_amount: txn.order_amount || 0,
                  commission_amount: txn.commission_amount || 0,
                  currency: "USD", status: txn.status, raw_status: txn.raw_status || "",
                },
                update: {
                  // C-082：transaction_time 必须随 sync 刷新为 API 的 order_time，
                  // 修复历史 commit 1788f95f 导致的 last_update_time 写错。
                  transaction_time: new Date(txn.transaction_time),
                  commission_amount: txn.commission_amount || 0,
                  status: txn.status, raw_status: txn.raw_status || "",
                  order_amount: txn.order_amount || 0,
                  merchant_name: txn.merchant || undefined,
                  is_deleted: 0,
                },
              });
              upserted++;
              continue;
            }

            const merchant = merchantMap.get(merchantKey);
            const umId = merchant ? merchant.id : BigInt(0);
            const merchantName = txn.merchant || merchant?.merchant_name || "";

            // 防止 API Key 共享时跨用户抢注：
            // 若该商家在其他用户下存在且有关联的 campaign，跳过当前用户的 create
            if (!merchant && mid) {
              const otherMerchant = await prisma.user_merchants.findFirst({
                where: {
                  platform, merchant_id: mid, is_deleted: 0,
                  user_id: { not: userId },
                  status: { in: ["claimed", "paused", "running"] },
                },
                select: { id: true },
              });
              const claimedByOther = otherMerchant
                ? await prisma.campaigns.findFirst({
                    where: { user_merchant_id: otherMerchant.id, is_deleted: 0 },
                    select: { id: true },
                  })
                : null;
              if (claimedByOther) {
                // 仅更新已存在的同记录状态，不创建新记录
                await prisma.affiliate_transactions.updateMany({
                  where: { platform, transaction_id: txn.transaction_id, is_deleted: 0 },
                  data: { status: txn.status, raw_status: txn.raw_status || "", commission_amount: txn.commission_amount || 0, order_amount: txn.order_amount || 0 },
                });
                continue;
              }
            }

            await prisma.affiliate_transactions.upsert({
              where: { platform_transaction_id: { platform, transaction_id: txn.transaction_id } },
              create: {
                user_id: userId, user_merchant_id: umId,
                platform_connection_id: conn.id,
                platform, merchant_id: mid, merchant_name: merchantName,
                transaction_id: txn.transaction_id,
                transaction_time: new Date(txn.transaction_time),
                order_amount: txn.order_amount || 0,
                commission_amount: txn.commission_amount || 0,
                currency: "USD", status: txn.status, raw_status: txn.raw_status || "",
              },
              update: {
                merchant_name: merchantName || undefined,
                // C-082：transaction_time 必须随 sync 刷新为 API 的 order_time，
                // 修复历史 commit 1788f95f 导致的 last_update_time 写错。
                transaction_time: new Date(txn.transaction_time),
                order_amount: txn.order_amount || 0,
                commission_amount: txn.commission_amount || 0,
                status: txn.status, raw_status: txn.raw_status || "",
                is_deleted: 0,
                ...(umId !== BigInt(0) ? { user_merchant_id: umId } : {}),
              },
            });
            upserted++;
          }

          platformStats[platform] = (platformStats[platform] || 0) + r.transactions.length;
        } catch (e) {
          log(`  ${user.username} ${conn.account_name || platform} error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // 变更检测：同步后再取一次 updated_at，有变化则更新版本戳
      const afterTs = await getMaxUpdatedAt(userId);
      const hasChange = afterTs !== beforeTs;

      // 佣金回写到 ads_daily_stats（数据中心广告系列页面读这张表显示佣金/订单）
      // 即使 upserted=0、hasChange=false 也执行：极轻量（仅 14 天聚合），可保证状态一致性
      let commissionUpdated = 0;
      try {
        commissionUpdated = await applyAffiliateCommissionToDailyStats(userId, statsRangeStart, statsRangeEnd);
        totalCommissionUpdated += commissionUpdated;
      } catch (e) {
        log(`  ${user.username} commission writeback error: ${e instanceof Error ? e.message : String(e)}`);
      }

      if (hasChange) {
        await updateTxnVersion(userId, afterTs);
        totalChanged++;
        log(`  ${user.username}: changed ✓ (${upserted} upserted, ${commissionUpdated} commission rows)`);
      } else if (commissionUpdated > 0) {
        // 即使 affiliate_transactions 没有 updated_at 变动（比如纯重写），
        // 但 ads_daily_stats 实际有写入：依然推进版本戳，让前端轮询拿到新数据
        await updateTxnVersion(userId, afterTs);
        log(`  ${user.username}: commission writeback only (${commissionUpdated} rows)`);
      } else {
        log(`  ${user.username}: no change`);
      }

      results[user.username] = {
        upserted,
        changed: hasChange,
        commission_updated: commissionUpdated,
        platforms: platformStats,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`  ${user.username} fatal: ${msg}`);
      results[user.username] = { error: msg };
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`快速同步完成：${totalChanged}/${users.length} 用户有变动，回写佣金 ${totalCommissionUpdated} 行，耗时 ${elapsed}s`);

  return NextResponse.json({
    ok: true,
    elapsed_s: parseFloat(elapsed),
    users_changed: totalChanged,
    users_total: users.length,
    window_days: QUICK_SYNC_DAYS,
    commission_updated_total: totalCommissionUpdated,
    results,
  });
}
