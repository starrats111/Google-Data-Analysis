import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * POST /api/user/team/report/actual-cny
 * 组长手填「实际佣金(CNY)」
 *   - R-04.4 每平台每半月：{ month, platform, half: "H1"|"H2", value }
 *     → scope_key = `team_paid_cny:{platform}:{half}`
 *   - 旧版总额（兼容保留）：{ month, value } → scope_key = 'actual_cny'
 * value=null 清除，恢复预估值
 */
export const POST = withLeader(async (req: NextRequest, { user }) => {
  const { month, value, platform, half, remark } = await req.json();
  if (!/^\d{4}-\d{2}$/.test(month || "")) return apiError("month 格式必须为 YYYY-MM");

  let scopeKey = "actual_cny";
  if (platform !== undefined || half !== undefined) {
    if (typeof platform !== "string" || !/^[A-Z]{2,8}$/.test(platform)) return apiError("platform 无效");
    if (half !== "H1" && half !== "H2") return apiError("half 必须为 H1 或 H2");
    scopeKey = `team_paid_cny:${platform}:${half}`;
  }

  const leaderId = BigInt(user.userId);

  if (value === null) {
    await prisma.report_overrides.updateMany({
      where: { user_id: leaderId, month, scope_key: scopeKey, is_deleted: 0 },
      data: { is_deleted: 1 },
    });
    return apiSuccess(null, "已清除");
  }

  const num = Number(value);
  if (isNaN(num) || num < 0 || num > 999999999) return apiError("value 必须为非负数字");

  await prisma.report_overrides.upsert({
    where: { user_id_month_scope_key: { user_id: leaderId, month, scope_key: scopeKey } },
    update: { value: num, remark: remark || null, updated_by: leaderId, is_deleted: 0 },
    create: { user_id: leaderId, month, scope_key: scopeKey, value: num, remark: remark || null, updated_by: leaderId },
  });
  return apiSuccess(null, "保存成功");
});
