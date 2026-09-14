import prisma from "@/lib/prisma";
import { CID_SUSPENDED_STATUSES } from "./cid-availability";

/**
 * D-330：被中止/已撤销 CID 旗下「孤儿在投系列」回停对账。
 *
 * 背景（07 2026-09-14 反馈：CID 已撤销，CRM 仍显示「已启用」，同步MCC 点多次无效）：
 * 状态同步的唯一数据源是 Google Sheet 的 CampaignInfo Tab，而该表由挂在 MCC 上的统一脚本
 * 生成。CID 一旦被撤销（CustomerClientLink → INACTIVE）或被 Google 停用，该账户就不再挂在
 * MCC 下，脚本再也扫不到它，它旗下所有系列**从此不再出现在 CampaignInfo 里**。
 *
 * 而两条同步路径都是「以 Sheet 行为驱动」：
 *   - sheet-status-sync.ts：`if (!sheetRow) continue;`（Sheet 里没有的系列不动）
 *   - data-center/sync/route.ts：`for (const [gcid, cs] of sheetStatusMap)`（只遍历 Sheet 行）
 * 于是这些系列被永久跳过，google_status 冻结在最后一次同步成功时的 ENABLED、status 冻结在
 * active。点 同步MCC / 刷新 / 同步CID 多少次，跳过的都是同一批 —— 这是「点了没反应」的根因，
 * 不是状态刷错了，是这批数据压根没进入处理范围。
 *
 * 连带影响：换链接告警中心按 `status='active' AND google_status='ENABLED'` 判定可见性
 * （alerts.ts getEnabledCampaignIds），冻结的 active+ENABLED 让这些死系列持续参与巡检并
 * 反复报「与商家无合作关系」；点「已处理」下一轮又冒出来（occur_count 持续累加）。
 *
 * 修复口径：CID 状态是 Google 真值（由 cid-list-sheet-sync / admin 撤销写入），不是过期快照。
 * CID ∈ suspended/cancelled ⟹ 其旗下系列不可能在投，直接回停，**不看在不在 Sheet 里**。
 *
 * 刻意不受 D-246 信任窗口约束：信任窗口防的是「过期 Sheet 快照把 CRM 刚做的实时操作翻回去」，
 * 而这里的依据是 CID 终态而非快照；且 CID 被中止后所有写操作已被 getCidSuspendedError 拦死，
 * 窗口内不存在待保护的成功 mutate。
 *
 * 刻意跳过：google_status='REMOVED'（终态）与 remove_source 非空（D-321 本地拒登移除，终态）。
 */

/** 回停时写入 pause_source 的取值（对应 PAUSE_SOURCE_LABELS.cid_revoked） */
export const CID_REVOKED_PAUSE_SOURCE = "cid_revoked";

export interface OrphanReconcileResult {
  /** 本轮从「显示在投(ENABLED)」被回停的系列数——这是用户能直接看到的修复量 */
  paused: number;
  /** 本轮仅把内部 status 拉平到 paused（Google 侧早已 PAUSED）的系列数 */
  aligned: number;
  /** 受影响的全部系列 id（两组合计，用于收敛告警/写日志） */
  ids: bigint[];
}

/** 已中止 CID 的 (MCC, CID) 对；customer_id 需已去横线 */
export interface DeadCidPair {
  mcc_id: bigint;
  customer_id: string;
}

/** 参与判定的系列最小字段集 */
export interface ReconcileCandidate {
  id: bigint;
  mcc_id: bigint | null;
  customer_id: string | null;
  google_status: string | null;
}

export interface ReconcileSplit {
  /** google_status 仍是 ENABLED —— 回停并记 paused_at/pause_source */
  toPause: ReconcileCandidate[];
  /** Google 侧早已非 ENABLED —— 只拉平内部 status，不动 paused_at */
  toAlign: ReconcileCandidate[];
}

/**
 * 纯判定（可单测）：候选系列按「所属 CID 是否已中止」筛出，再按 google_status 分两组。
 * 匹配必须 (mcc_id, customer_id) 成对——同一 customer_id 可能挂在不同 MCC 下且状态不同。
 */
export function splitOrphanCampaigns(
  deadPairs: DeadCidPair[],
  candidates: ReconcileCandidate[],
): ReconcileSplit {
  const deadKeys = new Set(deadPairs.map((p) => `${p.mcc_id}|${p.customer_id}`));
  const hit = candidates.filter((c) => {
    if (!c.customer_id || c.mcc_id == null) return false;
    return deadKeys.has(`${c.mcc_id}|${c.customer_id.replace(/-/g, "")}`);
  });
  return {
    toPause: hit.filter((c) => String(c.google_status || "").toUpperCase() === "ENABLED"),
    toAlign: hit.filter((c) => String(c.google_status || "").toUpperCase() !== "ENABLED"),
  };
}

