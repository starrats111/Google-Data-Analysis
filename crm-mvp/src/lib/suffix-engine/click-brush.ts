/**
 * 换链接「刷点击」引擎 —— kylink 式真人自然点击
 *
 * 一次「点击」= 通过住宅代理跟随商家联盟追踪链接的整条跳转（联盟平台据此注册一次真实点击
 * 并返回新 clickid），最终落地页 query 即一条可用 suffix 入库存池。
 *
 * 与旧实现的区别：不再一触发就并发刷完，而是按「目标投放国本地时区的人类作息曲线」
 * 把 N 次点击排程分散到当天剩余时间（写入 kyads_click_task_items），
 * 由 cron（/api/cron/click-execute）每 1-2 分钟取到期子项执行：
 *   - 同一任务（=同一「人」）内串行 + 3-9 秒随机间隔
 *   - 每次随机 User-Agent / Referer（住宅代理已轮换出口 IP）
 *   - 跨任务并行（受限并发，保护低配生产机）
 * 这样点击在时间上自然分布、当天完成，更接近真实用户行为。
 */

import { prisma } from '@/lib/prisma'
import { generateOneSuffix } from './suffix-generator'
import { recordExitIp } from './exit-ip'
import { raiseAlert, resolveAlertsByType } from './alerts'
import { STOCK_CONFIG } from './config'
import { generateClickSchedule, generateClickScheduleWithinWindow, randomPick, randomInt, USER_AGENTS, REFERERS } from './click-scheduler'
import { resolveMerchantReferer } from './referer-resolver'
import { pickCampaignAffiliateLink } from '@/lib/merchant-connection'

/** 单次刷点击允许的最大次数（低配生产机保护） */
export const MAX_BRUSH = 1000

/**
 * 用户是否为「只同步数据、不参与换链接/刷点击」模式（link_exchange_disabled=1）。
 * jy 交垟队即此类：CRM 只记录其订单/点击数据，绝不对其刷点击或换链接。
 */
async function isLinkExchangeDisabled(userId: bigint): Promise<boolean> {
  const u = await prisma.users.findUnique({ where: { id: userId }, select: { link_exchange_disabled: true } })
  return u?.link_exchange_disabled === 1
}

// ── cron 执行器调参（低配生产机：2 核 / 3.7G） ──
// 2026-07 提吞吐：kookeey 隔离后单条点击变慢（成功均值 ~16s、失败 ~46s），旧参数
// (20/轮、5/任务、并发5、2分钟一轮) 实际每轮只消化 6-9 条，全局积压 ~700 条到期未执行。
// 提限额+提并发+cron 加密到 1 分钟；内存安全由 puppeteer-semaphore 独立封顶（Chrome ≤2）保证，
// 多数点击是纯 HTTP 跟链，提并发主要加速这部分。
/** 单次 cron 最多执行多少个到期子项 */
const MAX_ITEMS_PER_CRON = 40
/** 单次 cron 单个任务最多执行多少个子项（其余留待下次 cron，自然分摊负载） */
const MAX_ITEMS_PER_TASK_PER_CRON = 8
/** 跨任务并行度 */
const TASK_CONCURRENCY = 8
/** 同一任务内连续点击的真人间隔（毫秒） */
const MIN_CLICK_INTERVAL_MS = 3000
const MAX_CLICK_INTERVAL_MS = 9000
/** executing 子项卡死回收阈值（毫秒） */
const EXECUTING_STALE_MS = 5 * 60 * 1000
/** 瞬时代理并发错误（多为撞 kookeey 子账号并发上限被拒/连接抖动）：延后重排一次而非直接判失败 */
const TRANSIENT_PROXY_ERR =
  /socks5 authentication failed|rejected by the socks5 server|proxy request timeout|socket hang up|econnreset|econnrefused|etimedout|tunneling socket/i
/** 重排标记（写在 error 前缀），用于「最多重排 1 次」判定，避免无限重排 */
const RETRY_MARK = '[retry]'
/** 重排延后区间（毫秒）：等并发尖峰过去、会话名额释放后再试 */
const REQUEUE_MIN_MS = 120_000
const REQUEUE_MAX_MS = 300_000

export interface BrushStartResult {
  ok: true
  taskId: string
  target: number
  firstAt: Date | null
  lastAt: Date | null
}
export interface BrushStartError {
  ok: false
  message: string
}

