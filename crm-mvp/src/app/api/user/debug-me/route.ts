import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/** 临时调试接口：查看当前 JWT 的 userId 以及对应的 campaigns */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const campaigns = await prisma.campaigns.findMany({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
    select: { id: true, campaign_name: true },
    orderBy: { id: "desc" },
    take: 10,
  });

  return apiSuccess({
    jwt_userId: user.userId,
    jwt_username: user.username,
    campaigns: campaigns.map(c => ({ id: String(c.id), name: c.campaign_name })),
  });
}
