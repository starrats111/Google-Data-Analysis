/**
 * D-277：账户状态总览查询（共享给 user 侧与 admin 侧两个 API）
 *
 * 数据全部来自库内（mcc_cid_accounts.status 由统一脚本 Sheet CID_List Status 列
 * 半小时级跟随 + 每日主同步维护），本查询零外部请求——符合读走 Sheet 铁律。
 *
 * 权限口径（07 2026-08-25 拍板 q2=a）：
 * - 成员：自己名下 MCC 的账户
 * - 组长：全组成员名下 MCC 的账户
 * - 管理员：全部
 */
import prisma from "@/lib/prisma";
import type { TokenPayload } from "@/lib/auth";

export interface AccountStatusRow {
  mcc_id: string;
  mcc_name: string | null;
  owner: string;
  customer_id: string;
  customer_name: string | null;
  /** active / suspended / cancelled */
  status: string;
  /** Y / N / U / D */
  is_available: string;
  /** ISO（UTC），前端按本地（北京）时间展示 */
  status_changed_at: string | null;
  last_synced_at: string | null;
  enabled_campaigns: number;
}

/** 解析可见范围：null=全部（管理员）；否则限定这些用户名下的 MCC */
export async function resolveScopeUserIds(user: TokenPayload): Promise<bigint[] | null> {
  if (user.role === "admin") return null;
  const self = BigInt(user.userId);
  if (user.role === "leader") {
    let teamId = user.teamId ? BigInt(user.teamId) : null;
    if (!teamId) {
      const u = await prisma.users.findFirst({
        where: { id: self, is_deleted: 0 },
        select: { team_id: true },
      });
      teamId = u?.team_id ?? null;
    }
    if (!teamId) return [self];
    const members = await prisma.users.findMany({
      where: { team_id: teamId, is_deleted: 0 },
      select: { id: true },
    });
    const ids = members.map((m) => m.id);
    return ids.length > 0 ? ids : [self];
  }
  return [self];
}

export async function queryAccountStatus(scopeUserIds: bigint[] | null): Promise<AccountStatusRow[]> {
  const mccs = await prisma.google_mcc_accounts.findMany({
    where: {
      is_deleted: 0,
      ...(scopeUserIds ? { user_id: { in: scopeUserIds } } : {}),
    },
    select: { id: true, mcc_id: true, mcc_name: true, user_id: true },
  });
  if (mccs.length === 0) return [];
  const mccIds = mccs.map((m) => m.id);
  const mccById = new Map(mccs.map((m) => [m.id.toString(), m]));

  const owners = await prisma.users.findMany({
    where: { id: { in: [...new Set(mccs.map((m) => m.user_id))] } },
    select: { id: true, username: true, display_name: true },
  });
  const ownerById = new Map(owners.map((u) => [u.id.toString(), u.display_name || u.username]));

  const cids = await prisma.mcc_cid_accounts.findMany({
    where: { mcc_account_id: { in: mccIds }, is_deleted: 0 },
    select: {
      mcc_account_id: true,
      customer_id: true,
      customer_name: true,
      status: true,
      is_available: true,
      status_changed_at: true,
      last_synced_at: true,
    },
  });

  // 名下 ENABLED 系列数（campaigns.customer_id 可能带横杠，归一后按 mcc+cid 汇总）
  const enabledRows = await prisma.campaigns.findMany({
    where: { mcc_id: { in: mccIds }, is_deleted: 0, google_status: "ENABLED" },
    select: { mcc_id: true, customer_id: true },
  });
  const enabledCount = new Map<string, number>();
  for (const r of enabledRows) {
    const cid = (r.customer_id || "").replace(/\D/g, "");
    if (!cid || !r.mcc_id) continue;
    const key = `${r.mcc_id}|${cid}`;
    enabledCount.set(key, (enabledCount.get(key) || 0) + 1);
  }

  const out: AccountStatusRow[] = [];
  for (const c of cids) {
    const mcc = mccById.get(c.mcc_account_id.toString());
    if (!mcc) continue;
    out.push({
      mcc_id: mcc.mcc_id,
      mcc_name: mcc.mcc_name,
      owner: ownerById.get(mcc.user_id.toString()) || "-",
      customer_id: c.customer_id,
      customer_name: c.customer_name,
      status: c.status,
      is_available: c.is_available,
      status_changed_at: c.status_changed_at ? c.status_changed_at.toISOString() : null,
      last_synced_at: c.last_synced_at ? c.last_synced_at.toISOString() : null,
      enabled_campaigns: enabledCount.get(`${c.mcc_account_id}|${c.customer_id}`) || 0,
    });
  }

  // 异常状态置顶，其余按 MCC / CID 排序
  const weight = (s: string) => (s === "suspended" ? 0 : s === "cancelled" ? 1 : 2);
  out.sort((a, b) =>
    weight(a.status) - weight(b.status)
    || a.mcc_id.localeCompare(b.mcc_id)
    || a.customer_id.localeCompare(b.customer_id));
  return out;
}
