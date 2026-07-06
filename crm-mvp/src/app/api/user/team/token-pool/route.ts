import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getTokenCooldown, maskToken } from "@/lib/google-ads/token-pool";

export const dynamic = "force-dynamic";

const MIN_TOKEN_LENGTH = 15;

/** 解析组长所属 team_id（token 里没有时查库兜底） */
async function resolveTeamId(userId: string, tokenTeamId?: string): Promise<bigint | null> {
  if (tokenTeamId) return BigInt(tokenTeamId);
  const u = await prisma.users.findFirst({
    where: { id: BigInt(userId), is_deleted: 0 },
    select: { team_id: true },
  });
  return u?.team_id ?? null;
}

/**
 * GET /api/user/team/token-pool
 * 本组 Developer Token 池清单（组长专属）。附带各 token 当前是否在 429 冷却中。
 */
export const GET = withLeader(async (_req: NextRequest, { user }) => {
  const teamId = await resolveTeamId(user.userId, user.teamId);
  if (!teamId) return apiError("未关联小组");

  const rows = await prisma.team_developer_tokens.findMany({
    where: { team_id: teamId, is_deleted: 0 },
    orderBy: { created_at: "asc" },
  });

  const data = rows.map((r) => {
    const cooldown = getTokenCooldown(r.token);
    return {
      id: r.id,
      token: r.token,
      token_masked: maskToken(r.token),
      label: r.label,
      is_active: r.is_active,
      created_at: r.created_at,
      cooling_until: cooldown ? cooldown.toISOString() : null,
    };
  });
  return apiSuccess(serializeData(data));
});

/**
 * POST /api/user/team/token-pool
 * 组长新增/编辑 token { id?, token, label?, is_active? }
 */
export const POST = withLeader(async (req: NextRequest, { user }) => {
  const teamId = await resolveTeamId(user.userId, user.teamId);
  if (!teamId) return apiError("未关联小组");

  const body = await req.json();
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 64) : "";
  const isActive = body.is_active === 0 ? 0 : 1;

  if (!token) return apiError("Token 不能为空");
  if (token.length < MIN_TOKEN_LENGTH || token.length > 64) {
    return apiError(`Token 长度异常（${token.length} 位）。Google Ads Developer Token 一般为 22 位，请检查是否复制完整`);
  }

  if (body.id) {
    const existing = await prisma.team_developer_tokens.findFirst({
      where: { id: BigInt(body.id), team_id: teamId, is_deleted: 0 },
    });
    if (!existing) return apiError("该 Token 记录不存在");
    const dup = await prisma.team_developer_tokens.findFirst({
      where: { team_id: teamId, token, is_deleted: 0, id: { not: existing.id } },
    });
    if (dup) return apiError("该 Token 已存在于本组池中");
    await prisma.team_developer_tokens.update({
      where: { id: existing.id },
      data: { token, label: label || null, is_active: isActive },
    });
    return apiSuccess(null, "保存成功");
  }

  const dup = await prisma.team_developer_tokens.findFirst({
    where: { team_id: teamId, token, is_deleted: 0 },
  });
  if (dup) return apiError("该 Token 已存在于本组池中");

  await prisma.team_developer_tokens.create({
    data: { team_id: teamId, token, label: label || null, is_active: isActive, created_by: BigInt(user.userId) },
  });
  return apiSuccess(null, "已加入 Token 池（1 分钟内生效）");
});

/**
 * DELETE /api/user/team/token-pool
 * 组长移除 token { id }（软删）
 */
export const DELETE = withLeader(async (req: NextRequest, { user }) => {
  const teamId = await resolveTeamId(user.userId, user.teamId);
  if (!teamId) return apiError("未关联小组");

  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");

  const existing = await prisma.team_developer_tokens.findFirst({
    where: { id: BigInt(id), team_id: teamId, is_deleted: 0 },
  });
  if (!existing) return apiError("该 Token 记录不存在");

  await prisma.team_developer_tokens.update({
    where: { id: existing.id },
    data: { is_deleted: 1 },
  });
  return apiSuccess(null, "已移除");
});
