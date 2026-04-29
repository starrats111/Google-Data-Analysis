import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * GET /api/user/data-center/txn-version
 *
 * 返回当前用户的交易数据版本戳（ISO 时间字符串）。
 * 前端每 60 秒轮询此接口，版本变化时局部刷新交易相关页面。
 * 接口极其轻量（单行 system_configs 查询），不会对服务器造成压力。
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const key = `txn_version_${user.userId}`;
  const row = await prisma.system_configs.findFirst({
    where: { config_key: key, is_deleted: 0 },
    select: { config_value: true, updated_at: true },
  });

  // 若从未同步过，返回当前时间作为初始版本（前端记录后开始追踪变化）
  const version = row?.config_value ?? new Date().toISOString();

  return apiSuccess({ version });
}
