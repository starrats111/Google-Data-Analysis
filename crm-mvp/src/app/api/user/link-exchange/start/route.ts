import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'

const VALID_NETWORKS = ['RW', 'LH', 'PM', 'LB', 'CG', 'CF', 'BSH', 'TJ', 'AW']

function parseMid(name: string): { platform: string; mid: string; parsed: boolean } {
  if (!name) return { platform: '', mid: '', parsed: false }
  const parts = name.split('-')
  if (parts.length < 3) return { platform: '', mid: '', parsed: false }
  const platform = parts[1].trim().toUpperCase().replace(/[0-9]+$/, '')
  const mid = parts[parts.length - 1].trim()
  const valid = VALID_NETWORKS.includes(platform) && mid.length > 0
  return { platform: valid ? platform : '', mid: valid ? mid : '', parsed: valid }
}

// POST /api/user/link-exchange/start
// Body: { clickCount: number }
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ code: -1, message: 'Not Found' }, { status: 404 })
  }
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  const userId = BigInt(user.userId)

  let body: { clickCount?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }

  const clickCount = Number(body.clickCount)
  if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 10000) {
    return NextResponse.json({ code: -1, message: '点击数须为 1-10000 的整数' }, { status: 400 })
  }

  // 1. 更新用户默认点击数
  await prisma.users.update({
    where: { id: userId },
    data: { link_exchange_click_count: clickCount },
  })

  // 2. 查出所有已启用广告系列
  const campaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, status: 'active', suffix_exchange_enabled: 1, is_deleted: 0 },
    select: { id: true, campaign_name: true },
  })

  if (campaigns.length === 0) {
    return NextResponse.json({ code: 0, data: { created: 0, skipped: 0, message: '无已启用的广告系列' } })
  }

  // 3. 解析 mid/platform，批量查匹配商家
  const parsed = campaigns.map((c) => ({ ...c, ...parseMid(c.campaign_name ?? '') }))
  const mids = [...new Set(parsed.filter((p) => p.parsed).map((p) => p.mid))]
  const platforms = [...new Set(parsed.filter((p) => p.parsed).map((p) => p.platform))]

  const merchants =
    mids.length > 0
      ? await prisma.user_merchants.findMany({
          where: { user_id: userId, merchant_id: { in: mids }, platform: { in: platforms }, is_deleted: 0 },
          select: { merchant_id: true, platform: true, tracking_link: true, kyads_referer_url: true },
        })
      : []

  const merchantMap = new Map(merchants.map((m) => [`${m.platform}:${m.merchant_id}`, m]))

  // 4. 为每个已匹配且有 tracking_link 的 campaign 创建任务
  const now = new Date()
  let created = 0
  let skipped = 0

  for (const c of parsed) {
    if (!c.parsed) { skipped++; continue }
    const merchant = merchantMap.get(`${c.platform}:${c.mid}`)
    if (!merchant?.tracking_link) { skipped++; continue }

    // upsert：若已有 pending 任务则更新 target_count，否则新建
    const existing = await prisma.kyads_click_tasks.findFirst({
      where: { campaign_id: c.id, user_id: userId, status: { in: ['pending', 'running'] }, is_deleted: 0 },
      select: { id: true },
    })

    if (existing) {
      await prisma.kyads_click_tasks.update({
        where: { id: existing.id },
        data: { target_count: clickCount, updated_at: now },
      })
    } else {
      await prisma.kyads_click_tasks.create({
        data: {
          user_id: userId,
          campaign_id: c.id,
          affiliate_url: merchant.tracking_link,
          referer_url: merchant.kyads_referer_url ?? '',
          target_count: clickCount,
          done_count: 0,
          status: 'pending',
        },
      })
    }
    created++
  }

  return NextResponse.json({
    code: 0,
    data: { created, skipped, message: `已为 ${created} 个广告系列创建/更新点击任务` },
  })
}
