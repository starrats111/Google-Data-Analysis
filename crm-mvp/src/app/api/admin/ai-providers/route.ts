import { NextRequest } from "next/server";
import { getAdminFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const providers = await prisma.ai_providers.findMany({
    where: { is_deleted: 0 },
    orderBy: { created_at: "desc" },
  });
  return apiSuccess(serializeData(providers));
}

export async function POST(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const { provider_name, api_key, api_base_url } = await req.json();
  if (!provider_name || !api_key) return apiError("供应商名称和 API Key 不能为空");

  const provider = await prisma.ai_providers.create({
    data: { provider_name, api_key, api_base_url: api_base_url || null },
  });
  return apiSuccess(serializeData(provider));
}

export async function PUT(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const { id, provider_name, api_key, api_base_url, status } = await req.json();
  if (!id) return apiError("缺少 ID");

  const data: Record<string, unknown> = {};
  if (provider_name !== undefined) data.provider_name = provider_name;
  if (api_key !== undefined) data.api_key = api_key;
  if (api_base_url !== undefined) data.api_base_url = api_base_url || null;
  if (status !== undefined) data.status = status;

  await prisma.ai_providers.update({ where: { id: BigInt(id) }, data });
  return apiSuccess(null, "更新成功");
}

export async function DELETE(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");

  await prisma.ai_providers.update({ where: { id: BigInt(id) }, data: { is_deleted: 1 } });
  return apiSuccess(null, "删除成功");
}