/**
 * 创建刷点击任务：按作息曲线排程 N 次点击到当天，写入子项表后立即返回。
 * 实际执行由 cron 到期触发，不在此同步执行。
 */
export async function startBrushTask(
  campaignId: bigint,
  userId: bigint,
  count: number,
): Promise<BrushStartResult | BrushStartError> {
  const n = Math.min(Math.max(Math.floor(count) || 0, 1), MAX_BRUSH)

  // 「只同步数据、不参与换链接/刷点击」的用户（jy 交垟队，link_exchange_disabled=1）一律拒绝
  if (await isLinkExchangeDisabled(userId)) return { ok: false, message: '该用户为只记录数据模式，已禁用刷点击' }

  const campaign = await prisma.campaigns.findFirst({
    where: { id: campaignId, user_id: userId, is_deleted: 0 },
    select: { id: true, user_merchant_id: true, target_country: true, platform_connection_id: true },
  })
  if (!campaign) return { ok: false, message: '广告系列不存在或无权限' }

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { tracking_link: true, campaign_link: true, connection_campaign_links: true, platform_connection_id: true },
  })
  // 账号感知：按广告归属账号(platform_connection_id)挑对应号的链接，避免刷到别的号（wj02 串号）
  const affiliateUrl = merchant ? pickCampaignAffiliateLink(campaign.platform_connection_id, merchant) : ''
  if (!affiliateUrl) return { ok: false, message: '该广告系列所属联盟账号未配置追踪链接' }

  // 来路优先级：手动来路 → 最新文章 → 联盟账号网站 → （空则执行时回退随机来路池）
  const referer = await resolveMerchantReferer(campaign.user_merchant_id)

  // 已有进行中的刷点击任务则不重复创建
  const existing = await prisma.kyads_click_tasks.findFirst({
    where: { campaign_id: campaignId, user_id: userId, status: { in: ['pending', 'running'] }, is_deleted: 0 },
    select: { id: true },
  })
  if (existing) return { ok: false, message: '已有刷点击任务进行中' }

  // 记住本次点击数，作为下次默认值
  await prisma.users.update({ where: { id: userId }, data: { link_exchange_click_count: n } }).catch(() => {})

  // 按目标国作息曲线排程到当天
  const schedule = generateClickSchedule(n, campaign.target_country || undefined)

  const task = await prisma.kyads_click_tasks.create({
    data: {
      user_id: userId,
      campaign_id: campaignId,
      affiliate_url: affiliateUrl,
      referer_url: referer.url ?? '',
      target_count: n,
      done_count: 0,
      status: 'running',
      started_at: new Date(),
    },
  })

  if (schedule.length > 0) {
    await prisma.kyads_click_task_items.createMany({
      data: schedule.map((scheduledAt) => ({ task_id: task.id, scheduled_at: scheduledAt, status: 'pending' })),
    })
  }

  return {
    ok: true,
    taskId: task.id.toString(),
    target: n,
    firstAt: schedule[0] ?? null,
    lastAt: schedule[schedule.length - 1] ?? null,
  }
}

/**
 * 需求2：窗口化刷点击任务 —— 把 count 次点击排程到「未来 windowMinutes 分钟内」随机分散，
 * 供「订单/点击比自动补刷」引擎调用（定版：1 小时内补完）。
 *
 * 与 startBrushTask 的区别：
 *   - 排程用 generateClickScheduleWithinWindow（窗口内随机），不走当天作息曲线；
 *   - 不做「已有进行中任务则拒绝」校验——自动补刷每小时可能多次小批补，允许并存
 *     （每小时总量上限由调用方 auto-click 引擎按 B/4 控制）。
 */
