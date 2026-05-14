/**
 * C-094.6 ATC watchlist 批量关注
 *
 * POST /api/user/atc/watchlist/batch
 * body: { items: [{ advertiser_id, advertiser_name?, region? }, ...], min_days? }
 *
 * 行为：
 *   - 单次批量上限 200 条，超出截断
 *   - 每条按 (user_id, advertiser_id, region) 唯一约束 upsert
 *   - 已存在且未删 → 跳过（skipped）
 *   - 已存在但软删 → 复活（reactivated）
 *   - 不存在 → 新建（created）
 *   - advertiser_id 校验失败 → invalid
 *
 * 返回：{ code, data: { created, reactivated, skipped, invalid } }
 */
import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

const BATCH_MAX = 200;

export const POST = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json().catch(() => ({})) as {
    items?: Array<{ advertiser_id?: string; advertiser_name?: string | null; region?: string }>;
    min_days?: number;
  };

  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) {
    return NextResponse.json({ code: -1, message: "items 不能为空" }, { status: 400 });
  }

  const items = rawItems.slice(0, BATCH_MAX);
  // C-094.11：未传 min_days 时从 users.atc_default_min_days 取（全局阈值）
  let minDays: number;
  if (Number.isFinite(body.min_days)) {
    minDays = Math.max(1, Math.min(365, Number(body.min_days)));
  } else {
    const u = await prisma.users.findFirst({ where: { id: userId }, select: { atc_default_min_days: true } });
    minDays = u?.atc_default_min_days ?? 30;
  }

  let created = 0, reactivated = 0, skipped = 0, invalid = 0;

  // 串行处理保证统计准确（200 条最大几秒内完成，无需并发优化）
  for (const it of items) {
    const advertiserId = (it.advertiser_id ?? "").trim();
    const region = (it.region ?? "US").trim().toUpperCase();
    const advertiserName = (it.advertiser_name ?? "")?.toString().trim() || null;

    if (!advertiserId.startsWith("AR") || !region) {
      invalid++;
      continue;
    }

    const existing = await prisma.user_atc_watchlist.findFirst({
      where: { user_id: userId, advertiser_id: advertiserId, region },
    });

    if (existing) {
      if (existing.is_deleted === 0) {
        skipped++;
        continue;
      }
      await prisma.user_atc_watchlist.update({
        where: { id: existing.id },
        data: {
          is_deleted: 0,
          advertiser_name: advertiserName ?? existing.advertiser_name,
          min_days: minDays,
        },
      });
      reactivated++;
      continue;
    }

    await prisma.user_atc_watchlist.create({
      data: {
        user_id: userId,
        advertiser_id: advertiserId,
        advertiser_name: advertiserName,
        region,
        min_days: minDays,
      },
    });
    created++;
  }

  return NextResponse.json({
    code: 0,
    data: {
      total: items.length,
      truncated: rawItems.length > BATCH_MAX,
      created,
      reactivated,
      skipped,
      invalid,
    },
  });
});
