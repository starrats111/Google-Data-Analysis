import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * GET /api/user/data-center/cost-adjustment?month=2026-03
 * 查询当前用户指定月份的所有 MCC 误差费用
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const month = new URL(req.url).searchParams.get("month");
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return apiError("month 格式必须为 YYYY-MM", 400);
  }

  const rows = await prisma.mcc_cost_adjustments.findMany({
    where: { user_id: BigInt(user.userId), month, is_deleted: 0 },
    select: { mcc_account_id: true, amount: true, remark: true },
  });

  return apiSuccess(serializeData(rows));
}

/**
 * POST /api/user/data-center/cost-adjustment
 * 创建/更新误差费用（upsert）
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json();
  const { mcc_account_id, month, amount, remark } = body;

  if (!mcc_account_id) return apiError("缺少 mcc_account_id", 400);
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return apiError("month 格式必须为 YYYY-MM", 400);
  if (typeof amount !== "number" || amount < 0) return apiError("amount 必须为非负数字", 400);

  const userId = BigInt(user.userId);
  const mccId = BigInt(mcc_account_id);

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: mccId, user_id: userId, is_deleted: 0 },
  });
  if (!mcc) return apiError("MCC 账户不存在", 404);

  const result = await prisma.mcc_cost_adjustments.upsert({
    where: {
      user_id_mcc_account_id_month: { user_id: userId, mcc_account_id: mccId, month },
    },
    update: { amount, remark: remark || null, is_deleted: 0 },
    create: { user_id: userId, mcc_account_id: mccId, month, amount, remark: remark || null },
  });

  return apiSuccess(serializeData(result));
}
