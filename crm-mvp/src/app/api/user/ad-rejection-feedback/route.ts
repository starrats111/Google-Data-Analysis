import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { POLICY_CATEGORY_MAP } from "@/lib/policy-hub/policy-categories";
import { policyLabelFor } from "@/lib/intellicenter/ad-creation/rejection-feedback";
import { detectIndustryProfile } from "@/lib/industry-profile";

/**
 * D-050 广告拒登反馈（事后学习负样本，员工手动录入，零 API）
 *
 * GET  /api/user/ad-rejection-feedback        → 当前用户的拒登记录（数据中心展示备注标记 + 列表）
 * POST /api/user/ad-rejection-feedback        → 录入一条拒登记录（自动抓被拒文案快照 + 行业识别）
 *
 * 复用范围：同商家=强约束、同行业=软提示（见 rejection-feedback.ts 的生成期加载逻辑）。
 */

const REASON_MAX = 1000;

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);
  const userId = BigInt(user.userId);

  try {
    const rows = await prisma.ad_rejection_feedback.findMany({
      where: { user_id: userId, is_deleted: 0 },
      orderBy: { created_at: "desc" },
      take: 500,
      select: {
        id: true,
        campaign_id: true,
        google_campaign_id: true,
        campaign_name: true,
        policy_category: true,
        reason_text: true,
        created_at: true,
      },
    });

    const list = rows.map((r) => ({
      id: r.id,
      campaign_id: r.campaign_id,
      google_campaign_id: r.google_campaign_id,
      campaign_name: r.campaign_name,
      policy_category: r.policy_category,
      policy_label: policyLabelFor(r.policy_category),
      reason_text: r.reason_text,
      created_at: r.created_at,
    }));

    return apiSuccess(serializeData(list));
  } catch (e) {
    console.error(`[ad-rejection-feedback] GET failed: ${e instanceof Error ? e.message : e}`);
    return apiError("查询拒登记录失败", 500);
  }
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);
  const userId = BigInt(user.userId);

  let body: {
    campaign_id?: string | number;
    policy_category?: string;
    reason_text?: string;
  };
  try {
    body = await req.json();
  } catch {
    return apiError("请求体解析失败", 400);
  }

  const policyCategory = (body.policy_category || "").trim();
  const reasonText = (body.reason_text || "").trim();
  if (!body.campaign_id) return apiError("缺少 campaign_id", 400);
  if (!policyCategory) return apiError("请选择政策类别", 400);
  if (!reasonText) return apiError("请填写拒登原因", 400);
  if (!POLICY_CATEGORY_MAP[policyCategory]) {
    return apiError("政策类别无效", 400);
  }

  let campaignId: bigint;
  try {
    campaignId = BigInt(body.campaign_id);
  } catch {
    return apiError("campaign_id 无效", 400);
  }

  try {
    // 1. 校验广告系列归属
    const campaign = await prisma.campaigns.findFirst({
      where: { id: campaignId, user_id: userId, is_deleted: 0 },
      select: {
        id: true,
        user_merchant_id: true,
        google_campaign_id: true,
        campaign_name: true,
      },
    });
    if (!campaign) return apiError("广告系列不存在或无权操作", 404);

    // 2. 商家信息（行业识别 + 名称/URL 记录）
    const merchant = await prisma.user_merchants.findFirst({
      where: { id: campaign.user_merchant_id, is_deleted: 0 },
      select: { id: true, merchant_name: true, merchant_url: true, category: true },
    });

    // 3. 自动抓被拒文案快照（campaign → ad_groups → ad_creatives 最新一条）
    let rejectedHeadlines: unknown = null;
    let rejectedDescriptions: unknown = null;
    let pageTextForIndustry: string | undefined;
    const adGroups = await prisma.ad_groups.findMany({
      where: { campaign_id: campaignId, is_deleted: 0 },
      select: { id: true },
    });
    if (adGroups.length > 0) {
      const creative = await prisma.ad_creatives.findFirst({
        where: { ad_group_id: { in: adGroups.map((g) => g.id) }, is_deleted: 0 },
        orderBy: { created_at: "desc" },
        select: { headlines: true, descriptions: true, crawl_cache: true },
      });
      if (creative) {
        rejectedHeadlines = creative.headlines ?? null;
        rejectedDescriptions = creative.descriptions ?? null;
        const cc = creative.crawl_cache as { pageText?: string } | null;
        if (cc && typeof cc.pageText === "string") pageTextForIndustry = cc.pageText;
      }
    }

    // 4. 行业识别（确定性，与生成期同一函数，保证"同行业"键一致）
    const industry = detectIndustryProfile({
      merchantName: merchant?.merchant_name ?? campaign.campaign_name ?? "",
      category: merchant?.category ?? null,
      pageText: pageTextForIndustry,
    });

    // 5. 入库
    const created = await prisma.ad_rejection_feedback.create({
      data: {
        user_id: userId,
        campaign_id: campaign.id,
        google_campaign_id: campaign.google_campaign_id ?? null,
        campaign_name: campaign.campaign_name ?? null,
        user_merchant_id: campaign.user_merchant_id,
        merchant_name: merchant?.merchant_name ?? null,
        merchant_url: merchant?.merchant_url ?? null,
        industry_category: industry?.id ?? null,
        policy_category: policyCategory,
        reason_text: reasonText.slice(0, REASON_MAX),
        rejected_headlines: rejectedHeadlines as never,
        rejected_descriptions: rejectedDescriptions as never,
        created_by: userId,
      },
      select: { id: true },
    });

    return apiSuccess(serializeData({ id: created.id, industry_category: industry?.id ?? null }));
  } catch (e) {
    console.error(`[ad-rejection-feedback] POST failed: ${e instanceof Error ? e.message : e}`);
    return apiError("保存拒登记录失败", 500);
  }
}
