import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { searchIntelligence } from "@/lib/atc-service";

export const GET = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const { searchParams } = req.nextUrl;
  const text = (searchParams.get("text") ?? "").trim();
  const region = (searchParams.get("region") ?? "US").toUpperCase();

  if (!text) {
    return NextResponse.json({ code: -1, message: "请输入广告主名称" }, { status: 400 });
  }

  // 读取用户 SerpApi Key
  const userRow = await prisma.users.findUnique({
    where: { id: userId },
    select: { serpapi_key: true },
  });
  if (!userRow?.serpapi_key) {
    return NextResponse.json({ code: -1, message: "请先在「个人设置 → 广告情报」中配置 SerpApi Key" }, { status: 400 });
  }

  const result = await searchIntelligence({
    text,
    region,
    serpApiKey: userRow.serpapi_key,
  });

  return NextResponse.json({
    code: 0,
    data: result,
  });
});
