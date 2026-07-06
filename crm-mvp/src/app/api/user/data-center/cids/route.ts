import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * GET /api/user/data-center/cids?mcc_account_id=xxx
 * 获取指定 MCC 下所有 CID 列表 + 每个 CID 当前的广告系列计数
 *
 * D-007（2026-05-16）：
 * - 取消"占用/可用"二元限制，前端不再 disabled，所有 active CID 均可选
 * - 新增 enabled_count / paused_count / removed_count 三段计数（来自本地 campaigns 表）
 * - 保留 is_available 字段向后兼容（仍按"有 ≥1 ENABLED 即 N"计算）
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const mccAccountId = searchParams.get("mcc_account_id");
  if (!mccAccountId) return apiError("缺少 mcc_account_id 参数", 400);

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: BigInt(mccAccountId), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!mcc) return apiError("MCC 账户不存在", 404);

  const cids = await prisma.mcc_cid_accounts.findMany({
    where: { mcc_account_id: BigInt(mccAccountId), is_deleted: 0, status: "active" },
    orderBy: { customer_id: "asc" },
  });

  // 一次 groupBy 同时拿到三种状态计数，cheap
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

  const cidsWithCounts = cids.map((cid) => {
    const c = countsByCid.get(cid.customer_id) || { enabled: 0, paused: 0, removed: 0 };
    return {
      ...cid,
      enabled_count: c.enabled,
      paused_count: c.paused,
      removed_count: c.removed,
      // 保留 is_available 向后兼容：有 ≥1 ENABLED 标 N，否则 Y
      is_available: c.enabled > 0 ? "N" : "Y",
    };
  });

  return apiSuccess(serializeData(cidsWithCounts));
}

/**
 * POST /api/user/data-center/cids
 * 从 Google Ads API 同步 MCC 下所有子账户 CID（Service Account 认证）
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { mcc_account_id } = await req.json();
  if (!mcc_account_id) return apiError("缺少 mcc_account_id", 400);

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: BigInt(mcc_account_id), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!mcc) return apiError("MCC 账户不存在", 404);
  {
    const { poolHasCredentialFor } = await import("@/lib/google-ads/token-pool");
    if (!mcc.service_account_json && !(await poolHasCredentialFor(mcc.mcc_id))) {
      return apiError("MCC 未配置服务账号凭证，且组 Token 池中无配对的 Service Account JSON（请组长在「团队设置 → Token 池」配置）", 400);
    }
  }

  try {
    const { listMccChildAccounts } = await import("@/lib/google-ads");

    const childAccounts = await listMccChildAccounts({
      mcc_id: mcc.mcc_id,
      developer_token: mcc.developer_token || "",
      service_account_json: mcc.service_account_json || "",
    });

    const existingCids = await prisma.mcc_cid_accounts.findMany({
      where: { mcc_account_id: BigInt(mcc_account_id), is_deleted: 0 },
    });
    const existingMap = new Map(existingCids.map((c) => [c.customer_id, c]));

    let created = 0, updated = 0, cancelled = 0;
    const googleCidSet = new Set(childAccounts.map((c) => c.customer_id));

    for (const child of childAccounts) {
      const existing = existingMap.get(child.customer_id);
      if (existing) {
        await prisma.mcc_cid_accounts.update({
          where: { id: existing.id },
          data: { customer_name: child.customer_name, status: "active", last_synced_at: new Date() },
        });
        updated++;
      } else {
        await prisma.mcc_cid_accounts.create({
          data: {
            mcc_account_id: BigInt(mcc_account_id),
            customer_id: child.customer_id,
            customer_name: child.customer_name,
            is_available: "Y", status: "active",
            last_synced_at: new Date(),
          },
        });
        created++;
      }
    }

    for (const existing of existingCids) {
      if (!googleCidSet.has(existing.customer_id) && existing.status === "active") {
        await prisma.mcc_cid_accounts.update({
          where: { id: existing.id },
          data: { status: "cancelled", is_available: "N" },
        });
        cancelled++;
      }
    }

    const allCids = await prisma.mcc_cid_accounts.findMany({
      where: { mcc_account_id: BigInt(mcc_account_id), is_deleted: 0, status: "active" },
      orderBy: { customer_id: "asc" },
    });

    // D-007：同 GET 路径一致，groupBy 拿三段计数
    const campaignCounts = await prisma.campaigns.groupBy({
      by: ["customer_id", "google_status"],
      where: {
        mcc_id: BigInt(mcc_account_id),
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

    const cidsWithCounts = allCids.map((cid) => {
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
      synced: { created, updated, cancelled, total: allCids.length },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[CID Sync] 失败:", message);

    if (message.includes("PERMISSION_DENIED") && message.includes("has not been used in project")) {
      const projectMatch = message.match(/project (\d+)/);
      const projectId = projectMatch?.[1] || "未知";
      return apiError(
        `CID 同步失败：Service Account 所属的 Google Cloud 项目（${projectId}）未启用 Google Ads API。` +
        `请联系管理员在 Google Cloud Console 中启用该 API 后重试。`,
        500
      );
    }
    if (message.includes("DEVELOPER_TOKEN_NOT_APPROVED")) {
      return apiError(
        "CID 同步失败：Developer Token 仅被批准用于测试账号，无法访问正式广告账号。" +
        "请在 Google Ads API Center 申请标准访问权限（Standard Access），或使用测试账号。",
        500
      );
    }
    if (message.includes("UNAUTHENTICATED") || message.includes("missing required authentication credential")) {
      return apiError(
        "CID 同步失败：认证失败，Service Account 凭证无效或已过期。" +
        "请检查 MCC 配置中的服务账号 JSON 是否正确，以及该服务账号是否有权限访问此 MCC。",
        500
      );
    }
    if (message.includes("PERMISSION_DENIED")) {
      return apiError("CID 同步失败：权限不足，请检查 Service Account 是否有 Google Ads API 访问权限", 500);
    }
    if (message.includes("无法从 Service Account 获取 access_token")) {
      return apiError("CID 同步失败：Service Account 凭证无效，请检查 MCC 配置中的服务账号 JSON", 500);
    }

    return apiError(`CID 同步失败: ${message.slice(0, 200)}`, 500);
  }
}
