/**
 * D-321 本地人工移除（拒登即移除）
 *
 * 背景：广告被 Google 拒登后，成员自己去 Google 后台移除广告，但 CRM 要等下一轮同步
 * （手动同步 / 06:00 daily-sync）才跟上，中间这条广告在数据中心一直显示「已启用」，
 * 还占着「选 CID」里的一个在投名额（enabled_count），员工只能干等。
 *
 * 规则（07 于 2026-09-06 拍板）：员工在 CRM 点「拒登」= 这条广告当场标成已移除，
 * 不调 Google API（Google 那边成员自己动手）。`remove_source` 非空即本地移除终态，
 * 所有同步入口不得再把状态冲回 ENABLED/PAUSED，否则第二天又变回「已启用」占名额。
 *
 * 反向豁免：「重发此条」重新发布时清空标记（见 ad-creation/republish），状态跟随新广告。
 * 兜底：cron/removed-still-spending 巡检「CRM 已移除但 Google 侧还在花钱」——
 * 防覆盖是双刃剑，成员忘了在 Google 移除时不能让它悄悄烧钱。
 */

/** 记录拒登时自动置的移除来源 */
export const REMOVE_SOURCE_REJECTION = "rejection";

/** 本地人工移除的终态：同步一律不得改其状态 */
export function isLocallyRemoved(row: { remove_source?: string | null } | null | undefined): boolean {
  return !!row?.remove_source;
}

/** 「重发此条」等重新发布路径用：清空本地移除标记，状态交还给同步 */
export const CLEAR_LOCAL_REMOVE = { removed_at: null, remove_source: null } as const;
