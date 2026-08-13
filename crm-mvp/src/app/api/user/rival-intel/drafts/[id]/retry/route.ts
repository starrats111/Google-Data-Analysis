/**
 * 重试失败的生成阶段。
 *
 * 把草稿从 draft_failed 复位成 draft_generating 并清掉失败标记，再入队。已完成的阶段
 * 保留在 completed_stages 里，所以 runner 会从失败那一步接着跑——不会重新花一遍
 * SerpApi / DataForSEO 的钱。
 */
import { NextRequest } from "next/server";
import { apiError, apiSuccess } from "@/lib/constants";
import { withUser } from "@/lib/api-handler";
import { getDraftById, updateDraft } from "@/lib/rival-intel/ad-create/repository";
import { enqueueDraftGeneration } from "@/lib/rival-intel/draft-generation-runner";

export const POST = withUser(async (_req: NextRequest, { user, params }) => {
  const id = params?.id;
  if (!id) return apiError("缺少草稿 ID");

  const draftId = BigInt(id);
  const draft = await getDraftById(draftId);
  if (!draft) return apiError("草稿不存在", 404);
  if (draft.user_id !== BigInt(user.userId)) return apiError("草稿不存在", 404);
  if (draft.status === "draft_ready") return apiError("草稿已生成完成，无需重试");
  if (draft.status === "draft_generating" && !draft.failed_stage) {
    return apiError("草稿正在生成中，请稍候");
  }

  await updateDraft(draftId, {
    status: "draft_generating",
    failed_stage: null,
    error_code: null,
    error_message: null,
    retryable: 0,
    stage_running: 0,
    stage_claimed_at: null,
  });
  enqueueDraftGeneration(draftId);

  return apiSuccess({ id: draftId.toString() }, "已重新入队，正在后台继续生成");
});
