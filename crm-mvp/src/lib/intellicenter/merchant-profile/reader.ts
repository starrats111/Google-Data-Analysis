/**
 * D-046.A IntelliCenter 商家智能画像 — 读写器
 *
 * 提供从 user_merchants 表读取画像 + 写回画像 + 字段合并的工具函数。
 * 详见设计方案"五、AI IntelliCenter MVP 详细方案 §五.2"。
 */

import prisma from "@/lib/prisma";
import {
  type ComplianceRiskLevel,
  COMPLIANCE_RISK_LEVELS,
  DEFAULT_PROFILE,
  type IndustryCategory,
  INDUSTRY_CATEGORIES,
  type MerchantIntelligenceProfile,
  type MerchantProfileFormPayload,
  type ProfileSource,
  PROFILE_SOURCES,
  type TrademarkAuthStatus,
  TRADEMARK_AUTH_STATUSES,
} from "./types";

// ---------- 内部工具：把 DB raw 字段转成 typed profile ----------
function parseJson<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === "object") return value as T;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return null;
}

function ensureIndustryCategory(value: unknown): IndustryCategory | null {
  if (
    typeof value === "string" &&
    (INDUSTRY_CATEGORIES as readonly string[]).includes(value)
  ) {
    return value as IndustryCategory;
  }
  return null;
}

function ensureTrademarkAuthStatus(value: unknown): TrademarkAuthStatus {
  if (
    typeof value === "string" &&
    (TRADEMARK_AUTH_STATUSES as readonly string[]).includes(value)
  ) {
    return value as TrademarkAuthStatus;
  }
  return "unauthorized";
}

function ensureComplianceRiskLevel(value: unknown): ComplianceRiskLevel {
  if (
    typeof value === "string" &&
    (COMPLIANCE_RISK_LEVELS as readonly string[]).includes(value)
  ) {
    return value as ComplianceRiskLevel;
  }
  return "low";
}

function ensureProfileSource(value: unknown): ProfileSource {
  if (
    typeof value === "string" &&
    (PROFILE_SOURCES as readonly string[]).includes(value)
  ) {
    return value as ProfileSource;
  }
  return "none";
}

/**
 * 把 user_merchants 的一行 DB 记录映射为 MerchantIntelligenceProfile。
 * 入参兼容：完整 user_merchants 行 / 只含画像 14 字段的子集均可。
 */
export function rowToProfile(
  row: Record<string, unknown> | null | undefined,
): MerchantIntelligenceProfile {
  if (!row) {
    return { ...DEFAULT_PROFILE };
  }
  return {
    industry_category: ensureIndustryCategory(row.industry_category),
    industry_subcategory:
      typeof row.industry_subcategory === "string" &&
      row.industry_subcategory.length > 0
        ? row.industry_subcategory
        : null,
    business_profile: parseJson(row.business_profile),
    audience_persona: parseJson(row.audience_persona),
    brand_assets: parseJson(row.brand_assets),
    trademark_authorization_status: ensureTrademarkAuthStatus(
      row.trademark_authorization_status,
    ),
    compliance_risk_level: ensureComplianceRiskLevel(row.compliance_risk_level),
    requires_certification: parseJson(row.requires_certification),
    successful_template_ids: parseJson(row.successful_template_ids),
    failed_template_ids: parseJson(row.failed_template_ids),
    seasonal_pattern: parseJson(row.seasonal_pattern),
    competitor_brands: parseJson(row.competitor_brands),
    profile_updated_at:
      row.profile_updated_at instanceof Date
        ? row.profile_updated_at
        : row.profile_updated_at
          ? new Date(row.profile_updated_at as string)
          : null,
    profile_source: ensureProfileSource(row.profile_source),
  };
}

/**
 * 按 merchantId 读取画像。merchant 不存在或 is_deleted 都返回 DEFAULT_PROFILE。
 */
