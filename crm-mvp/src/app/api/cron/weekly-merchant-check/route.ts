import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";

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
 * 每周一 06:00 自动执行：
 * 对每个用户，调用联盟平台 API 获取最新商家关系状态，
 * 剔除已非 joined 的 claimed 商家，加入新 joined 商家。
 */
export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const t0 = Date.now();
  const results: Record<string, unknown> = {};

  try {
    const users = await prisma.users.findMany({
      where: { is_deleted: 0, status: "active", role: { in: ["user", "leader"] } },
      select: { id: true, username: true },
    });

    for (const user of users) {
      try {
        results[user.username] = await checkUserMerchants(user.id, user.username);
      } catch (e) {
        results[user.username] = { error: e instanceof Error ? e.message : String(e) };
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`All done in ${elapsed}s`);
    return NextResponse.json({ ok: true, elapsed_s: elapsed, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`FATAL: ${msg}`);
    return NextResponse.json({ ok: false, error: msg, results }, { status: 500 });
  }
}

async function checkUserMerchants(userId: bigint, username: string): Promise<unknown> {
  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0, status: "connected" },
    select: { id: true, platform: true, account_name: true, api_key: true },
  });
  const validConns = conns.filter(c => c.api_key && c.api_key.length > 5);
  if (validConns.length === 0) return { skipped: true, reason: "no connections" };

  log(`Checking merchants for ${username} (${validConns.length} connections)...`);

  const { fetchAllMerchants } = await import("@/lib/platform-api");

  // 获取平台 API 返回的所有商家及其关系状态
  const platformMerchants = new Map<string, string>(); // "platform:mid" → relationship_status
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

  if (platformMerchants.size === 0) return { skipped: true, reason: "no merchants from API" };

  // 获取用户当前所有 claimed 商家
  const claimedMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0, status: "claimed" },
    select: { id: true, platform: true, merchant_id: true, merchant_name: true },
  });

  let removed = 0;
  let added = 0;
  const removedNames: string[] = [];
  const addedNames: string[] = [];

  // 检查每个 claimed 商家是否仍为 joined
  for (const m of claimedMerchants) {
    const platform = normalizePlatformCode(m.platform);
    const key = `${platform}:${m.merchant_id}`;
    const currentStatus = platformMerchants.get(key);

    // 只在 API 返回了该平台数据时才做判断（避免 API 失败误删）
    if (currentStatus === undefined) continue;

    if (currentStatus !== "joined") {
      // 商家已非 joined → 取消 claimed 状态，标记为 available
      await prisma.user_merchants.update({
        where: { id: m.id },
        data: { status: "available", claimed_at: null },
      });
      removed++;
      removedNames.push(`${m.merchant_name} (${platform}:${m.merchant_id} → ${currentStatus})`);
      log(`  REMOVED: ${m.merchant_name} [${platform}] status=${currentStatus}`);
    }
  }

  // 检查新 joined 的商家（API 返回 joined 但 user_merchants 表中没有）
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
    // 新 joined 商家 → 创建记录
    await prisma.user_merchants.create({
      data: {
        user_id: userId,
        platform: m.platform,
        merchant_id: m.merchant_id,
        merchant_name: m.merchant_name,
        category: m.category || null,
        commission_rate: m.commission_rate || null,
        supported_regions: m.supported_regions.length > 0 ? m.supported_regions : undefined,
        merchant_url: m.merchant_url || null,
        campaign_link: m.campaign_link || null,
        tracking_link: m.campaign_link || null,
        platform_connection_id: m.conn_id,
        status: "available",
      },
    });
    added++;
    addedNames.push(`${m.merchant_name} (${m.platform}:${m.merchant_id})`);
    log(`  ADDED: ${m.merchant_name} [${m.platform}]`);
  }

  // 发送通知
  if (removed > 0 || added > 0) {
    const parts: string[] = [];
    if (removed > 0) parts.push(`剔除 ${removed} 个非 joined 商家: ${removedNames.slice(0, 5).join(", ")}${removedNames.length > 5 ? "..." : ""}`);
    if (added > 0) parts.push(`新增 ${added} 个 joined 商家: ${addedNames.slice(0, 5).join(", ")}${addedNames.length > 5 ? "..." : ""}`);
    await prisma.notifications.create({
      data: { user_id: userId, title: "商家关系周检", content: parts.join("；"), type: "system" },
    }).catch(() => {});
  }

  return { checked: claimedMerchants.length, removed, added, removedNames: removedNames.slice(0, 10), addedNames: addedNames.slice(0, 10) };
}
