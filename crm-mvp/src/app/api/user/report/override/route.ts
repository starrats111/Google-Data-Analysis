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
  // D-348：合并行的 scope_key 用的是接替号（在用号）的 id，所以这条校验照旧成立；
  // 同时把被它接替的旧号 id 收集出来，清除覆盖时要连旧号的遗留值一起清。
  const supersededIds: bigint[] = [];
  if (scope_key.startsWith("mcc:")) {
    const mccId = BigInt(scope_key.slice(4));
    const mcc = await prisma.google_mcc_accounts.findFirst({
      where: { id: mccId, user_id: userId, is_deleted: 0 },
      select: { id: true, supersedes_id: true },
    });
    if (!mcc) return apiError("MCC 账户不存在");

    // 沿接替链把全部旧号收进来（旧号多已软删，用「含软删」的查询走）
    const seen = new Set<string>([String(mcc.id)]);
    let cur = mcc.supersedes_id;
    while (cur != null && !seen.has(String(cur))) {
      seen.add(String(cur));
      supersededIds.push(cur);
      const parent: { supersedes_id: bigint | null } | null = await prisma.google_mcc_accounts.findFirst({
        where: { id: cur, user_id: userId },
        select: { supersedes_id: true },
      });
      cur = parent?.supersedes_id ?? null;
    }
  }

  if (value === null) {
    // D-348：合并行「恢复系统值」必须同时清掉旧号遗留的那条 override，
    // 否则清完本号的值后，报表又沉用旧号的遗留值 —— 按钮看着没反应。
    const keys = [scope_key, ...supersededIds.map((id) => `mcc:${id}`)];
    await prisma.report_overrides.updateMany({
      where: { user_id: userId, month, scope_key: { in: keys }, is_deleted: 0 },
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
