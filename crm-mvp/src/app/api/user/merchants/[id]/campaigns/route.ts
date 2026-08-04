import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * GET /api/user/merchants/:id/campaigns
 * 商家行展开子表数据源：该商家名下的全部广告系列（不分页）。
 * 只返回子表需要的极简字段 + 拒登次数，用于「重发此条 / 拒登」两个操作。
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id } = await params;
  if (!id || !/^\d+$/.test(id)) return apiError("缺少商家 ID");

  const merchantId = BigInt(id);
  const merchant = await prisma.user_merchants.findFirst({
    where: { id: merchantId, user_id: BigInt(user.userId) },
    select: { id: true },
  });
  if (!merchant) return apiError("商家不存在或无权限", 404);

  const campaigns = await prisma.campaigns.findMany({
    where: { user_merchant_id: merchantId, user_id: BigInt(user.userId), is_deleted: 0 },
    select: {
      id: true,
      campaign_name: true,
      customer_id: true,
      google_campaign_id: true,
      google_status: true,
      target_country: true,
      created_at: true,
    },
    orderBy: { created_at: "desc" },
  });

  const rejectionCounts = campaigns.length
    ? await prisma.ad_rejection_feedback.groupBy({
        by: ["campaign_id"],
        where: { campaign_id: { in: campaigns.map((c) => c.id) }, is_deleted: 0 },
        _count: { _all: true },
      })
    : [];
  const rejectionMap = new Map<string, number>();
  for (const r of rejectionCounts) {
    if (r.campaign_id != null) rejectionMap.set(r.campaign_id.toString(), r._count._all);
  }

  return apiSuccess(serializeData({
    campaigns: campaigns.map((c) => ({
      id: c.id,
      campaign_name: c.campaign_name,
      customer_id: c.customer_id,
      google_campaign_id: c.google_campaign_id,
      status: c.google_status,
      target_country: c.target_country,
      rejection_count: rejectionMap.get(c.id.toString()) || 0,
    })),
  }));
}
