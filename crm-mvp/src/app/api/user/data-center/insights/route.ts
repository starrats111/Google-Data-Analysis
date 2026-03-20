import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

// 获取 AI 洞察列表
export const GET = withUser(async (req: NextRequest, { user }) => {
  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") || "daily"; // daily / weekly / monthly
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = Math.min(parseInt(searchParams.get("pageSize") || "10"), 50);

  const where = {
    user_id: BigInt(user.userId),
    insight_type: type,
    is_deleted: 0,
  };

  const [total, insights] = await Promise.all([
    prisma.ai_insights.count({ where }),
    prisma.ai_insights.findMany({
      where,
      orderBy: { insight_date: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return apiSuccess(serializeData({ list: insights, total, page, pageSize }));
});
