import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

// 获取广告默认设置
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  let settings = await prisma.ad_default_settings.findFirst({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
  });

  if (!settings) {
    settings = await prisma.ad_default_settings.create({
      data: { user_id: BigInt(user.userId) },
    });
  }

  return apiSuccess(serializeData(settings));
}

// 更新广告默认设置
export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json();
  const { bidding_strategy, ecpc_enabled, max_cpc, daily_budget, network_search, network_partners, network_display, naming_rule, naming_prefix, eu_political_ad } = body;

  const data: Record<string, unknown> = {};
  if (bidding_strategy !== undefined) data.bidding_strategy = bidding_strategy;
  if (ecpc_enabled !== undefined) data.ecpc_enabled = ecpc_enabled;
  if (max_cpc !== undefined) data.max_cpc = max_cpc;
  if (daily_budget !== undefined) data.daily_budget = daily_budget;
  if (network_search !== undefined) data.network_search = network_search;
  if (network_partners !== undefined) data.network_partners = network_partners;
  if (network_display !== undefined) data.network_display = network_display;
  if (naming_rule !== undefined) data.naming_rule = naming_rule;
  if (naming_prefix !== undefined) data.naming_prefix = naming_prefix;
  if (eu_political_ad !== undefined) data.eu_political_ad = eu_political_ad;

  const existing = await prisma.ad_default_settings.findFirst({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
  });

  if (existing) {
    await prisma.ad_default_settings.update({ where: { id: existing.id }, data });
  } else {
    await prisma.ad_default_settings.create({
      data: { user_id: BigInt(user.userId), ...data },
    });
  }

  return apiSuccess(null, "保存成功");
}
