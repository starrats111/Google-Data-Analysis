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

// ─────────────────────────────────────────────────────────────
// D-372：单条系列从 CampaignInfo「凭空消失」的对账（不同于 D-330 的 CID 整体撤销）。
//
// 实证（07 2026-10-24 反馈：furla.com-US-1019-2 在 Google Ads 后台被直接删除，点启停报
// 误导性「切换账户」提示）：生产库现场核实——该 gcid 所属 CID（889-724-9107）仍在正常投放
// 其他系列，CID 本身没被撤销，命中不了 D-330 那条路；而统一脚本重写 CampaignInfo 时，
// 对单条被删的系列就是整行不再写入（同一批核实：两条 10-13 已被 sync 写成 REMOVED 的系列，
// 10 天后也从当前 Sheet 快照里彻底消失——证明 REMOVED 在表里只是过渡态，脚本后续清表时
// 连 REMOVED 行一起扫掉了，不是只有"活着的"才会消失）。
//
// sheet-status-sync.ts 的主循环对「Sheet 里没有的系列」统一 continue 不动，这类单条消失的
// 系列因此永久冻结在最后一次同步到的状态——跟 D-330 的病因同源，但触发条件不同（没有
// CID 终态可以直接当依据），只能反查 Google 侧真实状态来确认。
//
// 为避免重新引入被 D-325/旧 fetchAllCampaignStatuses 打爆过的「逐条发 API」模式，
// 候选集合用两层闸门收紧到最小：
//   1) 本地仍标「在投」（active/ENABLED）且不是终态（非 REMOVED、remove_source 为空）；
//   2) 本轮 Sheet 快照里确实没有这个 gcid；
//   3) last_google_sync_at 已超过 STALE_HOURS——避免脚本单轮抖动/残表造成的瞬时缺行被误判。
// 命中以上三条的系列在正常 MCC 里应该是个位数，才值得逐条反查。
const MISSING_FROM_SHEET_STALE_HOURS = 24;

/** 回停时写入 pause_source 的取值（对应 PAUSE_SOURCE_LABELS 需新增 vanished_from_sheet） */
export const VANISHED_FROM_SHEET_PAUSE_SOURCE = "vanished_from_sheet";

export interface VanishedReconcileResult {
  /** 反查确认 Google 侧已 REMOVED，回停并标终态 */
  removed: number;
  /** 反查确认 Google 侧已 PAUSED，拉平内部状态 */
  paused: number;
  /** 反查仍是 ENABLED（脚本生成的偶发缺行，非真消失）或查询失败——只刷同步时间，不改状态 */
  stillAlive: number;
}

interface VanishedCandidate {
  id: bigint;
  google_campaign_id: string;
  customer_id: string;
}

/**
 * 对单个 MCC 执行「Sheet 里凭空消失的在投系列」反查对账。
 * 调用方需已拿到本轮 sheetMap（避免重复拉表）与该 MCC 的 Google Ads 凭据（反查要用）。
 */
export async function reconcileCampaignsVanishedFromSheet(
  scope: {
    userId: bigint;
    mccId: bigint;
    credentials: { mcc_id: string; developer_token: string; service_account_json: string };
    sheetGcids: Set<string>;
  },
): Promise<VanishedReconcileResult> {
  const staleCutoff = new Date(Date.now() - MISSING_FROM_SHEET_STALE_HOURS * 3600 * 1000);

  const candidates = await prisma.campaigns.findMany({
    where: {
      user_id: scope.userId,
      mcc_id: scope.mccId,
      is_deleted: 0,
      remove_source: null,
      google_campaign_id: { not: null },
      customer_id: { not: null },
      OR: [{ status: "active" }, { google_status: "ENABLED" }],
      NOT: { google_status: "REMOVED" },
      last_google_sync_at: { lt: staleCutoff },
    },
    select: { id: true, google_campaign_id: true, customer_id: true },
  });

  const missing: VanishedCandidate[] = candidates
    .filter((c) => c.google_campaign_id && !scope.sheetGcids.has(c.google_campaign_id))
    .map((c) => ({ id: c.id, google_campaign_id: c.google_campaign_id!, customer_id: c.customer_id! }));

  const result: VanishedReconcileResult = { removed: 0, paused: 0, stillAlive: 0 };
  if (missing.length === 0) return result;

  const { probeRealCampaignStatus } = await import("./mutate");
  const now = new Date();

  for (const c of missing) {
    const real = await probeRealCampaignStatus(scope.credentials, c.customer_id, c.google_campaign_id);
    if (real === "REMOVED") {
      await prisma.campaigns.update({
        where: { id: c.id },
        data: {
          status: "paused",
          google_status: "REMOVED",
          last_google_sync_at: now,
          paused_at: now,
          pause_source: VANISHED_FROM_SHEET_PAUSE_SOURCE,
        },
      });
      result.removed++;
      try {
        await prisma.suffix_alerts.updateMany({
          where: { campaign_id: c.id, status: "open", is_deleted: 0 },
          data: { status: "resolved", resolved_at: now },
        });
      } catch (e) {
        console.error("[VanishedReconcile] 收敛告警失败（不影响回停）:", e instanceof Error ? e.message : e);
      }
    } else if (real === "PAUSED") {
      await prisma.campaigns.update({
        where: { id: c.id },
        data: { status: "paused", google_status: "PAUSED", last_google_sync_at: now },
      });
      result.paused++;
    } else {
      // real === "ENABLED"（脚本偶发缺行，不是真消失）或反查失败（权限/网络/配额）：
      // 只刷同步时间避免本轮重复反查同一条，状态按兵不动，下次满足 staleness 再查一次
      await prisma.campaigns.update({
        where: { id: c.id },
        data: { last_google_sync_at: now },
      });
      result.stillAlive++;
    }
  }

  return result;
}
