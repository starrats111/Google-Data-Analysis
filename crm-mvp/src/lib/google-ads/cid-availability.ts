/**
 * CID 可用性四态语义（批次5，对齐 kyads）：
 *
 *   "Y" = 已核实空闲（无 ENABLED 广告系列）
 *   "N" = 占用中（有 ≥1 ENABLED 广告系列）
 *   "U" = 未核实（本轮同步没查到该 CID / MCC 同步失败）——不可当"可用"用，
 *         但也不禁止选择，UI 应提示"数据可能过期"
 *   "D" = 已停用（账号 cancelled/suspended，或管理员强停）——禁止再选，
 *         且任何批量 Y/N 回写都不得覆盖 D
 *
 * 历史语义：只有 Y/N（"有 ENABLED 即 N"），D 零散出现在 admin 路径但会被
 * daily-sync / data-center sync 的 updateMany 冲回 Y/N（缺陷）。
 * 本模块是唯一语义出口：所有判定/展示/自动选号从这里走，写库方用
 * CID_WRITE_GUARD 防止覆盖 D。
 */

export type CidAvailability = "Y" | "N" | "U" | "D";

export const CID_AVAILABILITY = {
  AVAILABLE: "Y",
  OCCUPIED: "N",
  UNKNOWN: "U",
  DISABLED: "D",
} as const;

/**
 * 批量回写 Y/N 时的 where 附加条件：D 是终态（除非 admin 显式恢复），
 * 同步任务不得把停用的 CID 冲回可用。
 */
export const CID_WRITE_GUARD = { is_available: { not: "D" } } as const;

/**
 * 对外展示/选择用的可用性：结合行状态、存量标记与实时 ENABLED 计数。
 * - 行状态非 active 或已标 D → "D"
 * - 有 ENABLED 广告 → "N"
 * - 存量标记 U（上轮没核实到）且本地无 ENABLED → "U"（本地计数可能过期，不能升为 Y）
 * - 其余 → "Y"
 */
export function deriveDisplayAvailability(input: {
  rowStatus: string;
  storedAvailability: string;
  enabledCount: number;
}): CidAvailability {
  if (input.rowStatus !== "active" || input.storedAvailability === "D") return "D";
  if (input.enabledCount > 0) return "N";
  if (input.storedAvailability === "U") return "U";
  return "Y";
}

/** 是否允许在建广告时选择该 CID（D 禁选，Y/N/U 均可选，N/U 由 UI 提示） */
export function isCidSelectable(availability: string): boolean {
  return availability !== "D";
}

export interface CidPickCandidate {
  customer_id: string;
  customer_name?: string | null;
  is_available?: string | null;
  enabled_count?: number | null;
}

/**
 * 自动选号排序（原 D-007 逻辑升级）：
 * 1. 排除 D（停用）
 * 2. 已核实（Y/N）优先于未核实（U）——U 的 enabled 计数不可信
 * 3. ENABLED 数量少者优先
 * 4. customer_name 数字小者优先
 */
export function rankCidsForAutoPick<T extends CidPickCandidate>(cids: T[]): T[] {
  return cids
    .filter((c) => isCidSelectable(c.is_available ?? "Y"))
    .sort((a, b) => {
      const aUnknown = a.is_available === "U" ? 1 : 0;
      const bUnknown = b.is_available === "U" ? 1 : 0;
      if (aUnknown !== bUnknown) return aUnknown - bUnknown;
      const ae = a.enabled_count ?? (a.is_available === "Y" ? 0 : 1);
      const be = b.enabled_count ?? (b.is_available === "Y" ? 0 : 1);
      if (ae !== be) return ae - be;
      const an = Number(a.customer_name) || 0;
      const bn = Number(b.customer_name) || 0;
      return an - bn;
    });
}
