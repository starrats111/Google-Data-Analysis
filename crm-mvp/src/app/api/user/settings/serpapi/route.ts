import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";

// GET — 读取当前用户 SerpApi Key
export const GET = withUser(async (_req, { user }) => {
  const userId = BigInt(user.userId);
  const row = await prisma.users.findUnique({
    where: { id: userId },
    select: { serpapi_key: true },
  });
  // Key 脱敏：只显示前 8 位 + 星号
  const key = row?.serpapi_key ?? null;
  const masked = key ? `${key.slice(0, 8)}${"*".repeat(Math.max(0, key.length - 8))}` : null;
  return NextResponse.json({ code: 0, data: { has_key: !!key, masked_key: masked } });
});

// POST — 保存 / 删除 SerpApi Key
export const POST = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json() as { action?: string; serpapi_key?: string };

  if (body.action === "delete") {
    await prisma.users.update({ where: { id: userId }, data: { serpapi_key: null } });
    return NextResponse.json({ code: 0, message: "已删除 SerpApi Key" });
  }

  const key = (body.serpapi_key ?? "").trim();
  if (!key) return NextResponse.json({ code: -1, message: "Key 不能为空" }, { status: 400 });
  if (key.length < 10) return NextResponse.json({ code: -1, message: "Key 格式不正确" }, { status: 400 });

  await prisma.users.update({ where: { id: userId }, data: { serpapi_key: key } });
  return NextResponse.json({ code: 0, message: "保存成功" });
});

// POST action=test — 验证 Key 是否有效
export const PUT = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json() as { serpapi_key?: string };
  const keyToTest = (body.serpapi_key ?? "").trim();

  if (!keyToTest) {
    // 从数据库读取已保存的 Key
    const row = await prisma.users.findUnique({ where: { id: userId }, select: { serpapi_key: true } });
    if (!row?.serpapi_key) return NextResponse.json({ code: -1, message: "尚未配置 SerpApi Key" }, { status: 400 });
  }

  const testKey = keyToTest || ((await prisma.users.findUnique({ where: { id: userId }, select: { serpapi_key: true } }))?.serpapi_key ?? "");

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
