import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import { queryAccountStatus, resolveScopeUserIds } from "@/lib/account-status-query";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/account-status
 * D-277：账户状态总览——成员看自己名下 MCC 的账户，组长看全组。
 * 纯读库（状态由统一脚本 Sheet 回传维护），零外部请求。
 */
export const GET = withUser(async (_req: NextRequest, { user }) => {
  const scope = await resolveScopeUserIds(user);
  const rows = await queryAccountStatus(scope);
  return apiSuccess(rows);
});
