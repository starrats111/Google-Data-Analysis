import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { callAiWithFallback } from "@/lib/ai-service";
import { dateColumnStart } from "@/lib/date-utils";
import {
  computePauseWindow, buildDailyRows, sumTotals, buildReviewScopeKey,
  PAUSE_SOURCE_LABELS, REVIEW_RECOMMENDATION_TYPE,
  type ReviewDailyRow,
} from "@/lib/review-analysis";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** 复用 D-238 广告分析的 AI 场景（管理台已配模型与 fallback），提示词为复盘专用固定文本 */
const AI_SCENE = "campaign_ad_analysis";
const AI_MAX_TOKENS = 2500;

const SYSTEM_PROMPT = [
  "你是 Google Ads 联盟营销团队的投放复盘分析师。用户给你一个**已被暂停**的广告系列在暂停前 7 个完整投放日的逐日数据。",
  "你的任务是做暂停复盘，输出一份简明扼要的中文点评（400 字以内），必须包含以下四部分（用小标题分隔）：",
  "1.【暂停判断】结合花费、佣金、ROI、点击/出单趋势，评价这次暂停是否合理、是否停早了或停晚了；",
  "2.【恶化过程】指出数据从哪一天开始恶化、主要恶化在哪个指标（如 CPC 走高、佣金归零、点击骤降等）；",
  "3.【根因猜想】给出 1-2 个最可能的原因假设（如出价过高、落地页/链接问题、商家佣金变动、预算钳制等）；",
  "4.【后续建议】明确回答：值得重启吗？若重启需要先改什么（预算/CPC/链接/换商家）；若不值得，说明理由。",
  "要求：只依据给出的数据说话，数据不足处明说「数据不足」，不要编造；金额单位是美元；语气客观直接。",
  "第一行先输出一句话结论（30 字以内），作为整份点评的摘要。",
].join("\n");

function buildUserPrompt(input: {
  name: string;
  cid: string | null;
  owner: string;
  pauseDate: string;
  pauseSourceLabel: string;
  dailyBudget: number;
  daily: ReviewDailyRow[];
}): string {
  const header = "| 日期 | 展示 | 点击 | 花费 | 订单 | 佣金 | 拒付 | AvgCPC | ROI |";
  const sep = "|------|------|------|------|------|------|------|--------|-----|";
  const lines = input.daily.map((d) =>
    `| ${d.date} | ${d.impressions} | ${d.clicks} | $${d.spend.toFixed(2)} | ${d.orders} | $${d.commission.toFixed(2)} | $${d.rejectedCommission.toFixed(2)} | $${d.avgCpc.toFixed(4)} | ${d.roi == null ? "—" : d.roi.toFixed(2)} |`,
  );
  const t = sumTotals(input.daily);
  return [
    `广告系列：${input.name}`,
    `CID：${input.cid || "未知"}　投放人员：${input.owner}`,
    `暂停日期：${input.pauseDate}（暂停方式：${input.pauseSourceLabel}）　日预算：$${input.dailyBudget.toFixed(2)}`,
    "",
    "【暂停前 7 个完整投放日逐日数据（不含暂停当天）】",
    header,
    sep,
    ...lines,
    "",
    `【7 天合计】花费 $${t.cost.toFixed(2)}，点击 ${t.clicks}，订单 ${t.orders}，佣金 $${t.commission.toFixed(2)}，拒付 $${t.rejected_commission.toFixed(2)}，` +
      `ROI ${t.cost > 0 ? ((t.commission - t.cost) / t.cost).toFixed(2) : "—"}`,
    "",
    "请按要求输出复盘点评。",
  ].join("\n");
}

/**
 * D-245 AI 复盘点评：按需生成 + 缓存入库（ai_recommendations），支持重新分析覆盖。
 *
 * POST /api/user/team/review-ai  { campaignId }
 */
