import prisma from "@/lib/prisma";

/**
 * 团队隐私可见性（组长控制的 teams.cross_team_visible 开关）
 *
 * 业务语义：
 *  - cross_team_visible = 0（默认）：本组成员只能看到「本组」的投放情况，
 *    商家「在投详情」弹窗只显示本组成员、列表「在投人数」也只统计本组。
 *  - cross_team_visible = 1：本组成员可查看「其他组」的投放情况（全员可见，旧行为）。
 *
 * 注意：开关挂在 viewer 自己所在的组上，由该组组长设置；
 * 无组用户（team_id 为空）默认视为不可跨组（只看同为无组的人）。
 */
export interface TeamVisibility {
  teamId: bigint | null;
  canSeeOtherTeams: boolean;
}

/** 解析某个查看者的团队可见性配置 */
export async function getTeamVisibility(userId: bigint): Promise<TeamVisibility> {
  const me = await prisma.users.findUnique({
    where: { id: userId },
    select: { team_id: true },
  });
  const teamId = me?.team_id ?? null;
  if (teamId == null) {
    // 无组用户：没有组级开关，默认不可跨组
    return { teamId: null, canSeeOtherTeams: false };
  }
  const team = await prisma.teams.findUnique({
    where: { id: teamId },
    select: { cross_team_visible: true },
  });
  return { teamId, canSeeOtherTeams: (team?.cross_team_visible ?? 0) === 1 };
}

/**
 * 根据可见性返回「允许查看的 user_id 集合」。
 *  - canSeeOtherTeams = true  → 返回 null，表示不做限制（可见全员）。
 *  - canSeeOtherTeams = false → 返回与查看者同组的 user_id 集合（含查看者自己）。
 */
export async function getVisibleUserIdSet(
  vis: TeamVisibility,
): Promise<Set<string> | null> {
  if (vis.canSeeOtherTeams) return null;
  // team_id 为 null 时 Prisma 会生成 IS NULL，即「无组成员之间互相可见」
  const teammates = await prisma.users.findMany({
    where: { team_id: vis.teamId, is_deleted: 0 } as never,
    select: { id: true },
  });
  return new Set(teammates.map((u) => u.id.toString()));
}
