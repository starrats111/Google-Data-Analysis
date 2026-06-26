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
import { generateClickSchedule, randomPick, randomInt, USER_AGENTS, REFERERS } from './click-scheduler'

/** 单次刷点击允许的最大次数（低配生产机保护） */
export const MAX_BRUSH = 1000

// ── cron 执行器调参（低配生产机：2 核 / 3.7G） ──
/** 单次 cron 最多执行多少个到期子项 */
const MAX_ITEMS_PER_CRON = 20
/** 单次 cron 单个任务最多执行多少个子项（其余留待下次 cron，自然分摊负载） */
const MAX_ITEMS_PER_TASK_PER_CRON = 5
/** 跨任务并行度 */
const TASK_CONCURRENCY = STOCK_CONFIG.CONCURRENCY
/** 同一任务内连续点击的真人间隔（毫秒） */
const MIN_CLICK_INTERVAL_MS = 3000
const MAX_CLICK_INTERVAL_MS = 9000
/** executing 子项卡死回收阈值（毫秒） */
const EXECUTING_STALE_MS = 5 * 60 * 1000

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

  const campaign = await prisma.campaigns.findFirst({
    where: { id: campaignId, user_id: userId, is_deleted: 0 },
    select: { id: true, user_merchant_id: true, target_country: true },
  })
  if (!campaign) return { ok: false, message: '广告系列不存在或无权限' }

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { tracking_link: true, kyads_referer_url: true },
  })
  if (!merchant?.tracking_link) return { ok: false, message: '该广告系列未匹配到带追踪链接的商家' }

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
      affiliate_url: merchant.tracking_link,
      referer_url: merchant.kyads_referer_url ?? '',
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
  country: string
  platform: string | null
  sourceMerchantId: bigint | null
  existingSuffixes: Set<string>
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
    select: { id: true, platform: true },
  })

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
    country: campaign.target_country || 'US',
    platform: merchant?.platform ?? null,
    sourceMerchantId: merchant?.id ?? null,
    existingSuffixes: new Set(existing.map((r) => r.suffix_content)),
  }
}

/** 执行单条点击子项 */
async function executeItem(rt: TaskRuntime, itemId: bigint): Promise<{ ok: boolean }> {
  const startedAt = Date.now()
  await prisma.kyads_click_task_items
    .update({ where: { id: itemId }, data: { status: 'executing', executed_at: new Date() } })
    .catch(() => {})

  const r = await generateOneSuffix(rt.affiliateUrl, rt.country, rt.platform, {
    userId: rt.userId,
    campaignId: rt.campaignId,
    userAgent: randomPick(USER_AGENTS),
    referer: randomPick(REFERERS) || null,
  })
  const duration = Date.now() - startedAt

  if (r.ok) {
    // 入库存池（去重）
    if (!rt.existingSuffixes.has(r.suffix)) {
      rt.existingSuffixes.add(r.suffix)
      await prisma.suffix_pool
        .create({
          data: {
            user_id: rt.userId,
            campaign_id: rt.campaignId,
            suffix_content: r.suffix,
            status: 'available',
            source_merchant_id: rt.sourceMerchantId,
            exit_ip: r.exitIp,
          },
        })
        .catch(() => {})
    }
    // 记录本次点击出口 IP（24h 去重 + 子项留痕）
    if (r.exitIp) await recordExitIp(rt.userId, rt.campaignId, r.exitIp)
    await prisma.kyads_click_task_items
      .update({ where: { id: itemId }, data: { status: 'success', exit_ip: r.exitIp, duration_ms: duration } })
      .catch(() => {})
    await prisma.kyads_click_tasks.update({ where: { id: rt.taskId }, data: { done_count: { increment: 1 } } }).catch(() => {})
    return { ok: true }
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
    await resolveAlertsByType(task.user_id, task.campaign_id, ['low_stock', 'replenish_failed', 'invalid_link'])
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

    if (candidates.length === 0) return { executed: 0, succeeded: 0, failed: 0, tasksFinalized: 0 }

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

    // 5. 收尾已完成的任务
    for (const key of taskKeys) {
      if (await finalizeTask(BigInt(key))) tasksFinalized++
    }
  } catch (err) {
    console.error('[click-brush] executeClickTaskItems error:', err instanceof Error ? err.message : err)
  }

  return { executed, succeeded, failed, tasksFinalized }
}
