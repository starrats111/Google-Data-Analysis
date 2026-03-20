import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

// 获取小组列表
export const GET = withAdmin(async () => {
  const teams = await prisma.teams.findMany({
    where: { is_deleted: 0 },
    select: { id: true, team_code: true, team_name: true, leader_id: true },
    orderBy: { id: "asc" },
  });

  return apiSuccess(serializeData({ list: teams }));
});