interface ReconcileScope {
  /** 限定 MCC 范围；省略=该用户全部 MCC */
  mccIds?: bigint[];
  /** 限定用户；省略=不限（cron 全量场景） */
  userId?: bigint;
}

/**
 * 把「CID 已被中止/撤销、但库内仍是在投」的系列统一回停。
 * 幂等：已是 paused/PAUSED 的行不会被重复写（where 只匹配仍在投的）。
 */
export async function reconcileOrphanCampaignsForSuspendedCids(
  scope: ReconcileScope = {},
): Promise<OrphanReconcileResult> {
  const cidWhere: Record<string, unknown> = {
    is_deleted: 0,
    status: { in: [...CID_SUSPENDED_STATUSES] },
  };
  if (scope.mccIds) {
    if (scope.mccIds.length === 0) return { paused: 0, aligned: 0, ids: [] };
    cidWhere.mcc_account_id = { in: scope.mccIds };
  }

  const deadCids = await prisma.mcc_cid_accounts.findMany({
    where: cidWhere,
    select: { mcc_account_id: true, customer_id: true },
  });
  if (deadCids.length === 0) return { paused: 0, aligned: 0, ids: [] };

  // 按 (mcc, cid) 成对匹配：同一 customer_id 可能挂在不同 MCC 下且状态不同，不能只按 cid 匹配
  const pairs = deadCids
    .filter((c) => !!c.customer_id)
    .map((c) => ({
      mcc_id: c.mcc_account_id,
      customer_id: c.customer_id.replace(/-/g, ""),
    }));
  if (pairs.length === 0) return { paused: 0, aligned: 0, ids: [] };

  // 先按 MCC 粗筛「仍在投」的候选，再在内存里按 (mcc, cid) 成对精确匹配。
  // 不用 OR 展开 pairs：CID 可达数百个，展开成几百个 OR 分支会拖慢查询。
  const victims = await prisma.campaigns.findMany({
    where: {
      ...(scope.userId ? { user_id: scope.userId } : {}),
      is_deleted: 0,
      remove_source: null, // D-321 本地拒登移除是终态
      google_campaign_id: { not: null },
      customer_id: { not: null },
      mcc_id: { in: [...new Set(pairs.map((p) => p.mcc_id))] },
      // 仍在投：内部 active 或 Google ENABLED（任一成立就该被回停）；REMOVED 是终态，排除
      OR: [{ status: "active" }, { google_status: "ENABLED" }],
      NOT: { google_status: "REMOVED" },
    },
    select: { id: true, mcc_id: true, customer_id: true, google_status: true },
  });

  // 分两组写：
  //  A) google_status 还是 ENABLED —— 真正的「显示在投」，这才是本次要修的那批，记暂停时间与来源。
  //  B) google_status 已是 PAUSED 但内部 status 漂在 active —— 只需把内部状态拉平。
  //     绝不覆盖它的 paused_at/pause_source：原值可能是 change_history 的精确时刻，
  //     用「发现 CID 撤销的时刻」盖掉是把好数据换成差数据（复盘页按 paused_at 取窗口）。
  const { toPause, toAlign } = splitOrphanCampaigns(pairs, victims);
  if (toPause.length === 0 && toAlign.length === 0) return { paused: 0, aligned: 0, ids: [] };

  const now = new Date();
  if (toPause.length > 0) {
    await prisma.campaigns.updateMany({
      where: { id: { in: toPause.map((c) => c.id) } },
      data: {
        status: "paused",
        google_status: "PAUSED",
        last_google_sync_at: now,
        paused_at: now,
        pause_source: CID_REVOKED_PAUSE_SOURCE,
      },
    });
  }
  if (toAlign.length > 0) {
    await prisma.campaigns.updateMany({
      where: { id: { in: toAlign.map((c) => c.id) } },
      data: { status: "paused", last_google_sync_at: now },
    });
  }

  const targetIds = [...toPause, ...toAlign].map((c) => c.id);

  // 立即收敛这些系列的换链接告警。suffix-replenish cron 里的
  // resolveAlertsForInactiveCampaigns 本来也会收（5 分钟一轮），但用户是点了同步在等结果，
  // 让「广告还在报警」这件事拖 5 分钟才消失，看起来仍像没修好。这里同步做掉，幂等无副作用。
  try {
    await prisma.suffix_alerts.updateMany({
      where: { campaign_id: { in: targetIds }, status: "open", is_deleted: 0 },
      data: { status: "resolved", resolved_at: now },
    });
  } catch (e) {
    console.error("[OrphanReconcile] 收敛告警失败（不影响回停）:", e instanceof Error ? e.message : e);
  }

  return { paused: toPause.length, aligned: toAlign.length, ids: targetIds };
}
