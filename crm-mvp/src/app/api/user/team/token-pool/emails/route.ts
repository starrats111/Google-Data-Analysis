import { NextRequest } from "next/server";
import { apiSuccess } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * GET /api/user/team/token-pool/emails
 * D-276：本组 Token 池启用凭证的服务邮箱（client_email）去重列表。
 * 组员可访问（父级 token-pool 是组长专属）；只回邮箱，不回 token/私钥/用量。
 * 用途：添加 MCC 弹窗提示「需要给以下服务邮箱授权」。
 */
export const GET = withUser(async (_req: NextRequest, { user }) => {
  let teamId = user.teamId ? BigInt(user.teamId) : null;
  if (!teamId) {
    const u = await prisma.users.findFirst({
      where: { id: BigInt(user.userId), is_deleted: 0 },
      select: { team_id: true },
    });
    teamId = u?.team_id ?? null;
  }
  if (!teamId) return apiSuccess([]);

  const rows = await prisma.team_developer_tokens.findMany({
    where: { team_id: teamId, is_deleted: 0, is_active: 1 },
    select: { service_account_json: true },
    orderBy: { created_at: "asc" },
  });

  const emails: string[] = [];
  for (const r of rows) {
    try {
      const email = r.service_account_json
        ? JSON.parse(r.service_account_json).client_email
        : null;
      if (typeof email === "string" && email && !emails.includes(email)) {
        emails.push(email);
      }
    } catch {
      // 凭证 JSON 解析失败的条目跳过，不影响其余邮箱展示
    }
  }
  return apiSuccess(emails);
});
