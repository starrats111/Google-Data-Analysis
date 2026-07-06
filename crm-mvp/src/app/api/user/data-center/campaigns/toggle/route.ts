import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * POST /api/user/data-center/campaigns/toggle
 * 切换广告系列状态（启用 ↔ 暂停）- Service Account 认证
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { campaign_id, action } = await req.json();
  if (!campaign_id) return apiError("缺少 campaign_id");
  if (!["enable", "pause"].includes(action)) return apiError("action 必须是 enable 或 pause");

  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaign_id), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!campaign) return apiError("广告系列不存在", 404);
  if (!campaign.google_campaign_id) return apiError("该广告系列尚未提交到 Google Ads");
  if (!campaign.mcc_id) return apiError("该广告系列未关联 MCC 账户");

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: campaign.mcc_id, is_deleted: 0 },
  });
  if (!mcc) return apiError("MCC 账户不存在");
  {
    const { poolHasCredentialFor } = await import("@/lib/google-ads/token-pool");
    if (!mcc.service_account_json && !(await poolHasCredentialFor(mcc.mcc_id))) {
      return apiError("MCC 未配置服务账号凭证，且组 Token 池中无配对的 Service Account JSON（请组长在「团队设置 → Token 池」配置）");
    }
  }

  try {
    const { updateCampaignStatus } = await import("@/lib/google-ads");
    const newStatus = action === "enable" ? "ENABLED" as const : "PAUSED" as const;
    const result = await updateCampaignStatus(
      { mcc_id: mcc.mcc_id, developer_token: mcc.developer_token || "", service_account_json: mcc.service_account_json || "" },
      campaign.customer_id || "",
      campaign.google_campaign_id,
      newStatus,
    );

    if (!result.success) return apiError(result.message);

    // ─────────────────────────────────────────────────────────────
    // D-029 BUG 修复（2026-05-26 实证 003-CG2-f1arcade-US 5/21 暂停后仍烧 $24.4）：
    //   旧代码反查失败时静默吞掉错误，confirmedStatus 默认沿用预期，导致 DB 写
    //   PAUSED 但 Google Ads 实际仍 ENABLED 的"幽灵暂停"现象。
    //
    // 修复策略：
    //   1. mutate 后等 1.5s 让 Google Ads 内部状态最终一致（实证有 eventual consistency 延迟）
    //   2. 反查失败时不静默：返回明确警告给前端，但 DB 仍记录预期 status（保证操作不丢失）
    //   3. 反查成功但 realStatus != newStatus（mutate 没真生效）：返回 mismatch 错误
    //   4. 详细日志每一步，便于后续排障
    // ─────────────────────────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 1500));

    let confirmedStatus = newStatus;
    let verifyOk = false;
    let verifyError: string | null = null;
    try {
      const { queryGoogleAds } = await import("@/lib/google-ads/client");
      const credentials = { mcc_id: mcc.mcc_id, developer_token: mcc.developer_token || "", service_account_json: mcc.service_account_json || "" };
      const rows = await queryGoogleAds(credentials, (campaign.customer_id || "").replace(/-/g, ""), `
        SELECT campaign.id, campaign.status
        FROM campaign
        WHERE campaign.id = ${campaign.google_campaign_id}
      `);
      if (rows.length > 0) {
        const c = rows[0].campaign as Record<string, unknown> | undefined;
        const realStatus = String(c?.status ?? "");
        if (realStatus === "ENABLED" || realStatus === "PAUSED" || realStatus === "REMOVED") {
          confirmedStatus = realStatus as typeof newStatus;
          verifyOk = true;
          console.log(`[CampaignToggle] D-029 反查成功 campaign_id=${campaign.id} google_id=${campaign.google_campaign_id} mutate=${newStatus} confirmed=${realStatus}`);
        } else {
          verifyError = `Google Ads 反查返回未知 status=${realStatus}`;
          console.warn(`[CampaignToggle] D-029 反查异常 campaign_id=${campaign.id} status=${realStatus}`);
        }
      } else {
        verifyError = "Google Ads 反查返回 0 条记录，可能广告系列已被远程删除";
        console.warn(`[CampaignToggle] D-029 反查空 campaign_id=${campaign.id} google_id=${campaign.google_campaign_id}`);
      }
    } catch (err) {
      verifyError = err instanceof Error ? err.message : String(err);
      console.error(`[CampaignToggle] D-029 反查失败 campaign_id=${campaign.id} mcc=${mcc.mcc_id} customer=${campaign.customer_id} err=${verifyError}`);
    }

    // D-040 v2 BUG-1: 双向同步 — 把 CRM 内部 status 字段一起更新，避免与 google_status 长期不一致
    // 旧逻辑只写 google_status，cron status-sync 也不刷 status，导致 9810 条历史 status!=google_status 漂移
    const confirmedStatusStr = String(confirmedStatus);
    const newInternalStatus = confirmedStatusStr === "PAUSED" || confirmedStatusStr === "REMOVED" ? "paused" : "active";
    await prisma.campaigns.update({
      where: { id: campaign.id },
      data: {
        status: newInternalStatus,
        google_status: confirmedStatus,
        last_google_sync_at: new Date(),
      },
    });

    const { syncMerchantStatusForUser } = await import("@/lib/campaign-merchant-link");
    await syncMerchantStatusForUser(BigInt(user.userId));

    // D-029：mutate 之后反查的 status 与预期不一致 → 明确告警，让用户知道操作未生效
    if (verifyOk && confirmedStatus !== newStatus) {
      return apiError(
        `Google Ads 反查显示状态为 ${confirmedStatus}，但您请求 ${newStatus}。` +
        `这通常说明 Mutate 操作未在 Google Ads 端真正生效（可能 MCC 服务账号已失去对该 CID 的访问权限）。` +
        `请到「个人设置 → MCC 管理」中重新配置该 MCC 的 Service Account JSON，或在 Google Ads 后台手动调整。`,
      );
    }

    // D-029：反查失败 → 警告（不阻塞，但前端明显提示）
    if (!verifyOk) {
      return apiSuccess(
        { status: confirmedStatus, verify_ok: false, verify_error: verifyError },
        `暂停指令已发送到 Google Ads，但无法验证实际状态（${verifyError || "原因未知"}）。` +
        `请在几分钟后到 Google Ads 后台核实该广告系列是否真的已${action === "enable" ? "启用" : "暂停"}。`,
      );
    }

    return apiSuccess({ status: confirmedStatus, verify_ok: true }, `广告已${action === "enable" ? "启用" : "暂停"}`);
  } catch (err) {
    return apiError(`操作失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
