import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withUser, withLeader } from "@/lib/api-handler";
import { serializeData } from "@/lib/auth";
import { toBigIntId } from "@/lib/safe-bigint";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** 解析当前用户所属 team_id（组员 token 无 teamId，需查库） */
async function resolveTeamId(userId: string, tokenTeamId?: string): Promise<bigint | null> {
  if (tokenTeamId) return BigInt(tokenTeamId);
  const u = await prisma.users.findFirst({
    where: { id: BigInt(userId), is_deleted: 0 },
    select: { team_id: true },
  });
  return u?.team_id ?? null;
}

/**
 * GET /api/user/team/payment-methods
 * 本组收款方式清单（组长管理用 / 组员绑定下拉用）
 */
export const GET = withUser(async (_req: NextRequest, { user }) => {
  const teamId = await resolveTeamId(user.userId, user.teamId);
  if (!teamId) return apiError("未关联小组");

  const rows = await prisma.payment_methods.findMany({
    where: { team_id: teamId, is_deleted: 0 },
    orderBy: { created_at: "asc" },
  });
  return apiSuccess(serializeData(rows));
});

/**
 * POST /api/user/team/payment-methods
 * 组长新建/编辑收款方式 { id?, payee_name, card_no }
 */
export const POST = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");
  const teamId = BigInt(user.teamId);

  const { id, payee_name, card_no } = await req.json();
  const name = typeof payee_name === "string" ? payee_name.trim() : "";
  const card = typeof card_no === "string" ? card_no.trim() : "";
  if (!name) return apiError("收款人姓名不能为空");
  if (name.length > 64 || card.length > 64) return apiError("姓名/卡号长度不能超过64字符");

  if (id) {
    const parsedId = toBigIntId(id);
    if (!parsedId) return apiError("ID 格式无效");
    const existing = await prisma.payment_methods.findFirst({
      where: { id: parsedId, team_id: teamId, is_deleted: 0 },
    });
    if (!existing) return apiError("收款方式不存在");
    await prisma.payment_methods.update({
      where: { id: existing.id },
      data: { payee_name: name, card_no: card },
    });
    return apiSuccess(null, "保存成功");
  }

  const dup = await prisma.payment_methods.findFirst({
    where: { team_id: teamId, payee_name: name, card_no: card, is_deleted: 0 },
  });
  if (dup) return apiError("已存在相同姓名和卡号的收款方式");

  await prisma.payment_methods.create({
    data: { team_id: teamId, payee_name: name, card_no: card },
  });
  return apiSuccess(null, "创建成功");
});

/**
 * DELETE /api/user/team/payment-methods
 * 组长软删收款方式 { id }。已被连接绑定时拒绝删除（先让组员换绑）。
 */
export const DELETE = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");
  const teamId = BigInt(user.teamId);

  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");
  const parsedId = toBigIntId(id);
  if (!parsedId) return apiError("ID 格式无效");

  const existing = await prisma.payment_methods.findFirst({
    where: { id: parsedId, team_id: teamId, is_deleted: 0 },
  });
  if (!existing) return apiError("收款方式不存在");

  const boundCount = await prisma.platform_connections.count({
    where: { payment_method_id: existing.id, is_deleted: 0 },
  });
  if (boundCount > 0) {
    return apiError(`该收款方式仍被 ${boundCount} 个联盟账号绑定，请先让组员换绑后再删除`);
  }

  await prisma.payment_methods.update({
    where: { id: existing.id },
    data: { is_deleted: 1 },
  });
  return apiSuccess(null, "删除成功");
});
