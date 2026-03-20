import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getUserFromRequest, serializeData } from "@/lib/auth";

// GET /api/user/notifications — 获取通知列表
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return NextResponse.json({ code: 401, message: "未登录" });

  const url = new URL(req.url);
  const page = parseInt(url.searchParams.get("page") || "1");
  const pageSize = parseInt(url.searchParams.get("page_size") || "20");

  const [list, total] = await Promise.all([
    prisma.notifications.findMany({
      where: { user_id: BigInt(user.userId), is_deleted: 0 },
      orderBy: { created_at: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.notifications.count({
      where: { user_id: BigInt(user.userId), is_deleted: 0 },
    }),
  ]);

  return NextResponse.json({
    code: 0,
    data: { list: serializeData(list), total, page, pageSize },
  });
}
