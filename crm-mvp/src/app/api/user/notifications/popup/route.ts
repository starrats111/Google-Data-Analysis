import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";

/**
 * D-266 批四：GET /api/user/notifications/popup
 * 当前用户未确认的弹窗级告警（type=alert 且 metadata.popup=true）。
 * 前端 UserLayout 轮询，弹阻断式弹窗；「我知道了」走既有 /:id/read 标记已读即消失。
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return NextResponse.json({ code: 401, message: "未登录" });

  const rows = await prisma.notifications.findMany({
    where: {
      user_id: BigInt(user.userId),
      type: "alert",
      is_read: 0,
      is_deleted: 0,
      metadata: { contains: '"popup":true' },
    },
    orderBy: { created_at: "desc" },
    take: 5,
    select: { id: true, title: true, content: true, created_at: true },
  });

  return NextResponse.json({
    code: 0,
    data: {
      list: rows.map((r) => ({
        id: String(r.id),
        title: r.title,
        content: r.content || "",
        // 库存 UTC，前端展示时换算北京时间
        created_at: r.created_at.toISOString(),
      })),
    },
  });
}
