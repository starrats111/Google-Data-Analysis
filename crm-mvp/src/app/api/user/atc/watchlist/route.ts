/**
 * C-089 ATC 广告情报二次升级：watchlist CRUD
 *
 * GET    /api/user/atc/watchlist     列出当前用户的所有关注
 * POST   /api/user/atc/watchlist     新增关注 { advertiser_id, advertiser_name?, region?, min_days? }
 *
 * 单条删除走 /api/user/atc/watchlist/[id]/route.ts
 */
import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

export const GET = withUser(async (_req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const rows = await prisma.user_atc_watchlist.findMany({
    where: { user_id: userId, is_deleted: 0 },
    orderBy: { created_at: "desc" },
  });

  return NextResponse.json({
    code: 0,
    data: rows.map((r) => ({
      id: r.id.toString(),
      advertiser_id: r.advertiser_id,
      advertiser_name: r.advertiser_name,
      region: r.region,
      min_days: r.min_days,
      created_at: r.created_at,
    })),
  });
});

export const POST = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json().catch(() => ({})) as {
    advertiser_id?: string;
    advertiser_name?: string;
    region?: string;
    min_days?: number;
  };

  const advertiserId = (body.advertiser_id ?? "").trim();
  const region = (body.region ?? "US").trim().toUpperCase();
  const minDays = Number.isFinite(body.min_days) ? Math.max(1, Math.min(365, Number(body.min_days))) : 15;
  const advertiserName = (body.advertiser_name ?? "").trim() || null;

  if (!advertiserId.startsWith("AR")) {
    return NextResponse.json(
      { code: -1, message: "advertiser_id 必须以 AR 开头" },
      { status: 400 },
    );
  }
  if (!region) {
    return NextResponse.json({ code: -1, message: "region 必填" }, { status: 400 });
  }

  // 若已存在（含软删），复用旧记录：is_deleted=0 + 更新 min_days/name
  const existing = await prisma.user_atc_watchlist.findFirst({
    where: { user_id: userId, advertiser_id: advertiserId, region },
  });

  if (existing) {
    const updated = await prisma.user_atc_watchlist.update({
      where: { id: existing.id },
      data: {
        is_deleted: 0,
        advertiser_name: advertiserName ?? existing.advertiser_name,
        min_days: minDays,
      },
    });
    return NextResponse.json({
      code: 0,
      data: { id: updated.id.toString(), reactivated: existing.is_deleted === 1 },
    });
  }

  const created = await prisma.user_atc_watchlist.create({
    data: {
      user_id: userId,
      advertiser_id: advertiserId,
      advertiser_name: advertiserName,
      region,
      min_days: minDays,
    },
  });

  return NextResponse.json({
    code: 0,
    data: { id: created.id.toString(), reactivated: false },
  });
});
