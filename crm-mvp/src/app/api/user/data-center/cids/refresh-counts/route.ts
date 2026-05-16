import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * POST /api/user/data-center/cids/refresh-counts
 * body: { mcc_account_id }
 *
 * D-007（2026-05-16）：轻量"刷新广告数量"接口
 * 与 syncUserCampaignStatuses 区别：
 *  - 作用域仅本 MCC（不跨 MCC，不跨用户）
 *  - 只更新 campaigns.google_status / last_google_sync_at（同 disabled 时 PAUSED 联动）
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
  if (!mcc.service_account_json) return apiError("MCC 未配置服务账号凭证", 400);
  if (!mcc.developer_token) {
    return apiError(
      `MCC「${mcc.mcc_name || mcc.mcc_id}」未配置 developer_token，请在「个人设置 → MCC 管理」中编辑该 MCC 填写 Developer Token`,
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
    const { fetchAllCampaignStatuses } = await import("@/lib/google-ads");
    const credentials = {
      mcc_id: mcc.mcc_id,
      developer_token: mcc.developer_token,
      service_account_json: mcc.service_account_json,
    };

    const { statuses, disabledCids } = await fetchAllCampaignStatuses(credentials, customerIds);
    let dbUpdated = 0;

    // 1. 停用/中止的 CID → campaigns 强制 PAUSED + mcc_cid_accounts.is_available='D'
    if (disabledCids.length > 0) {
      const r = await prisma.campaigns.updateMany({
        where: {
          customer_id: { in: disabledCids },
          mcc_id: BigInt(mccAccountId),
          is_deleted: 0,
          google_status: { not: "PAUSED" },
        },
        data: {
          google_status: "PAUSED",
          status: "paused",
          last_google_sync_at: new Date(),
        },
      });
      dbUpdated += r.count;
      await prisma.mcc_cid_accounts.updateMany({
        where: { mcc_account_id: BigInt(mccAccountId), customer_id: { in: disabledCids } },
        data: { is_available: "D", last_synced_at: new Date() },
      });
    }

    // 2. 拉到的 statuses → 更新已有 campaigns.google_status（不创建新行，避免联动）
    const existingCampaigns = await prisma.campaigns.findMany({
      where: { mcc_id: BigInt(mccAccountId), is_deleted: 0 },
      select: { id: true, google_campaign_id: true, google_status: true, customer_id: true },
    });
    const existingMap = new Map(existingCampaigns.map((c) => [c.google_campaign_id, c]));

    const liveCampaignIds = new Set<string>();
    for (const s of statuses) {
      liveCampaignIds.add(s.campaign_id);
      const existing = existingMap.get(s.campaign_id);
      if (!existing) continue;
      const statusChanged = existing.google_status !== s.status;
      const cidFilling = !existing.customer_id && s.customer_id;
      if (!statusChanged && !cidFilling) {
        await prisma.campaigns.update({
          where: { id: existing.id },
          data: { last_google_sync_at: new Date() },
        });
        continue;
      }
      const updateData: Record<string, unknown> = { last_google_sync_at: new Date() };
      if (statusChanged) updateData.google_status = s.status;
      if (cidFilling) updateData.customer_id = s.customer_id;
      await prisma.campaigns.update({ where: { id: existing.id }, data: updateData });
      dbUpdated++;
    }

    // 3. 本地 ENABLED 但 Google Ads 已不返回 → 极可能被删除，标 REMOVED
    // 仅作用于本次 statuses 覆盖到的 CID（避免误标 disabledCids 已经 PAUSED 的）
    const cidsCoveredByStatuses = new Set<string>();
    for (const s of statuses) if (s.customer_id) cidsCoveredByStatuses.add(s.customer_id);
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

    // 4. 写回 mcc_cid_accounts.is_available（按本次 statuses 真实情况）
    const cidEnabledFlag = new Map<string, boolean>();
    for (const s of statuses) {
      if (!s.customer_id) continue;
      if (s.status === "ENABLED") cidEnabledFlag.set(s.customer_id, true);
      else if (!cidEnabledFlag.has(s.customer_id)) cidEnabledFlag.set(s.customer_id, false);
    }
    for (const [customerId, hasEnabled] of cidEnabledFlag) {
      if (disabledCids.includes(customerId)) continue;
      await prisma.mcc_cid_accounts.updateMany({
        where: { mcc_account_id: BigInt(mccAccountId), customer_id: customerId },
        data: { is_available: hasEnabled ? "N" : "Y", last_synced_at: new Date() },
      });
    }

    // 5. 重新 groupBy 三段计数，返回与 GET 相同结构
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

    const cidsWithCounts = refreshedCids.map((cid) => {
      const c = countsByCid.get(cid.customer_id) || { enabled: 0, paused: 0, removed: 0 };
      return {
        ...cid,
        enabled_count: c.enabled,
        paused_count: c.paused,
        removed_count: c.removed,
        is_available: c.enabled > 0 ? "N" : "Y",
      };
    });

    return apiSuccess(serializeData({
      cids: cidsWithCounts,
      refreshed: {
        customer_ids: customerIds.length,
        statuses_pulled: statuses.length,
        db_updated: dbUpdated,
        disabled_cids: disabledCids.length,
      },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[CID RefreshCounts] 失败:", message);

    if (message.includes("PERMISSION_DENIED") && message.includes("has not been used in project")) {
      const projectMatch = message.match(/project (\d+)/);
      const projectId = projectMatch?.[1] || "未知";
      return apiError(
        `刷新广告数量失败：Service Account 所属的 Google Cloud 项目（${projectId}）未启用 Google Ads API。请联系管理员在 Google Cloud Console 中启用该 API 后重试。`,
        500,
      );
    }
    if (message.includes("DEVELOPER_TOKEN_NOT_APPROVED")) {
      return apiError(
        "刷新广告数量失败：Developer Token 仅被批准用于测试账号，无法访问正式广告账号。",
        500,
      );
    }
    if (message.includes("UNAUTHENTICATED") || message.includes("missing required authentication credential")) {
      return apiError(
        "刷新广告数量失败：认证失败，Service Account 凭证无效或已过期。请检查 MCC 配置中的服务账号 JSON。",
        500,
      );
    }
    if (message.includes("PERMISSION_DENIED")) {
      return apiError("刷新广告数量失败：权限不足，请检查 Service Account 是否有 Google Ads API 访问权限", 500);
    }
    return apiError(`刷新广告数量失败: ${message.slice(0, 200)}`, 500);
  }
}
