import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

// 获取操作日志列表
export const GET = withAdmin(async (req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const page = parseInt(searchParams.get("page") || "1");
  const pageSize = Math.min(parseInt(searchParams.get("pageSize") || "50"), 200);
  const action = searchParams.get("action") || "";
  const username = searchParams.get("username") || "";

  const where: Record<string, unknown> = {};
  if (action) where.action = action;
  if (username) where.username = { contains: username };

  const [total, logs] = await Promise.all([
    prisma.operation_logs.count({ where: where as never }),
    prisma.operation_logs.findMany({
      where: where as never,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return apiSuccess(serializeData({ list: logs, total, page, pageSize }));
});
