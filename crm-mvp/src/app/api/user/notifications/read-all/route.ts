import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";

// PUT /api/user/notifications/read-all — 全部标记已读
export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return NextResponse.json({ code: 401, message: "未登录" });

  await prisma.notifications.updateMany({
    where: { user_id: BigInt(user.userId), is_read: 0, is_deleted: 0 },
    data: { is_read: 1 },
  });

  return NextResponse.json({ code: 0, message: "ok" });
}
