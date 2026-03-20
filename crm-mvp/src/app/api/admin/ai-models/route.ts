import { NextRequest } from "next/server";
import { getAdminFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const configs = await prisma.ai_model_configs.findMany({
    where: { is_deleted: 0 },
    orderBy: [{ scene: "asc" }, { priority: "asc" }],
  });

  // 同时返回供应商列表用于下拉选择
  const providers = await prisma.ai_providers.findMany({
    where: { is_deleted: 0, status: "active" },
    select: { id: true, provider_name: true },
  });

  return apiSuccess(serializeData({ configs, providers }));
}

export async function POST(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const { scene, provider_id, model_name, max_tokens, temperature, priority } = await req.json();
  if (!scene || !provider_id || !model_name) return apiError("场景、供应商和模型名称不能为空");

  const config = await prisma.ai_model_configs.create({
    data: {
      scene,
      provider_id: BigInt(provider_id),
      model_name,
      max_tokens: max_tokens || 4096,
      temperature: temperature || 0.7,
      priority: priority || 1,
    },
  });
  return apiSuccess(serializeData(config));
}

export async function PUT(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const { id, scene, provider_id, model_name, max_tokens, temperature, is_active, priority } = await req.json();
  if (!id) return apiError("缺少 ID");

  const data: Record<string, unknown> = {};
  if (scene !== undefined) data.scene = scene;
  if (provider_id !== undefined) data.provider_id = BigInt(provider_id);
  if (model_name !== undefined) data.model_name = model_name;
  if (max_tokens !== undefined) data.max_tokens = max_tokens;
  if (temperature !== undefined) data.temperature = temperature;
  if (is_active !== undefined) data.is_active = is_active;
  if (priority !== undefined) data.priority = priority;

  await prisma.ai_model_configs.update({ where: { id: BigInt(id) }, data });
  return apiSuccess(null, "更新成功");
}

export async function DELETE(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");

  await prisma.ai_model_configs.update({ where: { id: BigInt(id) }, data: { is_deleted: 1 } });
  return apiSuccess(null, "删除成功");
}
