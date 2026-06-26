import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'
import { replenishCampaign, triggerReplenishAsync } from '@/lib/suffix-engine/stock-producer'
import { startBrushTask, startBrushAllTasks } from '@/lib/suffix-engine/click-brush'
import { syncUserLinks } from '@/lib/suffix-engine/link-sync'
import { STOCK_CONFIG } from '@/lib/suffix-engine/config'

interface ActionBody {
  action: 'replenish' | 'replenishAll' | 'toggle' | 'brushClicks' | 'brushAll' | 'syncLinks'
  campaignId?: string
  enabled?: boolean
  count?: number
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })
  const userId = BigInt(user.userId)

  let body: ActionBody
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }

  // 单系列补货（同步等待，给用户即时结果）
  if (body.action === 'replenish') {
    if (!body.campaignId) return NextResponse.json({ code: -1, message: '缺少 campaignId' }, { status: 400 })
    const campaignId = BigInt(body.campaignId)
    const owns = await prisma.campaigns.findFirst({
      where: { id: campaignId, user_id: userId, is_deleted: 0 },
      select: { id: true },
    })
    if (!owns) return NextResponse.json({ code: -1, message: '广告系列不存在或无权限' }, { status: 404 })

    const result = await replenishCampaign(campaignId, { force: true })
    return NextResponse.json({ code: 0, data: result })
  }

  // 全部低库存补货（异步触发，避免长时间阻塞请求）
  if (body.action === 'replenishAll') {
    const campaigns = await prisma.campaigns.findMany({
      where: { user_id: userId, status: 'active', is_deleted: 0, suffix_exchange_enabled: 1 },
      select: { id: true },
    })
    let queued = 0
    for (const c of campaigns) {
      const available = await prisma.suffix_pool.count({
        where: { campaign_id: c.id, status: 'available', is_deleted: 0 },
      })
      if (available <= STOCK_CONFIG.LOW_WATERMARK) {
        triggerReplenishAsync(c.id, { force: true })
        queued++
      }
    }
    return NextResponse.json({ code: 0, data: { queued } })
  }

  // 刷点击：后台为该系列生成 N 次点击（=N 条 suffix 入库存池），进度走 kyads_click_tasks
  if (body.action === 'brushClicks') {
    if (!body.campaignId) return NextResponse.json({ code: -1, message: '缺少 campaignId' }, { status: 400 })
    const count = Number(body.count)
    if (!Number.isFinite(count) || count < 1) {
      return NextResponse.json({ code: -1, message: '点击数须为不小于 1 的整数' }, { status: 400 })
    }
    const result = await startBrushTask(BigInt(body.campaignId), userId, count)
    if (!result.ok) return NextResponse.json({ code: -1, message: result.message }, { status: 400 })
    return NextResponse.json({ code: 0, data: { taskId: result.taskId, target: result.target } })
  }

  // 一次性刷点击：为所有已启用换链、已匹配商家的广告系列各刷 N 次
  if (body.action === 'brushAll') {
    const count = Number(body.count)
    if (!Number.isFinite(count) || count < 1) {
      return NextResponse.json({ code: -1, message: '点击数须为不小于 1 的整数' }, { status: 400 })
    }
    const result = await startBrushAllTasks(userId, count)
    return NextResponse.json({ code: 0, data: result })
  }

  // 手动同步链接：为已启用广告系列关联、缺上级联盟/未校验的商家后台跑解析+校验
  if (body.action === 'syncLinks') {
    const { queued } = await syncUserLinks(userId)
    return NextResponse.json({ code: 0, data: { queued } })
  }

  // 开关单系列换链
  if (body.action === 'toggle') {
    if (!body.campaignId) return NextResponse.json({ code: -1, message: '缺少 campaignId' }, { status: 400 })
    const campaignId = BigInt(body.campaignId)
    const owns = await prisma.campaigns.findFirst({
      where: { id: campaignId, user_id: userId, is_deleted: 0 },
      select: { id: true },
    })
    if (!owns) return NextResponse.json({ code: -1, message: '广告系列不存在或无权限' }, { status: 404 })
    await prisma.campaigns.update({
      where: { id: campaignId },
      data: { suffix_exchange_enabled: body.enabled ? 1 : 0 },
    })
    return NextResponse.json({ code: 0, data: { campaignId: body.campaignId, enabled: !!body.enabled } })
  }

  return NextResponse.json({ code: -1, message: '未知操作' }, { status: 400 })
}
