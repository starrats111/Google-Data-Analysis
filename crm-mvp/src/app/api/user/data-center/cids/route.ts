import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * GET /api/user/data-center/cids?mcc_account_id=xxx
 * 获取指定 MCC 下所有 CID 列表（含可用状态）
 * 动态查询 campaigns 表判断 CID 是否已被占用
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { searchParams } = new URL(req.url);
  const mccAccountId = searchParams.get("mcc_account_id");
  if (!mccAccountId) return apiError("缺少 mcc_account_id 参数", 400);

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: BigInt(mccAccountId), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!mcc) return apiError("MCC 账户不存在", 404);

  const cids = await prisma.mcc_cid_accounts.findMany({
    where: { mcc_account_id: BigInt(mccAccountId), is_deleted: 0 },
    orderBy: { customer_id: "asc" },
  });

  // 只有该 CID 下有 ENABLED 状态的广告系列才算占用
  const occupiedCampaigns = await prisma.campaigns.findMany({
    where: {
      mcc_id: BigInt(mccAccountId),
      customer_id: { not: null },
      google_campaign_id: { not: null },
      is_deleted: 0,
      google_status: "ENABLED",
    },
    select: { customer_id: true },
  });
  const occupiedCids = new Set(occupiedCampaigns.map((c) => c.customer_id).filter(Boolean));

  const cidsWithAvailability = cids.map((cid) => ({
    ...cid,
    is_available: occupiedCids.has(cid.customer_id) ? "N" : "Y",
  }));

  return apiSuccess(serializeData(cidsWithAvailability));
}

/**
 * POST /api/user/data-center/cids
 * 从 Google Ads API 同步 MCC 下所有子账户 CID（Service Account 认证）
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { mcc_account_id } = await req.json();
  if (!mcc_account_id) return apiError("缺少 mcc_account_id", 400);

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: BigInt(mcc_account_id), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!mcc) return apiError("MCC 账户不存在", 404);
  if (!mcc.service_account_json) return apiError("MCC 未配置服务账号凭证", 400);
  if (!mcc.developer_token) return apiError(`MCC「${mcc.mcc_name || mcc.mcc_id}」未配置 developer_token，请在「个人设置 → MCC 管理」中编辑该 MCC 填写 Developer Token`, 400);

  try {
    const { listMccChildAccounts } = await import("@/lib/google-ads");

    // #region agent log
    fetch('http://127.0.0.1:7366/ingest/05d05002-39c6-4179-a54f-bba78c014ee4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ea79a9'},body:JSON.stringify({sessionId:'ea79a9',location:'cids/route.ts:POST',message:'CID sync start',data:{mcc_id:mcc.mcc_id,has_sa:!!mcc.service_account_json,has_dt:!!mcc.developer_token},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    const childAccounts = await listMccChildAccounts({
      mcc_id: mcc.mcc_id,
      developer_token: mcc.developer_token,
      service_account_json: mcc.service_account_json,
    });
    // #region agent log
    fetch('http://127.0.0.1:7366/ingest/05d05002-39c6-4179-a54f-bba78c014ee4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ea79a9'},body:JSON.stringify({sessionId:'ea79a9',location:'cids/route.ts:POST',message:'CID sync result',data:{count:childAccounts.length},timestamp:Date.now()})}).catch(()=>{});

    const existingCids = await prisma.mcc_cid_accounts.findMany({
      where: { mcc_account_id: BigInt(mcc_account_id), is_deleted: 0 },
    });
    const existingMap = new Map(existingCids.map((c) => [c.customer_id, c]));

    let created = 0, updated = 0;
    for (const child of childAccounts) {
      const existing = existingMap.get(child.customer_id);
      if (existing) {
        await prisma.mcc_cid_accounts.update({
          where: { id: existing.id },
          data: { customer_name: child.customer_name, last_synced_at: new Date() },
        });
        updated++;
      } else {
        await prisma.mcc_cid_accounts.create({
          data: {
            mcc_account_id: BigInt(mcc_account_id),
            customer_id: child.customer_id,
            customer_name: child.customer_name,
            is_available: "Y", status: "active",
            last_synced_at: new Date(),
          },
        });
        created++;
      }
    }

    const allCids = await prisma.mcc_cid_accounts.findMany({
      where: { mcc_account_id: BigInt(mcc_account_id), is_deleted: 0 },
      orderBy: { customer_id: "asc" },
    });

    // 只有该 CID 下有 ENABLED 状态的广告系列才算占用
    const occupiedCampaigns = await prisma.campaigns.findMany({
      where: {
        mcc_id: BigInt(mcc_account_id),
        customer_id: { not: null },
        google_campaign_id: { not: null },
        is_deleted: 0,
        google_status: "ENABLED",
      },
      select: { customer_id: true },
    });
    const occupiedCids = new Set(occupiedCampaigns.map((c) => c.customer_id).filter(Boolean));

    const cidsWithAvailability = allCids.map((cid) => ({
      ...cid,
      is_available: occupiedCids.has(cid.customer_id) ? "N" : "Y",
    }));

    return apiSuccess(serializeData({
      cids: cidsWithAvailability,
      synced: { created, updated, total: allCids.length },
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[CID Sync] 失败:", message);
    // #region agent log
    fetch('http://127.0.0.1:7366/ingest/05d05002-39c6-4179-a54f-bba78c014ee4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ea79a9'},body:JSON.stringify({sessionId:'ea79a9',location:'cids/route.ts:error',message:'CID sync error',data:{error:message.slice(0,300)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return apiError(`CID 同步失败: ${message}`, 500);
  }
}
