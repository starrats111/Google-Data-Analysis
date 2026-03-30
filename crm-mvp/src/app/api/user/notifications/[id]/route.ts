import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getUserFromRequest, serializeData } from "@/lib/auth";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getUserFromRequest(req);
  if (!user) return NextResponse.json({ code: 401, message: "未登录" });

  const { id } = await params;

  const notif = await prisma.notifications.findFirst({
    where: { id: BigInt(id), user_id: BigInt(user.userId), is_deleted: 0 },
  });

  if (!notif) {
    return NextResponse.json({ code: 404, message: "通知不存在" });
  }

  let metadata = null;
  if (notif.metadata) {
    try { metadata = JSON.parse(notif.metadata); } catch { /* ignore */ }
  }

  if (notif.is_read === 0) {
    await prisma.notifications.update({
      where: { id: notif.id },
      data: { is_read: 1 },
    });
  }

  return NextResponse.json({
    code: 0,
    data: { ...serializeData(notif), metadata },
  });
}
