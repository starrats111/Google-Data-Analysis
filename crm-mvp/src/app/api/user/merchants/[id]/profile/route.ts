/**
 * D-046.A IntelliCenter — user 端商家智能画像 API
 *
 * GET   /api/user/merchants/{id}/profile     读取当前用户名下指定商家的 AI 画像
 * PATCH /api/user/merchants/{id}/profile     更新画像字段（profile_source = "manual"）
 *
 * 鉴权：仅返回 user_merchants.user_id == current user 的记录。
 * R5=B 用户可改全部 12 字段。
 */
import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import {
  isComplianceRiskLevel,
  isIndustryCategory,
  isTrademarkAuthStatus,
  loadMerchantProfile,
  saveMerchantProfile,
  type MerchantProfileFormPayload,
} from "@/lib/intellicenter/merchant-profile";

function parseMerchantId(idStr: string | undefined): bigint | null {
  if (!idStr || !/^\d+$/.test(idStr)) return null;
  try {
    return BigInt(idStr);
  } catch {
    return null;
  }
}

async function ensureOwnership(
  merchantId: bigint,
  userId: bigint,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const row = await prisma.user_merchants.findFirst({
    where: { id: merchantId, is_deleted: 0 },
    select: { user_id: true },
  });
  if (!row) {
    return { ok: false, status: 404, message: "商家不存在或已删除" };
  }
  if (row.user_id !== userId) {
    return { ok: false, status: 403, message: "无权访问该商家" };
  }
  return { ok: true };
}

export const GET = withUser(async (_req: NextRequest, { user, params }) => {
  const merchantId = parseMerchantId(params?.id);
  if (!merchantId) {
    return NextResponse.json(
      { code: -1, message: "缺少 / 非法商家 id" },
      { status: 400 },
    );
  }
  const userId = BigInt(user.userId);
  const own = await ensureOwnership(merchantId, userId);
  if (!own.ok) {
    return NextResponse.json(
      { code: -1, message: own.message },
      { status: own.status },
    );
  }
  const profile = await loadMerchantProfile(merchantId);
  return NextResponse.json({
    code: 0,
    data: {
      ...profile,
      profile_updated_at: profile.profile_updated_at
        ? profile.profile_updated_at.toISOString()
        : null,
    },
  });
});

export const PATCH = withUser(async (req: NextRequest, { user, params }) => {
  const merchantId = parseMerchantId(params?.id);
  if (!merchantId) {
    return NextResponse.json(
      { code: -1, message: "缺少 / 非法商家 id" },
      { status: 400 },
    );
  }
  const userId = BigInt(user.userId);
  const own = await ensureOwnership(merchantId, userId);
  if (!own.ok) {
    return NextResponse.json(
      { code: -1, message: own.message },
      { status: own.status },
    );
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  // 校验字段合法性
  if (
    body.industry_category != null &&
    !isIndustryCategory(body.industry_category)
  ) {
    return NextResponse.json(
      { code: -1, message: "industry_category 非法枚举值" },
      { status: 400 },
    );
  }
  if (
    body.trademark_authorization_status != null &&
    !isTrademarkAuthStatus(body.trademark_authorization_status)
  ) {
    return NextResponse.json(
      { code: -1, message: "trademark_authorization_status 非法枚举值" },
      { status: 400 },
    );
  }
  if (
    body.compliance_risk_level != null &&
    !isComplianceRiskLevel(body.compliance_risk_level)
  ) {
    return NextResponse.json(
      { code: -1, message: "compliance_risk_level 非法枚举值" },
      { status: 400 },
    );
  }

  const payload: MerchantProfileFormPayload = {};
  const ALLOWED_KEYS: (keyof MerchantProfileFormPayload)[] = [
    "industry_category",
    "industry_subcategory",
    "business_profile",
    "audience_persona",
    "brand_assets",
    "trademark_authorization_status",
    "compliance_risk_level",
    "requires_certification",
    "seasonal_pattern",
    "competitor_brands",
  ];
  for (const k of ALLOWED_KEYS) {
    if (k in body) {
      (payload as Record<string, unknown>)[k] = body[k];
    }
  }
  if (Object.keys(payload).length === 0) {
    return NextResponse.json(
      { code: -1, message: "无可更新字段" },
      { status: 400 },
    );
  }

  const updated = await saveMerchantProfile({
    merchantId,
    payload,
    source: "manual",
  });
  return NextResponse.json({
    code: 0,
    data: {
      ...updated,
      profile_updated_at: updated.profile_updated_at
        ? updated.profile_updated_at.toISOString()
        : null,
    },
  });
});