export const POST = withLeader(async (req: NextRequest, { user }) => {
  if (!user.teamId) return apiError("未关联小组");
  const body = await req.json().catch(() => ({}));
  const campaignIdRaw = body?.campaignId;
  if (!campaignIdRaw) return apiError("缺少 campaignId", 400);
  let campaignId: bigint;
  try {
    campaignId = BigInt(String(campaignIdRaw));
  } catch {
    return apiError("campaignId 格式无效", 400);
  }

  const campaign = await prisma.campaigns.findFirst({
    where: { id: campaignId, is_deleted: 0 },
    select: {
      id: true, user_id: true, customer_id: true, campaign_name: true,
      google_campaign_id: true, paused_at: true, pause_source: true, daily_budget: true,
    },
  });
  if (!campaign) return apiError("广告系列不存在", 404);
  const owner = await prisma.users.findFirst({
    where: { id: campaign.user_id, team_id: BigInt(user.teamId), is_deleted: 0 },
    select: { username: true, display_name: true },
  });
  if (!owner) return apiError("广告系列不存在", 404);
  if (!campaign.paused_at) return apiError("该系列没有暂停记录，无法复盘", 400);

  const window = computePauseWindow(campaign.paused_at);
  const stats = await prisma.ads_daily_stats.findMany({
    where: {
      campaign_id: campaignId,
      is_deleted: 0,
      date: { gte: window.dateStart, lt: window.dateEndExclusive },
    },
    select: {
      date: true, impressions: true, clicks: true, cost: true,
      orders: true, commission: true, rejected_commission: true,
    },
    orderBy: { date: "asc" },
  });
  const daily = buildDailyRows(window, stats);
  const totals = sumTotals(daily);
  if (totals.cost === 0 && totals.clicks === 0 && totals.commission === 0) {
    return apiError("暂停前 7 天没有任何投放数据，无法生成点评", 400);
  }

  let text: string;
  try {
    text = await callAiWithFallback(AI_SCENE, [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: buildUserPrompt({
          name: campaign.campaign_name || String(campaign.id),
          cid: campaign.customer_id,
          owner: owner.display_name || owner.username,
          pauseDate: window.pauseDateStr,
          pauseSourceLabel: PAUSE_SOURCE_LABELS[campaign.pause_source || ""] || "未知",
          dailyBudget: Number(campaign.daily_budget || 0),
          daily,
        }),
      },
    ], AI_MAX_TOKENS);
  } catch (err) {
    return apiError(`AI 点评生成失败：${err instanceof Error ? err.message : String(err)}`);
  }

  const trimmed = text.trim();
  const summary = (trimmed.split("\n").find((l) => l.trim()) || "复盘点评已生成").trim().slice(0, 500);

  // 缓存入库：scope_key 带暂停日期，(campaign_id, scope_key) 唯一，重新分析覆盖
  const scopeKey = buildReviewScopeKey(window.pauseDateStr);
  const payload = {
    user_id: campaign.user_id,
    google_campaign_id: campaign.google_campaign_id,
    campaign_name: (campaign.campaign_name || String(campaign.id)).slice(0, 255),
    date_range_start: window.dateStart,
    date_range_end: dateColumnStart(window.endStr),
    impressions: BigInt(totals.impressions),
    clicks: totals.clicks,
    spend: totals.cost,
    orders: totals.orders,
    commission: totals.commission,
    roi: totals.cost > 0 ? (totals.commission - totals.cost) / totals.cost : 0,
    recommendation_type: REVIEW_RECOMMENDATION_TYPE,
    strategy: "balanced",
    reason_summary: summary,
    reason_detail: trimmed,
    engine_type: "ai_review",
    status: "active",
    is_deleted: 0,
  };
  await prisma.ai_recommendations.upsert({
    where: { campaign_id_scope_key: { campaign_id: campaignId, scope_key: scopeKey } },
    update: payload,
    create: { campaign_id: campaignId, scope_key: scopeKey, ...payload },
  });

  return apiSuccess({
    review: { summary, detail: trimmed, updatedAt: new Date().toISOString() },
  }, "复盘点评已生成");
});
