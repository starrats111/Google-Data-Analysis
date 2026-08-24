import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import { serializeData } from "@/lib/auth";
import { toBigIntId } from "@/lib/safe-bigint";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * D-275 个人收款方式（个人设置「收款方式」tab）
 *
 * 规则（07 2026-08-24 拍板）：
 * - 组长维护了团队清单（owner_user_id IS NULL 的行存在）→ 本 tab 只读展示组长清单，不许自填；
 * - 组长没维护（yz 组模式）→ 组员自填银行卡（owner_user_id = 本人），仅本人可见可绑。
 */

async function resolveTeamId(userId: string, tokenTeamId?: string): Promise<bigint | null> {
  if (tokenTeamId) return BigInt(tokenTeamId);
  const u = await prisma.users.findFirst({
    where: { id: BigInt(userId), is_deleted: 0 },
    select: { team_id: true },
  });
  return u?.team_id ?? null;
}

/** 团队级清单是否存在（存在则同步组长清单、关闭自填） */
async function teamListExists(teamId: bigint): Promise<boolean> {
  const n = await prisma.payment_methods.count({
    where: { team_id: teamId, owner_user_id: null, is_deleted: 0 },
  });
  return n > 0;
}

/**
 * GET — 返回 { mode, methods }
 * mode = "team"：组长清单（只读）；mode = "self"：本人自填清单（可增删改）
 */
export const GET = withUser(async (_req: NextRequest, { user }) => {
  const teamId = await resolveTeamId(user.userId, user.teamId);
  if (!teamId) return apiError("未关联小组");

  const hasTeamList = await teamListExists(teamId);
  const rows = await prisma.payment_methods.findMany({
    where: hasTeamList
      ? { team_id: teamId, owner_user_id: null, is_deleted: 0 }
      : { team_id: teamId, owner_user_id: BigInt(user.userId), is_deleted: 0 },
    orderBy: { created_at: "asc" },
  });
  return apiSuccess({ mode: hasTeamList ? "team" : "self", methods: serializeData(rows) });
});

/**
 * POST — 自填新建/编辑 { id?, payee_name, pay_channel, card_no }
 * 校验口径与组长维护一致（C-178：纯名字 + 打款方式分列）。
 */
export const POST = withUser(async (req: NextRequest, { user }) => {
  const teamId = await resolveTeamId(user.userId, user.teamId);
  if (!teamId) return apiError("未关联小组");
  const userId = BigInt(user.userId);

  if (await teamListExists(teamId)) {
    return apiError("组长已维护收款方式清单，本组使用组长清单，无需自填");
  }

  const { id, payee_name, pay_channel, card_no } = await req.json();
  const name = typeof payee_name === "string" ? payee_name.trim() : "";
  const channel = typeof pay_channel === "string" ? pay_channel.trim() : "";
  const card = typeof card_no === "string" ? card_no.trim() : "";
  if (!name) return apiError("收款人姓名不能为空");
  if (/[（()）]/.test(name)) return apiError("收款人姓名请填纯名字，银行/渠道填在「打款方式」里");
  if (name.length > 64 || channel.length > 64 || card.length > 64) return apiError("姓名/打款方式/卡号长度不能超过64字符");

  if (id) {
    const parsedId = toBigIntId(id);
    if (!parsedId) return apiError("ID 格式无效");
    const existing = await prisma.payment_methods.findFirst({
      where: { id: parsedId, owner_user_id: userId, is_deleted: 0 },
    });
    if (!existing) return apiError("收款方式不存在");
    await prisma.payment_methods.update({
      where: { id: existing.id },
      data: { payee_name: name, pay_channel: channel, card_no: card },
    });
    return apiSuccess(null, "保存成功");
  }

  const dup = await prisma.payment_methods.findFirst({
    where: { owner_user_id: userId, payee_name: name, pay_channel: channel, card_no: card, is_deleted: 0 },
  });
  if (dup) return apiError("已存在相同姓名、打款方式和卡号的收款方式");

  await prisma.payment_methods.create({
    data: { team_id: teamId, owner_user_id: userId, payee_name: name, pay_channel: channel, card_no: card },
  });
  return apiSuccess(null, "创建成功");
});

/**
 * DELETE — 自填软删 { id }。已被本人联盟账号绑定时拒绝（先换绑）。
 */
export const DELETE = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);

  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");
  const parsedId = toBigIntId(id);
  if (!parsedId) return apiError("ID 格式无效");

  const existing = await prisma.payment_methods.findFirst({
    where: { id: parsedId, owner_user_id: userId, is_deleted: 0 },
  });
  if (!existing) return apiError("收款方式不存在");

  const boundCount = await prisma.platform_connections.count({
    where: { payment_method_id: existing.id, is_deleted: 0 },
  });
  if (boundCount > 0) {
    return apiError(`该收款方式仍被 ${boundCount} 个联盟账号绑定，请先在「联盟平台连接」换绑后再删除`);
  }

  await prisma.payment_methods.update({
    where: { id: existing.id },
    data: { is_deleted: 1 },
  });
  return apiSuccess(null, "删除成功");
});
