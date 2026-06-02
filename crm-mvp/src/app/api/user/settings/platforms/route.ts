import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const connections = await prisma.platform_connections.findMany({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
    orderBy: [{ platform: "asc" }, { created_at: "asc" }],
  });
  return apiSuccess(serializeData(connections));
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id, platform, account_name, api_key, publish_site_id, payee } = await req.json();
  if (!platform) return apiError("平台代码不能为空");

  const userId = BigInt(user.userId);
  const normalizedPayee = typeof payee === "string" ? payee.trim() : "";

  // 编辑模式：按 id 更新
  if (id) {
    const existing = await prisma.platform_connections.findFirst({
      where: { id: BigInt(id), user_id: userId, is_deleted: 0 },
    });
    if (!existing) return apiError("连接不存在");

    const data: Record<string, unknown> = {
      publish_site_id: publish_site_id ? BigInt(publish_site_id) : null,
    };
    if (account_name !== undefined) data.account_name = account_name;
    if (api_key && api_key.trim()) data.api_key = api_key;
    if (payee !== undefined) data.payee = normalizedPayee || null;

    await prisma.platform_connections.update({ where: { id: existing.id }, data });
    return apiSuccess(null, "保存成功");
  }

  // 新增模式：允许同一平台多个连接
  if (!api_key || !api_key.trim()) return apiError("新增连接时 API Key 不能为空");

  // 自动生成 account_name（如果未提供）
  let finalName = account_name?.trim() || "";
  if (!finalName) {
    const existingCount = await prisma.platform_connections.count({
      where: { user_id: userId, platform, is_deleted: 0 },
    });
    finalName = existingCount === 0 ? `${platform}1` : `${platform}${existingCount + 1}`;
  }

  await prisma.platform_connections.create({
    data: {
      user_id: userId,
      platform,
      account_name: finalName,
      api_key,
      channel_id: null,
      payee: normalizedPayee || null,
      publish_site_id: publish_site_id ? BigInt(publish_site_id) : null,
      status: "connected",
    },
  });

  // D-012: 新增 conn 后 fire-and-forget 触发该平台 sync，
  // 让新 conn 的商家数据立即入库 → 与同平台其他 conn 自然合并形成 MULTI_KEY
  // 治本未来"加了 conn 但 user 没手动点同步导致 user_merchants 缺该 conn 的 link"问题
  triggerAutoSyncAfterCreate(userId, platform).catch((e) => {
    console.error(`[D-012 auto-sync] init failed for user=${userId} platform=${platform}:`, e);
  });

  return apiSuccess(null, "保存成功");
}

// D-012: 新增 platform_connection 后自动触发该 user 该平台的 sync
// 失败不影响主流程（已被 conn 创建成功后调用，不阻塞响应）
async function triggerAutoSyncAfterCreate(userId: bigint, platform: string) {
  // 复用 sync engine（dynamic import 避免循环依赖 + 共享 syncingUsers 单例 lock）
  const { syncingUsers, doSyncInBackground } = await import("@/app/api/user/merchants/sync/route");
  const platformUpper = platform.toUpperCase();
  const lockKey = `${userId.toString()}:${platformUpper}`;
  if (syncingUsers.has(lockKey)) {
    console.log(`[D-012 auto-sync] skipped: user=${userId} platform=${platformUpper} already syncing`);
    return;
  }

  // 拉该 user 在该 platform 的所有 active conn（含刚新增的）
  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId, platform: platformUpper, is_deleted: 0 },
    select: { id: true, platform: true, account_name: true, api_key: true, channel_id: true },
  });
  const valid = conns.filter((c) => c.api_key && c.api_key.length > 5);
  if (valid.length === 0) {
    console.log(`[D-012 auto-sync] no valid conns for user=${userId} platform=${platformUpper}`);
    return;
  }

  syncingUsers.add(lockKey);
  console.log(`[D-012 auto-sync] triggered user=${userId} platform=${platformUpper} conns=${valid.length}`);

  // fire-and-forget：sync 自己在后台跑，本函数立即返回不阻塞主响应
  doSyncInBackground(userId, valid, platformUpper)
    .catch((e) => console.error(`[D-012 auto-sync ${platformUpper}] doSync failed for user=${userId}:`, e))
    .finally(() => { syncingUsers.delete(lockKey); });
}

export async function DELETE(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");

  const userId = BigInt(user.userId);
  const connId = BigInt(id);

  // 先查出连接信息（平台代码），确认归属当前用户
  const conn = await prisma.platform_connections.findFirst({
    where: { id: connId, user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true },
  });
  if (!conn) return apiError("连接不存在");

  // 软删除平台连接
  await prisma.platform_connections.update({
    where: { id: connId },
    data: { is_deleted: 1 },
  });

  // 联动清理一：软删除该连接下的所有联盟交易记录
  // 连接删除后，其历史交易数据不再属于用户的有效数据
  await prisma.affiliate_transactions.updateMany({
    where: { user_id: userId, platform_connection_id: connId, is_deleted: 0 },
    data: { is_deleted: 1 },
  });

  // 联动清理二：软删除该连接带来的非领取商家
  // 规则：已领取（claimed）或已暂停（paused）的不动，其余清除
  // C-090：保留 excluded 是因为这是用户主动排除的标记，不应被覆盖
  const KEEP_STATUSES = ["claimed", "paused", "excluded"];

  await prisma.user_merchants.updateMany({
    where: {
      user_id: userId,
      platform_connection_id: connId,
      status: { notIn: KEEP_STATUSES },
      is_deleted: 0,
    },
    data: { is_deleted: 1 },
  });

  // C-090：若该平台已无其他有效连接，按 platform 全量清理 available 商家
  // 修复前只清 platform_connection_id=NULL 的，会漏掉指向其他历史 connId 的孤儿
  const otherActiveConns = await prisma.platform_connections.count({
    where: { user_id: userId, platform: conn.platform, is_deleted: 0 },
  });
  if (otherActiveConns === 0) {
    await prisma.user_merchants.updateMany({
      where: {
        user_id: userId,
        platform: conn.platform,
        status: { notIn: KEEP_STATUSES },
        is_deleted: 0,
      },
      data: { is_deleted: 1 },
    });
  }

  return apiSuccess(null, "删除成功");
}
