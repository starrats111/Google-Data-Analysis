import { NextRequest } from "next/server";
import { getAdminFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";

/**
 * GET /api/admin/token-pool
 * Developer Token 池运行状态诊断：池大小、可用数、各 token（脱敏）冷却情况。
 * 池来源 = 所有活跃 MCC 的去重 developer_token + 环境变量 GOOGLE_ADS_TOKEN_POOL。
 */
export async function GET(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const { getTokenPoolStatus } = await import("@/lib/google-ads/token-pool");
  const status = await getTokenPoolStatus();
  return apiSuccess(status);
}
