import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import { queryAccountStatus } from "@/lib/account-status-query";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/account-status
 * D-277：账户状态总览（管理员看全部 MCC 的账户）。
 */
export const GET = withAdmin(async (_req: NextRequest) => {
  const rows = await queryAccountStatus(null);
  return apiSuccess(rows);
});
