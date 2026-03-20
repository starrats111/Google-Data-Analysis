import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * GET — 用户端只读查询违规商家 / 推荐商家列表
 * 数据由管理员通过 /api/admin/merchant-sheet 同步
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") || "violation";
  const search = searchParams.get("search") || "";
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("pageSize") || "50");

  if (type === "violation") {
    const where: Record<string, unknown> = { is_deleted: 0 };
    if (search) where.merchant_name = { contains: search };
    const [total, items] = await Promise.all([
      prisma.merchant_violations.count({ where: where as never }),
      prisma.merchant_violations.findMany({
        where: where as never, orderBy: { created_at: "desc" },
        skip: (page - 1) * pageSize, take: pageSize,
      }),
    ]);
    return apiSuccess(serializeData({ total, items, page, pageSize }));
  } else {
    const where: Record<string, unknown> = { is_deleted: 0 };
    if (search) where.merchant_name = { contains: search };
    const [total, items] = await Promise.all([
      prisma.merchant_recommendations.count({ where: where as never }),
      prisma.merchant_recommendations.findMany({
        where: where as never, orderBy: { created_at: "desc" },
        skip: (page - 1) * pageSize, take: pageSize,
      }),
    ]);
    return apiSuccess(serializeData({ total, items, page, pageSize }));
  }
}
