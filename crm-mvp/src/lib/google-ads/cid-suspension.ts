import prisma from "@/lib/prisma";
import { CID_SUSPENDED_STATUSES } from "./cid-availability";

/**
 * D-248：被中止 CID 的统一查询/守卫出口（07 拍板 2026-08-18）。
 *
 * 设计：「被中止」是 CID 的属性（Google 真值 status ∈ suspended/cancelled），
 * 广告系列的「被中止」展示由此派生，不落库新状态——同步照常写 Google 真实状态，
 * 展示与操作锁定永远看 CID，天然免疫同步覆盖。
 */

/** 规范化 CID（去横线），用于 Set 匹配 */
export function normalizeCid(cid: string): string {
  return cid.replace(/-/g, "");
}

/**
 * 加载指定 MCC 范围内所有「被中止 CID」集合（customer_id 已去横线）。
 * 展示派生（campaign-board-query）与统计排除（active-running）共用。
 */
export async function loadSuspendedCidSet(mccIds: bigint[]): Promise<Set<string>> {
  const set = new Set<string>();
  if (mccIds.length === 0) return set;
  const rows = await prisma.mcc_cid_accounts.findMany({
    where: {
      mcc_account_id: { in: mccIds },
      is_deleted: 0,
      status: { in: [...CID_SUSPENDED_STATUSES] },
    },
    select: { customer_id: true },
  });
  for (const r of rows) {
    if (r.customer_id) set.add(normalizeCid(r.customer_id));
  }
  return set;
}

/**
 * 服务端写接口守卫：广告系列所属 CID 被中止时返回拒绝文案，否则返回 null。
 * toggle / apply-actions / update-campaign 等所有对系列的写操作统一走这里。
 */
export async function getCidSuspendedError(
  customerId: string | null | undefined,
  mccId: bigint | null | undefined,
): Promise<string | null> {
  if (!customerId) return null;
  const cid = normalizeCid(customerId);
  const hit = await prisma.mcc_cid_accounts.findFirst({
    where: {
      customer_id: cid,
      is_deleted: 0,
      status: { in: [...CID_SUSPENDED_STATUSES] },
      ...(mccId ? { mcc_account_id: mccId } : {}),
    },
    select: { id: true, status: true },
  });
  if (!hit) return null;
  return `所属 CID ${cid} 已被 Google 中止/停用（${hit.status}），该 CID 下的广告系列无法操作`;
}
