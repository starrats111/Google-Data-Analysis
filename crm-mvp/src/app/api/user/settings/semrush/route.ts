import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

// 方案-09：员工自配 SemRush(3UE) 账号。对标 SerpApi 的 user_serpapi_keys，
// 每员工各用各账号配额，根治共享账号批量并发设备超限。密码明文存储（Q09-d，与全局 system_configs 一致）。

function maskTail(s: string, head = 3): string {
  if (!s) return "";
  return `${s.slice(0, head)}${"*".repeat(Math.max(0, s.length - head))}`;
}

// GET — 当前用户的 SemRush 账号列表（脱敏）
export const GET = withUser(async (_req, { user }) => {
  const userId = BigInt(user.userId);
  const rows = await prisma.user_semrush_keys.findMany({
    where: { user_id: userId, is_deleted: 0 },
    orderBy: { created_at: "asc" },
    select: {
      id: true, key_name: true, username: true, user_id_3ue: true,
      api_key: true, node: true, database: true, is_active: true, created_at: true,
    },
  });
  const data = rows.map((r) => ({
    id: r.id.toString(),
    key_name: r.key_name,
    username: r.username,
    user_id_3ue: r.user_id_3ue,
    masked_api_key: maskTail(r.api_key, 6),
    node: r.node,
    database: r.database,
    is_active: r.is_active === 1,
    created_at: r.created_at,
  }));
  return NextResponse.json({ code: 0, data });
});

// POST — 新增一个 SemRush 账号
export const POST = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json() as {
    key_name?: string; username?: string; password?: string;
    user_id_3ue?: string; api_key?: string; node?: string; database?: string;
  };

  const username = (body.username ?? "").trim();
  const password = (body.password ?? "").trim();
  const userId3ue = (body.user_id_3ue ?? "").trim();
  const apiKey = (body.api_key ?? "").trim();
  if (!username || !password || !userId3ue || !apiKey) {
    return NextResponse.json({ code: -1, message: "用户名/密码/UserID/ApiKey 均不能为空" }, { status: 400 });
  }

  const existing = await prisma.user_semrush_keys.findFirst({
    where: { user_id: userId, username, is_deleted: 0 },
  });
  if (existing) return NextResponse.json({ code: -1, message: "该 SemRush 账号已存在" }, { status: 400 });

  const count = await prisma.user_semrush_keys.count({ where: { user_id: userId, is_deleted: 0 } });
  const keyName = (body.key_name ?? "").trim() || `账号 ${count + 1}`;

  await prisma.user_semrush_keys.create({
    data: {
      user_id: userId,
      key_name: keyName,
      username,
      password,
      user_id_3ue: userId3ue,
      api_key: apiKey,
      node: (body.node ?? "").trim() || "3",
      database: (body.database ?? "").trim() || "us",
    },
  });
  return NextResponse.json({ code: 0, message: "添加成功" });
});

// PATCH — 修改备注名 / 启停 / 字段
export const PATCH = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json() as {
    id?: string; key_name?: string; is_active?: boolean;
    password?: string; user_id_3ue?: string; api_key?: string; node?: string; database?: string;
  };
  if (!body.id) return NextResponse.json({ code: -1, message: "缺少 id" }, { status: 400 });

  const keyId = BigInt(body.id);
  const row = await prisma.user_semrush_keys.findFirst({ where: { id: keyId, user_id: userId, is_deleted: 0 } });
  if (!row) return NextResponse.json({ code: -1, message: "账号不存在" }, { status: 404 });

  const update: Record<string, unknown> = {};
  if (body.key_name !== undefined) update.key_name = body.key_name.trim() || row.key_name;
  if (body.is_active !== undefined) update.is_active = body.is_active ? 1 : 0;
  if (body.password !== undefined && body.password.trim()) update.password = body.password.trim();
  if (body.user_id_3ue !== undefined && body.user_id_3ue.trim()) update.user_id_3ue = body.user_id_3ue.trim();
  if (body.api_key !== undefined && body.api_key.trim()) update.api_key = body.api_key.trim();
  if (body.node !== undefined && body.node.trim()) update.node = body.node.trim();
  if (body.database !== undefined && body.database.trim()) update.database = body.database.trim();

  await prisma.user_semrush_keys.update({ where: { id: keyId }, data: update });
  return NextResponse.json({ code: 0, message: "已更新" });
});

// DELETE — 软删除
export const DELETE = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json() as { id?: string };
  if (!body.id) return NextResponse.json({ code: -1, message: "缺少 id" }, { status: 400 });

  const keyId = BigInt(body.id);
  const row = await prisma.user_semrush_keys.findFirst({ where: { id: keyId, user_id: userId, is_deleted: 0 } });
  if (!row) return NextResponse.json({ code: -1, message: "账号不存在" }, { status: 404 });

  await prisma.user_semrush_keys.update({ where: { id: keyId }, data: { is_deleted: 1 } });
  return NextResponse.json({ code: 0, message: "已删除" });
});

// PUT — 测试连接（用提交的凭据或已存 id 的凭据实查一个域名验证）
export const PUT = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json() as {
    id?: string; username?: string; password?: string;
    user_id_3ue?: string; api_key?: string; node?: string; database?: string;
  };

  let username = (body.username ?? "").trim();
  let password = (body.password ?? "").trim();
  let userId3ue = (body.user_id_3ue ?? "").trim();
  let apiKey = (body.api_key ?? "").trim();
  let node = (body.node ?? "").trim() || "3";
  let database = (body.database ?? "").trim() || "us";

  // 未直接传凭据但传了 id → 从库取（PATCH 后再测、或列表里点测试）
  if ((!username || !password || !userId3ue || !apiKey) && body.id) {
    const row = await prisma.user_semrush_keys.findFirst({
      where: { id: BigInt(body.id), user_id: userId, is_deleted: 0 },
    });
    if (!row) return NextResponse.json({ code: -1, message: "账号不存在" }, { status: 404 });
    username = row.username; password = row.password; userId3ue = row.user_id_3ue;
    apiKey = row.api_key; node = row.node || "3"; database = row.database || "us";
  }

  if (!username || !password || !userId3ue || !apiKey) {
    return NextResponse.json({ code: -1, message: "请填写完整凭据或提供已保存账号 id" }, { status: 400 });
  }

  try {
    const { SemRushClient } = await import("@/lib/semrush-client");
    const client = new SemRushClient({
      username, password, userId: userId3ue, apiKey, database,
      nodeConfig: { chatNode: node, chatLang: "zh_CN", semrushNode: node, semrushLang: "zh" },
    });
    // 实查一个有数据的域名验证登录 + RPC 通路（返回即视为账号有效，关键词多少不影响）
    const result = await client.queryDomain("nike.com");
    return NextResponse.json({
      code: 0,
      message: `账号有效，连接正常（测试域名返回 ${result.keywords.length} 个关键词）`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ code: -1, message: `账号无效或连接失败: ${msg}` });
  }
});
