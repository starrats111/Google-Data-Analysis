import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { verifyHermesToken } from "@/lib/hermes-auth";

// HM-D50：接收 Hermes 推来的系列名 / 日预算 / CPC 出价。
//
// 起因（07 反馈 2026-07-29）：Hermes 把 lagos 那条的预算从 $2 调到了 $8、名字也按发布顺序
// 改成了 101-MUI1-lagos-US-0728-8005348，Google 后台都生效了，CRM 界面却还是 $2 和旧名字。
// 根因在 CRM 侧：
//   · 每天 06:00 的 daily-sync 对已存在的 campaign 只更新 google_status；
//   · campaign_name / daily_budget 只有手动点「同步MCC」走 Sheet 那条路才写；
//   · max_cpc_limit 更是只有人在界面点铅笔改过才有值——CRM 跑的 GAQL 里没有任何出价字段
//     （出价在 ad_group.cpc_bid_micros 上，要单独查一轮）。
// 与其为了拿出价再对每个 CID 多跑一次 GAQL，不如让改这些值的人直接告诉我们：
// Hermes 本来就知道自己改了什么，推过来零 API 成本、也不用等下一轮 cron。
//
// 按 google_campaign_id 匹配（gcid 全局唯一且改名不变），只更新这三项，不碰状态——
// 状态有 CRM 自己的同步链路在管，两边都写反而会打架。

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Incoming = {
  google_campaign_id: string;
  customer_id?: string;
  campaign_name?: string;
  daily_budget?: number;
  max_cpc?: number;
};

export async function POST(req: NextRequest) {
  const authErr = verifyHermesToken(req);
  if (authErr) return authErr;

  let body: { campaigns?: Incoming[] };
  try {
    body = await req.json();
  } catch {
    return apiError("请求体不是合法 JSON", 400);
  }
  const list = Array.isArray(body?.campaigns) ? body.campaigns : [];
  if (!list.length) return apiError("campaigns 不能为空", 400);
  if (list.length > 1000) return apiError("单次最多 1000 条", 400);

  try {
    const gcids = list.map((c) => String(c.google_campaign_id)).filter(Boolean);
    const existing = await prisma.campaigns.findMany({
      where: { google_campaign_id: { in: gcids }, is_deleted: 0 },
      select: {
        id: true, google_campaign_id: true, campaign_name: true,
        daily_budget: true, max_cpc_limit: true, customer_id: true,
      },
    });
    const byGcid = new Map(existing.map((c) => [c.google_campaign_id, c]));

    let updated = 0;
    const missing: string[] = [];
    const changes: Array<{ gcid: string; from: string; to: string }> = [];

    for (const inc of list) {
      const gcid = String(inc.google_campaign_id || "");
      const cur = byGcid.get(gcid);
      // Hermes 建的广告 CRM 迟早会自己同步进来（daily-sync 会新建），这里不代建：
      // 代建的话 user_id / mcc_id / user_merchant_id 都得猜，属于数据真实性规范里说的臆测
      if (!cur) {
        missing.push(gcid);
        continue;
      }

      const data: Record<string, unknown> = {};
      const diff: string[] = [];
      if (inc.campaign_name && inc.campaign_name !== cur.campaign_name) {
        data.campaign_name = inc.campaign_name;
        diff.push(`名 ${cur.campaign_name} → ${inc.campaign_name}`);
      }
      if (typeof inc.daily_budget === "number" && inc.daily_budget > 0
        && Number(cur.daily_budget) !== inc.daily_budget) {
        data.daily_budget = inc.daily_budget;
        diff.push(`预算 $${cur.daily_budget} → $${inc.daily_budget}`);
      }
      if (typeof inc.max_cpc === "number" && inc.max_cpc > 0
        && Number(cur.max_cpc_limit ?? 0) !== inc.max_cpc) {
        data.max_cpc_limit = inc.max_cpc;
        diff.push(`CPC $${cur.max_cpc_limit ?? 0} → $${inc.max_cpc}`);
      }
      // Hermes 发布时 CID 是它自己占的，CRM 那边可能还空着
      if (inc.customer_id && !cur.customer_id) data.customer_id = inc.customer_id;

      if (!Object.keys(data).length) continue;
      data.last_google_sync_at = new Date();
      await prisma.campaigns.update({ where: { id: cur.id }, data });
      updated++;
      if (diff.length && changes.length < 50) {
        changes.push({ gcid, from: cur.campaign_name ?? "", to: diff.join("；") });
      }
    }

    return apiSuccess({
      received: list.length,
      matched: existing.length,
      updated,
      missing: missing.length,
      missing_sample: missing.slice(0, 20),
      changes,
    });
  } catch (err) {
    console.error("[HermesCampaignState] POST 异常:", err);
    return apiError("回写广告系列状态失败", 500);
  }
}
