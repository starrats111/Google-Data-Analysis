import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * 组员可写的 scope：
 * - mcc:{id} 广告费覆盖
 * - book:/rejected:{platform}:{account} 账面/失效佣金纠正
 * - due:{platform}:{account}:{H1|H2} 应收纠正
 * - recv:…:{H1|H2} 实收 USD 纠正 / recvcny:…:{H1|H2} 实收 CNY 手填
 */
const MEMBER_SCOPE_RE =
  /^(mcc:\d+|(recv|recvcny|due):[A-Z]{2,8}:[^:]{0,32}:(H1|H2)|(book|rejected):[A-Z]{2,8}:[^:]{0,32})$/;

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
  //
  // D-348.1：**清除**（value=null）不要求 MCC 未删，新增/修改仍要求。
  // 起因：纠正值填下时 MCC 还是活的，之后该号被软删（删号重绑/代理商转移），
  // D-312 的 orphan 补段又会把已删号连同它遗留的 override 一起补回报表，
  // 与接替它的新号同时进合计 → 重复计算；而旧的 is_deleted:0 校验让这条
  // override 在页面上**点不掉**（复原图标报「MCC 账户不存在」），
  // 组员只能找开发改库。放行清除即可自助止血，且不放宽写入面：
  // 已删号仍然不能被填新值，归属校验（user_id）两种情形都保留。
  if (scope_key.startsWith("mcc:")) {
    const mccId = BigInt(scope_key.slice(4));
    const mcc = await prisma.google_mcc_accounts.findFirst({
      where: {
        id: mccId,
        user_id: userId,
        // 清除时允许已软删的 MCC；写入时仍限活跃 MCC
        ...(value === null ? {} : { is_deleted: 0 }),
      },
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