export async function startBrushTaskWindowed(
  campaignId: bigint,
  userId: bigint,
  count: number,
  windowMinutes: number,
): Promise<BrushStartResult | BrushStartError> {
  const n = Math.min(Math.max(Math.floor(count) || 0, 1), MAX_BRUSH)

  // 只记录数据模式（link_exchange_disabled=1，如 jy 组）不补刷。auto-click 已在入口拦截，
  // 这里作为兜底二次校验，杜绝任何调用路径绕过。
  if (await isLinkExchangeDisabled(userId)) return { ok: false, message: '该用户为只记录数据模式，已禁用刷点击' }

  const campaign = await prisma.campaigns.findFirst({
    where: { id: campaignId, user_id: userId, is_deleted: 0 },
    select: { id: true, user_merchant_id: true, target_country: true, platform_connection_id: true },
  })
  if (!campaign) return { ok: false, message: '广告系列不存在或无权限' }

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { tracking_link: true, campaign_link: true, connection_campaign_links: true, platform_connection_id: true },
  })
  // 账号感知：按广告归属账号挑对应号的链接（订单归属由调用方 auto-click 按同一 connId 统计）
  const affiliateUrl = merchant ? pickCampaignAffiliateLink(campaign.platform_connection_id, merchant) : ''
  if (!affiliateUrl) return { ok: false, message: '该广告系列所属联盟账号未配置追踪链接' }

  const referer = await resolveMerchantReferer(campaign.user_merchant_id)
  const schedule = generateClickScheduleWithinWindow(n, windowMinutes)

  const task = await prisma.kyads_click_tasks.create({
    data: {
      user_id: userId,
      campaign_id: campaignId,
      affiliate_url: affiliateUrl,
      referer_url: referer.url ?? '',
      target_count: n,
      done_count: 0,
      status: 'running',
      started_at: new Date(),
    },
  })

  if (schedule.length > 0) {
    await prisma.kyads_click_task_items.createMany({
      data: schedule.map((scheduledAt) => ({ task_id: task.id, scheduled_at: scheduledAt, status: 'pending' })),
    })
  }

  return {
    ok: true,
    taskId: task.id.toString(),
    target: n,
    firstAt: schedule[0] ?? null,
    lastAt: schedule[schedule.length - 1] ?? null,
  }
}

export interface BrushAllResult {
  queued: number
  skipped: number
  total: number
}

/**
 * 一次性为「该用户所有已启用换链、已匹配带追踪链接商家」的广告系列批量创建刷点击任务。
 * 每个系列各 count 次；已有进行中任务/无追踪链接的自动跳过。各任务按作息曲线排程到当天。
 */
export async function startBrushAllTasks(userId: bigint, count: number): Promise<BrushAllResult> {
  const n = Math.min(Math.max(Math.floor(count) || 0, 1), MAX_BRUSH)

  // 只记录数据模式（jy 组）：直接返回空结果，不创建任何刷点击任务
  if (await isLinkExchangeDisabled(userId)) return { queued: 0, skipped: 0, total: 0 }

  const campaigns = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      status: 'active',
      google_status: 'ENABLED',
      is_deleted: 0,
      google_campaign_id: { not: null },
      suffix_exchange_enabled: 1,
      user_merchant_id: { not: BigInt(0) },
    },
    select: { id: true },
  })

  let queued = 0
  let skipped = 0
  for (const c of campaigns) {
    const r = await startBrushTask(c.id, userId, n)
    if (r.ok) queued++
    else skipped++
  }
  return { queued, skipped, total: campaigns.length }
}

// ─────────────────────────────────────────────────────────────
// cron 执行器
// ─────────────────────────────────────────────────────────────

interface TaskRuntime {
  taskId: bigint
  userId: bigint
  campaignId: bigint
  campaignName: string | null
  affiliateUrl: string
  /** 商家自定义来路（kyads_referer_url），为空则每次随机选 REFERERS */
  refererUrl: string | null
  country: string
  platform: string | null
  sourceMerchantId: bigint | null
  /** F-IPDEDUP-01 组级去重键：用户所属组（NULL=未分组，不做组级去重） */
  teamId: bigint | null
  /** F-IPDEDUP-01 组级去重键：联盟平台商家 ID（字符串，跨用户对同一真实商家一致） */
  merchantIdStr: string | null
  existingSuffixes: Set<string>
  /** 本任务是否已顺带清过库存类告警（刷点击也在产出库存，成功一次即清一次，避免高消耗系列告警常驻） */
  alertsResolved?: boolean
}

/** 回收长时间卡在 executing 的子项，避免任务永久占坑 */
async function recoverStuckItems(now: Date): Promise<void> {
  const threshold = new Date(now.getTime() - EXECUTING_STALE_MS)
  await prisma.kyads_click_task_items
    .updateMany({
      where: { status: 'executing', is_deleted: 0, OR: [{ executed_at: { lte: threshold } }, { executed_at: null, updated_at: { lte: threshold } }] },
      data: { status: 'failed', error: '执行超时，系统自动回收', executed_at: now },
    })
    .catch(() => {})
}

