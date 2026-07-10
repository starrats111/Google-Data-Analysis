import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

/**
 * 团队隐私设置（组长专属）
 *
 * teams.cross_team_visible：
 *  - 0（默认）：本组成员看不到其他组的投放情况，「在投详情」只显示本组成员、在投人数只统计本组
 *  - 1：本组成员可查看其他组的投放情况（全员可见）
 */

/** GET：读取本组当前隐私开关 */
export const GET = withLeader(async (_req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("当前组长未关联小组");
  const team = await prisma.teams.findUnique({
    where: { id: BigInt(user.teamId) },
    select: { id: true, team_name: true, cross_team_visible: true },
  });
  if (!team) return apiError("小组不存在");
  return apiSuccess(serializeData({
    team_id: team.id,
    team_name: team.team_name,
    cross_team_visible: team.cross_team_visible,
  }));
});

/** PUT：更新本组隐私开关 { cross_team_visible: 0 | 1 } */
export const PUT = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("当前组长未关联小组");
  // D-163⑰：请求体解析失败或缺字段时拒绝，而不是静默当 0 写库（会把「全员可见」悄悄关掉）
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return apiError("请求体解析失败，请重试");
  }
  const raw = body.cross_team_visible;
  if (raw === undefined || raw === null) return apiError("缺少 cross_team_visible 参数");
  const value = raw === 1 || raw === "1" || raw === true ? 1 : 0;

  await prisma.teams.update({
    where: { id: BigInt(user.teamId) },
    data: { cross_team_visible: value },
  });
  return apiSuccess(serializeData({ cross_team_visible: value }), "已保存");
});
