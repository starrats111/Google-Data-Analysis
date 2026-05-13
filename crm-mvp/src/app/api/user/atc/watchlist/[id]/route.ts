/**
 * C-089 ATC watchlist 单条软删
 *
 * DELETE /api/user/atc/watchlist/{id}
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