/** 为某任务准备运行期上下文（campaign / merchant / 现有库存去重集合） */
async function buildTaskRuntime(taskId: bigint): Promise<TaskRuntime | null> {
  const task = await prisma.kyads_click_tasks.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'running') return null

  const campaign = await prisma.campaigns.findFirst({
    where: { id: task.campaign_id, is_deleted: 0 },
    select: { id: true, user_id: true, user_merchant_id: true, target_country: true, campaign_name: true },
  })
  if (!campaign) return null

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { id: true, platform: true, merchant_id: true },
  })

  // 组级去重键：取用户所属组（NULL=未分组，不参与组级去重）
  const owner = await prisma.users.findUnique({ where: { id: campaign.user_id }, select: { team_id: true } })

  const existing = await prisma.suffix_pool.findMany({
    where: { campaign_id: campaign.id, status: 'available', is_deleted: 0 },
    select: { suffix_content: true },
  })

  return {
    taskId,
    userId: campaign.user_id,
    campaignId: campaign.id,
    campaignName: campaign.campaign_name,
    affiliateUrl: task.affiliate_url,
    refererUrl: task.referer_url?.trim() || null,
    country: campaign.target_country || 'US',
    platform: merchant?.platform ?? null,
    sourceMerchantId: merchant?.id ?? null,
    teamId: owner?.team_id ?? null,
    merchantIdStr: merchant?.merchant_id ?? null,
    existingSuffixes: new Set(existing.map((r) => r.suffix_content)),
  }
}

/** 执行单条点击子项。返回 skipped=true 表示子项已被并行轮次认领，本轮跳过（不计成败） */
async function executeItem(rt: TaskRuntime, itemId: bigint): Promise<{ ok: boolean; skipped?: boolean }> {
  const startedAt = Date.now()
  // 原子认领：仅当仍是 pending 才置 executing。cron 加密到 1 分钟后相邻轮次可能重叠，
  // 靠这个条件更新保证同一子项绝不会被两轮重复执行（重复点击=重复烧代理流量+污染任务计数）。
  const claimed = await prisma.kyads_click_task_items
    .updateMany({
      where: { id: itemId, status: 'pending' },
      data: { status: 'executing', executed_at: new Date() },
    })
    .catch(() => ({ count: 0 }))
  if (claimed.count === 0) return { ok: false, skipped: true }

  // 读取上次错误，判断是否已重排过（error 以 RETRY_MARK 开头 = 本子项已延后重试过一次）
  const prior = await prisma.kyads_click_task_items
    .findUnique({ where: { id: itemId }, select: { error: true } })
    .catch(() => null)
  const alreadyRequeued = !!prior?.error && prior.error.startsWith(RETRY_MARK)

  const r = await generateOneSuffix(rt.affiliateUrl, rt.country, rt.platform, {
    userId: rt.userId,
    campaignId: rt.campaignId,
    teamId: rt.teamId,
    merchantId: rt.merchantIdStr,
    userAgent: randomPick(USER_AGENTS),
    // 优先用商家自定义来路，未配置才回退随机 REFERERS（更贴近真实站点引流）
    referer: rt.refererUrl || randomPick(REFERERS) || null,
  })
  const duration = Date.now() - startedAt

  if (r.ok) {
    // 入库存池（去重）
    if (!rt.existingSuffixes.has(r.suffix)) {
      rt.existingSuffixes.add(r.suffix)
      const expiresAt =
        STOCK_CONFIG.EXPIRE_HOURS > 0 ? new Date(Date.now() + STOCK_CONFIG.EXPIRE_HOURS * 3600_000) : null
      await prisma.suffix_pool
        .create({
          data: {
            user_id: rt.userId,
            campaign_id: rt.campaignId,
            suffix_content: r.suffix,
            status: 'available',
            source_merchant_id: rt.sourceMerchantId,
            exit_ip: r.exitIp,
            expires_at: expiresAt,
          },
        })
        .catch(() => {})
    }
    // 记录本次点击出口 IP（24h 组级去重 + 子项留痕）
    if (r.exitIp) {
      await recordExitIp(
        { teamId: rt.teamId, platform: rt.platform, merchantId: rt.merchantIdStr, userId: rt.userId, campaignId: rt.campaignId },
        r.exitIp,
      )
    }
    await prisma.kyads_click_task_items
      .update({ where: { id: itemId }, data: { status: 'success', exit_ip: r.exitIp, duration_ms: duration } })
      .catch(() => {})
    await prisma.kyads_click_tasks.update({ where: { id: rt.taskId }, data: { done_count: { increment: 1 } } }).catch(() => {})
    // 刷点击成功产出 suffix 同样意味着库存在恢复：与 cron 补货同口径，顺带清掉该系列库存类告警。
    // 只清一次（rt.alertsResolved 守卫），避免高消耗系列每条成功都打一次 DB。解决「刷点击一直在补、
    // 但 low_stock/replenish_failed/invalid_link 告警因只有 cron 补货成功才清而常驻」的问题。
    if (!rt.alertsResolved) {
      rt.alertsResolved = true
      await resolveAlertsByType(rt.userId, rt.campaignId, ['low_stock', 'replenish_failed', 'invalid_link', 'brush_blocked']).catch(() => {})
    }
    return { ok: true }
  }

  // 瞬时代理并发错误（撞 kookeey 并发上限被拒/连接抖动）或 D-177 代理不可用（余额耗尽/熔断/池空，
  // 未发起真实跟链）：延后重排一次，等会话名额/余额恢复后再试，不把环境故障算成点击失败。
  // 已重排过（alreadyRequeued）则按失败处理，避免无限重排。
  if ((TRANSIENT_PROXY_ERR.test(r.error) || r.reason === 'proxy_unavailable') && !alreadyRequeued) {
    const delayMs = randomInt(REQUEUE_MIN_MS, REQUEUE_MAX_MS)
    await prisma.kyads_click_task_items
      .update({
        where: { id: itemId },
        data: {
          status: 'pending',
          error: `${RETRY_MARK} ${r.error}`.slice(0, 500),
          scheduled_at: new Date(Date.now() + delayMs),
          executed_at: null,
          duration_ms: duration,
        },
      })
      .catch(() => {})
    return { ok: false }
  }

  await prisma.kyads_click_task_items
    .update({ where: { id: itemId }, data: { status: 'failed', error: r.error.slice(0, 500), duration_ms: duration } })
    .catch(() => {})
  return { ok: false }
}

