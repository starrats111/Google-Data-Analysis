import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { normalizePlatformCode } from "@/lib/constants";
import { quickCheckUrl } from "@/lib/url-validator";

export const dynamic = "force-dynamic";
// D-028：next start 的 Node 进程里，HTTP handler 一旦 return，
// fire-and-forget 的后台 Promise 会被立即解除引用，
// 导致 doMerchantCheck() 实际上从未跑完（PM2 日志里完全搜不到
// "Checking relations" / "All done in" 输出，全用户全平台 0 新增即是证据）。
// 改为 await 等待整个 check 完成；maxDuration 跟 daily-sync 对齐到 4 小时上限。
export const maxDuration = 14400;

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.log(`[CRON merchant-check ${new Date().toISOString()}] ${msg}`);
}

/**
 * GET /api/cron/daily-merchant-check
 *
 * 每天 00:00 CST 执行：
 * 1. 对每个用户的每个平台连接，调 fetchAllMerchants 拉所有 joined 商家：
 *    - API 仍标 joined 但 CRM 内 claimed 商家 → 不动
 *    - API 不再返回但 CRM 内 claimed 商家 → status 改回 available
 *    - API 新增 joined 商家 → CRM 自动 create user_merchants 记录
 * 2. 对 claimed 商家校验 tracking_link / campaign_link 是否可访问，
 *    失活链接发通知给用户。
 */
export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await doMerchantCheck();
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`FATAL: ${msg}`);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// ???????? cron ???????????????????????
// key = platform code?value = ??????
const CIRCUIT_BREAKER_THRESHOLD = 2; // ???? 2 ?????

async function doMerchantCheck() {
  const t0 = Date.now();

  // ?? cron ?????????
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
      ? ` | ????: ${[...platformCircuitOpen].join(", ")}`
      : "";
    log(`All done in ${elapsed}s ? removed: ${totalRemoved}, added: ${totalAdded}, invalidLinks: ${totalInvalidLinks}${circuitInfo}`);
  } catch (e) {
    log(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ========== 1. ???????? ==========

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

  // joined ?? map?key = platform:merchant_id ? ????
  const joinedMerchants = new Map<string, {
    platform: string; merchant_id: string; merchant_name: string;
    category: string; commission_rate: string; merchant_url: string;
    campaign_link: string; supported_regions: string[];
    conn_id: bigint;
  }>();
  // ???????????????API ??????????????
  // ????"?? API ??"?"?????? joined ???"
  const successfulPlatforms = new Set<string>();

  for (const conn of validConns) {
    const platform = normalizePlatformCode(conn.platform);

    // ??????????????? >= ???????
    if (platformCircuitOpen.has(platform)) {
      log(`  [??] ?? ${platform}???????? ${platformFailCounts.get(platform)} ??`);
      continue;
    }

    try {
      const r = await fetchAllMerchants(platform, conn.api_key!);

      if (r.error) {
        log(`  ${conn.account_name || platform}: API ?? - ${r.error}`);
        const fails = (platformFailCounts.get(platform) || 0) + 1;
        platformFailCounts.set(platform, fails);
        if (fails >= CIRCUIT_BREAKER_THRESHOLD) {
          platformCircuitOpen.add(platform);
          log(`  [????] ${platform} ???? ${fails} ?????????????`);
        }
        // ???????????????????????????????
        if (r.merchants.length === 0) continue;
      } else {
        platformFailCounts.set(platform, 0);
      }

      // ?????? assumeAllJoined=true?fetchAllMerchants ????? joined ??
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

      // ? error ??????????????????????????
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
        log(`  [????] ${platform} ???? ${fails} ?????????????`);
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
  // ?????????joined?pending/removed?????????
  const statusChangedList: { name: string; platform: string }[] = [];

  for (const m of claimedMerchants) {
    const platform = normalizePlatformCode(m.platform);
    const key = `${platform}:${m.merchant_id}`;

    // ???????????????????????????? API ??????
    if (!successfulPlatforms.has(platform)) continue;

    if (!joinedMerchants.has(key)) {
      // ?????? joined ?????????????????? pending / ????
      await prisma.user_merchants.update({
        where: { id: m.id },
        data: { status: "available", claimed_at: null },
      });
      removed++;
      removedList.push({ name: m.merchant_name, platform });
      statusChangedList.push({ name: m.merchant_name, platform });
      log(`  REMOVED: ${m.merchant_name} [${platform}] ? no longer in joined list`);
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
        title: "商家状态变更提醒",
        content: `以下商家在平台已经 joined，但您 CRM 内的状态仍是 pending，请到 CRM 平台手动更新状态：\n${names}${suffix}\n\n如不及时处理，您的广告可能投向未生效的商家，请尽快同步。\n\n详情：\n${detail}`,
        metadata: JSON.stringify({ statusChanged: statusChangedList }),
        type: "warning",
      },
    }).catch(() => {});
  }

  if (removed > 0 || added > 0) {
    const parts: string[] = [];
    if (removed > 0) parts.push(`减少 ${removed} 个 joined 商家`);
    if (added > 0) parts.push(`新增 ${added} 个 joined 商家`);
    const metadata = JSON.stringify({ removed: removedList, added: addedList });
    await prisma.notifications.create({
      data: { user_id: userId, title: "商家清单变更", content: parts.join("、"), metadata, type: "system" },
    }).catch(() => {});
  }

  log(`  ${username}: removed=${removed}, added=${added}`);
  return { checked: claimedMerchants.length, removed, added };
}

// ========== 2. ??????? ==========

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
        data: { link_status: "invalid", link_checked_at: new Date(), link_check_reason: "URL 格式错误" },
      });
      invalidCount++;
      invalidMerchants.push(m.merchant_name);
      invalidDetails.push({ name: m.merchant_name, platform: m.platform, reason: "URL 格式错误" });
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
        log(`  INVALID LINK: ${m.merchant_name} [${m.platform}] ? ${result.reason}`);
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
        title: "链接失效提醒",
        content: `检测到 ${invalidCount} 个失效链接：${invalidMerchants.slice(0, 5).join("、")}${invalidMerchants.length > 5 ? ` 等 ${invalidMerchants.length} 个` : ""}`,
        metadata,
        type: "warning",
      },
    }).catch(() => {});
  }

  log(`  ${username}: checked=${toCheck.length}, invalid=${invalidCount}`);
  return { invalidCount };
}
