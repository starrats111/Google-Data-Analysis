import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { batchReviewMerchants } from "@/lib/policy-review";

// DEBUG 4fc40c
import fs from "fs";
const logPath = "debug-4fc40c.log";
const dbg = (msg: string) => { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`); };

const syncingUsers = new Set<string>();

/**
 * POST /api/user/merchants/sync
 *
 * 异步后台同步：用 platform_connections 的 API Key 调联盟平台 API，
 * 拉取商家数据写入 user_merchants，完成后发通知。
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json().catch(() => ({}));
  const targetPlatform = body.platform as string | undefined;
  const userId = BigInt(user.userId);

  const lockKey = `${user.userId}:${targetPlatform || "ALL"}`;
  if (syncingUsers.has(lockKey)) {
    return apiError("同步正在进行中，请稍后再试", 429);
  }

  // 检查是否有可用的平台连接
  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, account_name: true, api_key: true, channel_id: true },
  });
  // C-029：AD 平台连接必须配置 channel_id，否则视为不可用
  const valid = conns.filter(c => {
    if (!c.api_key || c.api_key.length <= 5) return false;
    if (c.platform === "AD" && !(c.channel_id && c.channel_id.trim())) return false;
    return true;
  });

  dbg(`SYNC userId=${user.userId} conns=${conns.length} valid=${valid.length}`);

  if (valid.length === 0) {
    return apiError("没有可用的平台连接，请先在「平台连接」中配置 API Key");
  }

  syncingUsers.add(lockKey);
  doSyncInBackground(userId, valid, targetPlatform)
    .catch(err => { dbg(`FATAL: ${err instanceof Error ? err.message : String(err)}`); })
    .finally(() => { syncingUsers.delete(lockKey); });

  return apiSuccess({ message: "商家同步已开始，完成后将通知您" });
}

// ─── 后台异步同步 ───
async function doSyncInBackground(
  userId: bigint,
  conns: { id: bigint; platform: string; account_name: string; api_key: string | null; channel_id: string | null }[],
  targetPlatform?: string,
) {
  const t0 = Date.now();
  const errors: string[] = [];
  const platformCounts: Record<string, number> = {};
  let newCount = 0;
  let updatedCount = 0;

  try {
    // 1. 从联盟平台 API 拉取商家：跨平台并发，同平台内串行（防止并发请求压垮单一平台 API）
    // 背景：RW 等平台在多账号同时翻页时会触发超时，导致只能拿到第1-2页（丢失后续商家）。
    // 改为同平台串行拉取后，每个账号完整取完所有分页再开始下一个，彻底避免竞争。
    const { fetchAllMerchants } = await import("@/lib/platform-api");
    const rows: any[] = [];

    const fetchTargets = conns.filter(c => !targetPlatform || c.platform === targetPlatform.toUpperCase());

    // 按平台分组
    const byPlatform: Record<string, typeof fetchTargets> = {};
    for (const conn of fetchTargets) {
      (byPlatform[conn.platform] = byPlatform[conn.platform] || []).push(conn);
    }

    // 辅助函数：拉取单个连接，追加到 rows
    const fetchConn = async (conn: typeof fetchTargets[0]) => {
      dbg(`Fetch ${conn.platform}...`);
      try {
        // C-029：AD 需要透传 channelId；其他平台 extra 保持为空
        const extra = conn.platform === "AD" && conn.channel_id
          ? { channelId: conn.channel_id }
          : undefined;
        const r = await fetchAllMerchants(conn.platform, conn.api_key!, "joined", extra);
        if (r.error) errors.push(r.error);
        dbg(`  ${conn.platform}: ${r.merchants.length} merchants${r.error ? `, err=${r.error}` : ""}`);
        if (r.merchants.length > 0) {
          const s = r.merchants[0];
          dbg(`  sample: id=${s.merchant_id} cat=${s.category} comm=${s.commission_rate} link=${(s.campaign_link || "").substring(0, 60)}`);
        }
        return { conn, merchants: r.merchants };
      } catch (err) {
        const msg = `${conn.platform}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        dbg(`  ERROR ${msg}`);
        return { conn, merchants: [] as any[] };
      }
    };

    const pushMerchants = (conn: typeof fetchTargets[0], merchants: any[]) => {
      for (const m of merchants) {
        if (m.relationship_status !== "joined") {
          if (m.relationship_status === "pending") {
            dbg(`  [SKIP pending] platform=${conn.platform} id=${m.merchant_id} name=${m.merchant_name}`);
          }
          continue;
        }
        rows.push({
          platform_code: conn.platform,
          conn_id: conn.id,
          merchant_id: m.merchant_id,
          merchant_name: m.merchant_name,
          categories: m.category || "",
          commission_rate: m.commission_rate || "",
          support_regions: m.supported_regions ? JSON.stringify(m.supported_regions) : null,
          site_url: m.merchant_url || "",
          campaign_link: m.campaign_link || "",
          logo: m.logo_url || "",
          // C-029：AD 返回 cookieExpiryDays，其他平台为 undefined
          cookie_duration: typeof m.cookie_duration === "number" ? m.cookie_duration : null,
        });
      }
    };

    // 跨平台并发，同平台内串行
    await Promise.all(
      Object.values(byPlatform).map(async (platformConns) => {
        for (const conn of platformConns) {
          const { conn: c, merchants } = await fetchConn(conn);
          pushMerchants(c, merchants);
        }
      })
    );

    dbg(`Total fetched: ${rows.length}`);
    // 专项诊断：追踪 RW 166377 (Xcaret Hoteles) 是否出现在此次同步结果中
    const rw166377 = rows.find(r => r.platform_code === "RW" && r.merchant_id === "166377");
    dbg(`[DIAG-166377] ${rw166377 ? `✓ 已找到 RW:166377 comm=${rw166377.commission_rate} url=${rw166377.site_url} link=${rw166377.campaign_link}` : "✗ 未找到 RW:166377（Xcaret Hoteles），将被清理删除"}`);

    if (rows.length === 0) {
      const failedPlatformNames = errors.map(e => {
        const PLATFORM_NAMES: Record<string, string> = {
          CG: "CollabGlow", LH: "LinkHaitao", RW: "Rewardoo",
          CF: "CreatorFlare", BSH: "BrandSparkHub", PM: "Partnermatic", LB: "LinkBux",
          MUI: "UltraInfluence", AD: "AdsDoubler",
        };
        const m = e.match(/^([A-Z]+):/);
        return m ? (PLATFORM_NAMES[m[1]] ?? m[1]) : "未知平台";
      });
      const failMsg0 = failedPlatformNames.length > 0
        ? `未能获取到商家数据，可能是以下平台连接异常：${[...new Set(failedPlatformNames)].join("、")}。\n请检查平台账号的 API 连接是否正常，或联系管理员排查。`
        : "未能获取到任何商家数据，请联系管理员检查平台连接设置。";
      await notify(userId, "商家库同步失败", failMsg0);
      return;
    }

    // 2. 写入 user_merchants（去重 + 防止新增重复）
    const existing = await prisma.user_merchants.findMany({
      where: { user_id: userId },
      select: { id: true, platform: true, merchant_id: true, status: true, is_deleted: true, platform_connection_id: true, connection_campaign_links: true },
    });

    // 清理历史重复数据：按 platform:merchant_id 分组（1 条/平台商家），保留 status=claimed 或 id 最小的记录
    const groupedByKey = new Map<string, typeof existing>();
    for (const m of existing) {
      const k = `${m.platform}:${m.merchant_id}`;
      const arr = groupedByKey.get(k) || [];
      arr.push(m);
      groupedByKey.set(k, arr);
    }
    const deduped: typeof existing = [];
    for (const [, arr] of groupedByKey) {
      if (arr.length <= 1) { deduped.push(arr[0]); continue; }
      const keep = arr.find(m => m.status === "claimed" || m.status === "paused") || arr.reduce((a, b) => (a.id < b.id ? a : b));
      deduped.push(keep);
      const toDelete = arr.filter(m => m.id !== keep.id);
      if (toDelete.length > 0) {
        await prisma.user_merchants.deleteMany({ where: { id: { in: toDelete.map(m => m.id) } } });
        console.log(`[MerchantSync] 清理重复商家: ${toDelete.length} 条 (key=${arr[0].platform}:${arr[0].merchant_id})`);
      }
    }

    const map = new Map(deduped.map(m => [`${m.platform}:${m.merchant_id}`, m]));

    // 先按 platform:merchant_id 聚合各连接的 campaign_link
    const connLinksMap = new Map<string, Record<string, string>>();
    const merchantDataMap = new Map<string, typeof rows[0]>();
    for (const row of rows) {
      const key = `${row.platform_code}:${row.merchant_id}`;
      const links = connLinksMap.get(key) || {};
      if (row.campaign_link && row.conn_id) {
        links[String(row.conn_id)] = row.campaign_link;
      }
      connLinksMap.set(key, links);
      if (!merchantDataMap.has(key)) merchantDataMap.set(key, row);
    }

    const updateOps: Array<{ id: bigint; data: Record<string, unknown> }> = [];
    const createOps: Array<{ key: string; data: Record<string, unknown>; connId: bigint | null }> = [];

    for (const [key, row] of merchantDataMap) {
      let regions: unknown = null;
      if (row.support_regions) {
        try { regions = typeof row.support_regions === "string" ? JSON.parse(row.support_regions) : row.support_regions; } catch {}
      }
      let cat = row.categories || "";
      if (cat.startsWith('"') && cat.endsWith('"')) cat = cat.slice(1, -1);
      cat = simplifyCategory(cat);
      const connLinks = connLinksMap.get(key) || {};

      const ex = map.get(key);

      if (ex?.status === "excluded") {
        dbg(`[SKIP excluded] ${key}`);
        continue;
      }

      platformCounts[row.platform_code] = (platformCounts[row.platform_code] || 0) + 1;

      if (ex) {
        const updateData: Record<string, any> = {};
        if (row.merchant_name) updateData.merchant_name = row.merchant_name;
        if (cat) updateData.category = cat;
        if (row.commission_rate) updateData.commission_rate = row.commission_rate;
        if (regions != null) updateData.supported_regions = regions;
        if (row.site_url) updateData.merchant_url = row.site_url;
        if (row.logo) updateData.logo_url = row.logo;
        if (row.campaign_link) {
          updateData.tracking_link = row.campaign_link;
          updateData.campaign_link = row.campaign_link;
        }
        // C-029：AD 提供 cookieExpiryDays，按回写更新
        if (typeof row.cookie_duration === "number" && row.cookie_duration > 0) {
          updateData.cookie_duration = row.cookie_duration;
        }
        if (!ex.platform_connection_id && row.conn_id) {
          updateData.platform_connection_id = row.conn_id;
        }
        if (ex.is_deleted === 1) {
          updateData.is_deleted = 0;
          updateData.status = "available";
        }
        const prevLinks = (ex.connection_campaign_links && typeof ex.connection_campaign_links === "object" ? ex.connection_campaign_links : {}) as Record<string, string>;
        updateData.connection_campaign_links = { ...prevLinks, ...connLinks };
        if (Object.keys(updateData).length > 0) {
          updateOps.push({ id: ex.id, data: updateData });
        }
      } else {
        const createData: Record<string, any> = {
          user_id: userId,
          platform: row.platform_code,
          merchant_id: row.merchant_id,
          merchant_name: row.merchant_name || "",
          category: cat || null,
          commission_rate: row.commission_rate || null,
          merchant_url: row.site_url || null,
          logo_url: row.logo || null,
          tracking_link: row.campaign_link || null,
          campaign_link: row.campaign_link || null,
          platform_connection_id: row.conn_id || null,
          connection_campaign_links: Object.keys(connLinks).length > 0 ? connLinks : null,
          status: "available",
        };
        if (regions != null) createData.supported_regions = regions;
        // C-029：AD 提供 cookieExpiryDays，新增时一并写入
        if (typeof row.cookie_duration === "number" && row.cookie_duration > 0) {
          createData.cookie_duration = row.cookie_duration;
        }
        createOps.push({ key, connId: row.conn_id || null, data: createData });
      }
    }

    const DB_BATCH = 50;
    let updateFailCount = 0;
    const succeededUpdateIds: bigint[] = [];
    for (let i = 0; i < updateOps.length; i += DB_BATCH) {
      const batch = updateOps.slice(i, i + DB_BATCH);
      await Promise.all(batch.map(async (op) => {
        try {
          await prisma.user_merchants.update({ where: { id: op.id }, data: op.data });
          succeededUpdateIds.push(op.id);
        } catch (e) {
          updateFailCount++;
          dbg(`UPDATE FAIL id=${op.id} err=${e instanceof Error ? e.message : String(e)}`);
        }
      }));
    }
    updatedCount = updateOps.length - updateFailCount;

    let createFailCount = 0;
    const CREATE_BATCH = 200;
    for (let i = 0; i < createOps.length; i += CREATE_BATCH) {
      const batch = createOps.slice(i, i + CREATE_BATCH);
      try {
        await prisma.user_merchants.createMany({
          data: batch.map(op => op.data as any),
          skipDuplicates: true,
        });
        const created = await prisma.user_merchants.findMany({
          where: {
            user_id: userId,
            platform: { in: batch.map(op => (op.data as any).platform) },
            merchant_id: { in: batch.map(op => (op.data as any).merchant_id) },
          },
          select: { id: true, platform: true, merchant_id: true, status: true, is_deleted: true, platform_connection_id: true, connection_campaign_links: true },
        });
        for (const c of created) {
          map.set(`${c.platform}:${c.merchant_id}`, c);
        }
      } catch (e) {
        createFailCount += batch.length;
        dbg(`CREATE_MANY FAIL batch=${batch.length} err=${e instanceof Error ? e.message : String(e)}`);
      }
    }
    newCount = createOps.length - createFailCount;

    // 2.5 清理：只清理本次成功返回数据的平台中不再存在的未领取商家
    // 避免某个平台 API 失败/返回空数据时误删已有商家
    const syncedKeys = new Set(rows.map(r => `${r.platform_code}:${r.merchant_id}`));
    const syncedPlatforms = new Set(rows.map(r => r.platform_code));
    let removedCount = 0;
    const toRemoveIds: bigint[] = [];
    for (const [key, ex] of map.entries()) {
      const [exPlatform] = key.split(":");
      if (!syncedKeys.has(key) && ex.status !== "claimed" && ex.status !== "paused" && ex.status !== "excluded" && ex.is_deleted === 0 && syncedPlatforms.has(exPlatform)) {
        toRemoveIds.push(ex.id);
        removedCount++;
      }
    }
    if (toRemoveIds.length > 0) {
      await prisma.user_merchants.deleteMany({ where: { id: { in: toRemoveIds } } });
    }
    if (removedCount > 0) dbg(`Removed ${removedCount} non-joined merchants (only from synced platforms: ${[...syncedPlatforms].join(",")})`);

    // 3. 政策审核（仅审核本次成功新增和更新的商家）
    const succeededCreateIds = createOps
      .map((op) => map.get(op.key)?.id)
      .filter((id): id is bigint => id != null);
    const changedIds = [...succeededUpdateIds, ...succeededCreateIds];

    let policyMsg = "";
    try {
      const toReview = changedIds.length > 0 ? await prisma.user_merchants.findMany({
        where: { id: { in: changedIds }, is_deleted: 0 },
        select: { id: true, merchant_name: true, category: true, merchant_url: true },
      }) : [];
      dbg(`Policy review: ${toReview.length} merchants to review (changed only)`);
      if (toReview.length > 0) {
        const ps = await batchReviewMerchants(prisma as any, toReview.map(m => ({ ...m, platform: "" })));
        if (ps.reviewed > 0) policyMsg = `，政策审核 ${ps.reviewed} 个（限制 ${ps.restricted}，禁止 ${ps.prohibited}）`;
        dbg(`Policy result: reviewed=${ps.reviewed} restricted=${ps.restricted} prohibited=${ps.prohibited}`);
      }
    } catch (e) {
      dbg(`Policy error: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 4. 从 DB 匹配广告系列状态（不调 Google Ads API）
    let statusMsg = "";
    try {
      const allMerchantIds = [...map.values()].filter(m => m.is_deleted === 0).map(m => m.id);
      if (allMerchantIds.length > 0) {
        const campaigns = await prisma.campaigns.findMany({
          where: { user_id: userId, user_merchant_id: { in: allMerchantIds }, is_deleted: 0 },
          select: { user_merchant_id: true, google_status: true },
        });
        const enabledCount = new Set(campaigns.filter(c => c.google_status === "ENABLED").map(c => c.user_merchant_id.toString())).size;
        const pausedCount = new Set(campaigns.filter(c => c.google_status === "PAUSED").map(c => c.user_merchant_id.toString())).size;
        if (enabledCount > 0 || pausedCount > 0) {
          statusMsg = `，广告匹配：${enabledCount} 个投放中，${pausedCount} 个已暂停`;
        }
      }
    } catch (e) {
      dbg(`Campaign match error: ${e instanceof Error ? e.message : String(e)}`);
    }

    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    const platStr = Object.entries(platformCounts).map(([p, c]) => `${p}: ${c}`).join(", ");

    const failMsg = (updateFailCount + createFailCount) > 0
      ? `，失败 ${updateFailCount + createFailCount} 条`
      : "";
    const debugSummary = `同步完成（${sec}秒）：${rows.length} 个已批准商家（${platStr}），新增 ${newCount}，更新 ${updatedCount}，清理 ${removedCount}${failMsg}${statusMsg}${policyMsg}${errors.length > 0 ? `。警告: ${errors.join("; ")}` : ""}`;
    dbg(`DONE: ${debugSummary}`);

    // 构建员工友好的通知
    const PLATFORM_NAMES: Record<string, string> = {
      CG: "CollabGlow", LH: "LinkHaitao", RW: "Rewardoo",
      CF: "CreatorFlare", BSH: "BrandSparkHub", PM: "Partnermatic", LB: "LinkBux",
      MUI: "UltraInfluence", AD: "AdsDoubler",
    };
    const platReadable = Object.entries(platformCounts)
      .map(([p, c]) => `${PLATFORM_NAMES[p] ?? p} ${c} 家`)
      .join("、");

    const lines: string[] = [];
    lines.push(`本次共获取 ${rows.length} 家可推广商家（${platReadable}）`);

    if (newCount > 0) lines.push(`新增 ${newCount} 家商家，请前往「我的商家」查看`);
    if (removedCount > 0) lines.push(`移除 ${removedCount} 家已退出/下架商家`);

    // 广告状态（从 statusMsg 中提取数字）
    const enabledMatch = statusMsg.match(/(\d+) 个投放中/);
    const pausedMatch = statusMsg.match(/(\d+) 个已暂停/);
    if (enabledMatch || pausedMatch) {
      const enabledN = enabledMatch ? enabledMatch[1] : "0";
      const pausedN = pausedMatch ? pausedMatch[1] : "0";
      lines.push(`当前广告：${enabledN} 个投放中，${pausedN} 个已暂停`);
    }

    // 政策提醒（从 policyMsg 中提取）
    const restrictedMatch = policyMsg.match(/限制 (\d+)/);
    const prohibitedMatch = policyMsg.match(/禁止 (\d+)/);
    const restrictedN = restrictedMatch ? Number(restrictedMatch[1]) : 0;
    const prohibitedN = prohibitedMatch ? Number(prohibitedMatch[1]) : 0;
    if (prohibitedN > 0) lines.push(`注意：${prohibitedN} 家商家违反广告政策，已自动屏蔽，请勿推广`);
    else if (restrictedN > 0) lines.push(`提示：${restrictedN} 家商家属于受限类目，推广前请确认合规`);

    // 平台连接警告
    const failedPlatforms = errors
      .map(e => { const m = e.match(/^([A-Z]+):/); return m ? (PLATFORM_NAMES[m[1]] ?? m[1]) : null; })
      .filter(Boolean) as string[];
    if (failedPlatforms.length > 0) {
      lines.push(`以下平台本次同步异常，数据可能不完整：${[...new Set(failedPlatforms)].join("、")}`);
    }

    const notifyTitle = newCount > 0 ? `商家库更新完成（新增 ${newCount} 家）` : "商家库同步完成";
    const notifyContent = lines.join("\n");

    await notify(userId, notifyTitle, notifyContent);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dbg(`ERROR: ${msg}`);
    // 避免将技术性报错直接暴露给员工
    const isChunkError = msg.includes("chunk") || msg.includes("Cannot find module") || msg.includes("MODULE_NOT_FOUND");
    const employeeMsg = isChunkError
      ? "系统刚完成更新，同步服务临时不可用，请稍后重新同步。如持续失败请联系管理员。"
      : "商家同步遇到意外错误，请稍后重试。如持续失败请联系管理员。";
    await notify(userId, "商家库同步失败", employeeMsg).catch(() => {});
  }
}

async function notify(userId: bigint, title: string, content: string) {
  try {
    await prisma.notifications.create({ data: { user_id: userId, title, content, type: "system" } });
  } catch (e) {
    dbg(`notify err: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 简化类别为简短主营业务描述
 * "Home & Garden>Home & Garden" → "Home & Garden"
 * "Others>Others" → "Others"
 * "Health & Beauty>Health & Beauty>Supplements" → "Supplements"
 * "Computers & Electronics>Software" → "Software"
 */
function simplifyCategory(raw: string): string {
  if (!raw) return "";
  // 去掉引号
  let cat = raw.replace(/^"|"$/g, "").trim();
  // 按 > 分割，取最后一个有意义的部分
  const parts = cat.split(">").map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return cat;
  // 如果最后一级和倒数第二级相同，取倒数第二级
  const last = parts[parts.length - 1];
  if (parts.length >= 2 && parts[parts.length - 2] === last) {
    return last;
  }
  // 否则取最后一级
  return last;
}
