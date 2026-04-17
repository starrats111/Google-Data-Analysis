import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * POST /api/admin/suspend-cid-campaigns
 *
 * 将指定 CID（Google Ads 客户 ID）下的所有广告系列强制标记为已暂停。
 * 适用于：Google Ads 账号因"不可接受的商业行为"等政策违规被中止的情形。
 *
 * 操作：
 *   - campaigns.google_status = "PAUSED"
 *   - campaigns.status = "paused"
 *   - mcc_cid_accounts.is_available = "D"（停用）
 *
 * Body:
 *   {
 *     customer_id: string,   // CID，支持带横线（508-452-2625）或不带（5084522625）
 *     dry_run?: boolean      // true 时仅预览，不写库
 *   }
 */
export async function POST(req: NextRequest) {
  const caller = getUserFromRequest(req);
  if (!caller) return apiError("未授权", 401);

  const body = await req.json().catch(() => ({}));
  const { customer_id, dry_run = false } = body as { customer_id?: string; dry_run?: boolean };

  if (!customer_id) return apiError("缺少 customer_id");

  // 统一移除横线，DB 存储无横线格式
  const cid = String(customer_id).replace(/-/g, "").trim();
  if (!/^\d{8,12}$/.test(cid)) return apiError("customer_id 格式不合法，应为 8~12 位纯数字");

  // ── 查询影响范围 ─────────────────────────────────────────────────────────
  const activeCampaigns = await prisma.campaigns.findMany({
    where: {
      customer_id: cid,
      is_deleted: 0,
      google_status: { not: "PAUSED" },
    },
    select: { id: true, campaign_name: true, user_id: true, google_status: true },
  });

  const cidAccount = await prisma.mcc_cid_accounts.findMany({
    where: { customer_id: cid, is_deleted: 0 },
    select: { id: true, mcc_account_id: true, is_available: true },
  });

  if (dry_run) {
    return apiSuccess({
      dry_run: true,
      customer_id: cid,
      campaigns_to_pause: activeCampaigns.length,
      cid_accounts_to_disable: cidAccount.filter((a) => a.is_available !== "D").length,
      preview: activeCampaigns.map((c) => ({
        id: Number(c.id),
        name: c.campaign_name,
        user_id: Number(c.user_id),
        current_google_status: c.google_status,
      })),
    }, `预览：将暂停 ${activeCampaigns.length} 条广告系列（dry_run=true，未实际修改）`);
  }

  // ── 执行写库 ─────────────────────────────────────────────────────────────
  const now = new Date();

  const [campaignResult, cidResult] = await prisma.$transaction([
    prisma.campaigns.updateMany({
      where: {
        customer_id: cid,
        is_deleted: 0,
        google_status: { not: "PAUSED" },
      },
      data: {
        google_status: "PAUSED",
        status: "paused",
        last_google_sync_at: now,
      },
    }),
    prisma.mcc_cid_accounts.updateMany({
      where: { customer_id: cid, is_deleted: 0 },
      data: { is_available: "D", last_synced_at: now },
    }),
  ]);

  console.log(
    `[Admin/SuspendCID] CID=${cid} 已暂停 ${campaignResult.count} 条广告系列，` +
    `${cidResult.count} 条 CID 账号标记为停用。操作人: ${caller.username ?? caller.userId}`,
  );

  return apiSuccess(
    {
      customer_id: cid,
      campaigns_paused: campaignResult.count,
      cid_accounts_disabled: cidResult.count,
    },
    `CID ${cid} 下 ${campaignResult.count} 条广告系列已暂停`,
  );
}