export async function loadMerchantProfile(
  merchantId: bigint,
): Promise<MerchantIntelligenceProfile> {
  const row = await prisma.user_merchants.findFirst({
    where: { id: merchantId, is_deleted: 0 },
    select: {
      industry_category: true,
      industry_subcategory: true,
      business_profile: true,
      audience_persona: true,
      brand_assets: true,
      trademark_authorization_status: true,
      compliance_risk_level: true,
      requires_certification: true,
      successful_template_ids: true,
      failed_template_ids: true,
      seasonal_pattern: true,
      competitor_brands: true,
      profile_updated_at: true,
      profile_source: true,
    },
  });
  return rowToProfile(row as Record<string, unknown> | null);
}

/**
 * 批量加载画像（generate-extensions/preflight 用）。
 * 不存在的 ID 返回 DEFAULT_PROFILE。
 */
export async function loadMerchantProfilesBatch(
  merchantIds: bigint[],
): Promise<Map<string, MerchantIntelligenceProfile>> {
  const result = new Map<string, MerchantIntelligenceProfile>();
  if (merchantIds.length === 0) return result;
  const rows = await prisma.user_merchants.findMany({
    where: { id: { in: merchantIds }, is_deleted: 0 },
    select: {
      id: true,
      industry_category: true,
      industry_subcategory: true,
      business_profile: true,
      audience_persona: true,
      brand_assets: true,
      trademark_authorization_status: true,
      compliance_risk_level: true,
      requires_certification: true,
      successful_template_ids: true,
      failed_template_ids: true,
      seasonal_pattern: true,
      competitor_brands: true,
      profile_updated_at: true,
      profile_source: true,
    },
  });
  for (const r of rows) {
    result.set(String(r.id), rowToProfile(r as Record<string, unknown>));
  }
  for (const id of merchantIds) {
    if (!result.has(String(id))) {
      result.set(String(id), { ...DEFAULT_PROFILE });
    }
  }
  return result;
}

/**
 * 写回画像（admin/user UI 手动保存路径用）。
 * source 默认 'manual'，AI backfill 路径请显式传 'ai_backfill'。
 *
 * 只更新 payload 中存在 (key !== undefined) 的字段，避免误清空既有数据。
 */
export async function saveMerchantProfile(opts: {
  merchantId: bigint;
  payload: MerchantProfileFormPayload;
  source: ProfileSource;
}): Promise<MerchantIntelligenceProfile> {
  const { merchantId, payload, source } = opts;
  const data: Record<string, unknown> = {
    profile_source: ensureProfileSource(source),
    profile_updated_at: new Date(),
  };

  if ("industry_category" in payload) {
    data.industry_category = payload.industry_category ?? null;
  }
  if ("industry_subcategory" in payload) {
    data.industry_subcategory = payload.industry_subcategory ?? null;
  }
  if ("business_profile" in payload) {
    data.business_profile = (payload.business_profile ?? null) as never;
  }
  if ("audience_persona" in payload) {
    data.audience_persona = (payload.audience_persona ?? null) as never;
  }
  if ("brand_assets" in payload) {
    data.brand_assets = (payload.brand_assets ?? null) as never;
  }
  if ("trademark_authorization_status" in payload) {
    data.trademark_authorization_status = ensureTrademarkAuthStatus(
      payload.trademark_authorization_status,
    );
  }
  if ("compliance_risk_level" in payload) {
    data.compliance_risk_level = ensureComplianceRiskLevel(
      payload.compliance_risk_level,
    );
  }
  if ("requires_certification" in payload) {
    data.requires_certification = (payload.requires_certification ??
      null) as never;
  }
  if ("seasonal_pattern" in payload) {
    data.seasonal_pattern = (payload.seasonal_pattern ?? null) as never;
  }
  if ("competitor_brands" in payload) {
    data.competitor_brands = (payload.competitor_brands ?? null) as never;
  }

  await prisma.user_merchants.update({
    where: { id: merchantId },
    data: data as never,
  });
  return loadMerchantProfile(merchantId);
}
