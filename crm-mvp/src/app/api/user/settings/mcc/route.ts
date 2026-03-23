import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

// 获取 MCC 账户列表
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const accounts = await prisma.google_mcc_accounts.findMany({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
    orderBy: { created_at: "desc" },
  });
  return apiSuccess(serializeData(accounts));
}

// 添加 MCC 账户
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { mcc_id, mcc_name, currency, service_account_json, sheet_url, developer_token } = await req.json();
  if (!mcc_id) return apiError("MCC ID 不能为空");

  const account = await prisma.google_mcc_accounts.create({
    data: {
      user_id: BigInt(user.userId),
      mcc_id: mcc_id.trim(),
      mcc_name: mcc_name?.trim() || null,
      currency: currency || "USD",
      service_account_json: service_account_json?.trim() || null,
      sheet_url: sheet_url?.trim() || null,
      developer_token: developer_token?.trim() || null,
    },
  });
  return apiSuccess(serializeData(account));
}

// 更新 MCC 账户
export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id, mcc_name, currency, service_account_json, sheet_url, developer_token, is_active } = await req.json();
  if (!id) return apiError("缺少 ID");

  const data: Record<string, unknown> = {};
  if (mcc_name !== undefined) data.mcc_name = mcc_name;
  if (currency !== undefined) data.currency = currency;
  if (service_account_json !== undefined) data.service_account_json = service_account_json;
  if (sheet_url !== undefined) data.sheet_url = sheet_url;
  if (developer_token !== undefined && developer_token !== "") data.developer_token = developer_token.trim();
  if (is_active !== undefined) data.is_active = is_active;

  await prisma.google_mcc_accounts.update({ where: { id: BigInt(id) }, data });
  return apiSuccess(null, "更新成功");
}

// 删除 MCC 账户
export async function DELETE(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");

  await prisma.google_mcc_accounts.update({ where: { id: BigInt(id) }, data: { is_deleted: 1 } });
  return apiSuccess(null, "删除成功");
}
