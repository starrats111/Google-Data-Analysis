import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getUserFromRequest, serializeData } from "@/lib/auth";

// GET /api/user/notifications/preferences — 获取通知偏好
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return NextResponse.json({ code: 401, message: "未登录" });

  let prefs = await prisma.notification_preferences.findUnique({
    where: { user_id: BigInt(user.userId) },
  });

  if (!prefs) {
    prefs = await prisma.notification_preferences.create({
      data: { user_id: BigInt(user.userId) },
    });
  }

  return NextResponse.json({ code: 0, data: serializeData(prefs) });
}

// PUT /api/user/notifications/preferences — 更新通知偏好
export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return NextResponse.json({ code: 401, message: "未登录" });

  const body = await req.json();
  const { notify_system, notify_merchant, notify_article, notify_ad, notify_alert } = body;

  await prisma.notification_preferences.upsert({
    where: { user_id: BigInt(user.userId) },
    update: {
      notify_system: notify_system ?? 1,
      notify_merchant: notify_merchant ?? 1,
      notify_article: notify_article ?? 1,
      notify_ad: notify_ad ?? 1,
      notify_alert: notify_alert ?? 1,
    },
    create: {
      user_id: BigInt(user.userId),
      notify_system: notify_system ?? 1,
      notify_merchant: notify_merchant ?? 1,
      notify_article: notify_article ?? 1,
      notify_ad: notify_ad ?? 1,
      notify_alert: notify_alert ?? 1,
    },
  });

  return NextResponse.json({ code: 0, message: "ok" });
}
