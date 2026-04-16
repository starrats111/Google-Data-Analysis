/**
 * 联盟交易 SQL 片段（已废弃过滤逻辑，保留函数签名以兼容现有调用方）。
 *
 * 设计原则：affiliate_transactions 一旦写入，即通过 user_id 永久归属于该用户，
 * 与 platform_connections 的后续状态（删除、修改）完全无关。
 * 跨用户去重由同步写入阶段负责，统计查询只需 WHERE user_id = ? 即可保证隔离。
 * 因此此处直接返回恒真条件，不再对 platform_connections 做二次联查。
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function sqlAffiliateTxnValidPlatformConnection(_tableAlias: string): string {
  return "1=1";
}
