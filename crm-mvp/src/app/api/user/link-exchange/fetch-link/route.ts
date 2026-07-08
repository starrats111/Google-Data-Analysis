import { NextRequest, NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/auth'
import { generateOneSuffix } from '@/lib/suffix-engine/suffix-generator'
import { ALL_COUNTRIES } from '@/lib/constants'

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
  if (!/^[A-Z]{2}$/.test(country) || !ALL_COUNTRIES.some((c) => c.code === country)) {
    return NextResponse.json({ code: -1, message: '请选择有效的投放国家' }, { status: 400 })
  }

  // 不传 campaignId → 不做出口 IP 去重、不写库存；仅按国家取 kookeey 出口跟链一次。
  const r = await generateOneSuffix(affiliateUrl, country, null, { userId: BigInt(user.userId) })

  if (r.ok) {
    return NextResponse.json({
      code: 0,
      data: { finalUrl: r.finalUrl, suffix: r.suffix, exitIp: r.exitIp, hasTracking: true },
    })
  }

  // 跟到落地页但页面无追踪参数：仍返回最终 URL 供参考，前端提示「未检出追踪参数」。
  if (r.reason === 'no_tracking' && r.finalUrl) {
    return NextResponse.json({
      code: 0,
      data: { finalUrl: r.finalUrl, suffix: null, exitIp: null, hasTracking: false },
    })
  }

  const msg =
    r.reason === 'forbidden_network'
      ? `命中上级联盟黑名单，无法跟链：${r.error}`
      : r.reason === 'timeout'
        ? '跟链超时，请重试或更换国家'
        : `跟链失败：${r.error}`
  return NextResponse.json({ code: -1, message: msg }, { status: 200 })
}
