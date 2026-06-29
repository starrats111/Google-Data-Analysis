import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'
import { replenishCampaign, triggerReplenishAsync } from '@/lib/suffix-engine/stock-producer'
import { startBrushTask, startBrushAllTasks } from '@/lib/suffix-engine/click-brush'
import { syncUserLinks, resolveMerchantNow } from '@/lib/suffix-engine/link-sync'
import { resolveAlertsByType } from '@/lib/suffix-engine/alerts'
import { ensureCampaignMerchant } from '@/lib/campaign-merchant-link'
import { STOCK_CONFIG } from '@/lib/suffix-engine/config'

interface ActionBody {
  action: 'replenish' | 'replenishAll' | 'toggle' | 'brushClicks' | 'brushAll' | 'syncLinks' | 'updateLink' | 'setClickControl'
  campaignId?: string
  enabled?: boolean
  count?: number
  trackingLink?: string
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

  // 需求2：用户级开关「订单/点击比自动补刷点击」
  if (body.action === 'setClickControl') {
    await prisma.users.update({
      where: { id: userId },
      data: { click_control_enabled: body.enabled ? 1 : 0 },
    })
    return NextResponse.json({ code: 0, data: { clickControlEnabled: !!body.enabled } })
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

  // 手动填写/编辑商家追踪链接 → 重置校验状态并即时巡航验证（超时则后台继续）
  if (body.action === 'updateLink') {
    if (!body.campaignId) return NextResponse.json({ code: -1, message: '缺少 campaignId' }, { status: 400 })
    const link = (body.trackingLink || '').trim()
    if (!/^https?:\/\//i.test(link)) {
      return NextResponse.json({ code: -1, message: '请填写有效的 http(s) 链接' }, { status: 400 })
    }
    const campaign = await prisma.campaigns.findFirst({
      where: { id: BigInt(body.campaignId), user_id: userId, is_deleted: 0 },
      select: { id: true, user_merchant_id: true, campaign_name: true, target_country: true },
    })
    if (!campaign) return NextResponse.json({ code: -1, message: '广告系列不存在或无权限' }, { status: 404 })

    // 解析当前关联商家。孤儿（user_merchant_id>0 但商家行已删）/ 未匹配（=0）走自愈分支：
    // 按系列名解析「平台-MID」自动接回或新建商家，再写链接——对应「手动填入即完成自愈」，
    // 不再用「未匹配商家，无法直接填写链接」把人挡在门外。
    const merchantId = await ensureCampaignMerchant(userId, campaign)
    if (!merchantId) {
      return NextResponse.json(
        { code: -1, message: '该广告系列名无法解析出商家（平台-MID），无法自动关联，请检查系列命名后重试' },
        { status: 400 },
      )
    }

    // 写入新链接并重置校验/上级联盟状态，等待重新巡航
    await prisma.user_merchants.update({
      where: { id: merchantId },
      data: {
        tracking_link: link,
        tracking_status: 'unchecked',
        link_status: 'unchecked',
        parent_network: null,
        parent_blacklisted: 0,
        parent_checked_at: null,
        parent_check_reason: null,
      },
    })

    // 手动补链接即视为该系列「断链问题」已处理：清掉遗留的 merchant_not_found 告警
    await resolveAlertsByType(userId, campaign.id, ['merchant_not_found'])

    // 即时巡航验证（最多 ~35s）：成功即返回状态；超时则后台继续，前端稍后刷新
    const result = await Promise.race([
      resolveMerchantNow(merchantId, userId),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 35000)),
    ])
    // 验证后顺带触发该系列补货（链接可用即开始蓄库存）
    triggerReplenishAsync(BigInt(body.campaignId), { force: true })

    if (result === 'timeout') {
      return NextResponse.json({ code: 0, data: { saved: true, validating: true } })
    }
    return NextResponse.json({
      code: 0,
      data: { saved: true, trackingStatus: result?.trackingStatus ?? null, parentNetwork: result?.parentNetwork ?? null },
    })
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
    // 「只同步数据、不参与换链接」的用户（如 jy 交垟队）不允许开启换链
    if (body.enabled) {
      const u = await prisma.users.findUnique({ where: { id: userId }, select: { link_exchange_disabled: true } })
      if (u?.link_exchange_disabled === 1) {
        return NextResponse.json({ code: -1, message: '该账号仅同步数据，未开放换链接功能' }, { status: 403 })
      }
    }
    await prisma.campaigns.update({
      where: { id: campaignId },
      data: { suffix_exchange_enabled: body.enabled ? 1 : 0 },
    })
    return NextResponse.json({ code: 0, data: { campaignId: body.campaignId, enabled: !!body.enabled } })
  }

  return NextResponse.json({ code: -1, message: '未知操作' }, { status: 400 })
}
