import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** 组员可写的 scope：广告费覆盖(mcc:{id}) / 实收纠正 USD(recv:…) / 实收手填 CNY(recvcny:…) */
const MEMBER_SCOPE_RE = /^(mcc:\d+|(recv|recvcny):[A-Z]{2,8}:[^:]{0,32}:(H1|H2))$/;

/**
 * POST /api/user/report/override
 * 组员手填覆盖 { month, scope_key, value, remark? }；value 传 null 表示清除覆盖（恢复库内值）
 */
export const POST = withUser(async (req: NextRequest, { user }) => {
  const { month, scope_key, value, remark } = await req.json();
  if (!/^\d{4}-\d{2}$/.test(month || "")) return apiError("month 格式必须为 YYYY-MM");
  if (typeof scope_key !== "string" || !MEMBER_SCOPE_RE.test(scope_key)) {
    return apiError("scope_key 无效");
  }

  const userId = BigInt(user.userId);

  // mcc 覆盖需校验 MCC 归属本人
  if (scope_key.startsWith("mcc:")) {
    const mccId = BigInt(scope_key.slice(4));
    const mcc = await prisma.google_mcc_accounts.findFirst({
      where: { id: mccId, user_id: userId, is_deleted: 0 },
      select: { id: true },
    });
    if (!mcc) return apiError("MCC 账户不存在");
  }

  if (value === null) {
    await prisma.report_overrides.updateMany({
      where: { user_id: userId, month, scope_key, is_deleted: 0 },
      data: { is_deleted: 1 },
    });
    return apiSuccess(null, "已恢复系统计算值");
  }

  const num = Number(value);
  if (isNaN(num) || num < 0 || num > 99999999) return apiError("value 必须为非负数字");

  await prisma.report_overrides.upsert({
    where: { user_id_month_scope_key: { user_id: userId, month, scope_key } },
    update: { value: num, remark: remark || null, updated_by: userId, is_deleted: 0 },
    create: { user_id: userId, month, scope_key, value: num, remark: remark || null, updated_by: userId },
  });
  return apiSuccess(null, "保存成功");
});
