import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import { searchIntelligence } from "@/lib/atc-service";
import { getPoolKeys } from "@/lib/serpapi-key-pool";

export const GET = withUser(async (req: NextRequest) => {
  const { searchParams } = req.nextUrl;
  const text          = (searchParams.get("text") ?? "").trim();
  const advertiser_id = (searchParams.get("advertiser_id") ?? "").trim();
  const region        = (searchParams.get("region") ?? "US").toUpperCase();

  if (!text && !advertiser_id) {
    return NextResponse.json({ code: -1, message: "请输入广告主名称或 ID" }, { status: 400 });
  }

  // D-215：取全局共享 key 池，不再只看自己配的 key
  const serpApiKeys = await getPoolKeys();
  if (serpApiKeys.length === 0) {
    return NextResponse.json({ code: -1, message: "系统内暂无可用 SerpApi Key，请联系管理员在「管理员控制台 → SerpApi Key 池」配置" }, { status: 400 });
  }

  const result = await searchIntelligence({
    text:          text || undefined,
    advertiser_id: advertiser_id || undefined,
    region,
    serpApiKeys,
  });

  return NextResponse.json({
    code: 0,
    data: result,
  });
});
