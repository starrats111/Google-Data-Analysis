import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError, normalizePlatformCode } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { reassignByConfirmedIndex } from "@/lib/account-index-reassign";

interface Assignment {
  connectionId: string;
  accountIndex: number;
}

/**
 * D-180：保存联盟序号确认
 *
 * 入参：{ platform, assignments: [{ connectionId, accountIndex }] }
 * 校验：assignments 覆盖该 (user, platform) 全部在用连接；序号唯一、连续 1..N、无空缺。
 * 写入：account_index + account_index_confirmed_at=now()。
 * 成功后自动重排该平台广告归属 + 迁移链接键。
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);
  const userId = BigInt(user.userId);

  const body = await req.json().catch(() => null);
  if (!body || typeof body.platform !== "string" || !Array.isArray(body.assignments)) {
    return apiError("参数格式错误");
  }
  const platform = normalizePlatformCode(body.platform);
  const assignments = body.assignments as Assignment[];

  // 该用户该平台的在用连接
  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true },
  });
  const platformConnIds = conns
    .filter((c) => normalizePlatformCode(c.platform) === platform)
    .map((c) => c.id.toString());

  if (platformConnIds.length === 0) return apiError("该平台没有在用连接");

  // 校验：assignments 必须一一覆盖该平台全部连接
  const assignConnIds = assignments.map((a) => String(a.connectionId));
  if (assignConnIds.length !== platformConnIds.length) {
    return apiError(`需为该平台全部 ${platformConnIds.length} 个连接指定序号`);
  }
  const platformSet = new Set(platformConnIds);
  for (const cid of assignConnIds) {
    if (!platformSet.has(cid)) return apiError(`连接 ${cid} 不属于该平台或已删除`);
  }
  if (new Set(assignConnIds).size !== assignConnIds.length) {
    return apiError("同一连接被指定了多次");
  }

  // 校验：序号唯一、连续 1..N、无空缺
  const n = platformConnIds.length;
  const indexes = assignments.map((a) => Number(a.accountIndex));
  if (indexes.some((i) => !Number.isInteger(i) || i < 1 || i > n)) {
    return apiError(`序号必须是 1..${n} 的整数`);
  }
  if (new Set(indexes).size !== n) {
    return apiError("序号不能重复，需覆盖 1.." + n + " 且各不相同");
  }

  const now = new Date();
  await prisma.$transaction(
    assignments.map((a) =>
      prisma.platform_connections.update({
        where: { id: BigInt(a.connectionId) },
        data: { account_index: Number(a.accountIndex), account_index_confirmed_at: now },
      }),
    ),
  );

  // 自动重排该平台广告归属 + 迁移链接键
  let reassign;
  try {
    reassign = await reassignByConfirmedIndex(userId, platform, false);
  } catch (e) {
    console.error(`[D-180 confirm] reassign failed user=${userId} platform=${platform}:`, e);
    return apiSuccess(
      { saved: true, reassignError: true },
      "序号已保存，但自动重排失败，请联系管理员核查广告归属",
    );
  }

  return apiSuccess(
    {
      saved: true,
      reassigned: reassign.campaignsReassigned.length,
      linkMigrated: reassign.linkMigrations.filter((l) => l.migrated).length,
      linkNeedManual: reassign.linkMigrations.filter((l) => !l.migrated).length,
    },
    "序号已确认，广告归属已按新序号重排",
  );
}
