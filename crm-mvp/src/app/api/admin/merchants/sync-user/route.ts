import { NextRequest } from "next/server";
import { withAdmin } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/constants";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";

/**
 * POST /api/admin/merchants/sync-user
 *
 * 管理员触发指定用户的商家同步（同步执行，实时返回结果）。
 * Body: { userId: string, platform?: string }
 */
export const POST = withAdmin(async (req: NextRequest) => {
  const body = await req.json().catch(() => ({}));
  const { userId, platform } = body as { userId?: string; platform?: string };

  if (!userId) return apiError("缺少 userId");

  const uid = BigInt(userId);

  const conns = await prisma.platform_connections.findMany({
    where: {
      user_id: uid,
      is_deleted: 0,
      ...(platform ? { platform: platform.toUpperCase() } : {}),
    },
    select: { id: true, platform: true, account_name: true, api_key: true },
  });

  const valid = conns.filter((c) => c.api_key && c.api_key.length > 5);
  if (valid.length === 0) {
    return apiError("该用户没有可用的平台连接，请先在「平台连接」中配置 API Key");
  }

  const { fetchAllMerchants } = await import("@/lib/platform-api");

  const errors: string[] = [];
  const fetchedRows: Array<{
    platform_code: string;
    conn_id: bigint;
    merchant_id: string;
    merchant_name: string;
    categories: string;
    commission_rate: string;
    support_regions: string | null;
    site_url: string;
    campaign_link: string;
    logo: string;
  }> = [];

  // ── 拉取各平台商家 ──
  for (const conn of valid) {
    try {
      const r = await fetchAllMerchants(conn.platform, conn.api_key!, "joined");
      if (r.error) errors.push(r.error);
      for (const m of r.merchants) {
        if (m.relationship_status !== "joined") continue;
        fetchedRows.push({
          platform_code: conn.platform,
          conn_id: conn.id,
          merchant_id: m.merchant_id,
          merchant_name: m.merchant_name,
          categories: m.category || "",
          commission_rate: m.commission_rate || "",
          support_regions: m.supported_regions?.length ? JSON.stringify(m.supported_regions) : null,
          site_url: m.merchant_url || "",
          campaign_link: m.campaign_link || "",
          logo: m.logo_url || "",
        });
      }
    } catch (err) {
      errors.push(`${conn.platform}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (fetchedRows.length === 0) {
    return apiSuccess(serializeData({ newCount: 0, updatedCount: 0, total: 0, errors }), `同步完成，未获取到任何商家数据${errors.length ? "（有错误）" : ""}`);
  }

  // ── 写入数据库 ──
  const existing = await prisma.user_merchants.findMany({
    where: { user_id: uid },
    select: { id: true, platform: true, merchant_id: true, status: true, is_deleted: true, platform_connection_id: true },
  });

  // 清理重复数据：保留 status=claimed/paused 或 id 最小的一条
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
    const keep = arr.find((m) => m.status === "claimed" || m.status === "paused") || arr.reduce((a, b) => (a.id < b.id ? a : b));
    deduped.push(keep);
    const toDelete = arr.filter((m) => m.id !== keep.id);
    if (toDelete.length > 0) {
      await prisma.user_merchants.deleteMany({ where: { id: { in: toDelete.map((m) => m.id) } } });
    }
  }

  const map = new Map(deduped.map((m) => [`${m.platform}:${m.merchant_id}`, m]));

  const updateOps: Array<{ id: bigint; data: Record<string, unknown> }> = [];
  const createOps: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const platformCounts: Record<string, number> = {};

  for (const row of fetchedRows) {
    const key = `${row.platform_code}:${row.merchant_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    platformCounts[row.platform_code] = (platformCounts[row.platform_code] || 0) + 1;

    let regions: unknown = null;
    if (row.support_regions) {
      try { regions = JSON.parse(row.support_regions); } catch {}
    }
    let cat = simplifyCategory(row.categories);

    const ex = map.get(key);
    if (ex) {
      const d: Record<string, unknown> = {};
      if (row.merchant_name) d.merchant_name = row.merchant_name;
      if (cat) d.category = cat;
      if (row.commission_rate) d.commission_rate = row.commission_rate;
      if (regions != null) d.supported_regions = regions;
      if (row.site_url) d.merchant_url = row.site_url;
      if (row.logo) d.logo_url = row.logo;
      if (row.campaign_link) { d.tracking_link = row.campaign_link; d.campaign_link = row.campaign_link; }
      if (!ex.platform_connection_id && row.conn_id) d.platform_connection_id = row.conn_id;
      if (ex.is_deleted === 1) { d.is_deleted = 0; d.status = "available"; }
      if (Object.keys(d).length > 0) updateOps.push({ id: ex.id, data: d });
    } else {
      const d: Record<string, unknown> = {
        user_id: uid,
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
      if (regions != null) d.supported_regions = regions;
      createOps.push(d);
    }
  }

  // 批量更新
  let updatedCount = 0;
  const DB_BATCH = 50;
  for (let i = 0; i < updateOps.length; i += DB_BATCH) {
    await Promise.all(updateOps.slice(i, i + DB_BATCH).map(async (op) => {
      try {
        await prisma.user_merchants.update({ where: { id: op.id }, data: op.data });
        updatedCount++;
      } catch {}
    }));
  }

  // 批量新建
  let newCount = 0;
  const CREATE_BATCH = 200;
  for (let i = 0; i < createOps.length; i += CREATE_BATCH) {
    try {
      const r = await prisma.user_merchants.createMany({
        data: createOps.slice(i, i + CREATE_BATCH) as never[],
        skipDuplicates: true,
      });
      newCount += r.count;
    } catch {}
  }

  return apiSuccess(
    serializeData({ newCount, updatedCount, total: fetchedRows.length, platformCounts, errors }),
    `同步完成：新增 ${newCount}，更新 ${updatedCount}，共 ${fetchedRows.length} 条商家数据${errors.length ? `（${errors.length} 个平台报错）` : ""}`,
  );
});

function simplifyCategory(raw: string): string {
  if (!raw) return "";
  let cat = raw.replace(/^"|"$/g, "").trim();
  const parts = cat.split(">").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return cat;
  const last = parts[parts.length - 1];
  if (parts.length >= 2 && parts[parts.length - 2] === last) return last;
  return last;
}
