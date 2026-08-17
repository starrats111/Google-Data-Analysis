import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getUserFromRequest } from "@/lib/auth";

// D-239 表格列展示偏好：每用户 × 每表格一条，config = { columns: string[] }（可见列 key 的有序数组）

const TABLE_KEY_RE = /^[a-z0-9-]{1,64}$/;

// GET /api/user/table-preferences?table=data-center-campaigns — 读取列偏好（未配置返回 null）
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return NextResponse.json({ code: 401, message: "未登录" });

  const tableKey = req.nextUrl.searchParams.get("table") || "";
  if (!TABLE_KEY_RE.test(tableKey)) {
    return NextResponse.json({ code: 400, message: "table 参数不合法" });
  }

  const pref = await prisma.user_table_preferences.findUnique({
    where: { user_id_table_key: { user_id: BigInt(user.userId), table_key: tableKey } },
  });

  return NextResponse.json({
    code: 0,
    data: pref && !pref.is_deleted ? { config: pref.config } : { config: null },
  });
}

// PUT /api/user/table-preferences — 保存列偏好 { table, columns: string[] }
export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return NextResponse.json({ code: 401, message: "未登录" });

  const body = await req.json().catch(() => null);
  const tableKey = typeof body?.table === "string" ? body.table : "";
  const columns = body?.columns;

  if (!TABLE_KEY_RE.test(tableKey)) {
    return NextResponse.json({ code: 400, message: "table 参数不合法" });
  }
  if (
    !Array.isArray(columns) ||
    columns.length === 0 ||
    columns.length > 100 ||
    columns.some((c) => typeof c !== "string" || c.length > 64)
  ) {
    return NextResponse.json({ code: 400, message: "columns 必须是非空字符串数组" });
  }

  const config = { columns };
  await prisma.user_table_preferences.upsert({
    where: { user_id_table_key: { user_id: BigInt(user.userId), table_key: tableKey } },
    update: { config, is_deleted: 0 },
    create: { user_id: BigInt(user.userId), table_key: tableKey, config },
  });

  return NextResponse.json({ code: 0, message: "ok" });
}
