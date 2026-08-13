/**
 * 发布竞品情报草稿。
 *
 * 只做鉴权 + 参数落地，真正的活在 `publish-draft.ts`：把草稿资产同步进 CRM 的
 * ad_creatives / keywords，然后建 ad_submit_jobs 交给 CRM 的提交流水线。
 * 命名（六段 + 共用序号池）、CID 挑选、政策改写重投、campaigns 回写全部由那条链负责。
 */
import { NextRequest } from "next/server";
import { apiError, apiSuccess } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import { serializeData } from "@/lib/auth";
import { PublishDraftError, publishDraft } from "@/lib/rival-intel/publish-draft";

export const POST = withUser(async (req: NextRequest, { user, params }) => {
  const id = params?.id;
  if (!id) return apiError("缺少草稿 ID");

  const body = await req.json().catch(() => ({}));
  const customerId = typeof body?.customer_id === "string" ? body.customer_id.trim() : null;

  try {
    const result = await publishDraft({
      draftId: BigInt(id),
      userId: BigInt(user.userId),
      customerId,
    });
    return apiSuccess(
      serializeData({
        campaign_id: result.campaignId.toString(),
        submit_job_id: result.submitJobId.toString(),
        reused: result.reused,
        headlines: result.headlines,
        descriptions: result.descriptions,
        keywords: result.keywords,
        negative_keywords: result.negativeKeywords,
      }),
      "已提交，正在后台发布到 Google Ads",
    );
  } catch (err) {
    if (err instanceof PublishDraftError) return apiError(err.message, err.status);
    throw err;
  }
});
