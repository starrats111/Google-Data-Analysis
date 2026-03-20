import { NextRequest } from "next/server";
import { clearLoginCookie, getAdminFromRequest, getUserFromRequest } from "@/lib/auth";
import { apiSuccess } from "@/lib/constants";

export async function POST(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (admin) {
    await clearLoginCookie("admin");
    return apiSuccess(null, "已退出");
  }

  const user = getUserFromRequest(req);
  if (user) {
    await clearLoginCookie("user");
    return apiSuccess(null, "已退出");
  }

  return apiSuccess(null, "已退出");
}
