import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

// 获取广告系列列表
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const merchant_id = searchParams.get("merchant_id") || "";

  const where: Record<string, unknown> = {
    user_id: BigInt(user.userId),
    is_deleted: 0,
  };
  if (merchant_id) where.user_merchant_id = BigInt(merchant_id);

  const campaigns = await prisma.campaigns.findMany({
    where: where as never,
    orderBy: { created_at: "desc" },
  });

  return apiSuccess(serializeData(campaigns));
}

// 更新广告系列
export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id, daily_budget, bidding_strategy, max_cpc_limit, status, network_search, network_partners, network_display } = await req.json();
  if (!id) return apiError("缺少 ID");

  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(id), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!campaign) return apiError("广告系列不存在");

  const data: Record<string, unknown> = {};
  if (daily_budget !== undefined) data.daily_budget = daily_budget;
  if (bidding_strategy !== undefined) data.bidding_strategy = bidding_strategy;
  if (max_cpc_limit !== undefined) data.max_cpc_limit = max_cpc_limit;
  if (status !== undefined) data.status = status;
  if (network_search !== undefined) data.network_search = network_search;
  if (network_partners !== undefined) data.network_partners = network_partners;
  if (network_display !== undefined) data.network_display = network_display;

  await prisma.campaigns.update({ where: { id: BigInt(id) }, data });
  return apiSuccess(null, "更新成功");
}
