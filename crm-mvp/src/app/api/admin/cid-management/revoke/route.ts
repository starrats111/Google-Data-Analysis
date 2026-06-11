import { NextRequest } from "next/server";
import { withAdmin } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { logOperation } from "@/lib/operation-log";

/**
 * POST /api/admin/cid-management/revoke  body: { mcc_account_id, customer_id }
 *
 * 一键撤销 CID：
 *   1) 二次确认已在前端完成（展示 ENABLED 数量）；
 *   2) 先把该 CID 下本地 ENABLED 广告系列标 PAUSED/REMOVED（捕获 id 以便失败回滚）；
 *   3) 通过 Google Ads API 把该 CID 从 MCC 解绑（CustomerClientLink → INACTIVE）；
 *   4) 成功 → 本地 mcc_cid_accounts.status=cancelled + 写审计（revoke_cid）；
 *   5) 失败 → 回滚第 2 步、写失败审计、返回 Google 错误原文。
 *
 * ⚠️ 解绑不可逆（恢复需重新邀请并由对方接受）。管理员专用。
 */
export const POST = withAdmin(async (req: NextRequest, { user }) => {
  const body = await req.json().catch(() => ({}));
  const mccAccountId = body?.mcc_account_id;
  const customerId = body?.customer_id ? String(body.customer_id).replace(/-/g, "") : "";
  if (!mccAccountId || !customerId) return apiError("缺少 mcc_account_id 或 customer_id", 400);

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: BigInt(mccAccountId), is_deleted: 0 },
  });
  if (!mcc) return apiError("MCC 账户不存在", 404);
  if (!mcc.service_account_json) return apiError("该 MCC 未配置服务账号凭证，无法解绑", 400);
  if (!mcc.developer_token) return apiError(`MCC「${mcc.mcc_name || mcc.mcc_id}」未配置 Developer Token，无法解绑`, 400);

  const cidRec = await prisma.mcc_cid_accounts.findFirst({
    where: { mcc_account_id: BigInt(mccAccountId), customer_id: customerId, is_deleted: 0 },
  });
  if (!cidRec) return apiError("该 MCC 下未找到此 CID 记录", 404);
  if (cidRec.status === "cancelled") return apiError("该 CID 已是「已撤销」状态，无需重复操作", 400);

  // 2) 预暂停本地 ENABLED 广告系列（记录 id 以便失败回滚）
  const enabled = await prisma.campaigns.findMany({
    where: { mcc_id: BigInt(mccAccountId), customer_id: customerId, is_deleted: 0, google_status: "ENABLED" },
    select: { id: true },
  });
  const enabledIds = enabled.map((c) => c.id);
  if (enabledIds.length > 0) {
    await prisma.campaigns.updateMany({
      where: { id: { in: enabledIds } },
      data: { status: "paused", google_status: "REMOVED", last_google_sync_at: new Date() },
    });
  }

  try {
    const { unlinkCidFromMcc } = await import("@/lib/google-ads");
    const result = await unlinkCidFromMcc(
      { mcc_id: mcc.mcc_id, developer_token: mcc.developer_token, service_account_json: mcc.service_account_json },
      customerId,
    );

    // 4) 本地标记 cancelled
    await prisma.mcc_cid_accounts.update({
      where: { id: cidRec.id },
      data: { status: "cancelled", is_available: "N", last_synced_at: new Date() },
    });

    await logOperation({
      userId: user.userId,
      username: user.username,
      action: "revoke_cid",
      targetType: "cid",
      targetId: customerId,
      detail: {
        mcc_account_id: String(mccAccountId),
        mcc_id: mcc.mcc_id,
        mcc_owner_user_id: mcc.user_id.toString(),
        customer_id: customerId,
        customer_name: cidRec.customer_name,
        paused_campaigns: enabledIds.length,
        google_unlinked: result.unlinked,
        google_already_inactive: result.alreadyInactive,
      },
      req,
    });

    const note = result.alreadyInactive
      ? "该 CID 在 Google Ads 中本就未与此 MCC 关联（或已解绑），已同步标记为已撤销"
      : "已从 Google Ads 的此 MCC 解绑（CustomerClientLink → INACTIVE）";
    return apiSuccess({
      unlinked: result.unlinked,
      already_inactive: result.alreadyInactive,
      paused_campaigns: enabledIds.length,
      message: `撤销成功：${note}${enabledIds.length > 0 ? `，并暂停/移除本地 ${enabledIds.length} 个在投广告系列` : ""}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 5) 回滚预暂停（Google 侧未解绑，保持一致）
    if (enabledIds.length > 0) {
      await prisma.campaigns.updateMany({
        where: { id: { in: enabledIds } },
        data: { status: "active", google_status: "ENABLED" },
      });
    }
    await logOperation({
      userId: user.userId,
      username: user.username,
      action: "revoke_cid_failed",
      targetType: "cid",
      targetId: customerId,
      detail: { mcc_account_id: String(mccAccountId), mcc_id: mcc.mcc_id, customer_id: customerId, error: message.slice(0, 500) },
      req,
    });
    return apiError(`撤销失败：${message.slice(0, 400)}`, 500);
  }
});
