import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { findArIdByName, pickApiKey } from "@/lib/atc-service";

/**
 * 在已知快照域名中实时搜索广告主名称，找到对应 AR ID。
 * 适用于：本地快照因日期窗口或数量限制未记录该广告主时的兜底发现。
 */
async function discoverArIdByDomainSearch(
  name: string,
  serpApiKey: string,
  snapshotDomains: string[],
): Promise<{ id: string; name: string; domains: string[] } | null> {
  if (snapshotDomains.length === 0) return null;

  const lowerName = name.toLowerCase();

  for (const domain of snapshotDomains.slice(0, 5)) {
    try {
      const qs = new URLSearchParams({
        engine: "google_ads_transparency_center",
        text: domain,
        num: "100",
        api_key: serpApiKey,
      }).toString();
      const res = await fetch(`https://serpapi.com/search?${qs}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { ad_creatives?: Array<{ advertiser_id?: string; advertiser?: string; target_domain?: string }> };
      const ads = data.ad_creatives ?? [];
      for (const ad of ads) {
        if ((ad.advertiser ?? "").toLowerCase().includes(lowerName) && ad.advertiser_id) {
          return { id: ad.advertiser_id, name: ad.advertiser!, domains: [domain] };
        }
      }
    } catch {
      // 单域名失败不影响其他域名
    }
  }
  return null;
}

/**
 * GET /api/user/atc/find-advertiser?name=包新蕾
 * 1. 先在本地快照 DB 中按名称模糊搜索
 * 2. 若本地无结果，用 Google Search 搜索 ATC 主页，提取 AR ID
 */
export const GET = withUser(async (req: NextRequest, { user }: { user: { id: bigint } }) => {
  const { searchParams } = req.nextUrl;
  const name = (searchParams.get("name") ?? "").trim();
  if (!name) return NextResponse.json({ code: 0, data: [] });

  // ① 本地快照搜索
  const snapshots = await prisma.merchant_atc_snapshots.findMany({
    select: { domain: true, top_advertisers_json: true },
    where: { top_advertisers_json: { not: null } },
  });

  const lowerName = name.toLowerCase();
  const found = new Map<string, { id: string; name: string; domains: string[] }>();

  for (const snap of snapshots) {
    const list = snap.top_advertisers_json as { id: string; name: string }[] | null;
    if (!Array.isArray(list)) continue;
    for (const adv of list) {
      if ((adv.name ?? "").toLowerCase().includes(lowerName)) {
        if (!found.has(adv.id)) {
          found.set(adv.id, { id: adv.id, name: adv.name, domains: [] });
        }
        found.get(adv.id)!.domains.push(snap.domain);
      }
    }
  }

  if (found.size > 0) {
    return NextResponse.json({ code: 0, data: Array.from(found.values()).slice(0, 10) });
  }

  // ② 本地无结果 → 获取 SerpApi Key
  let serpApiKey: string | null = null;
  try {
    const keyRows = await prisma.user_serpapi_keys.findMany({
      where: { user_id: user.id, is_active: true },
      select: { api_key: true },
    });
    const keys = keyRows.map((r) => r.api_key);
    if (keys.length > 0) serpApiKey = pickApiKey(keys);
  } catch { /* ignore */ }

  if (serpApiKey) {
    // ② a. Google Search 探测 ATC 主页中的 AR ID（带名称验证，防止返回错误广告主）
    try {
      const arId = await findArIdByName(name, serpApiKey);
      if (arId) {
        return NextResponse.json({
          code: 0,
          data: [{ id: arId, name, domains: [], source: "google_search" }],
        });
      }
    } catch { /* ignore */ }

    // ② b. 域名扫描兜底：对本地已知快照域名做实时 SerpApi 搜索，按名称找 AR ID
    // 适用于：快照因日期窗口过窄或数量上限未记录该广告主时（如龚建成只偶尔投放）
    try {
      const knownDomains = snapshots.map((s) => s.domain).filter(Boolean);
      const discovered = await discoverArIdByDomainSearch(name, serpApiKey, knownDomains);
      if (discovered) {
        return NextResponse.json({
          code: 0,
          data: [{ ...discovered, source: "domain_scan" }],
        });
      }
    } catch { /* ignore */ }
  }

  return NextResponse.json({ code: 0, data: [] });
});
