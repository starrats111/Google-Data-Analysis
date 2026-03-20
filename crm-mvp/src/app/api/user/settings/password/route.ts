import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { old_password, new_password } = await req.json();

  if (!old_password || !new_password) {
    return apiError("请输入旧密码和新密码");
  }
  if (new_password.length < 6 || new_password.length > 64) {
    return apiError("新密码长度需在 6-64 位之间");
  }

  const dbUser = await prisma.users.findFirst({
    where: { id: BigInt(user.userId), is_deleted: 0 },
    select: { id: true, password_hash: true },
  });
  if (!dbUser) return apiError("用户不存在", 404);

  const valid = await bcrypt.compare(old_password, dbUser.password_hash);
  if (!valid) return apiError("旧密码错误");

  const hash = await bcrypt.hash(new_password, 10);
  await prisma.users.update({
    where: { id: dbUser.id },
    data: {
      password_hash: hash,
      plain_password: new_password,
    },
  });

  return apiSuccess(null, "密码修改成功");
}
