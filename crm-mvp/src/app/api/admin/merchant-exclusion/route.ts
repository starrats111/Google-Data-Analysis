import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

/**
 * POST /api/admin/merchant-exclusion
 *
 * 将某商家标记为跨用户归属排除（status='excluded', is_deleted=1），
 * 并将该商家名下的联盟交易迁移到正确的目标用户 + 目标商家。
 *
 * 场景：某商家在 wj07 的联盟账号下加盟，但实际 Google Ads 广告系列归属 wj02，
 * 需要将 wj07 的该商家排除，佣金数据归入 wj02。
 *
 * Body:
 *   - user_merchant_id: number         (要排除的商家 DB ID，如 wj07 的 NASM ID)
 *   - redirect_user_id: number         (目标用户 ID，如 wj02 的 user_id)
 *   - redirect_user_merchant_id: number (目标用户商家 ID，如 wj02 的 NASM ID)
 *   - redirect_platform_connection_id?: number (目标用户的平台连接 ID，可选)
 *   - dry_run?: boolean                (true = 只预览，不写库)
 */
export const POST = withAdmin(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  const {
    user_merchant_id,
    redirect_user_id,
    redirect_user_merchant_id,
    redirect_platform_connection_id,
    dry_run = false,
  } = body;

  if (!user_merchant_id) return apiError("缺少 user_merchant_id", 400);
  if (!redirect_user_id) return apiError("缺少 redirect_user_id", 400);
  if (!redirect_user_merchant_id) return apiError("缺少 redirect_user_merchant_id", 400);

  const srcId = BigInt(user_merchant_id);
  const dstUserId = BigInt(redirect_user_id);
  const dstMerchantId = BigInt(redirect_user_merchant_id);
  const dstConnectionId = redirect_platform_connection_id ? BigInt(redirect_platform_connection_id) : null;

  // 1. 查询要排除的商家信息
  const srcMerchant = await prisma.user_merchants.findUnique({
    where: { id: srcId },
    select: { id: true, user_id: true, platform: true, merchant_id: true, merchant_name: true, status: true, is_deleted: true },
  });
  if (!srcMerchant) return apiError(`商家 ID=${user_merchant_id} 不存在`, 404);

  // 2. 查询目标商家信息（验证存在）
  const dstMerchant = await prisma.user_merchants.findUnique({
    where: { id: dstMerchantId },
    select: { id: true, user_id: true, platform: true, merchant_id: true, merchant_name: true },
  });
  if (!dstMerchant) return apiError(`目标商家 ID=${redirect_user_merchant_id} 不存在`, 404);
  if (dstMerchant.user_id !== dstUserId) {
    return apiError(`目标商家 ID=${redirect_user_merchant_id} 不属于目标用户 ID=${redirect_user_id}`, 400);
  }

  // 3. 查询受影响的交易
  const affectedTxns = await prisma.affiliate_transactions.findMany({
    where: { user_merchant_id: srcId, is_deleted: 0 },
    select: { id: true, transaction_id: true, commission_amount: true, status: true },
  });

  const preview = {
    src_merchant: {
      id: String(srcMerchant.id),
      user_id: String(srcMerchant.user_id),
      platform: srcMerchant.platform,
      merchant_id: srcMerchant.merchant_id,
      merchant_name: srcMerchant.merchant_name,
      current_status: srcMerchant.status,
      is_deleted: srcMerchant.is_deleted,
    },
    dst_merchant: {
      id: String(dstMerchant.id),
      user_id: String(dstMerchant.user_id),
      platform: dstMerchant.platform,
      merchant_id: dstMerchant.merchant_id,
      merchant_name: dstMerchant.merchant_name,
    },
    affected_transactions: affectedTxns.length,
    total_commission: affectedTxns.reduce((s, t) => s + Number(t.commission_amount), 0).toFixed(2),
    dry_run,
  };

  if (dry_run) {
    return apiSuccess(serializeData({ preview, message: "dry_run=true，未执行任何写库操作" }));
  }

  // ── 执行写库操作 ──

  // Step 1: 将源商家标记为 excluded（跨用户归属排除）
  await prisma.user_merchants.update({
    where: { id: srcId },
    data: { status: "excluded", is_deleted: 1 },
  });

  // Step 2: 迁移该商家名下的所有联盟交易到目标用户 + 目标商家
  const txnUpdateData: Record<string, unknown> = {
    user_id: dstUserId,
    user_merchant_id: dstMerchantId,
  };
  if (dstConnectionId) {
    txnUpdateData.platform_connection_id = dstConnectionId;
  }

  const txnResult = await prisma.affiliate_transactions.updateMany({
    where: { user_merchant_id: srcId, is_deleted: 0 },
    data: txnUpdateData,
  });

  // Step 3: 同步清理源用户 ads_daily_stats 中该商家的佣金字段（归零，待下次同步重算）
  // 找出源用户下关联该商家的 campaigns
  const srcCampaigns = await prisma.campaigns.findMany({
    where: { user_id: srcMerchant.user_id, user_merchant_id: srcId, is_deleted: 0 },
    select: { id: true },
  });
  if (srcCampaigns.length > 0) {
    const srcCampaignIds = srcCampaigns.map(c => c.id);
    await prisma.ads_daily_stats.updateMany({
      where: { campaign_id: { in: srcCampaignIds } },
      data: { commission: 0, rejected_commission: 0, orders: 0 },
    });
  }

  return apiSuccess(serializeData({
    preview,
    result: {
      merchant_excluded: true,
      transactions_migrated: txnResult.count,
      src_campaign_stats_cleared: srcCampaigns.length > 0 ? srcCampaigns.length : 0,
    },
    message: `操作完成：商家 ${srcMerchant.merchant_name}（ID=${user_merchant_id}）已标记为 excluded，${txnResult.count} 笔交易已迁移至用户 ID=${redirect_user_id}`,
  }));
});

/**
 * GET /api/admin/merchant-exclusion?user_id=XXX
 * 查看指定用户下所有被排除的商家
 */
export const GET = withAdmin(async (req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get("user_id");

  const where: Record<string, unknown> = { status: "excluded" };
  if (userId) where.user_id = BigInt(userId);

  const excluded = await prisma.user_merchants.findMany({
    where,
    select: {
      id: true,
      user_id: true,
      platform: true,
      merchant_id: true,
      merchant_name: true,
      status: true,
      is_deleted: true,
      created_at: true,
      updated_at: true,
    },
    orderBy: { updated_at: "desc" },
    take: 200,
  });

  return apiSuccess(serializeData(excluded));
});
