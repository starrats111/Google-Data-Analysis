import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'
import { getAlertSummary } from '@/lib/suffix-engine/alerts'
import { STOCK_CONFIG } from '@/lib/suffix-engine/config'

// Campaign 名称解析：格式 XXX-PLATFORM-品牌-国家-日期-MID
const VALID_NETWORKS = ['RW', 'LH', 'PM', 'LB', 'CG', 'CF', 'BSH', 'TJ', 'AW']

function parseCampaignName(name: string): { platform: string; mid: string; parsed: boolean } {
  if (!name) return { platform: '', mid: '', parsed: false }
  const parts = name.split('-')
  if (parts.length < 3) return { platform: '', mid: '', parsed: false }
  const platform = parts[1].trim().toUpperCase().replace(/[0-9]+$/, '')
  const mid = parts[parts.length - 1].trim()
  const valid = VALID_NETWORKS.includes(platform) && mid.length > 0
  return { platform: valid ? platform : '', mid: valid ? mid : '', parsed: valid }
}

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  const userId = BigInt(user.userId)

  const campaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, status: 'active', is_deleted: 0 },
    select: {
      id: true,
      google_campaign_id: true,
      campaign_name: true,
      target_country: true,
      suffix_exchange_enabled: true,
      suffix_last_apply_at: true,
      suffix_last_content: true,
    },
    orderBy: { campaign_name: 'asc' },
  })

  const parsed = campaigns.map((c) => ({ ...c, ...parseCampaignName(c.campaign_name ?? '') }))
  const mids = [...new Set(parsed.filter((p) => p.parsed).map((p) => p.mid))]
  const platforms = [...new Set(parsed.filter((p) => p.parsed).map((p) => p.platform))]

  const merchants =
    mids.length > 0
      ? await prisma.user_merchants.findMany({
          where: { user_id: userId, merchant_id: { in: mids }, platform: { in: platforms }, is_deleted: 0 },
          select: {
            id: true,
            merchant_id: true,
            platform: true,
            merchant_name: true,
            tracking_link: true,
            link_status: true,
            link_check_reason: true,
          },
        })
      : []
  const merchantMap = new Map(merchants.map((m) => [`${m.platform}:${m.merchant_id}`, m]))

  // 按 campaign_id + status 统计库存
  const campaignIds = campaigns.map((c) => c.id)
  const stockRows =
    campaignIds.length > 0
      ? await prisma.suffix_pool.groupBy({
          by: ['campaign_id', 'status'],
          where: { campaign_id: { in: campaignIds }, is_deleted: 0 },
          _count: { _all: true },
        })
      : []
  const stockMap = new Map<string, { available: number; leased: number; consumed: number }>()
  for (const r of stockRows) {
    const key = r.campaign_id.toString()
    const cur = stockMap.get(key) ?? { available: 0, leased: 0, consumed: 0 }
    if (r.status === 'available') cur.available = r._count._all
    else if (r.status === 'leased') cur.leased = r._count._all
    else if (r.status === 'consumed') cur.consumed = r._count._all
    stockMap.set(key, cur)
  }

  const rows = parsed.map((c) => {
    const merchant = merchantMap.get(`${c.platform}:${c.mid}`) ?? null
    const stock = stockMap.get(c.id.toString()) ?? { available: 0, leased: 0, consumed: 0 }
    return {
      campaignId: c.id.toString(),
      googleCampaignId: c.google_campaign_id,
      campaignName: c.campaign_name,
      country: c.target_country,
      platform: c.platform,
      mid: c.mid,
      matched: !!merchant,
      merchantId: merchant?.id.toString() ?? null,
      merchantName: merchant?.merchant_name ?? null,
      trackingLink: merchant?.tracking_link ?? null,
      linkStatus: merchant?.link_status ?? 'unchecked',
      linkCheckReason: merchant?.link_check_reason ?? null,
      suffixEnabled: c.suffix_exchange_enabled === 1,
      lastApplyAt: c.suffix_last_apply_at,
      lastSuffix: c.suffix_last_content,
      stock,
      lowStock: stock.available <= STOCK_CONFIG.LOW_WATERMARK,
    }
  })

  const apiKeyRecord = await prisma.users.findUnique({
    where: { id: userId },
    select: { script_api_key: true },
  })

  const { summary: alertSummary, totalOpen } = await getAlertSummary(userId)

  const totalAvailable = rows.reduce((s, r) => s + r.stock.available, 0)
  const lowStockCount = rows.filter((r) => r.matched && r.suffixEnabled && r.lowStock).length

  return NextResponse.json({
    code: 0,
    data: {
      rows,
      apiKey: apiKeyRecord?.script_api_key ?? null,
      summary: {
        total: rows.length,
        matched: rows.filter((r) => r.matched).length,
        totalAvailable,
        lowStockCount,
        alertOpen: totalOpen,
      },
      alertSummary,
      stockConfig: { target: STOCK_CONFIG.TARGET_STOCK, lowWatermark: STOCK_CONFIG.LOW_WATERMARK },
    },
  })
}
