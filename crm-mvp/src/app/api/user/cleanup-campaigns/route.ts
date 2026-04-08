import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * POST /api/admin/cleanup-campaigns
 * 清理指定用户的非 ENABLED 广告系列，并释放仅关联到被删除广告的商家
 *
 * Body: { username: string, dry_run?: boolean }
 *   dry_run=true 时仅预览不执行
 */
export async function POST(req: NextRequest) {
  const caller = getUserFromRequest(req);
  if (!caller) return apiError("未授权", 401);

  const { username, dry_run = false } = await req.json();
  if (!username) return apiError("缺少 username");

  const user = await prisma.users.findFirst({
    where: { username, is_deleted: 0 },
    select: { id: true, username: true },
  });
  if (!user) return apiError("用户不存在");

  const userId = user.id;

  // 1. 查询所有广告系列
  const allCampaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, is_deleted: 0, google_campaign_id: { not: null } },
    select: {
      id: true, campaign_name: true, google_status: true,
      user_merchant_id: true, google_campaign_id: true,
    },
  });

  const toKeep = allCampaigns.filter((c) => c.google_status === "ENABLED");
  const toDelete = allCampaigns.filter((c) => c.google_status !== "ENABLED");

  // 2. 找出需要释放的商家：
  //    只关联到被删除广告的商家 → 释放为 available
  //    同时关联到保留广告的商家 → 不释放
  const keepMerchantIds = new Set(
    toKeep.filter((c) => c.user_merchant_id && c.user_merchant_id !== BigInt(0))
      .map((c) => String(c.user_merchant_id))
  );

  const deleteMerchantIds = new Set<string>();
  for (const c of toDelete) {
    if (c.user_merchant_id && c.user_merchant_id !== BigInt(0)) {
      const mid = String(c.user_merchant_id);
      if (!keepMerchantIds.has(mid)) {
        deleteMerchantIds.add(mid);
      }
    }
  }

  // 查询要释放的商家详情
  const merchantsToRelease = deleteMerchantIds.size > 0
    ? await prisma.user_merchants.findMany({
        where: {
          id: { in: [...deleteMerchantIds].map(BigInt) },
          user_id: userId,
          is_deleted: 0,
          status: { in: ["claimed", "paused"] },
        },
        select: { id: true, platform: true, merchant_id: true, merchant_name: true, status: true },
      })
    : [];

  if (dry_run) {
    return apiSuccess(serializeData({
      dry_run: true,
      username: user.username,
      keep_count: toKeep.length,
      delete_count: toDelete.length,
      release_merchant_count: merchantsToRelease.length,
      campaigns_to_delete: toDelete.map((c) => ({
        id: c.id, name: c.campaign_name, status: c.google_status,
      })),
      merchants_to_release: merchantsToRelease.map((m) => ({
        id: m.id, platform: m.platform, mid: m.merchant_id,
        name: m.merchant_name, current_status: m.status,
      })),
      campaigns_to_keep: toKeep.map((c) => ({
        id: c.id, name: c.campaign_name, status: c.google_status,
      })),
    }));
  }

  // 3. 执行删除
  const deleteIds = toDelete.map((c) => c.id);
  if (deleteIds.length > 0) {
    await prisma.campaigns.updateMany({
      where: { id: { in: deleteIds } },
      data: { is_deleted: 1 },
    });
  }

  // 4. 释放商家
  const releaseIds = merchantsToRelease.map((m) => m.id);
  if (releaseIds.length > 0) {
    await prisma.user_merchants.updateMany({
      where: { id: { in: releaseIds } },
      data: { status: "available", claimed_at: null },
    });
  }

  return apiSuccess(serializeData({
    dry_run: false,
    username: user.username,
    deleted_campaigns: deleteIds.length,
    released_merchants: releaseIds.length,
    kept_campaigns: toKeep.length,
    details: {
      deleted: toDelete.map((c) => ({ name: c.campaign_name, status: c.google_status })),
      released: merchantsToRelease.map((m) => ({ platform: m.platform, mid: m.merchant_id, name: m.merchant_name })),
      kept: toKeep.map((c) => ({ name: c.campaign_name })),
    },
  }));
}
