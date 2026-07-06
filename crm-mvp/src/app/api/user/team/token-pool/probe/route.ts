import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { probeTeamTokens } from "@/lib/google-ads/token-probe";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function resolveTeamId(userId: string, tokenTeamId?: string): Promise<bigint | null> {
  if (tokenTeamId) return BigInt(tokenTeamId);
  const u = await prisma.users.findFirst({
    where: { id: BigInt(userId), is_deleted: 0 },
    select: { team_id: true },
  });
  return u?.team_id ?? null;
}

/**
 * POST /api/user/team/token-pool/probe
 * 组长手动触发本组 token 池体检 { id? }（不传 = 检测全部活跃 token）。
 * 对每个凭证对逐一向本组各 MCC 发最便宜的探测查询，自动写回可用性标记。
 */
export const POST = withLeader(async (req: NextRequest, { user }) => {
  const teamId = await resolveTeamId(user.userId, user.teamId);
  if (!teamId) return apiError("未关联小组");

  const body = await req.json().catch(() => ({}));
  const tokenId = body?.id ? BigInt(body.id) : null;

  const results = await probeTeamTokens(teamId, tokenId);
  if (results.length === 0) return apiError("没有可探测的 Token（池为空或该记录不存在）");
  return apiSuccess(results, "检测完成");
});
