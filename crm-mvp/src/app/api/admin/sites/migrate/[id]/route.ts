import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

// 查询单个迁移任务进度
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return apiError("缺少任务 ID");

  const task = await prisma.site_migrations.findUnique({ where: { id: BigInt(id) } });
  if (!task) return apiError("任务不存在", 404);

  return apiSuccess(serializeData(task));
}
