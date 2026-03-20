import { NextRequest } from "next/server";
import { getAdminFromRequest, getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const preferRole = req.nextUrl.searchParams.get("role");

  // 如果明确指定 role=user，优先检查 user token（解决同时存在 admin/user cookie 时显示错误身份）
  if (preferRole === "user") {
    const userPayload = getUserFromRequest(req);
    if (userPayload) {
      const user = await prisma.users.findFirst({
        where: { id: BigInt(userPayload.userId), is_deleted: 0, role: { in: ["user", "leader"] } },
        select: { id: true, username: true, role: true, status: true, team_id: true, display_name: true },
      });
      if (user && user.status === "active") return apiSuccess(serializeData(user));
    }
  }

  // 先尝试管理员 token
  const admin = getAdminFromRequest(req);
  if (admin) {
    const user = await prisma.users.findFirst({
      where: { id: BigInt(admin.userId), is_deleted: 0, role: "admin" },
      select: { id: true, username: true, role: true, status: true },
    });
    if (!user || user.status !== "active") return apiError("未登录", 401);
    return apiSuccess(serializeData(user));
  }

  // 再尝试用户 token（user 或 leader）
  const userPayload = getUserFromRequest(req);
  if (userPayload) {
    const user = await prisma.users.findFirst({
      where: { id: BigInt(userPayload.userId), is_deleted: 0, role: { in: ["user", "leader"] } },
      select: { id: true, username: true, role: true, status: true, team_id: true, display_name: true },
    });
    if (!user || user.status !== "active") return apiError("未登录", 401);
    return apiSuccess(serializeData(user));
  }

  return apiError("未登录", 401);
}
