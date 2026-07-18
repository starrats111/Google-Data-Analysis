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
  action: 'replenish' | 'replenishAll' | 'toggle' | 'brushClicks' | 'brushAll' | 'syncLinks' | 'updateLink' | 'setClickControl' | 'setScriptInterval' | 'recheckLink'
  campaignId?: string
  enabled?: boolean
  count?: number
  trackingLink?: string
  ratioMinPct?: number
  ratioMaxPct?: number
  loopIntervalSeconds?: number | null
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
    const data: { click_control_enabled?: number; click_control_ratio_min_pct?: number; click_control_ratio_max_pct?: number } = {}
    if (typeof body.enabled === 'boolean') data.click_control_enabled = body.enabled ? 1 : 0
    // 转化率(订单/点击)区间，单位 %。校验：1~100 整数且 min<max
    if (body.ratioMinPct != null || body.ratioMaxPct != null) {
      const minPct = Math.round(Number(body.ratioMinPct))
      const maxPct = Math.round(Number(body.ratioMaxPct))
      if (!Number.isFinite(minPct) || !Number.isFinite(maxPct) || minPct < 1 || maxPct > 100 || minPct >= maxPct) {
        return NextResponse.json({ code: -1, message: '转化率区间不合法（需 1~100 且下限<上限）' }, { status: 400 })
      }
      data.click_control_ratio_min_pct = minPct
      data.click_control_ratio_max_pct = maxPct
    }
    if (Object.keys(data).length === 0) return NextResponse.json({ code: -1, message: '无更新内容' }, { status: 400 })
    await prisma.users.update({ where: { id: userId }, data })
    return NextResponse.json({ code: 0, data: { clickControlEnabled: data.click_control_enabled === 1 } })
  }

  // 用户自助调节「换链脚本轮询间隔(秒)」：脚本下一轮启动经 /api/v1/suffix/script-config 读取生效，无需重发脚本
  if (body.action === 'setScriptInterval') {
    // null/0 → 恢复默认（用 NULL 落库，接口回退默认15）
    if (body.loopIntervalSeconds == null || Number(body.loopIntervalSeconds) === 0) {
      await prisma.users.update({ where: { id: userId }, data: { script_loop_interval_seconds: null } })
      return NextResponse.json({ code: 0, data: { loopIntervalSeconds: null } })
    }
    const sec = Math.round(Number(body.loopIntervalSeconds))
    // 合理范围：10~120 秒（过小会增加 Google Ads 脚本压力/配额，过大失去意义）
    if (!Number.isFinite(sec) || sec < 10 || sec > 120) {
      return NextResponse.json({ code: -1, message: '轮询间隔须为 10~120 秒的整数（留空恢复默认15）' }, { status: 400 })
    }
    await prisma.users.update({ where: { id: userId }, data: { script_loop_interval_seconds: sec } })
    return NextResponse.json({ code: 0, data: { loopIntervalSeconds: sec } })
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

  // D-178 告警处理通道：「重验」——员工处理 invalid_link/replenish_failed 告警的动作入口。
  // 清 D-177 失败计数与冷却 → force 补货（同步等待）→ 把 D-177 三态结论翻译成员工能看懂的话返回。
  // 重验通过/活链判定会自动 resolve 该系列的 invalid_link 告警（stock-producer 已有逻辑）。
  if (body.action === 'recheckLink') {
    if (!body.campaignId) return NextResponse.json({ code: -1, message: '缺少 campaignId' }, { status: 400 })
    const campaignId = BigInt(body.campaignId)
    const owns = await prisma.campaigns.findFirst({
      where: { id: campaignId, user_id: userId, is_deleted: 0 },
      select: { id: true },
    })
    if (!owns) return NextResponse.json({ code: -1, message: '广告系列不存在或无权限' }, { status: 404 })

    // 员工主动重验 = 从零开始判定：清连续失败计数与冷却（force 补货本就穿透冷却，这里清计数避免旧账累加）
    await prisma.campaigns.update({
      where: { id: campaignId },
      data: { suffix_fail_count: 0, suffix_cooldown_until: null },
    })

    // 小目标快速验证：只补到「现有库存+2」，避免同步等整轮补 20 条把请求拖到超时——
    // 重验要的是当场结论（probe 成败），库存缺口交给后续 cron 正常补
    const available = await prisma.suffix_pool.count({
      where: { campaign_id: campaignId, status: 'available', is_deleted: 0 },
    })
    const r = await replenishCampaign(campaignId, { force: true, target: available + 2 })

    // 翻译成员工可执行的结论
    let verdict: 'ok' | 'alive' | 'dead' | 'proxy' | 'other'
    let advice: string
    if (r.generated > 0 || r.reason === 'static_suffix') {
      verdict = 'ok'
      advice = `重验通过，链接可用，已补货 ${r.generated} 条（库存 ${r.after}），相关告警已自动解除。`
    } else if (r.reason === 'alive_no_tracking') {
      verdict = 'alive'
      advice = '链接活着：已跟到商家官网，只是本次没拿到追踪参数（多为需浏览器执行 JS）。系统会自动重试，无需换链接；若持续无产出再考虑更换。'
    } else if (r.reason === 'proxy_unavailable') {
      verdict = 'proxy'
      advice = '代理暂不可用（流量耗尽或熔断中），这不是链接问题。请先到本页顶部查看 kookeey 剩余流量，稍后再点重验。'
    } else if (r.reason === 'probe_failed') {
      verdict = 'dead'
      advice = `重验仍失败：${r.probeError ?? '未跟到商家落地页'}${r.probeFinalUrl ? `（实际落到 ${r.probeFinalUrl.slice(0, 120)}）` : ''}。请到联盟平台后台重新生成该商家的追踪链接，然后点告警行的「换链接」按钮替换，保存后会自动验证。`
    } else if (r.reason === 'tracker_forbidden') {
      verdict = 'dead'
      advice = `联盟跳板明确拒绝该追踪链接（${r.probeError ?? 'HTTP 4xx'}）——token 已失效/被联盟停用，等系统自愈无用。请到联盟平台后台重新生成该商家的追踪链接，然后点告警行的「换链接」按钮替换，保存后会自动验证。`
    } else {
      verdict = 'other'
      advice = `未完成重验（${r.reason ?? '未知原因'}），请稍后重试；若反复出现请联系管理员。`
    }
    return NextResponse.json({ code: 0, data: { verdict, advice, result: r } })
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
      select: { id: true, user_merchant_id: true, campaign_name: true, target_country: true, platform_connection_id: true },
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

    // 手动重填即以新链接为准，必须清掉可能盖住 tracking_link 的「冻结链接」：
    //   - campaign_link（历史同步冻结的落地链接）
    //   - connection_campaign_links 里本广告归属账号(platform_connection_id)的项
    // 否则 pickCampaignAffiliateLink 仍优先返回旧冻结链接，用户重填不生效
    // （FC-Moto/xcaret 类「落地无追踪参数」误报根因）。只删本账号的项，不动同商家其他账号链接。
    let cleanedConnLinks: Record<string, string> | undefined = undefined
    const connKey = campaign.platform_connection_id?.toString()
    if (connKey) {
      const cur = await prisma.user_merchants.findUnique({
        where: { id: merchantId },
        select: { connection_campaign_links: true },
      })
      const raw = cur?.connection_campaign_links
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && connKey in (raw as Record<string, string>)) {
        const obj = { ...(raw as Record<string, string>) }
        delete obj[connKey]
        cleanedConnLinks = obj
      }
    }

    // 写入新链接并重置校验/上级联盟状态，等待重新巡航
    await prisma.user_merchants.update({
      where: { id: merchantId },
      data: {
        tracking_link: link,
        campaign_link: null,
        ...(cleanedConnLinks !== undefined ? { connection_campaign_links: cleanedConnLinks } : {}),
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

    // D-178：换了新链接 = 旧链接的失败历史作废，立即清 D-177 失败计数与冷却，
    // 让新链接马上参与验证/补货，不用干等最长 8h 的疑似死链冷却到期。
    await prisma.campaigns.update({
      where: { id: campaign.id },
      data: { suffix_fail_count: 0, suffix_cooldown_until: null },
    })

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
