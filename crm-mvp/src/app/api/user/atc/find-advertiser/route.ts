import { NextRequest, NextResponse } from "next/server";
import { withUser } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { findArIdByName, pickApiKey } from "@/lib/atc-service";

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

  // ② 本地无结果 → 用 Google Search 探测 ATC 主页中的 AR ID
  try {
    const keyRows = await prisma.user_serpapi_keys.findMany({
      where: { user_id: user.id, is_active: true },
      select: { api_key: true },
    });
    const keys = keyRows.map((r) => r.api_key);
    if (keys.length > 0) {
      const apiKey = pickApiKey(keys);
      const arId = await findArIdByName(name, apiKey);
      if (arId) {
        return NextResponse.json({
          code: 0,
          data: [{ id: arId, name, domains: [], source: "google_search" }],
        });
      }
    }
  } catch {
    // 兜底：Google Search 失败不影响主流程
  }

  return NextResponse.json({ code: 0, data: [] });
});
