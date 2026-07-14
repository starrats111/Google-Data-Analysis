/**
 * 换链接补货引擎配置（移植自 kylink stock-producer 的自适应水位思想，按 CRM 低配生产机调参）
 *
 * 设计目标：
 * - 每个广告系列维持一定量的可用 suffix 库存，供 Google Ads 脚本 lease 时即取即用
 * - 库存低于低水位时触发补货，补到目标水位
 * - probe-then-batch：先探一条，成功再批量，失败立即熔断，避免对坏链接/坏代理空跑
 */

export const STOCK_CONFIG = {
  /** 单个广告系列的目标库存水位（补货补到此值）。纯 HTTP 系列启用自适应后此值为「上限封顶」。 */
  TARGET_STOCK: 20,
  /** 低水位：可用库存 <= 此值时触发补货 */
  LOW_WATERMARK: 6,
  /** 纯 HTTP 系列自适应目标水位（治「固定补到 20 → 低消费系列 36h 内消费不掉、约 32% 过期作废」）。
   *  目标 = clamp( ceil(近 N 天日均消费 × COVERAGE_HOURS/24), MIN_TARGET_STOCK, TARGET_STOCK )。
   *  高消费系列仍接近 20（不缺货）；低/新系列降到下限（少蓄水、少作废）。仅普通 HTTP 系列生效——
   *  浏览器系列走 BROWSER_TARGET_STOCK、静态后缀系列走去重逻辑、lease 显式 target 优先，均不受影响。 */
  ADAPTIVE_TARGET_ENABLED: true,
  /** 库存目标覆盖的消费时长（小时）：库存约保留这么多小时的消费量。cron 每 5min 补货，短覆盖即够周转。 */
  TARGET_COVERAGE_HOURS: 12,
  /** 自适应目标下限：低消费/新系列至少蓄这么多，避免消费波动时频繁 NO_STOCK。 */
  MIN_TARGET_STOCK: 6,
  /** 计算日均消费的回看天数（数据源：suffix_assignments write_success=1 的 reported_at）。 */
  CONSUMPTION_LOOKBACK_DAYS: 3,
  /** 「必须无头浏览器才能跟链」的系列（suffix_needs_browser=1）专用的更低目标库存。
   *  这类系列每生成一条都要跑整页浏览器（纯 HTTP 的几十倍流量），故按最小可用量蓄水，降频补货省流量。 */
  BROWSER_TARGET_STOCK: 5,
  /** 浏览器系列的低水位：可用库存 <= 此值才补货（比普通系列更低，减少被 cron 选中的频次）。 */
  BROWSER_LOW_WATERMARK: 2,
  /** 浏览器系列两次 cron 补货之间的最小冷却（毫秒）。即便低于水位，冷却期内也跳过，进一步压低频率。 */
  BROWSER_REPLENISH_COOLDOWN_MS: 60 * 60_000,
  /** 单次补货最多生成数量（防止单系列长时间占用资源） */
  MAX_PER_REPLENISH: 24,
  /** 批量生成并发度。
   *  说明：无头浏览器并发由 puppeteer-semaphore 独立封顶（NORMAL=2），与此值解耦——
   *  即便 5 路并行，同时存在的 Chrome 仍 ≤2，内存安全；提到 5 主要加速「占多数的 HTTP 可解析链接」。 */
  CONCURRENCY: 5,
  /** 单条 suffix 生成总超时（毫秒）：含轻量跟链 + 代理 + 可能的无头浏览器兜底重试。
   *  取 55s：浏览器兜底正确跟随 LH/中转 JS 延迟跳转后单条可达 ~25-30s，叠加最长 30s 抢 puppeteer slot
   *  排队，故不能砍到 45s（会误杀正在成功跟链的 LH）；55s 较 75s 仍显著提速且不误伤合法慢链。 */
  GEN_TIMEOUT_MS: 55000,
  /** 连续失败多少条后熔断本次补货（probe 阶段失败直接熔断） */
  CIRCUIT_FAIL_THRESHOLD: 4,
  /** suffix 默认有效期（小时），过期回收；0 表示不过期。
   *  联盟 clickid/token 多有时效，36h 内未被 lease 即回收，避免投放到失效后缀（对齐 kylink STOCK_EXPIRY_HOURS=36） */
  EXPIRE_HOURS: 36,
  /** leased 后多久仍未回执（write_success）视为卡死，回收为 expired（小时） */
  LEASE_STALE_HOURS: 6,
  /** cron 单次最多处理多少个广告系列（提到 50：缓解「每轮只够补 2-3 个、库存分布两极」问题） */
  CRON_MAX_CAMPAIGNS: 50,
  /** 只补货最近多少小时内有 lease 活动的广告系列 */
  ACTIVE_WINDOW_HOURS: 48,

  // ── D-177 失败分类冷却（采纳 kyads verify-link 判定思想，冷却落库、pm2 重启不丢） ──
  /** proxy_unavailable（kookeey 余额耗尽/熔断/池空）瞬时错误冷却：环境故障，短冷却重试，不计死链 */
  PROXY_UNAVAILABLE_COOLDOWN_MS: 10 * 60_000,
  /** 「域名匹配但无追踪参数」活链冷却：链接活着（需浏览器/参数被吃），短冷却换姿势重试，不报 invalid_link */
  ALIVE_LINK_COOLDOWN_MS: 30 * 60_000,
  /** 疑似死链（域名也不匹配/跟链硬失败）连续多少次才升级 invalid_link 告警 + 长冷却 */
  DEAD_LINK_FAIL_THRESHOLD: 3,
  /** 疑似死链达阈值后的长冷却：期间不再重试（不烧浏览器/代理），到期自动再验一次 */
  DEAD_LINK_COOLDOWN_MS: 8 * 60 * 60_000,
} as const

export type StockConfig = typeof STOCK_CONFIG
