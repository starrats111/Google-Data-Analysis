import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";

// PUT /api/user/notifications/[id]/read — 标记单条已读
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getUserFromRequest(req);
  if (!user) return NextResponse.json({ code: 401, message: "未登录" });

  const { id } = await params;

  await prisma.notifications.updateMany({
    where: { id: BigInt(id), user_id: BigInt(user.userId) },
    data: { is_read: 1 },
  });

  return NextResponse.json({ code: 0, message: "ok" });
}
