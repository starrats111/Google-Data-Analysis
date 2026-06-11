import { NextRequest } from "next/server";
import { withAdmin } from "@/lib/api-handler";
import { serializeData } from "@/lib/auth";
import { apiSuccess } from "@/lib/constants";
import prisma from "@/lib/prisma";

/**
 * GET /api/admin/cid-management
 *   - 无参数：返回拥有 ≥1 个有效 MCC 的员工列表（按员工维度管理 CID 的入口）
 *   - ?user_id=X：返回该员工各 MCC 及其下 CID 列表（带本地广告系列三段计数）
 *
 * 管理员专用（admin_token）。数据查询路径：
 *   users → google_mcc_accounts(user_id) → mcc_cid_accounts(mcc_account_id)
 */
export const GET = withAdmin(async (req: NextRequest) => {
  const { searchParams } = new URL(req.url);
  const userIdParam = searchParams.get("user_id");

  // 所有有效 MCC（按员工维度）
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0 },
    select: {
      id: true,
      user_id: true,
      mcc_id: true,
      mcc_name: true,
      currency: true,
      service_account_json: true,
      developer_token: true,
    },
    orderBy: { id: "asc" },
  });

  // ── 模式 A：员工列表 ──
  if (!userIdParam) {
    const userIds = [...new Set(mccs.map((m) => m.user_id.toString()))].map((s) => BigInt(s));
    const users = await prisma.users.findMany({
      where: { id: { in: userIds }, is_deleted: 0 },
      select: { id: true, username: true, display_name: true, role: true },
    });
    const mccCountByUser = new Map<string, number>();
    for (const m of mccs) {
      const k = m.user_id.toString();
      mccCountByUser.set(k, (mccCountByUser.get(k) || 0) + 1);
    }
    const employees = users
      .map((u) => ({
        user_id: u.id,
        username: u.username,
        display_name: u.display_name,
        role: u.role,
        mcc_count: mccCountByUser.get(u.id.toString()) || 0,
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
    return apiSuccess(serializeData({ employees }));
  }

  // ── 模式 B：某员工的 MCC + CID 树 ──
  const targetUserId = BigInt(userIdParam);
  const userMccs = mccs.filter((m) => m.user_id.toString() === targetUserId.toString());
  if (userMccs.length === 0) {
    return apiSuccess(serializeData({ mccs: [] }));
  }

  const user = await prisma.users.findFirst({
    where: { id: targetUserId },
    select: { id: true, username: true, display_name: true },
  });

  const mccAccountIds = userMccs.map((m) => m.id);

  // 各 MCC 下 CID
  const cids = await prisma.mcc_cid_accounts.findMany({
    where: { mcc_account_id: { in: mccAccountIds }, is_deleted: 0 },
    orderBy: [{ mcc_account_id: "asc" }, { customer_id: "asc" }],
  });

  // 广告系列三段计数（campaigns.mcc_id 存 google_mcc_accounts.id）
  const campaignCounts = await prisma.campaigns.groupBy({
    by: ["mcc_id", "customer_id", "google_status"],
    where: {
      mcc_id: { in: mccAccountIds },
      customer_id: { not: null },
      google_campaign_id: { not: null },
      is_deleted: 0,
    },
    _count: { _all: true },
  });
  const countsByKey = new Map<string, { enabled: number; paused: number; removed: number }>();
  for (const row of campaignCounts) {
    if (!row.customer_id || row.mcc_id == null) continue;
    const key = `${row.mcc_id.toString()}:${row.customer_id}`;
    const slot = countsByKey.get(key) || { enabled: 0, paused: 0, removed: 0 };
    const status = String(row.google_status || "").toUpperCase();
    const n = row._count._all;
    if (status === "ENABLED") slot.enabled += n;
    else if (status === "PAUSED") slot.paused += n;
    else if (status === "REMOVED") slot.removed += n;
    countsByKey.set(key, slot);
  }

  const cidsByMcc = new Map<string, typeof cids>();
  for (const c of cids) {
    const k = c.mcc_account_id.toString();
    if (!cidsByMcc.has(k)) cidsByMcc.set(k, []);
    cidsByMcc.get(k)!.push(c);
  }

  const result = userMccs.map((m) => {
    const list = (cidsByMcc.get(m.id.toString()) || []).map((c) => {
      const cnt = countsByKey.get(`${m.id.toString()}:${c.customer_id}`) || { enabled: 0, paused: 0, removed: 0 };
      return {
        id: c.id,
        customer_id: c.customer_id,
        customer_name: c.customer_name,
        status: c.status,
        is_available: c.status === "active" ? (cnt.enabled > 0 ? "N" : "Y") : "D",
        last_synced_at: c.last_synced_at,
        enabled_count: cnt.enabled,
        paused_count: cnt.paused,
        removed_count: cnt.removed,
      };
    });
    return {
      mcc_account_id: m.id,
      mcc_id: m.mcc_id,
      mcc_name: m.mcc_name,
      currency: m.currency,
      credentials_ready: !!(m.service_account_json && m.developer_token),
      cids: list,
    };
  });

  return apiSuccess(serializeData({
    user: user ? { user_id: user.id, username: user.username, display_name: user.display_name } : null,
    mccs: result,
  }));
});
