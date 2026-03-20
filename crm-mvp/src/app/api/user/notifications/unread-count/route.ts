import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";

// GET /api/user/notifications/unread-count
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return NextResponse.json({ code: 401, message: "未登录" });

  const count = await prisma.notifications.count({
    where: { user_id: BigInt(user.userId), is_read: 0, is_deleted: 0 },
  });

  return NextResponse.json({ code: 0, data: { count } });
}
