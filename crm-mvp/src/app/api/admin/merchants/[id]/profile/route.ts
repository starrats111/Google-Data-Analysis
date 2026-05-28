/**
 * D-046.A IntelliCenter — admin 端商家智能画像 API
 *
 * GET   /api/admin/merchants/{id}/profile     读取任意商家 AI 画像（admin 权限）
 * PATCH /api/admin/merchants/{id}/profile     更新画像字段（profile_source = "manual"）
 *
 * 鉴权：admin 角色可访问任意商家，区别于 user 端只能访问自己的。
 * R5=B admin 可改全部 12 字段。
 */
import { NextRequest, NextResponse } from "next/server";
import { withAdmin } from "@/lib/api-handler";
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

async function ensureExists(
  merchantId: bigint,
): Promise<
  | { ok: true; meta: { merchant_name: string; user_id: bigint } }
  | { ok: false; status: number; message: string }
> {
  const row = await prisma.user_merchants.findFirst({
    where: { id: merchantId, is_deleted: 0 },
    select: { id: true, merchant_name: true, user_id: true },
  });
  if (!row) {
    return { ok: false, status: 404, message: "商家不存在或已删除" };
  }
  return {
    ok: true,
    meta: { merchant_name: row.merchant_name, user_id: row.user_id },
  };
}

export const GET = withAdmin(async (_req: NextRequest, { params }) => {
  const merchantId = parseMerchantId(params?.id);
  if (!merchantId) {
    return NextResponse.json(
      { code: -1, message: "缺少 / 非法商家 id" },
      { status: 400 },
    );
  }
  const exist = await ensureExists(merchantId);
  if (!exist.ok) {
    return NextResponse.json(
      { code: -1, message: exist.message },
      { status: exist.status },
    );
  }
  const profile = await loadMerchantProfile(merchantId);
  return NextResponse.json({
    code: 0,
    data: {
      merchant_id: merchantId.toString(),
      merchant_name: exist.meta.merchant_name,
      user_id: exist.meta.user_id.toString(),
      ...profile,
      profile_updated_at: profile.profile_updated_at
        ? profile.profile_updated_at.toISOString()
        : null,
    },
  });
});

export const PATCH = withAdmin(async (req: NextRequest, { params }) => {
  const merchantId = parseMerchantId(params?.id);
  if (!merchantId) {
    return NextResponse.json(
      { code: -1, message: "缺少 / 非法商家 id" },
      { status: 400 },
    );
  }
  const exist = await ensureExists(merchantId);
  if (!exist.ok) {
    return NextResponse.json(
      { code: -1, message: exist.message },
      { status: exist.status },
    );
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

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
      merchant_id: merchantId.toString(),
      merchant_name: exist.meta.merchant_name,
      ...updated,
      profile_updated_at: updated.profile_updated_at
        ? updated.profile_updated_at.toISOString()
        : null,
    },
  });
});
