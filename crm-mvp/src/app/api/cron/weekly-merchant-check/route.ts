import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";
import { quickCheckUrl } from "@/lib/url-validator";

export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET || "";

function verifyCron(req: NextRequest): boolean {
  if (!CRON_SECRET) return false;
  return req.headers.get("authorization") === `Bearer ${CRON_SECRET}`;
}

function log(msg: string) {
  console.log(`[CRON merchant-check ${new Date().toISOString()}] ${msg}`);
}

/**
 * GET /api/cron/weekly-merchant-check
 *
 * 每天 00:00 自动执行（立即返回，后台异步执行）：
 * 1. 对每个用户，调用联盟平台 API 获取最新商家关系状态，
 *    剔除已非 joined 的 claimed 商家，加入新 joined 商家。
 * 2. 对 claimed 商家的 tracking_link / campaign_link 进行可达性检测，
 *    标记无效链接并通知用户。
 */
export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  doMerchantCheck().catch(e => log(`FATAL: ${e instanceof Error ? e.message : String(e)}`));

  return NextResponse.json({ ok: true, message: "merchant check started in background" });
}

// 熔断器：记录本轮 cron 中各平台的连续失败次数，超过阈值则跳过后续用户
// key = platform code，value = 连续失败次数
const CIRCUIT_BREAKER_THRESHOLD = 2; // 连续失败 2 次触发熔断