/** 串行执行某任务本批次的子项（含真人间隔） */
async function runTaskItems(rt: TaskRuntime, itemIds: bigint[]): Promise<{ done: number; failed: number }> {
  let done = 0
  let failed = 0
  for (let i = 0; i < itemIds.length; i++) {
    const res = await executeItem(rt, itemIds[i])
    if (res.skipped) continue // 已被并行轮次认领，不计成败也不等间隔
    if (res.ok) done++
    else failed++
    if (i < itemIds.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, randomInt(MIN_CLICK_INTERVAL_MS, MAX_CLICK_INTERVAL_MS)))
    }
  }
  return { done, failed }
}

/** 检查并收尾已无待执行子项的任务（标记 done/failed + 告警联动） */
async function finalizeTask(taskId: bigint): Promise<boolean> {
  const task = await prisma.kyads_click_tasks.findUnique({ where: { id: taskId } })
  if (!task || task.status !== 'running') return false

  const pending = await prisma.kyads_click_task_items.count({
    where: { task_id: taskId, status: { in: ['pending', 'executing'] }, is_deleted: 0 },
  })
  if (pending > 0) return false

  const done = task.done_count
  const newStatus = done > 0 ? 'done' : 'failed'
  await prisma.kyads_click_tasks.update({
    where: { id: taskId },
    data: { status: newStatus, finished_at: new Date(), error_message: done > 0 ? null : '全部点击失败' },
  })

  if (done > 0) {
    await resolveAlertsByType(task.user_id, task.campaign_id, ['low_stock', 'replenish_failed', 'invalid_link', 'brush_blocked'])
  } else {
    const campaign = await prisma.campaigns.findUnique({ where: { id: task.campaign_id }, select: { campaign_name: true } })
    await raiseAlert(task.user_id, {
      type: 'replenish_failed',
      campaignId: task.campaign_id,
      level: 'error',
      message: `广告系列「${campaign?.campaign_name ?? task.campaign_id.toString()}」刷点击全部失败`,
      context: { affiliateUrl: task.affiliate_url.slice(0, 300) },
    })
  }
  return true
}

