import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * POST /api/user/data-center/cids/refresh-counts
 * body: { mcc_account_id }
 *
 * D-007（2026-05-16）：轻量"刷新广告数量"接口
 * 数据源为 Google Sheet CampaignInfo（统一脚本维护），零 Google Ads API 消耗。
 *  - 作用域仅本 MCC（不跨 MCC，不跨用户）
 *  - 只更新 campaigns.google_status / last_google_sync_at
 *  - 不创建新发现的 campaign（避免触发商家联动）
 *  - 写回后重新 groupBy 三段计数，返回与 GET 相同结构
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json().catch(() => ({}));
  const mccAccountId = body?.mcc_account_id;
  if (!mccAccountId) return apiError("缺少 mcc_account_id", 400);

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: BigInt(mccAccountId), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!mcc) return apiError("MCC 账户不存在", 404);
  if (!mcc.sheet_url) {
    return apiError(
      `MCC「${mcc.mcc_name || mcc.mcc_id}」未配置 Google Sheet，请在「个人设置 → MCC 管理」中填写 Sheet 链接`,
      400,
    );
  }

  const cids = await prisma.mcc_cid_accounts.findMany({
    where: { mcc_account_id: BigInt(mccAccountId), is_deleted: 0, status: "active" },
    orderBy: { customer_id: "asc" },
  });

  if (cids.length === 0) {
    return apiSuccess(serializeData({
      cids: [],
      refreshed: { customer_ids: 0, statuses_pulled: 0, db_updated: 0, disabled_cids: 0 },
    }));
  }

  const customerIds = cids.map((c) => c.customer_id);

  try {
    const { readCampaignInfoStatuses } = await import("@/lib/sheet-status-sync");
    const sheetMap = await readCampaignInfoStatuses(mcc.sheet_url);
    if (!sheetMap) {
      return apiError(
        "刷新广告数量失败：该 MCC 的 Sheet 缺少 CampaignInfo 数据（需 Google Ads 统一脚本生成），请确认脚本已在运行且 Sheet 已设为「知道链接的任何人都可以查看」",
        500,
      );
    }

    let dbUpdated = 0;

    // 1. Sheet 状态 → 更新已有 campaigns.google_status（不创建新行，避免联动）
    const existingCampaigns = await prisma.campaigns.findMany({
      where: { mcc_id: BigInt(mccAccountId), is_deleted: 0 },
      select: { id: true, google_campaign_id: true, google_status: true, customer_id: true },
    });
    const existingMap = new Map(existingCampaigns.map((c) => [c.google_campaign_id, c]));

    const liveCampaignIds = new Set<string>();
    for (const [gcid, s] of sheetMap) {
      liveCampaignIds.add(gcid);
      const existing = existingMap.get(gcid);
      if (!existing) continue;
      const statusChanged = existing.google_status !== s.status;
      const cidFilling = !existing.customer_id && s.customerId;
      if (!statusChanged && !cidFilling) {
        await prisma.campaigns.update({
          where: { id: existing.id },
          data: { last_google_sync_at: new Date() },
        });
        continue;
      }
      const updateData: Record<string, unknown> = { last_google_sync_at: new Date() };
      if (statusChanged) updateData.google_status = s.status;
      if (cidFilling) updateData.customer_id = s.customerId;
      await prisma.campaigns.update({ where: { id: existing.id }, data: updateData });
      dbUpdated++;
    }

    // 2. 本地 ENABLED 但 Sheet 已不含 → 极可能被删除，标 REMOVED
    // 仅作用于本次 Sheet 覆盖到的 CID（脚本没扫到的 CID 不动，避免误标）
    const cidsCoveredByStatuses = new Set<string>();
    for (const [, s] of sheetMap) if (s.customerId) cidsCoveredByStatuses.add(s.customerId);
    if (cidsCoveredByStatuses.size > 0) {
      const ghosts = existingCampaigns.filter(
        (c) =>
          c.customer_id &&
          cidsCoveredByStatuses.has(c.customer_id) &&
          c.google_status === "ENABLED" &&
          c.google_campaign_id &&
          !liveCampaignIds.has(c.google_campaign_id),
      );
      if (ghosts.length > 0) {
        const r = await prisma.campaigns.updateMany({
          where: { id: { in: ghosts.map((g) => g.id) } },
          data: { google_status: "REMOVED", last_google_sync_at: new Date() },
        });
        dbUpdated += r.count;
      }
    }

    // 3. 写回 mcc_cid_accounts.is_available（按 Sheet 真实情况；缺 CustomerId 的行跳过）
    const cidEnabledFlag = new Map<string, boolean>();
    for (const [, s] of sheetMap) {
      if (!s.customerId) continue;
      if (s.status === "ENABLED") cidEnabledFlag.set(s.customerId, true);
      else if (!cidEnabledFlag.has(s.customerId)) cidEnabledFlag.set(s.customerId, false);
    }
    const { CID_WRITE_GUARD } = await import("@/lib/google-ads/cid-availability");
    for (const [customerId, hasEnabled] of cidEnabledFlag) {
      await prisma.mcc_cid_accounts.updateMany({
        where: { mcc_account_id: BigInt(mccAccountId), customer_id: customerId, ...CID_WRITE_GUARD },
        data: { is_available: hasEnabled ? "N" : "Y", last_synced_at: new Date() },
      });
    }

    // 4. 重新 groupBy 三段计数，返回与 GET 相同结构
    const refreshedCids = await prisma.mcc_cid_accounts.findMany({
      where: { mcc_account_id: BigInt(mccAccountId), is_deleted: 0, status: "active" },
      orderBy: { customer_id: "asc" },
    });

    const campaignCounts = await prisma.campaigns.groupBy({
      by: ["customer_id", "google_status"],
      where: {
        mcc_id: BigInt(mccAccountId),
        customer_id: { not: null },
        google_campaign_id: { not: null },
        is_deleted: 0,
      },
      _count: { _all: true },
    });

    const countsByCid = new Map<string, { enabled: number; paused: number; removed: number }>();
    for (const row of campaignCounts) {
      if (!row.customer_id) continue;
      const slot = countsByCid.get(row.customer_id) || { enabled: 0, paused: 0, removed: 0 };
      const status = String(row.google_status || "").toUpperCase();
      const n = row._count._all;
      if (status === "ENABLED") slot.enabled += n;
      else if (status === "PAUSED") slot.paused += n;
      else if (status === "REMOVED") slot.removed += n;
      countsByCid.set(row.customer_id, slot);
    }

    const { deriveDisplayAvailability } = await import("@/lib/google-ads/cid-availability");
    const cidsWithCounts = refreshedCids.map((cid) => {
      const c = countsByCid.get(cid.customer_id) || { enabled: 0, paused: 0, removed: 0 };
      return {
        ...cid,
        enabled_count: c.enabled,
        paused_count: c.paused,
        removed_count: c.removed,
        is_available: deriveDisplayAvailability({
          rowStatus: cid.status,
          storedAvailability: cid.is_available,
          enabledCount: c.enabled,
        }),
      };
    });

    return apiSuccess(serializeData({
      cids: cidsWithCounts,
      refreshed: {
        customer_ids: customerIds.length,
        statuses_pulled: sheetMap.size,
        db_updated: dbUpdated,
        disabled_cids: 0,
      },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[CID RefreshCounts] 失败:", message);
    return apiError(`刷新广告数量失败: ${message.slice(0, 200)}`, 500);
  }
}
