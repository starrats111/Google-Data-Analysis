/**
 * C-093 批量广告主分类 API
 *   POST /api/user/atc/advertiser-classify
 *   body: { advertiser_ids: string[], region?: string, force_refresh?: boolean }
 *   resp: { code, data: { items: Array<{ advertiser_id, classification, unique_domain_count, ad_count, domains, from_cache }> } }
 *
 * 内部并发限流 5，缓存命中 7 天 TTL 不消耗 SerpApi。
 * 单个 advertiser 反查失败不阻塞整体，以 unknown 占位返回。
 */
import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { getOrFetchAdvertiserDomainSnapshot, type AdvertiserDomainSnapshot } from "@/lib/atc-service";

const CONCURRENCY = 5;
const MAX_BATCH = 50; // 单次请求最多 50 个广告主，避免 SerpApi 配额爆炸

export const POST = withUser(async (req: NextRequest, { user }) => {
  const userId = BigInt(user.userId);
  const body = await req.json() as {
    advertiser_ids?: string[];
    region?: string;
    force_refresh?: boolean;
  };

  const ids = Array.isArray(body.advertiser_ids) ? body.advertiser_ids : [];
  if (ids.length === 0) {
    return NextResponse.json({ code: -1, message: "缺少 advertiser_ids" }, { status: 400 });
  }
  if (ids.length > MAX_BATCH) {
    return NextResponse.json(
      { code: -1, message: `单次最多 ${MAX_BATCH} 个广告主，当前传入 ${ids.length} 个` },
      { status: 400 }
    );
  }

  const region = (body.region ?? "US").toUpperCase();
  const forceRefresh = body.force_refresh === true;

  const keyRows = await prisma.user_serpapi_keys.findMany({
    where: { user_id: userId, is_active: 1, is_deleted: 0 },
    select: { api_key: true },
  });
  const serpApiKeys = keyRows.map((r) => r.api_key);
  if (serpApiKeys.length === 0) {
    return NextResponse.json(
      { code: -1, message: "请先在「个人设置 → 广告情报」中配置 SerpApi Key" },
      { status: 400 }
    );
  }

  const uniqueIds = Array.from(new Set(ids.map((x) => x.trim()).filter((x) => x.length > 0)));
  const results = new Map<string, AdvertiserDomainSnapshot | { error: string }>();

  let cursor = 0;
  async function worker() {
    while (cursor < uniqueIds.length) {
      const idx = cursor++;
      const advertiserId = uniqueIds[idx];
      try {
        const snap = await getOrFetchAdvertiserDomainSnapshot({
          advertiserId,
          region,
          serpApiKeys,
          forceRefresh,
        });
        results.set(advertiserId, snap);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.set(advertiserId, { error: message });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const items = uniqueIds.map((advertiserId) => {
    const r = results.get(advertiserId);
    if (!r) {
      return {
        advertiser_id: advertiserId,
        classification: "unknown" as const,
        unique_domain_count: 0,
        qualifying_domain_count: 0,
        ad_count: 0,
        domains: [] as string[],
        domain_details: [] as unknown[],
        ocr_pending: false,
        from_cache: false,
        error: "no result",
      };
    }
    if ("error" in r) {
      return {
        advertiser_id: advertiserId,
        classification: "unknown" as const,
        unique_domain_count: 0,
        qualifying_domain_count: 0,
        ad_count: 0,
        domains: [] as string[],
        domain_details: [] as unknown[],
        ocr_pending: false,
        from_cache: false,
        error: r.error,
      };
    }
    return {
      advertiser_id: r.advertiserId,
      advertiser_name: r.advertiserName,
      classification: r.classification,
      unique_domain_count: r.uniqueDomainCount,
      qualifying_domain_count: r.qualifyingDomainCount,
      ad_count: r.adCount,
      domains: r.domains,
      domain_details: r.domainDetails,
      ocr_pending: r.ocrPending,
      from_cache: r.fromCache,
      fetched_at: r.fetchedAt,
    };
  });

  return NextResponse.json({ code: 0, data: { items, region } });
});
