import { NextRequest } from "next/server";
import { apiError } from "@/lib/constants";

/**
 * POST /api/user/articles/sync
 * [已废弃] 数据分析平台文章同步功能已停用，文章功能已完全迁移至 CRM 独立管理。
 */
export async function POST(_req: NextRequest) {
  return apiError(
    "文章同步功能已停用。数据分析平台已下线，请直接在 CRM 中创建和管理文章。",
    410,
  );
}
