/**
 * 换链接补货引擎配置（移植自 kylink stock-producer 的自适应水位思想，按 CRM 低配生产机调参）
 *
 * 设计目标：
 * - 每个广告系列维持一定量的可用 suffix 库存，供 Google Ads 脚本 lease 时即取即用
 * - 库存低于低水位时触发补货，补到目标水位
 * - probe-then-batch：先探一条，成功再批量，失败立即熔断，避免对坏链接/坏代理空跑
 */

export const STOCK_CONFIG = {
  /** 单个广告系列的目标库存水位（补货补到此值） */
  TARGET_STOCK: 20,
  /** 低水位：可用库存 <= 此值时触发补货 */
  LOW_WATERMARK: 6,
  /** 单次补货最多生成数量（防止单系列长时间占用资源） */
  MAX_PER_REPLENISH: 24,
  /** 批量生成并发度（低配机串行偏保守） */
  CONCURRENCY: 3,
  /** 单条 suffix 生成总超时（毫秒）：含轻量跟链 + 代理 + 可能的无头浏览器兜底重试 */
  GEN_TIMEOUT_MS: 75000,
  /** 连续失败多少条后熔断本次补货（probe 阶段失败直接熔断） */
  CIRCUIT_FAIL_THRESHOLD: 4,
  /** suffix 默认有效期（小时），过期回收；0 表示不过期。
   *  联盟 clickid/token 多有时效，36h 内未被 lease 即回收，避免投放到失效后缀（对齐 kylink STOCK_EXPIRY_HOURS=36） */
  EXPIRE_HOURS: 36,
  /** leased 后多久仍未回执（write_success）视为卡死，回收为 expired（小时） */
  LEASE_STALE_HOURS: 6,
  /** cron 单次最多处理多少个广告系列 */
  CRON_MAX_CAMPAIGNS: 30,
  /** 只补货最近多少小时内有 lease 活动的广告系列 */
  ACTIVE_WINDOW_HOURS: 48,
} as const

export type StockConfig = typeof STOCK_CONFIG