export interface ClickExecuteResult {
  executed: number
  succeeded: number
  failed: number
  tasksFinalized: number
}

/**
 * cron 执行器：取到期子项执行（每 1-2 分钟调用）。
 * - 仅取 scheduled_at <= now 且 pending 的子项
 * - 按任务分组，组内串行 + 真人间隔，组间受限并行
 * - 公平限额：单任务单次最多 MAX_ITEMS_PER_TASK_PER_CRON，总量 MAX_ITEMS_PER_CRON
 */
export async function executeClickTaskItems(): Promise<ClickExecuteResult> {
  const now = new Date()
  let executed = 0
  let succeeded = 0
  let failed = 0
  let tasksFinalized = 0

  try {
    await recoverStuckItems(now)

    // 1. 取运行中任务 id（无 FK 关系，分两步查避免迁移漂移）
    const runningTasks = await prisma.kyads_click_tasks.findMany({
      where: { status: 'running', is_deleted: 0 },
      select: { id: true },
    })
    if (runningTasks.length === 0) return { executed: 0, succeeded: 0, failed: 0, tasksFinalized: 0 }
    const runningIds = runningTasks.map((t) => t.id)

    // 取候选到期子项，窗口适当放大以便公平分摊
    const candidates = await prisma.kyads_click_task_items.findMany({
      where: {
        status: 'pending',
        is_deleted: 0,
        scheduled_at: { lte: now },
        task_id: { in: runningIds },
      },
      orderBy: { scheduled_at: 'asc' },
      take: MAX_ITEMS_PER_CRON * 4,
      select: { id: true, task_id: true },
    })

    if (candidates.length > 0) {
      // 2. 公平挑选：按任务限额 + 总量限额
      const perTaskCount = new Map<string, number>()
      const selectedByTask = new Map<string, bigint[]>()
      let totalSelected = 0
      for (const item of candidates) {
        if (totalSelected >= MAX_ITEMS_PER_CRON) break
        const key = item.task_id.toString()
        const cnt = perTaskCount.get(key) ?? 0
        if (cnt >= MAX_ITEMS_PER_TASK_PER_CRON) continue
        perTaskCount.set(key, cnt + 1)
        if (!selectedByTask.has(key)) selectedByTask.set(key, [])
        selectedByTask.get(key)!.push(item.id)
        totalSelected++
      }

      // 3. 准备每个任务的运行期上下文
      const taskKeys = Array.from(selectedByTask.keys())
      const runtimes = new Map<string, TaskRuntime | null>()
      for (const key of taskKeys) {
        runtimes.set(key, await buildTaskRuntime(BigInt(key)))
      }

      // 4. 组间受限并行，组内串行
      let idx = 0
      const runNext = async (): Promise<void> => {
        while (idx < taskKeys.length) {
          const myIdx = idx++
          const key = taskKeys[myIdx]
          const rt = runtimes.get(key)
          const itemIds = selectedByTask.get(key)!
          if (!rt) {
            // 任务上下文缺失（被删/状态变更）：把本批子项标记失败，避免空转
            await prisma.kyads_click_task_items
              .updateMany({ where: { id: { in: itemIds } }, data: { status: 'failed', error: 'task_context_missing', executed_at: new Date() } })
              .catch(() => {})
            executed += itemIds.length
            failed += itemIds.length
            continue
          }
          const res = await runTaskItems(rt, itemIds)
          executed += res.done + res.failed
          succeeded += res.done
          failed += res.failed
        }
      }
      await Promise.all(Array.from({ length: Math.min(TASK_CONCURRENCY, taskKeys.length) }, () => runNext()))
    }

    // 5. 收尾：对「所有」running 任务兜底 finalize，而不只本轮执行过子项的任务（LE-01 #4）。
    // 否则子项已全部终态、但收尾时机被错过（部署重启 / 卡死回收发生在无候选的轮次）的任务
    // 会永远停在 running，并让 startBrushTask 一直拒绝该系列的新刷点击任务（僵尸占坑）。
    for (const id of runningIds) {
      if (await finalizeTask(id)) tasksFinalized++
    }
  } catch (err) {
    console.error('[click-brush] executeClickTaskItems error:', err instanceof Error ? err.message : err)
  }

  return { executed, succeeded, failed, tasksFinalized }
}
