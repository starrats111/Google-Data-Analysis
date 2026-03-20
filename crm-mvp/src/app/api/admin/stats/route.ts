import { NextRequest } from "next/server";
import { getAdminFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { cachedQuery } from "@/lib/cache";

export async function GET(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  // 统计数据缓存 60 秒 — 减少 4 次 COUNT 查询
  const stats = await cachedQuery("admin:stats", async () => {
    const [users, providers, models, configs] = await Promise.all([
      prisma.users.count({ where: { is_deleted: 0, role: "user" } }),
      prisma.ai_providers.count({ where: { is_deleted: 0 } }),
      prisma.ai_model_configs.count({ where: { is_deleted: 0 } }),
      prisma.system_configs.count({ where: { is_deleted: 0 } }),
    ]);
    return { users, providers, models, configs };
  }, 60000);

  return apiSuccess(serializeData(stats));
}
