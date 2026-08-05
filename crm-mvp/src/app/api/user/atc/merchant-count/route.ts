import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { queryMerchantAtc, extractDomain } from "@/lib/atc-service";
import { getPoolKeys } from "@/lib/serpapi-key-pool";

export const POST = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json() as { merchant_id?: string | number; force_refresh?: boolean; region?: string };

  if (!body.merchant_id) {
    return NextResponse.json({ code: -1, message: "缺少 merchant_id" }, { status: 400 });
  }

  const merchantId = BigInt(body.merchant_id);
  const forceRefresh = body.force_refresh === true;
  const region = (body.region ?? "US").toUpperCase();

  // 1. D-215：取全局共享 key 池，不再只看自己配的 key
  const serpApiKeys = await getPoolKeys();
  if (serpApiKeys.length === 0) {
    return NextResponse.json({ code: -1, message: "系统内暂无可用 SerpApi Key，请在「个人设置 → 广告情报」中配置" }, { status: 400 });
  }

  // 2. 读取商家信息
  const merchant = await prisma.user_merchants.findFirst({
    where: { id: merchantId, user_id: userId, is_deleted: 0 },
    select: { id: true, merchant_name: true, merchant_url: true },
  });
  if (!merchant) {
    return NextResponse.json({ code: -1, message: "商家不存在" }, { status: 404 });
  }

  const domain = extractDomain(merchant.merchant_url);
  if (!domain) {
    return NextResponse.json({ code: -1, message: "该商家未配置域名，无法查询 ATC 数据" }, { status: 400 });
  }

  // 3. 查询（带缓存）
  try {
    const result = await queryMerchantAtc({
      merchantId: merchant.id,
      merchantName: merchant.merchant_name,
      domain,
      region,
      serpApiKeys,
      forceRefresh,
    });

    return NextResponse.json({
      code: 0,
      data: {
        domain: result.domain,
        region: result.region,
        real_count: result.realCount,
        raw_count: result.rawCount,
        top_advertisers: result.topAdvertisers,
        sample_ads: result.sampleAds,
        fetched_at: result.fetchedAt,
        from_cache: result.fromCache,
      },
    });
  } catch (err) {
    // SerpApi 配额/限流/超时类错误返回 429，让前端给出明确提示而非「服务器内部错误」。
    const msg = err instanceof Error ? err.message : String(err);
    if (/SerpApi HTTP 429/i.test(msg)) {
      return NextResponse.json(
        { code: -1, message: "SerpApi 配额暂时已用尽，请稍后再试（或在「个人设置 → 广告情报」补充更多 Key）" },
        { status: 429 },
      );
    }
    if (/SerpApi HTTP 5\d{2}/i.test(msg) || /AbortError|timeout/i.test(msg)) {
      return NextResponse.json(
        { code: -1, message: "SerpApi 暂时不可达，请稍后重试" },
        { status: 503 },
      );
    }
    throw err; // 其它未知错误交给全局 handler
  }
});
