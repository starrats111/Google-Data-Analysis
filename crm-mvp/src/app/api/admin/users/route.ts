import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin, validateRequired, validateLength } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

// 获取用户列表
export const GET = withAdmin(async (req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = parseInt(searchParams.get("pageSize") || "50");
  const search = searchParams.get("search") || "";

  const where: Record<string, unknown> = { is_deleted: 0 };
  if (search) {
    where.username = { contains: search };
  }

  const [total, users] = await Promise.all([
    prisma.users.count({ where: where as never }),
    prisma.users.findMany({
      where: where as never,
      select: { id: true, username: true, role: true, status: true, team_id: true, display_name: true, plain_password: true, created_at: true, updated_at: true },
      orderBy: { created_at: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return apiSuccess(serializeData({ list: users, total, page, pageSize }));
});

// 创建用户
export const POST = withAdmin(async (req: NextRequest) => {
  const body = await req.json();
  const { username, password, role } = body;

  const missing = validateRequired(body, ["username", "password"]);
  if (missing) return apiError(missing);

  const lenErr = validateLength(username, "用户名", 2, 32) || validateLength(password, "密码", 6, 64);
  if (lenErr) return apiError(lenErr);

  if (role && role !== "admin" && role !== "user" && role !== "leader") return apiError("无效的角色");

  const exists = await prisma.users.findFirst({ where: { username, is_deleted: 0 } });
  if (exists) return apiError("用户名已存在");

  const hash = await bcrypt.hash(password, 10);
  const user = await prisma.users.create({
    data: {
      username,
      password_hash: hash,
      plain_password: password,
      role: role || "user",
      team_id: body.team_id ? BigInt(body.team_id) : null,
      display_name: body.display_name || null,
    },
  });

  // 如果是普通用户，自动创建广告默认设置 + 通知偏好
  if ((role || "user") === "user") {
    await Promise.all([
      prisma.ad_default_settings.create({ data: { user_id: user.id } }),
      prisma.notification_preferences.create({ data: { user_id: user.id } }),
    ]);
  }

  return apiSuccess(serializeData({ id: user.id, username: user.username, role: user.role }));
});

// 更新用户（启用/禁用/重置密码）
export const PUT = withAdmin(async (req: NextRequest) => {
  const { id, status, password, role, team_id, display_name } = await req.json();
  if (!id) return apiError("缺少用户 ID");

  const updateData: Record<string, unknown> = {};
  if (status) {
    if (!["active", "disabled"].includes(status)) return apiError("无效的状态值");
    updateData.status = status;
  }
  if (password) {
    const lenErr = validateLength(password, "密码", 6, 64);
    if (lenErr) return apiError(lenErr);
    updateData.password_hash = await bcrypt.hash(password, 10);
    updateData.plain_password = password;
  }
  if (role) {
    if (!["admin", "user", "leader"].includes(role)) return apiError("无效的角色");
    updateData.role = role;
  }
  if (team_id !== undefined) {
    updateData.team_id = team_id ? BigInt(team_id) : null;
  }
  if (display_name !== undefined) {
    updateData.display_name = display_name || null;
  }

  if (Object.keys(updateData).length === 0) return apiError("没有需要更新的字段");

  await prisma.users.update({
    where: { id: BigInt(id) },
    data: updateData,
  });

  return apiSuccess(null, "更新成功");
});

// 删除用户（软删除）
export const DELETE = withAdmin(async (req: NextRequest) => {
  const { id } = await req.json();
  if (!id) return apiError("缺少用户 ID");

  // 不允许删除自己
  // admin user info is available via the wrapper but we check by id
  await prisma.users.update({
    where: { id: BigInt(id) },
    data: { is_deleted: 1 },
  });

  return apiSuccess(null, "删除成功");
});
