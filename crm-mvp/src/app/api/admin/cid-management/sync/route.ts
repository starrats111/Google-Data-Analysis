import { NextRequest } from "next/server";
import { withAdmin } from "@/lib/api-handler";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * POST /api/admin/cid-management/sync  body: { mcc_account_id }
 * 管理员侧从 Google Ads 同步指定 MCC 的子账户 CID 列表（不限员工归属）。
 * 复用 user 侧同步的 upsert 逻辑：新增/更新 active，Google 不再返回的标 cancelled。
 */
export const POST = withAdmin(async (req: NextRequest) => {
  const { mcc_account_id } = await req.json();
  if (!mcc_account_id) return apiError("缺少 mcc_account_id", 400);

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: BigInt(mcc_account_id), is_deleted: 0 },
  });
  if (!mcc) return apiError("MCC 账户不存在", 404);
  if (!mcc.service_account_json) return apiError("该 MCC 未配置服务账号凭证", 400);
  if (!mcc.developer_token) return apiError(`MCC「${mcc.mcc_name || mcc.mcc_id}」未配置 Developer Token`, 400);

  try {
    const { listMccChildAccounts } = await import("@/lib/google-ads");
    const childAccounts = await listMccChildAccounts({
      mcc_id: mcc.mcc_id,
      developer_token: mcc.developer_token,
      service_account_json: mcc.service_account_json,
    });

    const existingCids = await prisma.mcc_cid_accounts.findMany({
      where: { mcc_account_id: BigInt(mcc_account_id), is_deleted: 0 },
    });
    const existingMap = new Map(existingCids.map((c) => [c.customer_id, c]));
    const googleCidSet = new Set(childAccounts.map((c) => c.customer_id));

    let created = 0, updated = 0, cancelled = 0;
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
            // 批次5：新发现的 CID 未核实过 → U（首轮状态同步后会转 Y/N）
            is_available: "U", status: "active",
            last_synced_at: new Date(),
          },
        });
        created++;
      }
    }
    // Google 已不返回的 active CID → 标 cancelled + D（停用终态，同步不会冲回 Y/N）
    const cancelledCids: string[] = [];
    for (const existing of existingCids) {
      if (!googleCidSet.has(existing.customer_id) && existing.status === "active") {
        await prisma.mcc_cid_accounts.update({
          where: { id: existing.id },
          data: { status: "cancelled", is_available: "D" },
        });
        cancelledCids.push(existing.customer_id);
        cancelled++;
      }
    }
    // CID 停用联动：其下本地 ENABLED 系列同步改判 PAUSED（账号都没了不可能真在投，
    // 否则数据中心出现「已启用 + CID已移除」的矛盾状态）
    if (cancelledCids.length > 0) {
      await prisma.campaigns.updateMany({
        where: { mcc_id: BigInt(mcc_account_id), customer_id: { in: cancelledCids }, is_deleted: 0, google_status: "ENABLED" },
        data: { google_status: "PAUSED", status: "paused", last_google_sync_at: new Date() },
      });
    }

    return apiSuccess({ created, updated, cancelled, total: googleCidSet.size });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[Admin CID Sync] 失败:", message);
    return apiError(`CID 同步失败：${message.slice(0, 300)}`, 500);
  }
});
