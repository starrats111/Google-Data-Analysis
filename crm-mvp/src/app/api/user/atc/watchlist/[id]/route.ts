/**
 * C-089 / C-094.6 ATC watchlist 单条操作
 *
 * DELETE /api/user/atc/watchlist/{id}        软删（取消关注）
 * PATCH  /api/user/atc/watchlist/{id}        切换 is_shared (body: { is_shared: boolean })
 */
import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

export const DELETE = withUser(async (
  _req: NextRequest,
  { user, params },
) => {
  const userId = BigInt(user.userId);
  const idStr = params?.id;
  if (!idStr) {
    return NextResponse.json({ code: -1, message: "缺少 id" }, { status: 400 });
  }
  const id = BigInt(idStr);

  const row = await prisma.user_atc_watchlist.findUnique({ where: { id } });
  if (!row || row.user_id !== userId) {
    return NextResponse.json({ code: -1, message: "未找到该关注" }, { status: 404 });
  }
  if (row.is_deleted === 1) {
    return NextResponse.json({ code: 0, data: { alreadyDeleted: true } });
  }

  await prisma.user_atc_watchlist.update({
    where: { id },
    data: { is_deleted: 1 },
  });
  return NextResponse.json({ code: 0, data: { ok: true } });
});

export const PATCH = withUser(async (req: NextRequest, { user, params }) => {
  const userId = BigInt(user.userId);
  const idStr = params?.id;
  if (!idStr) {
    return NextResponse.json({ code: -1, message: "缺少 id" }, { status: 400 });
  }
  const id = BigInt(idStr);

  const row = await prisma.user_atc_watchlist.findUnique({ where: { id } });
  if (!row || row.user_id !== userId) {
    return NextResponse.json({ code: -1, message: "未找到该关注" }, { status: 404 });
  }
  if (row.is_deleted === 1) {
    return NextResponse.json({ code: -1, message: "关注已取消，无法修改" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({})) as {
    is_shared?: boolean;
    min_days?: number;
  };

  const data: { is_shared?: number; min_days?: number } = {};
  if (typeof body.is_shared === "boolean") data.is_shared = body.is_shared ? 1 : 0;
  if (Number.isFinite(body.min_days)) {
    data.min_days = Math.max(1, Math.min(365, Number(body.min_days)));
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ code: -1, message: "无可更新字段" }, { status: 400 });
  }

  const updated = await prisma.user_atc_watchlist.update({
    where: { id },
    data,
  });

  return NextResponse.json({
    code: 0,
    data: {
      id: updated.id.toString(),
      is_shared: updated.is_shared === 1,
      min_days: updated.min_days,
    },
  });
});
