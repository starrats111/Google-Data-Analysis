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

  const { id, platform, account_name, api_key, channel_id, publish_site_id } = await req.json();
  if (!platform) return apiError("平台代码不能为空");

  const userId = BigInt(user.userId);

  // C-029：AD 平台必填 channel_id
  const normalizedChannelId = typeof channel_id === "string" ? channel_id.trim() : "";
  if (platform === "AD" && !id && !normalizedChannelId) {
    return apiError("AD 平台必须填写渠道 ID（channelId）");
  }

  // 编辑模式：按 id 更新
  if (id) {
    const existing = await prisma.platform_connections.findFirst({
      where: { id: BigInt(id), user_id: userId, is_deleted: 0 },
    });
    if (!existing) return apiError("连接不存在");

    // AD 编辑时若清空了 channel_id，也应拦截
    if (existing.platform === "AD" && channel_id !== undefined && !normalizedChannelId) {
      return apiError("AD 平台的渠道 ID 不能为空");
    }

    const data: Record<string, unknown> = {
      publish_site_id: publish_site_id ? BigInt(publish_site_id) : null,
    };
    if (account_name !== undefined) data.account_name = account_name;
    if (api_key && api_key.trim()) data.api_key = api_key;
    if (channel_id !== undefined) data.channel_id = normalizedChannelId || null;

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
      // 仅 AD 平台保存 channel_id，其他平台一律 NULL，避免字段污染
      channel_id: platform === "AD" ? (normalizedChannelId || null) : null,
      publish_site_id: publish_site_id ? BigInt(publish_site_id) : null,
      status: "connected",
    },
  });

  return apiSuccess(null, "保存成功");
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

  // 联动清理：软删除该连接带来的非领取商家
  // 规则：已领取（claimed）或已暂停（paused）的不动，其余清除
  const KEEP_STATUSES = ["claimed", "paused"];

  await prisma.user_merchants.updateMany({
    where: {
      user_id: userId,
      platform_connection_id: connId,
      status: { notIn: KEEP_STATUSES },
      is_deleted: 0,
    },
    data: { is_deleted: 1 },
  });

  // 若该平台已无其他有效连接，同步清理无 platform_connection_id 的平台残余商家
  const otherActiveConns = await prisma.platform_connections.count({
    where: { user_id: userId, platform: conn.platform, is_deleted: 0 },
  });
  if (otherActiveConns === 0) {
    await prisma.user_merchants.updateMany({
      where: {
        user_id: userId,
        platform: conn.platform,
        platform_connection_id: null,
        status: { notIn: KEEP_STATUSES },
        is_deleted: 0,
      },
      data: { is_deleted: 1 },
    });
  }

  return apiSuccess(null, "删除成功");
}
