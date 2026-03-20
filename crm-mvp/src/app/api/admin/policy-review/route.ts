import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { batchReviewMerchants, clearPolicyCategoryCache } from "@/lib/policy-review";

/**
 * POST /api/admin/policy-review
 * 全量审核所有商家的政策合规性
 * 管理员手动触发，更新所有商家的 policy_status 和 policy_category_code
 */
export const POST = withAdmin(async (req: NextRequest) => {
  // 清除缓存，确保使用最新的政策类别
  clearPolicyCategoryCache();

  // 查询所有未删除的商家
  const allMerchants = await prisma.user_merchants.findMany({
    where: { is_deleted: 0 },
    select: {
      id: true,
      merchant_name: true,
      merchant_url: true,
      category: true,
      platform: true,
      policy_status: true,
      policy_category_code: true,
    },
  });

  if (allMerchants.length === 0) {
    return apiSuccess({ reviewed: 0, restricted: 0, prohibited: 0, clean: 0 }, "没有商家需要审核");
  }

  // 批量审核
  const stats = await batchReviewMerchants(prisma, allMerchants);

  return apiSuccess(serializeData({
    ...stats,
    clean: stats.reviewed - stats.restricted - stats.prohibited,
    total: allMerchants.length,
  }), `审核完成：共 ${allMerchants.length} 个商家，限制 ${stats.restricted}，禁止 ${stats.prohibited}，无限制 ${stats.reviewed - stats.restricted - stats.prohibited}`);
});
