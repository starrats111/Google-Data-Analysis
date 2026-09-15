import { NextRequest, NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/auth'
import { generateOneSuffix } from '@/lib/suffix-engine/suffix-generator'
import { isSameUrl } from '@/lib/link-resolver/tracker'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// POST /api/user/link-exchange/fetch-link
// 「取链接」工具：输入联盟链接 + 选择国家 → 用该国动态住宅代理(kookeey)跟随整条跳转，
// 返回最终落地页完整 URL（含追踪参数）。不入库存、不换链，仅单次解析用于复制。
// 复用换链接同一套解析器（resolveAffiliateLink 内部强制 exchange:true → 只走 kookeey）。
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  let body: { affiliateUrl?: string; country?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }

  const affiliateUrl = (body.affiliateUrl || '').trim()
  const country = (body.country || '').trim().toUpperCase()

  if (!/^https?:\/\//i.test(affiliateUrl)) {
    return NextResponse.json({ code: -1, message: '请填写有效的 http(s) 联盟链接' }, { status: 400 })
  }
  // 任意 2 位 ISO 国家代码均放行（不限于内置国家列表）；kookeey 无该国出口时会以跟链失败返回
  if (!/^[A-Z]{2}$/.test(country)) {
    return NextResponse.json({ code: -1, message: '请输入 2 位国家代码，如 US、ES、DE' }, { status: 400 })
  }

  // 不传 campaignId → 不做出口 IP 去重、不写库存；仅按国家取 kookeey 出口跟链一次。
  // D-334 interactive：人正在页面上等 → 浏览器兜底的 exchange 槽位插到 cron 等待者前面。
  const r = await generateOneSuffix(affiliateUrl, country, null, {
    userId: BigInt(user.userId),
    interactive: true,
  })

  if (r.ok) {
    return NextResponse.json({
      code: 0,
      data: { finalUrl: r.finalUrl, suffix: r.suffix, exitIp: r.exitIp, hasTracking: true },
    })
  }

  // 跟到落地页但页面无追踪参数：仍返回最终 URL 供参考，前端提示「未检出追踪参数」。
  if (r.reason === 'no_tracking' && r.finalUrl) {
    // D-337B：整条链一步没跳、终点就是输入本身 → 用户填的是商家官网，不是联盟追踪链接。
    // 官网没有联盟跳板，点击压根不会登记，永远取不到参数，重试多少次都一样。
    // 2026-09-15 yz08、09-14 wj10 两天内各犯一次（后者还入了库，导致该系列被误报链接失效），
    // 而当时的提示只有笼统的「请确认链接是否正确」，看不出错在哪。故这种情形单列。
    //
    // 判定用「终点 === 输入」而不是数跳转次数：resolver 没把跳转数回传到这一层，
    // 加字段要动 resolveAffiliateLink 的返回契约，而「原样返回」这个信号已经够准
    // （真联盟链接必然至少跳一次到广告主域名）。
    //
    // 复用 tracker 的 isSameUrl：它只把「同一个 URL 的等价写法」算作相同
    // （域名大小写、末尾斜杠、hash），而 http↔https、加 www、路径大小写变化、
    // 多出查询串都算不同——这些差异意味着真发生过跳转，此时不该说「没有任何跳转」。
    const looksLikeMerchantSite = isSameUrl(r.finalUrl, affiliateUrl.trim())
    return NextResponse.json({
      code: 0,
      data: { finalUrl: r.finalUrl, suffix: null, exitIp: null, hasTracking: false, looksLikeMerchantSite },
    })
  }

  const msg =
    r.reason === 'forbidden_network'
      ? `命中上级联盟黑名单，无法跟链：${r.error}`
      : r.reason === 'timeout'
        ? '跟链超时，请重试或更换国家'
        : // D-231：本机开不出浏览器，本轮没验过这条链接，别让人以为链接有问题
          r.reason === 'local_resource'
          ? '系统当前繁忙，暂时没能启动浏览器跟这条链接（不是链接的问题），请稍后重试'
          : `跟链失败：${r.error}`
  return NextResponse.json({ code: -1, message: msg }, { status: 200 })
}
