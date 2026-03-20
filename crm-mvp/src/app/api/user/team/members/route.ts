import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader, validateRequired, validateLength } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

// 获取本组组员列表
export const GET = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");

  const members = await prisma.users.findMany({
    where: { team_id: BigInt(user.teamId), is_deleted: 0, role: "user" },
    select: { id: true, username: true, display_name: true, status: true, created_at: true, updated_at: true },
    orderBy: { created_at: "desc" },
  });

  return apiSuccess(serializeData({ list: members, total: members.length }));
});

// 创建组员（自动分配到本组）
export const POST = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");

  const body = await req.json();
  const { username, password, display_name } = body;

  const missing = validateRequired(body, ["username", "password"]);
  if (missing) return apiError(missing);

  const lenErr = validateLength(username, "用户名", 2, 32) || validateLength(password, "密码", 6, 64);
  if (lenErr) return apiError(lenErr);

  // 检查用户名是否已存在
  const exists = await prisma.users.findFirst({ where: { username, is_deleted: 0 } });
  if (exists) return apiError("用户名已存在");

  const hash = await bcrypt.hash(password, 10);
  const newUser = await prisma.users.create({
    data: {
      username,
      password_hash: hash,
      role: "user",
      team_id: BigInt(user.teamId),
      display_name: display_name || null,
    },
  });

  // 自动创建广告默认设置 + 通知偏好
  await Promise.all([
    prisma.ad_default_settings.create({ data: { user_id: newUser.id } }),
    prisma.notification_preferences.create({ data: { user_id: newUser.id } }),
  ]);

  return apiSuccess(serializeData({ id: newUser.id, username: newUser.username, display_name: newUser.display_name }));
});

// 更新组员（状态/密码/显示名）
export const PUT = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");

  const { id, status, password, display_name } = await req.json();
  if (!id) return apiError("缺少用户 ID");

  // 验证目标用户属于本组
  const target = await prisma.users.findFirst({
    where: { id: BigInt(id), team_id: BigInt(user.teamId), is_deleted: 0, role: "user" },
  });
  if (!target) return apiError("该用户不属于您的小组", 403);

  const updateData: Record<string, unknown> = {};
  if (status) {
    if (!["active", "disabled"].includes(status)) return apiError("无效的状态值");
    updateData.status = status;
  }
  if (password) {
    const lenErr = validateLength(password, "密码", 6, 64);
    if (lenErr) return apiError(lenErr);
    updateData.password_hash = await bcrypt.hash(password, 10);
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

// 删除组员（软删除）
export const DELETE = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");

  const { id } = await req.json();
  if (!id) return apiError("缺少用户 ID");

  // 验证目标用户属于本组
  const target = await prisma.users.findFirst({
    where: { id: BigInt(id), team_id: BigInt(user.teamId), is_deleted: 0, role: "user" },
  });
  if (!target) return apiError("该用户不属于您的小组", 403);

  await prisma.users.update({
    where: { id: BigInt(id) },
    data: { is_deleted: 1 },
  });

  return apiSuccess(null, "删除成功");
});
