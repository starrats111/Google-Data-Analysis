import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { normalizeCampaignActionItems, type CampaignActionItem } from "@/lib/campaign-analysis";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * D-238「一键执行」：把 AI 建议的 actionItems 通过 Google Ads API 落地。
 *
 * POST { campaignId, actions: [{type, targetValue?, percentChange?}] }
 *   - increase/decrease_budget：改预算（targetValue 绝对值优先，否则按 percentChange 相对现值）
 *   - increase/decrease_cpc：改 ad_group 出价
 *   - pause：暂停系列
 *   - keep：无操作
 *
 * 安全钳制（与 kyads 同思路）：预算 $0.5-$500、CPC $0.01-$10；每次执行写 operation_logs。
 */

const BUDGET_MIN = 0.5;
const BUDGET_MAX = 500;
const CPC_MIN = 0.01;
const CPC_MAX = 10;

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function resolveTarget(
  action: CampaignActionItem,
  currentValue: number,
): number | null {
  if (action.targetValue != null && action.targetValue > 0) return action.targetValue;
  if (action.percentChange != null && action.percentChange > 0 && currentValue > 0) {
    const factor = action.type.startsWith("increase")
      ? 1 + action.percentChange / 100
      : 1 - action.percentChange / 100;
    return currentValue * factor;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const body = await req.json();
  const campaignIdRaw = body.campaignId;
  if (!campaignIdRaw) return apiError("缺少 campaignId", 400);
  const actions = normalizeCampaignActionItems(body.actions);
  if (actions.length === 0) return apiError("没有可执行的操作建议", 400);

  const userId = BigInt(user.userId);
  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(String(campaignIdRaw)), user_id: userId, is_deleted: 0 },
  });
  if (!campaign) return apiError("广告系列不存在", 404);
  if (!campaign.google_campaign_id) return apiError("广告系列未关联 Google Ads", 400);
  if (!campaign.mcc_id) return apiError("广告系列未关联 MCC 账户", 400);
  // D-248：被中止 CID 旗下广告禁止一切操作（前端灰化 + 服务端拦截双层）
  {
    const { getCidSuspendedError } = await import("@/lib/google-ads/cid-suspension");
    const suspendedMsg = await getCidSuspendedError(campaign.customer_id, campaign.mcc_id);
    if (suspendedMsg) return apiError(suspendedMsg, 403);
  }

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: campaign.mcc_id, user_id: userId, is_deleted: 0 },
  });
  if (!mcc) return apiError("广告系列关联的 MCC 账户不存在", 404);
  {
    const { poolHasCredentialFor } = await import("@/lib/google-ads/token-pool");
    if (!mcc.service_account_json && !(await poolHasCredentialFor(mcc.mcc_id))) {
      return apiError("MCC 未配置服务账号凭证，且组 Token 池中无配对的 Service Account JSON", 400);
    }
  }

  const credentials = {
    mcc_id: mcc.mcc_id,
    developer_token: mcc.developer_token || "",
    service_account_json: mcc.service_account_json || "",
  };
  const { updateCampaignBudget, updateCampaignMaxCpc, updateCampaignStatus } = await import("@/lib/google-ads");

  const results: Array<{ type: string; success: boolean; message: string; appliedValue?: number }> = [];

  for (const action of actions) {
    try {
      if (action.type === "keep") {
        results.push({ type: action.type, success: true, message: "维持现状，无需调整" });
        continue;
      }
      if (action.type === "pause") {
        // D-247：Hermes 在管系列状态主权归 Hermes，CRM 不写状态（预算/CPC 类动作不受限）
        if (campaign.hermes_managed_at) {
          results.push({ type: action.type, success: false, message: "该系列由 Hermes 托管，状态主权归 Hermes：CRM 不执行暂停，请通过飞书让 Hermes 处理" });
          continue;
        }
        const r = await updateCampaignStatus(credentials, campaign.customer_id || "", campaign.google_campaign_id, "PAUSED");
        if (r.success) {
          await prisma.campaigns.update({
            where: { id: campaign.id },
            data: {
              google_status: "PAUSED", status: "paused", last_google_sync_at: new Date(),
              // D-246：实时 mutate 成功的状态，Sheet 快照同步在信任窗口内不得覆盖
              status_verified_at: new Date(),
              // D-245 复盘分析：记录暂停时间与来源（已是 PAUSED 时不覆盖更早的暂停时间）
              ...(campaign.google_status !== "PAUSED" ? { paused_at: new Date(), pause_source: "ai_apply" } : {}),
            },
          });
        }
        results.push({ type: action.type, ...r });
        continue;
      }
      if (action.type === "increase_budget" || action.type === "decrease_budget") {
        const current = Number(campaign.daily_budget || 0);
        const target = resolveTarget(action, current);
        if (target == null) {
          results.push({ type: action.type, success: false, message: "建议缺少目标值/百分比，无法执行" });
          continue;
        }
        const applied = Number(clamp(target, BUDGET_MIN, BUDGET_MAX).toFixed(2));
        const r = await updateCampaignBudget(credentials, campaign.customer_id || "", campaign.google_campaign_id, applied);
        if (r.success) {
          await prisma.campaigns.update({ where: { id: campaign.id }, data: { daily_budget: applied } });
        }
        results.push({ type: action.type, ...r, appliedValue: applied });
        continue;
      }
      // increase_cpc / decrease_cpc
      const current = Number(campaign.max_cpc_limit || 0);
      const target = resolveTarget(action, current);
      if (target == null) {
        results.push({ type: action.type, success: false, message: "建议缺少目标值/百分比，无法执行" });
        continue;
      }
      const applied = Number(clamp(target, CPC_MIN, CPC_MAX).toFixed(2));
      const r = await updateCampaignMaxCpc(credentials, campaign.customer_id || "", campaign.google_campaign_id, applied);
      if (r.success) {
        await prisma.campaigns.update({ where: { id: campaign.id }, data: { max_cpc_limit: applied } });
      }
      results.push({ type: action.type, ...r, appliedValue: applied });
    } catch (err) {
      results.push({
        type: action.type,
        success: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 审计日志
  try {
    await prisma.operation_logs.create({
      data: {
        user_id: userId,
        username: user.username || String(user.userId),
        action: "apply_ai_actions",
        target_type: "campaign",
        target_id: String(campaign.id),
        detail: JSON.stringify({ campaign_name: campaign.campaign_name, actions, results }).slice(0, 4000),
      },
    });
  } catch { /* 审计失败不阻塞 */ }

  const allOk = results.every((r) => r.success);
  return apiSuccess({ results, allSuccess: allOk }, allOk ? "执行完成" : "部分操作执行失败");
}
