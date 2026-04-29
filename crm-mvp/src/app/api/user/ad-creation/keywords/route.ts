import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

interface KeywordInput {
  text: string;
  matchType?: string;
  avgMonthlySearches?: number | null;
  suggestedBid?: number | null;
  competition?: string | null;
  source?: string | null;
}

/**
 * PUT /api/user/ad-creation/keywords
 * 替换某 campaign 下的全部关键词（删旧插新，带 source 字段）
 * Body: { campaign_id: number, keywords: KeywordInput[] }
 */
export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  let campaignId: bigint;
  let keywords: KeywordInput[];
  try {
    const body = await req.json();
    campaignId = BigInt(body.campaign_id);
    keywords = Array.isArray(body.keywords) ? body.keywords : [];
  } catch {
    return apiError("请求参数错误");
  }

  // 验证 campaign 归属
  const campaign = await prisma.campaigns.findFirst({
    where: { id: campaignId, user_id: BigInt(user.userId), is_deleted: 0 },
    select: { id: true },
  });
  if (!campaign) return apiError("广告系列不存在", 404);

  // 查找 ad_group
  const adGroup = await prisma.ad_groups.findFirst({
    where: { campaign_id: campaign.id, is_deleted: 0 },
    select: { id: true },
  });
  if (!adGroup) return apiError("广告组不存在", 404);

  // 过滤空词
  const validKeywords = keywords.filter((kw) => kw.text && kw.text.trim().length > 0);

  // 删旧插新（事务）
  await prisma.$transaction([
    prisma.keywords.deleteMany({
      where: { ad_group_id: adGroup.id },
    }),
    prisma.keywords.createMany({
      data: validKeywords.map((kw) => ({
        ad_group_id: adGroup.id,
        keyword_text: kw.text.trim(),
        match_type: (kw.matchType || "PHRASE").toUpperCase(),
        avg_monthly_searches: kw.avgMonthlySearches ?? null,
        suggested_bid: kw.suggestedBid ?? null,
        competition: kw.competition ?? null,
        source: kw.source ?? null,
      })),
      skipDuplicates: true,
    }),
  ]);

  return apiSuccess({ saved: validKeywords.length });
}
