import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getScriptUserFromRequest } from '@/lib/script-auth'

interface LookupCampaign {
  campaignId: string
  networkShortName: string
  mid: string
  finalUrl?: string
}

export async function POST(req: NextRequest) {
  const scriptUser = await getScriptUserFromRequest(req)
  if (!scriptUser) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: '无效的 API Key' } }, { status: 401 })
  }

  let body: { campaigns?: LookupCampaign[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: { code: 'BAD_REQUEST', message: '请求体解析失败' } }, { status: 400 })
  }

  const campaigns: LookupCampaign[] = body.campaigns ?? []
  if (!Array.isArray(campaigns) || campaigns.length === 0) {
    return NextResponse.json({ success: true, campaignResults: {}, stats: { total: 0, found: 0, notFound: 0 } })
  }

  const campaignResults: Record<string, { campaignId: string; found: boolean; trackingUrl: string | null }> = {}
  let found = 0
  let notFound = 0

  await Promise.all(
    campaigns.map(async (c) => {
      const { campaignId, networkShortName, mid } = c
      if (!campaignId || !networkShortName || !mid) {
        campaignResults[campaignId] = { campaignId, found: false, trackingUrl: null }
        notFound++
        return
      }

      // 通过 merchant_id（=mid）和 platform（=networkShortName）从 user_merchants 查联盟链接
      const merchant = await prisma.user_merchants.findFirst({
        where: {
          user_id: scriptUser.userId,
          merchant_id: mid,
          platform: networkShortName,
          is_deleted: 0,
        },
        select: { tracking_link: true },
      })

      if (merchant?.tracking_link) {
        campaignResults[campaignId] = { campaignId, found: true, trackingUrl: merchant.tracking_link }
        found++
      } else {
        campaignResults[campaignId] = { campaignId, found: false, trackingUrl: null }
        notFound++
      }
    })
  )

  return NextResponse.json({
    success: true,
    campaignResults,
    stats: { total: campaigns.length, found, notFound },
  })
}
