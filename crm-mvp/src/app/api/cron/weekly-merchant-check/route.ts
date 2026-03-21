import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";

export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET || "";

function verifyCron(req: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  return req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

function log(msg: string) {
  console.log(`[CRON weekly-merchant ${new Date().toISOString()}] ${msg}`);
}

/**
 * GET /api/cron/weekly-merchant-check
 *
 * 每周一 06:00 自动执行（立即返回，后台异步执行）：
 * 对每个用户，调用联盟平台 API 获取最新商家关系状态，
 * 剔除已非 joined 的 claimed 商家，加入新 joined 商家。
 */
export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 立即返回，后台异步执行
  doWeeklyCheck().catch(e => log(`FATAL: ${e instanceof Error ? e.message : String(e)}`));

  return NextResponse.json({ ok: true, message: "weekly merchant check started in background" });
}

async function doWeeklyCheck() {
  const t0 = Date.now();

  try {
    const users = await prisma.users.findMany({
      where: { is_deleted: 0, status: "active", role: { in: ["user", "leader"] } },
      select: { id: true, username: true },
    });

    let totalRemoved = 0, totalAdded = 0;

    for (const user of users) {
      try {
        const result = await checkUserMerchants(user.id, user.username);
        if (result && typeof result === "object" && "removed" in result) {
          totalRemoved += (result as any).removed || 0;
          totalAdded += (result as any).added || 0;
        }
      } catch (e) {
        log(`  ${user.username} error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`All done in ${elapsed}s — removed: ${totalRemoved}, added: ${totalAdded}`);
  } catch (e) {
    log(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function checkUserMerchants(userId: bigint, username: string): Promise<unknown> {
  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0, status: "connected" },
    select: { id: true, platform: true, account_name: true, api_key: true },
  });
  const validConns = conns.filter(c => c.api_key && c.api_key.length > 5);
  if (validConns.length === 0) return { skipped: true };

  log(`Checking ${username} (${validConns.length} conns)...`);

  const { fetchAllMerchants } = await import("@/lib/platform-api");

  const platformMerchants = new Map<string, string>();
  const joinedMerchants = new Map<string, {
    platform: string; merchant_id: string; merchant_name: string;
    category: string; commission_rate: string; merchant_url: string;
    campaign_link: string; supported_regions: string[];
    conn_id: bigint;
  }>();

  for (const conn of validConns) {
    const platform = normalizePlatformCode(conn.platform);
    try {
      const r = await fetchAllMerchants(platform, conn.api_key!);
      for (const m of r.merchants) {
        const key = `${platform}:${m.merchant_id}`;
        platformMerchants.set(key, m.relationship_status);
        if (m.relationship_status === "joined") {
          joinedMerchants.set(key, {
            platform, merchant_id: m.merchant_id, merchant_name: m.merchant_name,
            category: m.category, commission_rate: m.commission_rate,
            merchant_url: m.merchant_url, campaign_link: m.campaign_link,
            supported_regions: m.supported_regions, conn_id: conn.id,
          });
        }
      }
    } catch (e) {
      log(`  ${conn.account_name || platform}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (platformMerchants.size === 0) return { skipped: true, reason: "no data from API" };

  const claimedMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0, status: "claimed" },
    select: { id: true, platform: true, merchant_id: true, merchant_name: true },
  });

  let removed = 0, added = 0;

  for (const m of claimedMerchants) {
    const platform = normalizePlatformCode(m.platform);
    const key = `${platform}:${m.merchant_id}`;
    const currentStatus = platformMerchants.get(key);
    if (currentStatus === undefined) continue;

    if (currentStatus !== "joined") {
      await prisma.user_merchants.update({
        where: { id: m.id },
        data: { status: "available", claimed_at: null },
      });
      removed++;
      log(`  REMOVED: ${m.merchant_name} [${platform}] → ${currentStatus}`);
    }
  }

  const existingKeys = new Set<string>();
  const allMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { platform: true, merchant_id: true },
  });
  for (const m of allMerchants) {
    existingKeys.add(`${normalizePlatformCode(m.platform)}:${m.merchant_id}`);
  }

  for (const [key, m] of joinedMerchants) {
    if (existingKeys.has(key)) continue;
    await prisma.user_merchants.create({
      data: {
        user_id: userId, platform: m.platform, merchant_id: m.merchant_id,
        merchant_name: m.merchant_name, category: m.category || null,
        commission_rate: m.commission_rate || null,
        supported_regions: m.supported_regions.length > 0 ? m.supported_regions : undefined,
        merchant_url: m.merchant_url || null, campaign_link: m.campaign_link || null,
        tracking_link: m.campaign_link || null, platform_connection_id: m.conn_id,
        status: "available",
      },
    });
    added++;
    log(`  ADDED: ${m.merchant_name} [${m.platform}]`);
  }

  if (removed > 0 || added > 0) {
    const parts: string[] = [];
    if (removed > 0) parts.push(`剔除 ${removed} 个非 joined 商家`);
    if (added > 0) parts.push(`新增 ${added} 个 joined 商家`);
    await prisma.notifications.create({
      data: { user_id: userId, title: "商家关系周检", content: parts.join("；"), type: "system" },
    }).catch(() => {});
  }

  log(`  ${username}: removed=${removed}, added=${added}`);
  return { checked: claimedMerchants.length, removed, added };
}
