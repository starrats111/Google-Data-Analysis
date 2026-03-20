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

  const { id, platform, account_name, api_key, publish_site_id } = await req.json();
  if (!platform) return apiError("平台代码不能为空");

  const userId = BigInt(user.userId);

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

  await prisma.platform_connections.update({
    where: { id: BigInt(id) },
    data: { is_deleted: 1 },
  });
  return apiSuccess(null, "删除成功");
}
