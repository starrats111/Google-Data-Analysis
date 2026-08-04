import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError, normalizePlatformCode } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { nowCST, parseTxnDateStart, parseTxnDateEndExclusive } from "@/lib/date-utils";
import { getRedirectedMerchantKeys } from "@/lib/merchant-ownership-rules";
import { applyAffiliateCommissionToDailyStats } from "@/lib/daily-stats-commission";
import { aggregateRawTransactions } from "@/lib/affiliate-txn-aggregate";
import { markConnectionSuccess, markConnectionAttempted, markConnectionFailure } from "@/lib/connection-health";

/**
 * POST /api/user/data-center/sync-transactions
 *
 * 直接调用各联盟平台 API 拉取交易数据到 CRM
 * 使用 platform_connections 中配置的 API Key
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const userId = BigInt(user.userId);
  const body = await req.json().catch(() => ({}));

  // C-084：联盟交易同步按 CST 切日（推翻 C-080）
  const now = nowCST();
  const DEFAULT_START = "2025-01-01";
  const startStr = body.days
    ? now.subtract(body.days, "day").format("YYYY-MM-DD")
    : DEFAULT_START;
  const startDate = parseTxnDateStart(startStr);
  const endStr = now.format("YYYY-MM-DD");
  // 佣金回写区间的独占上界：今日 CST 结束（含今天已到账的单）
  const commissionEndExclusive = parseTxnDateEndExclusive(endStr);

  try {
    // 1. 获取用户的所有平台连接
    const connections = await prisma.platform_connections.findMany({
      where: { user_id: userId, is_deleted: 0, status: "connected" },
      select: { id: true, platform: true, account_name: true, api_key: true, channel_id: true },
    });

    const validConns = connections
      .filter((c) => c.api_key && c.api_key.length > 5)
      .sort((a, b) => Number(b.id) - Number(a.id));
    if (validConns.length === 0) {
      return apiError("没有可用的平台连接，请先在「个人设置 → 联盟平台连接」中配置 API Key", 400);
    }

    // 2. 获取商家映射（查询所有商家，不限 claimed，提升匹配率）
    const userMerchants = await prisma.user_merchants.findMany({
      where: { user_id: userId, is_deleted: 0 },
      select: { id: true, merchant_id: true, platform: true, merchant_name: true },
    });
    const merchantMap = new Map(
      userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m])
    );

    // 3. 并行拉取各平台交易（3 个平台并发）
    const { fetchAllTransactions } = await import("@/lib/platform-api");

    type FetchedConn = { conn: typeof validConns[0]; platform: string; label: string; transactions: any[]; error?: string };
    const fetched: FetchedConn[] = [];
    const FETCH_CONCURRENCY = 3;

    for (let fi = 0; fi < validConns.length; fi += FETCH_CONCURRENCY) {
      const batch = validConns.slice(fi, fi + FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (conn) => {
          const platform = normalizePlatformCode(conn.platform);
          const label = conn.account_name || platform;
          try {
            const r = await fetchAllTransactions(platform, conn.api_key!, startStr, endStr);
            return { conn, platform, label, transactions: r.transactions, error: r.error };
          } catch (err) {
            return { conn, platform, label, transactions: [] as any[], error: `${err instanceof Error ? err.message : String(err)}` };
          }
        })
      );
      fetched.push(...results);
    }

    // 顺序处理各平台数据（upsert 到数据库）
    const accountResults: { account_name: string; platform: string; synced: number; total_fetched: number; error?: string }[] = [];
    let totalSynced = 0;
    let totalSkipped = 0;

    for (const { conn, platform, label, transactions, error } of fetched) {
      // D-026: 写连接健康状态
      if (error) {
        await markConnectionFailure(conn.id, error);
      } else if (transactions.length === 0) {
        await markConnectionAttempted(conn.id);
      } else {
        await markConnectionSuccess(conn.id);
      }
      if (error && transactions.length === 0) {
        accountResults.push({ account_name: label, platform, synced: 0, total_fetched: 0, error });
        continue;
      }
      if (transactions.length === 0) {
        accountResults.push({ account_name: label, platform, synced: 0, total_fetched: 0, error: error || undefined });
        continue;
      }

      // C-079：API line items 聚合 + 0/0 幽灵过滤
      // 同 (merchant, transaction_time) 多 transaction_id 视为同一笔订单的 line items，
      // 合并为 1 行（代表 id = 字典序最小，commission/order_amount 取 SUM），
      // 同时丢弃 commission=0 AND order=0 的幽灵行。
      const aggRes = aggregateRawTransactions(transactions);
      const dedupedTxns = aggRes.aggregated;
      if (aggRes.stats.merged_line_items > 0 || aggRes.stats.dropped_ghosts > 0) {
        console.log(`[sync-txn] ${platform}/${label}: raw=${aggRes.stats.raw_count} → ${dedupedTxns.length} (merged line items=${aggRes.stats.merged_line_items}, dropped ghosts=${aggRes.stats.dropped_ghosts})`);
      }

      // 自动创建缺失的 user_merchants（交易中有但商家表没有的）
      const missingMerchants = new Map<string, { merchantId: string; name: string }>();
      for (const txn of dedupedTxns) {
        const mid = txn.merchant_id || "";
        if (!mid) continue;
        const key = `${platform}_${mid}`;
        if (!merchantMap.has(key) && !missingMerchants.has(key)) {
          missingMerchants.set(key, { merchantId: mid, name: txn.merchant || "" });
        }
      }
      for (const [key, { merchantId, name }] of missingMerchants) {
        try {
          // Skip merchants that have been excluded (regardless of is_deleted)
          const wasExcluded = await prisma.user_merchants.findFirst({
            where: { user_id: userId, platform, merchant_id: merchantId, status: "excluded" },
            select: { id: true },
          });
          if (wasExcluded) continue;

          let existing = await prisma.user_merchants.findFirst({
            where: { user_id: userId, platform, merchant_id: merchantId, is_deleted: 0 },
            select: { id: true, merchant_id: true, platform: true, merchant_name: true },
          });
          if (!existing) {
            existing = await prisma.user_merchants.create({
              data: { user_id: userId, platform, merchant_id: merchantId, merchant_name: name, status: "available" },
              select: { id: true, merchant_id: true, platform: true, merchant_name: true },
            });
          }
          merchantMap.set(key, existing);
        } catch { /* ignore race condition */ }
      }

      let synced = 0;
      let skipped = 0;
      let cleaned = 0;

      // 预清理：如果交易有 order_id，先删除数据库中以该 order_id 作为 transaction_id 的旧记录
      // 这解决了历史代码用 order_id 而非 collabgrow_id 导致的重复问题
      const orderIdsToClean = dedupedTxns
        .filter((txn) => txn.order_id && txn.transaction_id !== txn.order_id)
        .map((txn) => txn.order_id!);
      if (orderIdsToClean.length > 0) {
        for (let ci = 0; ci < orderIdsToClean.length; ci += 200) {
          const batch = orderIdsToClean.slice(ci, ci + 200);
          const result = await prisma.affiliate_transactions.deleteMany({
            where: { platform, user_id: userId, transaction_id: { in: batch } },
          });
          cleaned += result.count;
        }
        if (cleaned > 0) {
          console.log(`[sync-txn] ${platform}/${label}: 清理了 ${cleaned} 条旧 order_id 格式记录`);
        }
      }

      // C-088：软删被合并掉的历史子行（同一订单的非代表 line item id），
      // 收敛 RW 等"拒原行+建新行"残留的陈旧行，避免一笔订单重复计数 / 状态错乱。
      if (aggRes.absorbedTxnIds.length > 0) {
        let absorbedDeleted = 0;
        for (let ci = 0; ci < aggRes.absorbedTxnIds.length; ci += 200) {
          const batch = aggRes.absorbedTxnIds.slice(ci, ci + 200);
          const res = await prisma.affiliate_transactions.updateMany({
            where: { platform, user_id: userId, transaction_id: { in: batch }, is_deleted: 0 },
            data: { is_deleted: 1 },
          });
          absorbedDeleted += res.count;
        }
        if (absorbedDeleted > 0) {
          console.log(`[sync-txn] ${platform}/${label}: 软删了 ${absorbedDeleted} 条被合并的历史子行`);
        }
      }

      const redirectRules = getRedirectedMerchantKeys(userId);

      // C-020 R1.1：domain 兜底——仅对 source=url_direct 的商家，按 domain 回填 user_merchant_id
      const urlDirectMerchants = await prisma.user_merchants.findMany({
        where: {
          user_id: userId,
          platform_connection_id: conn.id,
          source: "url_direct",
          is_deleted: 0,
        },
        select: { id: true, merchant_id: true, platform: true, merchant_name: true, merchant_url: true },
      });
      const extractDomain = (u: string | null | undefined): string => {
        if (!u) return "";
        try { return new URL(u).hostname.replace(/^www\./i, "").toLowerCase(); }
        catch { return ""; }
      };
      const urlDirectByDomain = new Map<string, typeof urlDirectMerchants[0]>();
      for (const m of urlDirectMerchants) {
        const d = extractDomain(m.merchant_url);
        if (d && !urlDirectByDomain.has(d)) urlDirectByDomain.set(d, m);
      }

      for (let i = 0; i < dedupedTxns.length; i += 50) {
        const batch = dedupedTxns.slice(i, i + 50);
        const ops = batch.map((txn) => {
          const merchantId = txn.merchant_id || "";
          const txnId = txn.transaction_id;
          if (!txnId) { skipped++; return null; }

          // 检查硬编码归属规则：将交易直接写入目标用户
          const rule = redirectRules.get(`${platform}_${merchantId}`);
          if (rule) {
            return prisma.affiliate_transactions.upsert({
              where: { platform_transaction_id: { platform, transaction_id: txnId } },
              create: {
                user_id: BigInt(rule.target_user_id),
                user_merchant_id: BigInt(rule.target_user_merchant_id),
                campaign_id: BigInt(rule.target_campaign_id),
                platform_connection_id: conn.id,
                platform, merchant_id: merchantId, merchant_name: txn.merchant || "",
                transaction_id: txnId, transaction_time: new Date(txn.transaction_time),
                order_amount: txn.order_amount || 0, commission_amount: txn.commission_amount || 0,
                currency: "USD", status: txn.status, raw_status: txn.raw_status || "",
              },
              update: {
                user_id: BigInt(rule.target_user_id),
                user_merchant_id: BigInt(rule.target_user_merchant_id),
                campaign_id: BigInt(rule.target_campaign_id),
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
          }

          let merchant = merchantMap.get(`${platform}_${merchantId}`);
          // domain 兜底：精确匹配失败时，仅在 source=url_direct 范围内按 domain 匹配（C-020 R1.1）
          if (!merchant && txn.merchant_url) {
            const d = extractDomain(txn.merchant_url);
            if (d) merchant = urlDirectByDomain.get(d);
          }
          const userMerchantId = merchant ? merchant.id : BigInt(0);
          const merchantName = txn.merchant || merchant?.merchant_name || "";
          const newComm = txn.commission_amount || 0;
          const newAmt = txn.order_amount || 0;

          return prisma.affiliate_transactions.upsert({
            where: { platform_transaction_id: { platform, transaction_id: txnId } },
            create: {
              user_id: userId, user_merchant_id: userMerchantId, platform_connection_id: conn.id,
              platform, merchant_id: merchantId, merchant_name: merchantName, transaction_id: txnId,
              transaction_time: new Date(txn.transaction_time), order_amount: newAmt,
              commission_amount: newComm, currency: "USD", status: txn.status, raw_status: txn.raw_status || "",
            },
            update: {
              merchant_id: merchantId,
              ...(userMerchantId !== BigInt(0) ? { user_merchant_id: userMerchantId } : {}),
              // C-082：transaction_time 必须随 sync 刷新为 API 的 order_time，
              // 修复历史 commit 1788f95f 导致的 last_update_time 写错。
              transaction_time: new Date(txn.transaction_time),
              commission_amount: newComm,
              status: txn.status, raw_status: txn.raw_status || "",
              order_amount: newAmt,
              merchant_name: merchantName || undefined,
            },
          });
        }).filter(Boolean);

        await Promise.all(ops);
        synced += ops.length;
      }

      totalSynced += synced;
      totalSkipped += skipped;
      accountResults.push({ account_name: label, platform, synced, total_fetched: transactions.length, error: error || undefined });
    }

    // 4. 关联交易和 campaigns 到正确的商家
    await linkTransactionsToMerchants(userId);
    await linkCampaignsToMerchants(userId);
    await claimLinkedMerchants(userId);

    // 4.5 按规则将特定商家的交易转移给实际投放人
    const reassigned = await reassignTransactionsByRules(userId);

    // 5. 佣金回写（内部会先清零区间再写入正确值）
    const commissionUpdated = await updateDailyStatsCommission(userId, startDate, commissionEndExclusive);

    // 5.5 如果有交易被转移，也更新目标用户的佣金
    if (reassigned.length > 0) {
      for (const r of reassigned) {
        await updateDailyStatsCommission(BigInt(r.targetUserId), startDate, commissionEndExclusive);
      }
    }

    // 6. RW/LH/LB 已付剖分（口径A 配套）：交易同步会把它们的已打款订单重置为非 paid，
    //    这里用支付细节API 把它们重新归入 paid 桶，使「已支付=交易表 paid 桶」对 RW/LH/LB 也成立。
    try {
      const { markPaidFromPaymentDetails } = await import("@/lib/affiliate-paid-carve");
      const carve = await markPaidFromPaymentDetails(userId);
      if (carve.rows_marked_paid > 0 || carve.errors.length > 0) {
        console.log(`[sync-txn] RW/LH/LB 已付剖分：标记 ${carve.rows_marked_paid} 笔为 paid（明细 ${carve.detail_signids} 行，打款单 ${carve.scanned_withdrawals}）${carve.errors.length ? `，错误 ${carve.errors.length}` : ""}`);
      }
    } catch (e) {
      console.log(`[sync-txn] 已付剖分异常: ${e instanceof Error ? e.message : String(e)}`);
    }

    const errors = accountResults.filter((r) => r.error);
    const msg = accountResults.map((r) =>
      `${r.account_name}: ${r.synced}条${r.error ? ` (${r.error})` : ""}`
    ).join("；");

    return apiSuccess(serializeData({
      synced: totalSynced,
      skipped: totalSkipped,
      commission_updated: commissionUpdated,
      accounts: accountResults,
      message: `交易同步完成 — ${msg}，更新 ${commissionUpdated} 条佣金`,
    }));
  } catch (err) {
    return apiError(`同步失败: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
}

// ─── linkTransactionsToMerchants ───

async function linkTransactionsToMerchants(userId: bigint) {
  await normalizeExistingTransactionPlatforms(userId);

  // 精确匹配：platform + merchant_id（单条 SQL 替代 N 次循环）
  await prisma.$executeRawUnsafe(`
    UPDATE affiliate_transactions t
    JOIN user_merchants m
      ON t.user_id = m.user_id AND t.merchant_id = m.merchant_id AND t.platform = m.platform
    SET t.user_merchant_id = m.id
    WHERE t.user_id = ? AND t.user_merchant_id = 0 AND t.is_deleted = 0 AND m.is_deleted = 0
      AND t.merchant_id != ''
  `, userId);

  // 兜底匹配：仅 merchant_id（处理平台未精确匹配的情况）
  await prisma.$executeRawUnsafe(`
    UPDATE affiliate_transactions t
    JOIN user_merchants m
      ON t.user_id = m.user_id AND t.merchant_id = m.merchant_id
    SET t.user_merchant_id = m.id
    WHERE t.user_id = ? AND t.user_merchant_id = 0 AND t.is_deleted = 0 AND m.is_deleted = 0
      AND t.merchant_id != ''
  `, userId);

  // 兜底匹配：按商家名称（merchant_id 为空时尝试用名称匹配）
  await prisma.$executeRawUnsafe(`
    UPDATE affiliate_transactions t
    JOIN user_merchants m
      ON t.user_id = m.user_id AND t.merchant_name = m.merchant_name AND t.platform = m.platform
    SET t.user_merchant_id = m.id
    WHERE t.user_id = ? AND t.user_merchant_id = 0 AND t.is_deleted = 0 AND m.is_deleted = 0
      AND t.merchant_name != ''
  `, userId);
}

async function normalizeExistingTransactionPlatforms(userId: bigint) {
  const distinctPlatforms = await prisma.$queryRawUnsafe<{ platform: string }[]>(
    "SELECT DISTINCT platform FROM affiliate_transactions WHERE user_id = ? AND is_deleted = 0",
    userId
  );
  for (const row of distinctPlatforms) {
    const normalized = normalizePlatformCode(row.platform);
    if (normalized !== row.platform) {
      await prisma.affiliate_transactions.updateMany({
        where: { user_id: userId, platform: row.platform, is_deleted: 0 },
        data: { platform: normalized },
      });
    }
  }
}

function parseCampaignName(name: string): { platform: string; mid: string } | null {
  if (!name) return null;
  const parts = name.split(/[-\s]+/);
  if (parts.length < 4) return null;
  const rawPlatform = parts[1]?.trim();
  const mid = parts[parts.length - 1]?.trim();
  if (!rawPlatform || !mid || !/^\d+$/.test(mid)) return null;
  return { platform: normalizePlatformCode(rawPlatform), mid };
}

async function linkCampaignsToMerchants(userId: bigint) {
  const unlinked = await prisma.campaigns.findMany({
    where: { user_id: userId, user_merchant_id: BigInt(0), is_deleted: 0, google_campaign_id: { not: null } },
    select: { id: true, campaign_name: true },
    take: 500,
  });
  if (unlinked.length === 0) return 0;

  const userMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, merchant_id: true, status: true },
  });
  const merchantIndex = new Map(
    userMerchants.map((m) => [`${normalizePlatformCode(m.platform)}_${m.merchant_id}`, m])
  );

  let linked = 0;
  const updates: Promise<unknown>[] = [];
  const claimedMerchantIds = new Set<bigint>();

  for (const c of unlinked) {
    const parsed = parseCampaignName(c.campaign_name || "");
    if (!parsed) continue;
    const merchant = merchantIndex.get(`${parsed.platform}_${parsed.mid}`);
    if (!merchant) continue;

    updates.push(prisma.campaigns.update({ where: { id: c.id }, data: { user_merchant_id: merchant.id } }));

    if (merchant.status !== "claimed" && !claimedMerchantIds.has(merchant.id)) {
      claimedMerchantIds.add(merchant.id);
      updates.push(
        prisma.user_merchants.update({
          where: { id: merchant.id },
          data: { status: "claimed", claimed_at: new Date() },
        })
      );
    }

    linked++;
    if (updates.length >= 20) await Promise.all(updates.splice(0));
  }

  if (updates.length > 0) await Promise.all(updates);
  return linked;
}

async function claimLinkedMerchants(userId: bigint) {
  const linkedMerchantIds = await prisma.campaigns.findMany({
    where: { user_id: userId, is_deleted: 0, user_merchant_id: { not: BigInt(0) }, google_campaign_id: { not: null } },
    select: { user_merchant_id: true },
    distinct: ["user_merchant_id"],
  });

  if (linkedMerchantIds.length === 0) return 0;

  const ids = linkedMerchantIds.map((c) => c.user_merchant_id);
  const result = await prisma.user_merchants.updateMany({
    where: { id: { in: ids }, user_id: userId, is_deleted: 0, status: { not: "claimed" } },
    data: { status: "claimed", claimed_at: new Date() },
  });

  return result.count;
}

// ─── updateDailyStatsCommission ───

/**
 * D-211：原先这里内联着一份没有 platform_connection_id 维度的老实现，
 * 与数据中心侧口径已漂移两轮。现统一走 daily-stats-commission.ts，归因规则只有一份。
 */
async function updateDailyStatsCommission(userId: bigint, startDate: Date, endExclusive: Date): Promise<number> {
  return applyAffiliateCommissionToDailyStats(userId, startDate, endExclusive);
}

// ─── reassignTransactionsByRules ───

interface ReassignRule {
  source_user_id: number;
  target_user_id: number;
  platform: string;
  merchant_id: string;
  target_user_merchant_id: number;
  target_campaign_id: number;
}

async function reassignTransactionsByRules(sourceUserId: bigint) {
  const cfg = await prisma.system_configs.findFirst({
    where: { config_key: "transaction_reassignment_rules", is_deleted: 0 },
  });
  if (!cfg?.config_value) return [];

  let rules: ReassignRule[];
  try { rules = JSON.parse(cfg.config_value); } catch { return []; }

  const applicable = rules.filter(r => BigInt(r.source_user_id) === sourceUserId);
  if (applicable.length === 0) return [];

  const results: { targetUserId: number; count: number }[] = [];

  for (const rule of applicable) {
    // Step 1: Move new transactions from source to target user
    const result = await prisma.affiliate_transactions.updateMany({
      where: {
        user_id: BigInt(rule.source_user_id),
        platform: rule.platform,
        merchant_id: rule.merchant_id,
        is_deleted: 0,
      },
      data: {
        user_id: BigInt(rule.target_user_id),
        user_merchant_id: BigInt(rule.target_user_merchant_id),
        campaign_id: BigInt(rule.target_campaign_id),
      },
    });

    // Step 2: Fix previously-reassigned transactions whose user_merchant_id
    // was overwritten by the sync upsert back to the source user's merchant
    const fixResult = await prisma.affiliate_transactions.updateMany({
      where: {
        user_id: BigInt(rule.target_user_id),
        platform: rule.platform,
        merchant_id: rule.merchant_id,
        user_merchant_id: { not: BigInt(rule.target_user_merchant_id) },
        is_deleted: 0,
      },
      data: {
        user_merchant_id: BigInt(rule.target_user_merchant_id),
        campaign_id: BigInt(rule.target_campaign_id),
      },
    });

    const total = result.count + fixResult.count;
    if (total > 0) {
      console.log(`[sync-txn] reassign: ${result.count} new + ${fixResult.count} fixed ${rule.platform}/${rule.merchant_id} txns for user ${rule.source_user_id} → ${rule.target_user_id}`);
      results.push({ targetUserId: rule.target_user_id, count: total });
    }
  }

  return results;
}
