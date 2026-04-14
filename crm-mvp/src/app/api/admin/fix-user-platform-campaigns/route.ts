import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { syncMerchantStatusForUser } from "@/lib/campaign-merchant-link";

/**
 * POST /api/admin/fix-user-platform-campaigns
 *
 * 针对指定用户，删除非目标平台的广告系列，并将保留的广告系列重新从 001 开始编号。
 *
 * Body:
 *   username: string        — 目标用户名
 *   keep_platform: string   — 保留的平台前缀，如 "CF"（匹配 parts[1] startsWith）
 *   dry_run?: boolean        — true 时仅预览，不执行
 */
export const POST = withAdmin(async (req: NextRequest) => {
  const { username, keep_platform, dry_run = false } = await req.json();
  if (!username) return apiError("缺少 username");
  if (!keep_platform) return apiError("缺少 keep_platform（如 CF）");

  const user = await prisma.users.findFirst({
    where: { username, is_deleted: 0 },
    select: { id: true, username: true },
  });
  if (!user) return apiError("用户不存在");

  const userId = user.id;
  const platformPrefix = keep_platform.toUpperCase();

  // 1. 查询所有正式广告系列（已提交 Google 且未软删）
  const allCampaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, is_deleted: 0, google_campaign_id: { not: null } },
    select: {
      id: true,
      campaign_name: true,
      google_status: true,
      user_merchant_id: true,
      google_campaign_id: true,
      mcc_id: true,
    },
    orderBy: { id: "asc" },
  });

  // 从 campaign_name 中解析 platform 段（parts[1]），判断是否属于目标平台
  const isCfCampaign = (name: string | null): boolean => {
    if (!name) return false;
    const parts = name.split("-");
    if (parts.length < 6) return false;
    return parts[1].toUpperCase().startsWith(platformPrefix);
  };

  const toCampaigns = allCampaigns.filter((c) => isCfCampaign(c.campaign_name));
  const toDelete = allCampaigns.filter((c) => !isCfCampaign(c.campaign_name));

  // 2. 计算 CF 广告系列的重编号方案（按当前序号升序，重编为 001, 002, ...）
  // 同时保留 parts[1..末尾] 不变，只替换 parts[0]
  const parseRenameInfo = (c: (typeof toCampaigns)[0]) => {
    const parts = (c.campaign_name || "").split("-");
    // parts[0] 是序号，其余保留
    const rest = parts.slice(1).join("-");
    return { id: c.id, currentName: c.campaign_name, rest };
  };

  // 按当前序号升序排（便于稳定重编）
  const sortedCf = [...toCampaigns].sort((a, b) => {
    const seqA = parseInt((a.campaign_name || "").split("-")[0] || "0", 10);
    const seqB = parseInt((b.campaign_name || "").split("-")[0] || "0", 10);
    return seqA - seqB;
  });

  const renameMap: { id: bigint; oldName: string | null; newName: string }[] = sortedCf.map(
    (c, idx) => {
      const info = parseRenameInfo(c);
      const newSeq = String(idx + 1).padStart(3, "0");
      return {
        id: c.id,
        oldName: info.currentName,
        newName: `${newSeq}-${info.rest}`,
      };
    }
  );

  // 3. 找出需要释放的商家（仅关联被删除广告的商家）
  const keepMerchantIds = new Set(
    toCampaigns
      .filter((c) => c.user_merchant_id && c.user_merchant_id !== BigInt(0))
      .map((c) => String(c.user_merchant_id))
  );

  const toReleaseMerchantIds = new Set<string>();
  for (const c of toDelete) {
    if (c.user_merchant_id && c.user_merchant_id !== BigInt(0)) {
      const mid = String(c.user_merchant_id);
      if (!keepMerchantIds.has(mid)) toReleaseMerchantIds.add(mid);
    }
  }

  const merchantsToRelease =
    toReleaseMerchantIds.size > 0
      ? await prisma.user_merchants.findMany({
          where: {
            id: { in: [...toReleaseMerchantIds].map(BigInt) },
            user_id: userId,
            is_deleted: 0,
            status: { in: ["claimed", "paused"] },
          },
          select: { id: true, platform: true, merchant_id: true, merchant_name: true },
        })
      : [];

  if (dry_run) {
    return apiSuccess(
      serializeData({
        dry_run: true,
        username: user.username,
        keep_platform: platformPrefix,
        delete_count: toDelete.length,
        keep_count: toCampaigns.length,
        release_merchant_count: merchantsToRelease.length,
        campaigns_to_delete: toDelete.map((c) => ({
          id: c.id,
          name: c.campaign_name,
          status: c.google_status,
        })),
        campaigns_to_rename: renameMap.map((r) => ({
          id: r.id,
          old_name: r.oldName,
          new_name: r.newName,
        })),
        merchants_to_release: merchantsToRelease.map((m) => ({
          id: m.id,
          platform: m.platform,
          mid: m.merchant_id,
          name: m.merchant_name,
        })),
      })
    );
  }

  // 4. 执行：软删除非 CF 广告系列
  const deleteIds = toDelete.map((c) => c.id);
  if (deleteIds.length > 0) {
    await prisma.campaigns.updateMany({
      where: { id: { in: deleteIds } },
      data: { is_deleted: 1 },
    });
  }

  // 5. 执行：逐条重命名 CF 广告系列（跳过名称本身未变的）
  const actualRenamed: { id: string; old_name: string | null; new_name: string }[] = [];
  for (const r of renameMap) {
    if (r.oldName === r.newName) continue;
    await prisma.campaigns.update({
      where: { id: r.id },
      data: { campaign_name: r.newName },
    });
    actualRenamed.push({ id: String(r.id), old_name: r.oldName, new_name: r.newName });
  }

  // 6. 商家状态联动
  await syncMerchantStatusForUser(userId);

  return apiSuccess(
    serializeData({
      dry_run: false,
      username: user.username,
      keep_platform: platformPrefix,
      deleted_campaigns: deleteIds.length,
      renamed_campaigns: actualRenamed.length,
      released_merchants: merchantsToRelease.length,
      details: {
        deleted: toDelete.map((c) => ({ name: c.campaign_name, status: c.google_status })),
        renamed: actualRenamed,
        kept_unchanged: renameMap
          .filter((r) => r.oldName === r.newName)
          .map((r) => ({ name: r.newName })),
      },
    })
  );
});
