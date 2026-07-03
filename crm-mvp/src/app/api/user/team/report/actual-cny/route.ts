import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/user/team/report/actual-cny
 * 组长手填「实际佣金(CNY)」 { month, value, remark? }；value=null 清除
 * 存 report_overrides（user_id=组长, scope_key='actual_cny'）
 */
export const POST = withLeader(async (req: NextRequest, { user }) => {
  const { month, value, remark } = await req.json();
  if (!/^\d{4}-\d{2}$/.test(month || "")) return apiError("month 格式必须为 YYYY-MM");

  const leaderId = BigInt(user.userId);

  if (value === null) {
    await prisma.report_overrides.updateMany({
      where: { user_id: leaderId, month, scope_key: "actual_cny", is_deleted: 0 },
      data: { is_deleted: 1 },
    });
    return apiSuccess(null, "已清除");
  }

  const num = Number(value);
  if (isNaN(num) || num < 0 || num > 999999999) return apiError("value 必须为非负数字");

  await prisma.report_overrides.upsert({
    where: { user_id_month_scope_key: { user_id: leaderId, month, scope_key: "actual_cny" } },
    update: { value: num, remark: remark || null, updated_by: leaderId, is_deleted: 0 },
    create: { user_id: leaderId, month, scope_key: "actual_cny", value: num, remark: remark || null, updated_by: leaderId },
  });
  return apiSuccess(null, "保存成功");
});
