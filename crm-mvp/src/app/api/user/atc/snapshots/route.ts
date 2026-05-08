import { NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { extractDomain } from "@/lib/atc-service";

/**
 * GET /api/user/atc/snapshots
 * 批量返回当前用户所有商家的 ATC 快照（广告主列表、竞争数、区域）
 * 供页面加载时预填充，无需重新查询 SerpApi
 */
export const GET = withUser(async (_req, { user }) => {
  const userId = BigInt(user.userId);

  // 1. 读取该用户所有有 URL 的商家
  const merchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0, atc_sync_status: "done" },
    select: {
      id: true,
      merchant_name: true,
      merchant_url: true,
      atc_advertiser_count: true,
      atc_last_synced_at: true,
    },
  });

  // 2. 提取 domain，去重后批量查快照
  const domainToMerchantId = new Map<string, string[]>();
  for (const m of merchants) {
    const domain = extractDomain(m.merchant_url);
    if (!domain) continue;
    if (!domainToMerchantId.has(domain)) domainToMerchantId.set(domain, []);
    domainToMerchantId.get(domain)!.push(String(m.id));
  }

  const domains = Array.from(domainToMerchantId.keys());
  if (domains.length === 0) return NextResponse.json({ code: 0, data: {} });

  const snapshots = await prisma.merchant_atc_snapshots.findMany({
    where: { domain: { in: domains } },
    select: {
      domain: true,
      region: true,
      real_advertiser_count: true,
      top_advertisers_json: true,
      fetched_at: true,
    },
    orderBy: { fetched_at: "desc" },
  });

  // 3. 构建 merchantId → snapshot 映射（每个 domain 取最新快照）
  const domainSnapshotMap = new Map<string, typeof snapshots[number]>();
  for (const snap of snapshots) {
    if (!domainSnapshotMap.has(snap.domain)) {
      domainSnapshotMap.set(snap.domain, snap);
    }
  }

  // 4. 输出 merchantId → { count, region, topAdvertisers, syncedAt }
  const result: Record<string, {
    count: number;
    region: string;
    topAdvertisers: { id: string; name: string }[];
    syncedAt: string;
  }> = {};

  for (const [domain, merchantIds] of domainToMerchantId) {
    const snap = domainSnapshotMap.get(domain);
    if (!snap) continue;
    const topAdvertisers = (snap.top_advertisers_json as { id: string; name: string }[] | null) ?? [];
    for (const id of merchantIds) {
      result[id] = {
        count: snap.real_advertiser_count,
        region: snap.region,
        topAdvertisers,
        syncedAt: snap.fetched_at.toISOString(),
      };
    }
  }

  return NextResponse.json({ code: 0, data: result });
});
