import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import prisma from "@/lib/prisma";
import { signToken, setLoginCookie, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { checkRateLimit, getClientIP, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  // ─── 速率限制：每 IP 每分钟最多 5 次登录尝试 ───
  const ip = getClientIP(req);
  const { allowed, resetAt } = checkRateLimit(`login:${ip}`, 5, 60 * 1000);
  if (!allowed) return rateLimitResponse(resetAt);

  try {
    const { username, password, role } = await req.json();

    if (!username || !password || !role) {
      return apiError("用户名、密码和角色不能为空");
    }

    if (typeof username !== "string" || username.length > 64) {
      return apiError("用户名格式无效");
    }

    if (typeof password !== "string" || password.length > 128) {
      return apiError("密码格式无效");
    }

    if (role !== "admin" && role !== "user") {
      return apiError("无效的角色类型");
    }

    const user = await prisma.users.findFirst({
      where: { username, is_deleted: 0 },
    });

    if (!user) {
      return apiError("用户名或密码错误", 401);
    }

    // admin 入口只允许 admin 角色；user 入口允许 user 和 leader 角色
    if (role === "admin" && user.role !== "admin") {
      return apiError("用户名或密码错误", 401);
    }
    if (role === "user" && user.role !== "user" && user.role !== "leader") {
      return apiError("用户名或密码错误", 401);
    }

    if (user.status !== "active") {
      return apiError("账户已被禁用", 403);
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return apiError("用户名或密码错误", 401);
    }

    const actualRole = user.role as "admin" | "user" | "leader";
    const payload: {
      userId: string;
      username: string;
      role: "admin" | "user" | "leader";
      teamId?: string;
    } = {
      userId: user.id.toString(),
      username: user.username,
      role: actualRole,
    };

    // 组长写入 teamId
    if (actualRole === "leader" && user.team_id) {
      payload.teamId = user.team_id.toString();
    }

    const token = signToken(payload);
    // leader 走 user cookie
    const cookieRole = actualRole === "leader" ? "user" : actualRole;
    await setLoginCookie(cookieRole, token);

    return apiSuccess(serializeData({
      id: user.id,
      username: user.username,
      role: user.role,
    }));
  } catch (error) {
    console.error("[Login Error]", error);
    return apiError("登录失败，请稍后重试", 500);
  }
}
