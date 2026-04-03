import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'

// Campaign 名称解析：格式 XXX-PLATFORM-品牌-国家-日期-MID
const VALID_NETWORKS = ['RW', 'LH', 'PM', 'LB', 'CG', 'CF', 'BSH', 'TJ', 'AW']

function parseCampaignName(name: string): { platform: string; mid: string; parsed: boolean } {
  if (!name) return { platform: '', mid: '', parsed: false }
  const parts = name.split('-')
  if (parts.length < 3) return { platform: '', mid: '', parsed: false }
  const rawNet = parts[1].trim().toUpperCase()
  const platform = rawNet.replace(/[0-9]+$/, '')
  const mid = parts[parts.length - 1].trim()
  const valid = VALID_NETWORKS.includes(platform) && mid.length > 0
  return { platform: valid ? platform : '', mid: valid ? mid : '', parsed: valid }
}

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ code: -1, message: 'Not Found' }, { status: 404 })
  }
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  const userId = BigInt(user.userId)

  // 1. 查用户所有已启用广告系列
  const campaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, status: 'active', is_deleted: 0 },
    select: {
      id: true,
      google_campaign_id: true,
      campaign_name: true,
      suffix_exchange_enabled: true,
      suffix_last_apply_at: true,
      suffix_click_baseline: true,
    },
    orderBy: { campaign_name: 'asc' },
  })

  // 2. 解析每条 campaign 的 mid / platform
  const parsed = campaigns.map((c) => ({
    ...c,
    ...parseCampaignName(c.campaign_name ?? ''),
  }))

  const mids = [...new Set(parsed.filter((p) => p.parsed).map((p) => p.mid))]
  const platforms = [...new Set(parsed.filter((p) => p.parsed).map((p) => p.platform))]

  // 3. 批量查匹配的商家（user_merchants）
  const merchants =
    mids.length > 0
      ? await prisma.user_merchants.findMany({
          where: {
            user_id: userId,
            merchant_id: { in: mids },
            platform: { in: platforms },
            is_deleted: 0,
          },
          select: {
            id: true,
            merchant_id: true,
            platform: true,
            merchant_name: true,
            tracking_link: true,
            kyads_referer_url: true,
            link_status: true,
            link_checked_at: true,
            link_check_reason: true,
          },
        })
      : []

  // mid+platform → merchant 快速查找
  const merchantMap = new Map(
    merchants.map((m) => [`${m.platform}:${m.merchant_id}`, m])
  )

  // 3b. 查每个 user_merchant 下最新已发布的文章 URL（用作自动来路）
  // 用 JS 去重取最新，避免 Prisma MySQL 不支持 distinct+orderBy 不同字段
  const merchantIds = merchants.map((m) => m.id)
  const allArticles =
    merchantIds.length > 0
      ? await prisma.articles.findMany({
          where: {
            user_merchant_id: { in: merchantIds },
            status: 'published',
            published_url: { not: null },
            is_deleted: 0,
          },
          orderBy: { published_at: 'desc' },
          select: { user_merchant_id: true, published_url: true, published_at: true },
        })
      : []

  // 每个 merchant 只取最新一篇（已按 published_at desc 排序，第一次出现即最新）
  const articleRefererMap = new Map<string, string | null>()
  for (const a of allArticles) {
    if (!a.user_merchant_id) continue
    const key = a.user_merchant_id.toString()
    if (!articleRefererMap.has(key)) articleRefererMap.set(key, a.published_url)
  }

  // 4. 查最新点击任务状态（JS 去重取最新，避免 distinct+orderBy 冲突）
  const campaignIds = campaigns.map((c) => c.id)
  const allTasks =
    campaignIds.length > 0
      ? await prisma.kyads_click_tasks.findMany({
          where: { campaign_id: { in: campaignIds }, is_deleted: 0 },
          orderBy: { created_at: 'desc' },
          select: {
            campaign_id: true,
            status: true,
            target_count: true,
            done_count: true,
            created_at: true,
            finished_at: true,
          },
        })
      : []

  // 每个 campaign 只保留最新一条（已按 created_at desc）
  const taskMap = new Map<string, (typeof allTasks)[0]>()
  for (const t of allTasks) {
    const key = t.campaign_id.toString()
    if (!taskMap.has(key)) taskMap.set(key, t)
  }

  // 5. 查整体任务摘要（当前有多少 pending/running）
  const [pendingCount, runningCount] = await Promise.all([
    prisma.kyads_click_tasks.count({ where: { user_id: userId, status: 'pending', is_deleted: 0 } }),
    prisma.kyads_click_tasks.count({ where: { user_id: userId, status: 'running', is_deleted: 0 } }),
  ])

  // 6. 查用户默认点击数
  const userRecord = await prisma.users.findUnique({
    where: { id: userId },
    select: { link_exchange_click_count: true },
  })

  // 7. 拼装返回
  const rows = parsed.map((c) => {
    const key = `${c.platform}:${c.mid}`
    const merchant = merchantMap.get(key) ?? null
    const task = taskMap.get(c.id.toString()) ?? null

    return {
      campaignId: c.id.toString(),
      googleCampaignId: c.google_campaign_id,
      campaignName: c.campaign_name,
      platform: c.platform,
      mid: c.mid,
      matched: !!merchant,
      // 商家信息
      merchantId: merchant?.id.toString() ?? null,
      merchantName: merchant?.merchant_name ?? null,
      trackingLink: merchant?.tracking_link ?? null,
      // 来路 URL：优先手动配置，其次取最新文章 URL，最后为 null
      refererUrl: merchant?.kyads_referer_url
        ?? (merchant ? (articleRefererMap.get(merchant.id.toString()) ?? null) : null),
      refererSource: merchant?.kyads_referer_url
        ? 'manual'
        : (merchant && articleRefererMap.has(merchant.id.toString()) ? 'article' : 'none'),
      linkStatus: merchant?.link_status ?? 'unchecked',
      linkCheckedAt: merchant?.link_checked_at ?? null,
      linkCheckReason: merchant?.link_check_reason ?? null,
      // 任务状态
      taskStatus: task?.status ?? null,
      taskTargetCount: task?.target_count ?? null,
      taskDoneCount: task?.done_count ?? null,
      taskCreatedAt: task?.created_at ?? null,
      taskFinishedAt: task?.finished_at ?? null,
      // 换链相关
      suffixEnabled: c.suffix_exchange_enabled === 1,
      lastApplyAt: c.suffix_last_apply_at,
    }
  })

  return NextResponse.json({
    code: 0,
    data: {
      rows,
      defaultClickCount: userRecord?.link_exchange_click_count ?? 10,
      taskSummary: { pending: pendingCount, running: runningCount },
      total: rows.length,
      matched: rows.filter((r) => r.matched).length,
    },
  })
}
