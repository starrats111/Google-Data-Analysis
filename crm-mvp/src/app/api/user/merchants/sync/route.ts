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
    select: { id: true, platform: true, account_name: true, api_key: true },
  });
  const valid = conns.filter(c => c.api_key && c.api_key.length > 5);

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
  conns: { id: bigint; platform: string; account_name: string; api_key: string | null }[],
  targetPlatform?: string,
) {
  const t0 = Date.now();
  const errors: string[] = [];
  const platformCounts: Record<string, number> = {};
  let newCount = 0;
  let updatedCount = 0;

  try {
    // 1. 从联盟平台 API 并行拉取商家（3 个平台并发）
    const { fetchAllMerchants } = await import("@/lib/platform-api");
    const rows: any[] = [];

    const fetchTargets = conns.filter(c => !targetPlatform || c.platform === targetPlatform.toUpperCase());
    const FETCH_CONCURRENCY = 7;
    for (let fi = 0; fi < fetchTargets.length; fi += FETCH_CONCURRENCY) {
      const batch = fetchTargets.slice(fi, fi + FETCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (conn) => {
          dbg(`Fetch ${conn.platform}...`);
          try {
            // 传 relationship="joined" 让平台 API 直接只返回已加入品牌，
            // 避免全量拉取（数十万条）+本地过滤时因 200 页上限漏掉末尾新品牌
            const r = await fetchAllMerchants(conn.platform, conn.api_key!, "joined");
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
        })
      );
      for (const { conn, merchants } of results) {
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
          });
        }
      }
    }

    dbg(`Total fetched: ${rows.length}`);

    if (rows.length === 0) {
      await notify(userId, "商家同步失败", `没有获取到商家数据。${errors.join("; ")}`);
      return;
    }

    // 2. 写入 user_merchants（去重 + 防止新增重复）
    const existing = await prisma.user_merchants.findMany({
      where: { user_id: userId },
      select: { id: true, platform: true, merchant_id: true, status: true, is_deleted: true, platform_connection_id: true },
    });

    // 清理历史重复数据：保留 status=claimed 或 id 最小的记录，删除其余
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

    const seenInThisBatch = new Set<string>();
    const updateOps: Array<{ id: bigint; data: Record<string, unknown> }> = [];
    const createOps: Array<{ key: string; data: Record<string, unknown>; connId: bigint | null }> = [];

    for (const row of rows) {
      const key = `${row.platform_code}:${row.merchant_id}`;
      if (seenInThisBatch.has(key)) continue;
      seenInThisBatch.add(key);
      platformCounts[row.platform_code] = (platformCounts[row.platform_code] || 0) + 1;

      let regions: unknown = null;
      if (row.support_regions) {
        try { regions = typeof row.support_regions === "string" ? JSON.parse(row.support_regions) : row.support_regions; } catch {}
      }
      let cat = row.categories || "";
      if (cat.startsWith('"') && cat.endsWith('"')) cat = cat.slice(1, -1);
      cat = simplifyCategory(cat);

      const ex = map.get(key);
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
        if (!ex.platform_connection_id && row.conn_id) {
          updateData.platform_connection_id = row.conn_id;
        }
        if (ex.is_deleted === 1) {
          updateData.is_deleted = 0;
          updateData.status = "available";
        }
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
          status: "available",
        };
        if (regions != null) createData.supported_regions = regions;
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
          select: { id: true, platform: true, merchant_id: true, status: true, is_deleted: true, platform_connection_id: true },
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
      if (!syncedKeys.has(key) && ex.status !== "claimed" && ex.status !== "paused" && ex.is_deleted === 0 && syncedPlatforms.has(exPlatform)) {
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
    const summary = `同步完成（${sec}秒）：${rows.length} 个已批准商家（${platStr}），新增 ${newCount}，更新 ${updatedCount}，清理 ${removedCount}${failMsg}${statusMsg}${policyMsg}${errors.length > 0 ? `。警告: ${errors.join("; ")}` : ""}`;

    dbg(`DONE: ${summary}`);
    await notify(userId, "商家同步完成", summary);

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    dbg(`ERROR: ${msg}`);
    await notify(userId, "商家同步失败", `同步出错: ${msg}`).catch(() => {});
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