async function doMerchantCheck() {
  const t0 = Date.now();

  // 每次 cron 运行时重置熔断计数
  const platformFailCounts = new Map<string, number>();
  const platformCircuitOpen = new Set<string>();

  try {
    const users = await prisma.users.findMany({
      where: { is_deleted: 0, status: "active", role: { in: ["user", "leader"] } },
      select: { id: true, username: true },
    });

    let totalRemoved = 0, totalAdded = 0, totalInvalidLinks = 0;

    for (const user of users) {
      try {
        const relResult = await checkUserMerchants(
          user.id,
          user.username,
          platformFailCounts,
          platformCircuitOpen,
        );
        if (relResult && typeof relResult === "object" && "removed" in relResult) {
          totalRemoved += (relResult as any).removed || 0;
          totalAdded += (relResult as any).added || 0;
        }

        const linkResult = await checkUserMerchantLinks(user.id, user.username);
        totalInvalidLinks += linkResult.invalidCount;
      } catch (e) {
        log(`  ${user.username} error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const circuitInfo = platformCircuitOpen.size > 0
      ? ` | 熔断平台: ${[...platformCircuitOpen].join(", ")}`
      : "";
    log(`All done in ${elapsed}s — removed: ${totalRemoved}, added: ${totalAdded}, invalidLinks: ${totalInvalidLinks}${circuitInfo}`);
  } catch (e) {
    log(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ========== 1. 商家关系状态检查 ==========

async function checkUserMerchants(
  userId: bigint,
  username: string,
  platformFailCounts: Map<string, number>,
  platformCircuitOpen: Set<string>,
): Promise<unknown> {
  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0, status: "connected" },
    select: { id: true, platform: true, account_name: true, api_key: true },
  });
  const validConns = conns.filter(c => c.api_key && c.api_key.length > 5);
  if (validConns.length === 0) return { skipped: true };

  log(`Checking relations for ${username} (${validConns.length} conns)...`);

  const { fetchAllMerchants } = await import("@/lib/platform-api");

  // joined 商家 map：key = platform:merchant_id → 商家详情
  const joinedMerchants = new Map<string, {
    platform: string; merchant_id: string; merchant_name: string;
    category: string; commission_rate: string; merchant_url: string;
    campaign_link: string; supported_regions: string[];
    conn_id: bigint;
  }>();
  // 本次成功拉取到数据的平台集合（API 无报错且返回了至少一条数据）
  // 用于区分"平台 API 失败"和"商家真的不在 joined 列表里"
  const successfulPlatforms = new Set<string>();

  for (const conn of validConns) {
    const platform = normalizePlatformCode(conn.platform);

    // 熔断检查：本轮该平台已连续失败 >= 阈值，直接跳过
    if (platformCircuitOpen.has(platform)) {
      log(`  [熔断] 跳过 ${platform}（本轮已连续失败 ${platformFailCounts.get(platform)} 次）`);
      continue;
    }

    try {
      const r = await fetchAllMerchants(platform, conn.api_key!);

      if (r.error) {
        log(`  ${conn.account_name || platform}: API 错误 - ${r.error}`);
        const fails = (platformFailCounts.get(platform) || 0) + 1;
        platformFailCounts.set(platform, fails);
        if (fails >= CIRCUIT_BREAKER_THRESHOLD) {
          platformCircuitOpen.add(platform);
          log(`  [熔断触发] ${platform} 连续失败 ${fails} 次，本轮后续用户跳过该平台`);
        }
        // 有错误但仍有部分数据时继续处理，但不标记平台为成功（避免误删）
        if (r.merchants.length === 0) continue;
      } else {
        platformFailCounts.set(platform, 0);
      }

      // 所有平台均为 assumeAllJoined=true，fetchAllMerchants 返回的均是 joined 商家
      for (const m of r.merchants) {
        if (m.relationship_status === "joined") {
          const key = `${platform}:${m.merchant_id}`;
          joinedMerchants.set(key, {
            platform, merchant_id: m.merchant_id, merchant_name: m.merchant_name,
            category: m.category, commission_rate: m.commission_rate,
            merchant_url: m.merchant_url, campaign_link: m.campaign_link,
            supported_regions: m.supported_regions, conn_id: conn.id,
          });
        }
      }

      // 无 error 且至少返回一条数据，才标记为成功（用于后续剔除判断）
      if (!r.error && r.merchants.length > 0) {
        successfulPlatforms.add(platform);
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log(`  ${conn.account_name || platform}: ${errMsg}`);
      const fails = (platformFailCounts.get(platform) || 0) + 1;
      platformFailCounts.set(platform, fails);
      if (fails >= CIRCUIT_BREAKER_THRESHOLD) {
        platformCircuitOpen.add(platform);
        log(`  [熔断触发] ${platform} 连续失败 ${fails} 次，本轮后续用户跳过该平台`);
      }
    }
  }

  if (joinedMerchants.size === 0 && successfulPlatforms.size === 0) {
    return { skipped: true, reason: "no data from API" };
  }

  const claimedMerchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0, status: { in: ["claimed", "paused"] } },
    select: { id: true, platform: true, merchant_id: true, merchant_name: true, status: true },
  });

  let removed = 0, added = 0;
  const removedList: { name: string; platform: string }[] = [];
  const addedList: { name: string; platform: string }[] = [];
  // 合作状态变更通知（joined→pending/removed），需单独提醒用户
  const statusChangedList: { name: string; platform: string }[] = [];

  for (const m of claimedMerchants) {
    const platform = normalizePlatformCode(m.platform);
    const key = `${platform}:${m.merchant_id}`;

    // 仅处理本次成功拉取过数据的平台；未成功的平台跳过，避免因 API 失败误删商家
    if (!successfulPlatforms.has(platform)) continue;

    if (!joinedMerchants.has(key)) {
      // 商家不在本次 joined 列表里，说明合作状态已变更（可能变为 pending / 被移除）
      await prisma.user_merchants.update({
        where: { id: m.id },
        data: { status: "available", claimed_at: null },
      });
      removed++;
      removedList.push({ name: m.merchant_name, platform });
      statusChangedList.push({ name: m.merchant_name, platform });
      log(`  REMOVED: ${m.merchant_name} [${platform}] → no longer in joined list`);
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
    addedList.push({ name: m.merchant_name, platform: m.platform });
    log(`  ADDED: ${m.merchant_name} [${m.platform}]`);
  }

  if (statusChangedList.length > 0) {
    const names = statusChangedList.slice(0, 5).map(e => `${e.name}（${e.platform}）`).join("、");
    const suffix = statusChangedList.length > 5 ? ` 等 ${statusChangedList.length} 个` : "";
    const detail = statusChangedList.map(e => `· ${e.name}（${e.platform}）`).join("\n");
    await prisma.notifications.create({
      data: {
        user_id: userId,
        title: "商家合作状态变更提醒",
        content: `以下商家已不在平台 joined 列表中，可能已变为 pending 或被移除，CRM 已自动降级为可选状态：\n${names}${suffix}\n\n请登录对应平台确认合作状态，如已恢复 joined 请重新同步商家库。\n\n详情：\n${detail}`,
        metadata: JSON.stringify({ statusChanged: statusChangedList }),
        type: "warning",
      },
    }).catch(() => {});
  }

  if (removed > 0 || added > 0) {
    const parts: string[] = [];
    if (removed > 0) parts.push(`降级 ${removed} 个合作状态变更商家`);
    if (added > 0) parts.push(`新增 ${added} 个 joined 商家`);
    const metadata = JSON.stringify({ removed: removedList, added: addedList });
    await prisma.notifications.create({
      data: { user_id: userId, title: "商家关系定期检查", content: parts.join("；"), metadata, type: "system" },
    }).catch(() => {});
  }

  log(`  ${username}: removed=${removed}, added=${added}`);
  return { checked: claimedMerchants.length, removed, added };
}

// ========== 2. 链接可达性检测 ==========

const LINK_CHECK_DELAY_MS = 2000;

async function checkUserMerchantLinks(
  userId: bigint,
  username: string,
): Promise<{ invalidCount: number }> {
  const merchants = await prisma.user_merchants.findMany({
    where: { user_id: userId, is_deleted: 0, status: "claimed" },
    select: {
      id: true, merchant_name: true, platform: true,
      tracking_link: true, campaign_link: true,
    },
  });

  const toCheck = merchants.filter(m => m.tracking_link || m.campaign_link);
  if (toCheck.length === 0) return { invalidCount: 0 };

  log(`Checking links for ${username} (${toCheck.length} merchants)...`);

  let invalidCount = 0;
  const invalidMerchants: string[] = [];
  const invalidDetails: { name: string; platform: string; reason: string }[] = [];

  for (const m of toCheck) {
    const linkToCheck = m.tracking_link || m.campaign_link;
    if (!linkToCheck) continue;

    try {
      new URL(linkToCheck);
    } catch {
      await prisma.user_merchants.update({
        where: { id: m.id },
        data: { link_status: "invalid", link_checked_at: new Date(), link_check_reason: "URL 格式无效" },
      });
      invalidCount++;
      invalidMerchants.push(m.merchant_name);
      invalidDetails.push({ name: m.merchant_name, platform: m.platform, reason: "URL 格式无效" });
      log(`  INVALID URL format: ${m.merchant_name} [${m.platform}]`);
      continue;
    }

    try {
      const result = await quickCheckUrl(linkToCheck);

      await prisma.user_merchants.update({
        where: { id: m.id },
        data: {
          link_status: result.ok ? "valid" : "invalid",
          link_checked_at: new Date(),
          link_check_reason: result.ok ? null : (result.reason || null),
        },
      });

      if (!result.ok) {
        invalidCount++;
        invalidMerchants.push(m.merchant_name);
        invalidDetails.push({ name: m.merchant_name, platform: m.platform, reason: result.reason || "未知" });
        log(`  INVALID LINK: ${m.merchant_name} [${m.platform}] → ${result.reason}`);
      }
    } catch (e) {
      log(`  Link check error for ${m.merchant_name}: ${e instanceof Error ? e.message : String(e)}`);
    }

    await new Promise(r => setTimeout(r, LINK_CHECK_DELAY_MS));
  }

  if (invalidCount > 0) {
    const metadata = JSON.stringify({ invalidLinks: invalidDetails });
    await prisma.notifications.create({
      data: {
        user_id: userId,
        title: "商家链接异常",
        content: `检测到 ${invalidCount} 个商家链接无效：${invalidMerchants.slice(0, 5).join("、")}${invalidMerchants.length > 5 ? ` 等 ${invalidMerchants.length} 个` : ""}`,
        metadata,
        type: "warning",
      },
    }).catch(() => {});
  }

  log(`  ${username}: checked=${toCheck.length}, invalid=${invalidCount}`);
  return { invalidCount };
}
