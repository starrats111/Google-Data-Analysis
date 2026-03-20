import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { clearPolicyCategoryCache } from "@/lib/policy-review";

/**
 * GET /api/admin/policy-categories
 * 获取所有政策限制类别
 */
export const GET = withAdmin(async (req: NextRequest) => {
  const categories = await prisma.ad_policy_categories.findMany({
    where: { is_deleted: 0 },
    orderBy: { sort_order: "asc" },
  });

  return apiSuccess(serializeData(categories));
});

/**
 * POST /api/admin/policy-categories
 * 新增政策限制类别
 */
export const POST = withAdmin(async (req: NextRequest) => {
  const body = await req.json();
  const {
    category_code, category_name, category_name_en, restriction_level,
    description, allowed_regions, blocked_regions, age_targeting,
    requires_cert, ad_copy_rules, landing_page_rules,
    match_keywords, match_domains, sort_order,
  } = body;

  if (!category_code || !category_name || !restriction_level) {
    return apiError("缺少必填字段: category_code, category_name, restriction_level");
  }

  // 检查 code 唯一性
  const existing = await prisma.ad_policy_categories.findFirst({
    where: { category_code, is_deleted: 0 },
  });
  if (existing) return apiError(`类别代码 ${category_code} 已存在`);

  const created = await prisma.ad_policy_categories.create({
    data: {
      category_code,
      category_name,
      category_name_en: category_name_en || category_code,
      restriction_level,
      description: description || null,
      allowed_regions: allowed_regions || null,
      blocked_regions: blocked_regions || null,
      age_targeting: age_targeting || null,
      requires_cert: requires_cert ? 1 : 0,
      ad_copy_rules: ad_copy_rules || null,
      landing_page_rules: landing_page_rules || null,
      match_keywords: match_keywords || null,
      match_domains: match_domains || null,
      sort_order: sort_order || 0,
    },
  });

  clearPolicyCategoryCache();
  return apiSuccess(serializeData(created), "创建成功");
});

/**
 * PUT /api/admin/policy-categories
 * 更新政策限制类别
 */
export const PUT = withAdmin(async (req: NextRequest) => {
  const body = await req.json();
  const { id, ...updateData } = body;

  if (!id) return apiError("缺少 id");

  const record = await prisma.ad_policy_categories.findFirst({
    where: { id: BigInt(id), is_deleted: 0 },
  });
  if (!record) return apiError("记录不存在");

  // 构建更新数据（只更新传入的字段）
  const data: Record<string, any> = {};
  const allowedFields = [
    "category_name", "category_name_en", "restriction_level", "description",
    "allowed_regions", "blocked_regions", "age_targeting", "requires_cert",
    "ad_copy_rules", "landing_page_rules", "match_keywords", "match_domains", "sort_order",
  ];

  for (const field of allowedFields) {
    if (updateData[field] !== undefined) {
      if (field === "requires_cert") {
        data[field] = updateData[field] ? 1 : 0;
      } else {
        data[field] = updateData[field];
      }
    }
  }

  const updated = await prisma.ad_policy_categories.update({
    where: { id: BigInt(id) },
    data,
  });

  clearPolicyCategoryCache();
  return apiSuccess(serializeData(updated), "更新成功");
});

/**
 * DELETE /api/admin/policy-categories
 * 软删除政策限制类别
 */
export const DELETE = withAdmin(async (req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return apiError("缺少 id");

  await prisma.ad_policy_categories.update({
    where: { id: BigInt(id) },
    data: { is_deleted: 1 },
  });

  clearPolicyCategoryCache();
  return apiSuccess(null, "删除成功");
});
