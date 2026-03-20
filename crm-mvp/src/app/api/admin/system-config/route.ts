import { NextRequest } from "next/server";
import { getAdminFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const configs = await prisma.system_configs.findMany({
    where: { is_deleted: 0 },
    orderBy: { config_key: "asc" },
  });
  return apiSuccess(serializeData(configs));
}

export async function POST(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const { config_key, config_value, description } = await req.json();
  if (!config_key) return apiError("配置键不能为空");

  const exists = await prisma.system_configs.findFirst({ where: { config_key, is_deleted: 0 } });
  if (exists) return apiError("配置键已存在");

  const config = await prisma.system_configs.create({
    data: { config_key, config_value: config_value || null, description: description || null },
  });
  return apiSuccess(serializeData(config));
}

export async function PUT(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const { id, config_value, description } = await req.json();
  if (!id) return apiError("缺少 ID");

  const data: Record<string, unknown> = {};
  if (config_value !== undefined) data.config_value = config_value;
  if (description !== undefined) data.description = description;

  await prisma.system_configs.update({ where: { id: BigInt(id) }, data });
  return apiSuccess(null, "更新成功");
}

export async function DELETE(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");

  await prisma.system_configs.update({ where: { id: BigInt(id) }, data: { is_deleted: 1 } });
  return apiSuccess(null, "删除成功");
}
