/**
 * 联盟交易 SQL 片段：排除已删除平台连接、或连接归属用户不一致的脏数据。
 * platform_connection_id 为 NULL 时仍计入（历史数据）。
 */
export function sqlAffiliateTxnValidPlatformConnection(tableAlias: string): string {
  return `(
    ${tableAlias}.platform_connection_id IS NULL
    OR EXISTS (
      SELECT 1 FROM platform_connections _pc
      WHERE _pc.id = ${tableAlias}.platform_connection_id
        AND _pc.user_id = ${tableAlias}.user_id
        AND _pc.is_deleted = 0
    )
  )`;
}
