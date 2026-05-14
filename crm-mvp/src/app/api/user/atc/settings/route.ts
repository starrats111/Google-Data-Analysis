/**
 * C-094.11 我的广告主-全局阈值（atc_default_min_days）
 *
 * GET  /api/user/atc/settings        返回 default_min_days
 * PATCH /api/user/atc/settings       { default_min_days: 30 }
 *   - 更新 users.atc_default_min_days
 *   - 同时把当前用户所有未删除 watchlist.min_days 改成新值（用户视角的"统一阈值"）
 */
import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

export const GET = withUser(async (_req: NextRequest, { user }) => {
  const u = await prisma.users.findFirst({
    where: { id: BigInt(user.userId), is_deleted: 0 },
    select: { atc_default_min_days: true },
  });
  return NextResponse.json({
    code: 0,
    data: { default_min_days: u?.atc_default_min_days ?? 30 },
  });
});

export const PATCH = withUser(async (req: NextRequest, { user }) => {
  const body = await req.json().catch(() => ({})) as { default_min_days?: number };
  const raw = body?.default_min_days;
  const days = Math.max(1, Math.min(365, Math.floor(Number(raw))));
  if (!Number.isFinite(days)) {
    return NextResponse.json({ code: 1, message: "default_min_days 必须是 1~365 之间的整数" });
  }

  const userId = BigInt(user.userId);
  const [, updatedRows] = await prisma.$transaction([
    prisma.users.update({
      where: { id: userId },
      data: { atc_default_min_days: days },
    }),
    prisma.user_atc_watchlist.updateMany({
      where: { user_id: userId, is_deleted: 0 },
      data: { min_days: days },
    }),
  ]);

  return NextResponse.json({
    code: 0,
    data: { default_min_days: days, applied_rows: updatedRows.count },
  });
});
