import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

function maskKey(key: string): string {
  return `${key.slice(0, 8)}${"*".repeat(Math.max(0, key.length - 8))}`;
}

// GET — 返回当前用户所有 SerpApi Key 列表（脱敏）
export const GET = withUser(async (_req, { user }) => {
  const userId = BigInt(user.userId);
  const rows = await prisma.user_serpapi_keys.findMany({
    where: { user_id: userId, is_deleted: 0 },
    orderBy: { created_at: "asc" },
    select: { id: true, key_name: true, api_key: true, is_active: true, created_at: true },
  });
  const data = rows.map((r) => ({
    id: r.id.toString(),
    key_name: r.key_name,
    masked_key: maskKey(r.api_key),
    is_active: r.is_active === 1,
    created_at: r.created_at,
  }));
  return NextResponse.json({ code: 0, data });
});

// POST — 新增一个 SerpApi Key
export const POST = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json() as { key_name?: string; api_key?: string };

  const apiKey = (body.api_key ?? "").trim();
  if (!apiKey) return NextResponse.json({ code: -1, message: "Key 不能为空" }, { status: 400 });
  if (apiKey.length < 10) return NextResponse.json({ code: -1, message: "Key 格式不正确" }, { status: 400 });

  // 检查是否已存在相同 key（避免重复添加）
  const existing = await prisma.user_serpapi_keys.findFirst({
    where: { user_id: userId, api_key: apiKey, is_deleted: 0 },
  });
  if (existing) return NextResponse.json({ code: -1, message: "该 Key 已存在" }, { status: 400 });

  // 自动生成备注名
  const count = await prisma.user_serpapi_keys.count({ where: { user_id: userId, is_deleted: 0 } });
  const keyName = (body.key_name ?? "").trim() || `Key ${count + 1}`;

  await prisma.user_serpapi_keys.create({
    data: { user_id: userId, key_name: keyName, api_key: apiKey },
  });
  return NextResponse.json({ code: 0, message: "添加成功" });
});

// PATCH — 修改 Key 名称 / 启用禁用
export const PATCH = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json() as { id?: string; key_name?: string; is_active?: boolean };

  if (!body.id) return NextResponse.json({ code: -1, message: "缺少 id" }, { status: 400 });

  const keyId = BigInt(body.id);
  const row = await prisma.user_serpapi_keys.findFirst({ where: { id: keyId, user_id: userId, is_deleted: 0 } });
  if (!row) return NextResponse.json({ code: -1, message: "Key 不存在" }, { status: 404 });

  const update: Record<string, unknown> = {};
  if (body.key_name !== undefined) update.key_name = body.key_name.trim() || row.key_name;
  if (body.is_active !== undefined) update.is_active = body.is_active ? 1 : 0;

  await prisma.user_serpapi_keys.update({ where: { id: keyId }, data: update });
  return NextResponse.json({ code: 0, message: "已更新" });
});

// DELETE — 删除指定 Key
export const DELETE = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json() as { id?: string };
  if (!body.id) return NextResponse.json({ code: -1, message: "缺少 id" }, { status: 400 });

  const keyId = BigInt(body.id);
  const row = await prisma.user_serpapi_keys.findFirst({ where: { id: keyId, user_id: userId, is_deleted: 0 } });
  if (!row) return NextResponse.json({ code: -1, message: "Key 不存在" }, { status: 404 });

  await prisma.user_serpapi_keys.update({ where: { id: keyId }, data: { is_deleted: 1 } });
  return NextResponse.json({ code: 0, message: "已删除" });
});

// PUT — 测试指定 Key 是否有效
export const PUT = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json() as { id?: string; api_key?: string };

  let testKey = (body.api_key ?? "").trim();

  // 如果传了 id，从数据库取原始 Key
  if (!testKey && body.id) {
    const row = await prisma.user_serpapi_keys.findFirst({
      where: { id: BigInt(body.id), user_id: userId, is_deleted: 0 },
      select: { api_key: true },
    });
    if (!row) return NextResponse.json({ code: -1, message: "Key 不存在" }, { status: 404 });
    testKey = row.api_key;
  }

  if (!testKey) return NextResponse.json({ code: -1, message: "请提供 Key 或 id" }, { status: 400 });

  try {
    const qs = new URLSearchParams({
      engine: "google_ads_transparency_center",
      domain: "nike.com",
      region: "US",
      num: "1",
      api_key: testKey,
    }).toString();
    const res = await fetch(`https://serpapi.com/search?${qs}`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json() as { error?: string };
    if (data.error) return NextResponse.json({ code: -1, message: `Key 无效: ${data.error}` });
    return NextResponse.json({ code: 0, message: "Key 有效，连接正常" });
  } catch (err) {
    return NextResponse.json({ code: -1, message: `连接失败: ${err instanceof Error ? err.message : String(err)}` });
  }
});
