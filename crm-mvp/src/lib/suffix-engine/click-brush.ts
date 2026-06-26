/**
 * 换链接「刷点击」引擎
 *
 * 在本架构里，一次「点击」= 通过住宅代理访问商家联盟追踪链接并跟随整条跳转，
 * 联盟平台据此注册一次真实点击并返回新的 clickid，最终落地页 query 即一条可用 suffix。
 * 因此「刷 N 次点击」= 后台为该广告系列生成 N 条 suffix 进入库存池（顺带补足换链库存）。
 *
 * 进度复用既有 kyads_click_tasks 表（target_count / done_count / status），前端轮询展示。
 * 实际生成逻辑复用 suffix-generator.generateOneSuffix（与补货引擎同源）。
 */

import { prisma } from '@/lib/prisma'
import { STOCK_CONFIG } from './config'
import { generateOneSuffix } from './suffix-generator'
import { raiseAlert, resolveAlertsByType } from './alerts'

/** 单次刷点击允许的最大次数（低配生产机保护） */
export const MAX_BRUSH = 1000

/** 简单并发限制器 */
async function runWithConcurrency(
  count: number,
  limit: number,
  worker: () => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, count) }, async () => {
    while (true) {
      const i = next++
      if (i >= count) break
      await worker()
    }
  })
  await Promise.all(runners)
}

export interface BrushStartResult {
  ok: true
  taskId: string
  target: number
}
export interface BrushStartError {
  ok: false
  message: string
}

/**
 * 创建刷点击任务（同步建任务后立即返回 taskId 供前端展示进度），
 * 实际生成由 runBrushTask fire-and-forget 后台执行。
 */
export async function startBrushTask(
  campaignId: bigint,
  userId: bigint,
  count: number,
): Promise<BrushStartResult | BrushStartError> {
  const n = Math.min(Math.max(Math.floor(count) || 0, 1), MAX_BRUSH)

  const campaign = await prisma.campaigns.findFirst({
    where: { id: campaignId, user_id: userId, is_deleted: 0 },
    select: { id: true, user_merchant_id: true, suffix_exchange_enabled: true },
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

  // fire-and-forget 后台执行（PM2 常驻进程，与 triggerReplenishAsync 同模式）
  runBrushTask(task.id).catch((err) => {
    console.error('[click-brush] run failed:', task.id.toString(), err instanceof Error ? err.message : err)
  })

  return { ok: true, taskId: task.id.toString(), target: n }
}

export interface BrushAllResult {
  queued: number
  skipped: number
  total: number
}

/**
 * 一次性为「该用户所有已启用换链、已匹配带追踪链接商家」的广告系列批量创建刷点击任务。
 * 每个系列各 count 次；已有进行中任务/无追踪链接的自动跳过。各任务 fire-and-forget 后台执行。
 */
export async function startBrushAllTasks(userId: bigint, count: number): Promise<BrushAllResult> {
  const n = Math.min(Math.max(Math.floor(count) || 0, 1), MAX_BRUSH)

  // 仅真正投放（有 gcid）、active+ENABLED、已开换链开关的系列
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

/** 后台执行刷点击任务：循环生成 suffix 入库存池并更新进度 */
export async function runBrushTask(taskId: bigint): Promise<void> {
  const task = await prisma.kyads_click_tasks.findUnique({ where: { id: taskId } })
  if (!task || task.status === 'done' || task.status === 'failed') return

  const campaign = await prisma.campaigns.findFirst({
    where: { id: task.campaign_id, is_deleted: 0 },
    select: { id: true, user_id: true, user_merchant_id: true, target_country: true, campaign_name: true },
  })
  if (!campaign) {
    await prisma.kyads_click_tasks.update({
      where: { id: taskId },
      data: { status: 'failed', error_message: 'campaign_not_found', finished_at: new Date() },
    })
    return
  }

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
    select: { id: true, platform: true },
  })

  const affiliateUrl = task.affiliate_url
  const country = campaign.target_country
  const platform = merchant?.platform ?? null
  const target = task.target_count
  const cid = campaign.id.toString()

  const existingSuffixes = new Set(
    (
      await prisma.suffix_pool.findMany({
        where: { campaign_id: campaign.id, status: 'available', is_deleted: 0 },
        select: { suffix_content: true },
      })
    ).map((r) => r.suffix_content),
  )

  let done = 0
  let failed = 0
  let lastError: string | null = null
  let consecutiveFail = 0
  let aborted = false

  const persist = async (suffix: string): Promise<void> => {
    if (existingSuffixes.has(suffix)) return
    existingSuffixes.add(suffix)
    await prisma.suffix_pool.create({
      data: {
        user_id: campaign.user_id,
        campaign_id: campaign.id,
        suffix_content: suffix,
        status: 'available',
        source_merchant_id: merchant?.id ?? null,
      },
    })
  }

  const flushProgress = async () => {
    await prisma.kyads_click_tasks.update({ where: { id: taskId }, data: { done_count: done } }).catch(() => {})
  }

  // ── probe：先探一条，失败立即熔断并告警 ──
  const probe = await generateOneSuffix(affiliateUrl, country, platform, { userId: campaign.user_id })
  if (!probe.ok) {
    await raiseAlert(campaign.user_id, {
      type: 'invalid_link',
      campaignId: campaign.id,
      level: 'error',
      message: `广告系列「${campaign.campaign_name ?? cid}」刷点击失败：${probe.error}`,
      context: { affiliateUrl: affiliateUrl.slice(0, 300), reason: probe.reason, finalUrl: probe.finalUrl ?? null },
    })
    await prisma.kyads_click_tasks.update({
      where: { id: taskId },
      data: { status: 'failed', error_message: probe.error.slice(0, 500), finished_at: new Date() },
    })
    return
  }
  await persist(probe.suffix)
  done++
  await flushProgress()

  // ── batch：成功后批量生成剩余 ──
  const remaining = target - 1
  if (remaining > 0) {
    await runWithConcurrency(remaining, STOCK_CONFIG.CONCURRENCY, async () => {
      if (aborted) return
      const r = await generateOneSuffix(affiliateUrl, country, platform, { userId: campaign.user_id })
      if (r.ok) {
        consecutiveFail = 0
        await persist(r.suffix)
        done++
        await flushProgress()
      } else {
        failed++
        lastError = r.error
        consecutiveFail++
        if (consecutiveFail >= STOCK_CONFIG.CIRCUIT_FAIL_THRESHOLD) aborted = true
      }
    })
  }

  await prisma.kyads_click_tasks.update({
    where: { id: taskId },
    data: {
      done_count: done,
      status: done > 0 ? 'done' : 'failed',
      error_message: done > 0 ? null : (lastError ?? '全部失败').slice(0, 500),
      finished_at: new Date(),
    },
  })

  if (done > 0) {
    await resolveAlertsByType(campaign.user_id, campaign.id, ['low_stock', 'replenish_failed', 'invalid_link'])
  } else {
    await raiseAlert(campaign.user_id, {
      type: 'replenish_failed',
      campaignId: campaign.id,
      level: 'error',
      message: `广告系列「${campaign.campaign_name ?? cid}」刷点击全部失败（尝试 ${failed} 次）：${lastError ?? '未知原因'}`,
      context: { affiliateUrl: affiliateUrl.slice(0, 300), country },
    })
  }
}
