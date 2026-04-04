import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getScriptUserFromRequest } from '@/lib/script-auth'

// ---------------------------------------------------------------
// GET /api/v1/click-baseline?campaignIds=xxx,yyy,zzz
// 脚本启动时调用：读取上次记录的点击基线，跨实例继承状态
// ---------------------------------------------------------------
export async function GET(req: NextRequest) {
  const scriptUser = await getScriptUserFromRequest(req)
  if (!scriptUser) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHORIZED', message: '无效的 API Key' } },
      { status: 401 }
    )
  }

  const { searchParams } = new URL(req.url)
  const rawIds = searchParams.get('campaignIds') ?? ''
  const campaignIds = rawIds
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  if (campaignIds.length === 0) {
    return NextResponse.json({ success: true, baselines: {} })
  }

  // 每次最多查询 500 个，防止 IN 查询过大
  const MAX = 500
  const ids = campaignIds.slice(0, MAX)

  const rows = await prisma.campaigns.findMany({
    where: {
      user_id: scriptUser.userId,
      google_campaign_id: { in: ids },
      is_deleted: 0,
    },
    select: {
      google_campaign_id: true,
      suffix_click_baseline: true,
      suffix_click_checkpoint_at: true,
    },
  })

  // 构建 { campaignId → {clicks, checkpointAt} } 映射
  const baselines: Record<string, { clicks: number; checkpointAt: string | null }> = {}
  for (const row of rows) {
    if (!row.google_campaign_id) continue
    baselines[row.google_campaign_id] = {
      clicks: row.suffix_click_baseline ?? 0,
      checkpointAt: row.suffix_click_checkpoint_at
        ? row.suffix_click_checkpoint_at.toISOString()
        : null,
    }
  }

  return NextResponse.json({
    success: true,
    baselines,
    meta: { requested: campaignIds.length, found: rows.length, truncated: campaignIds.length > MAX },
  })
}

// ---------------------------------------------------------------
// POST /api/v1/click-baseline/sync
// 脚本退出前调用：批量写入当前点击数作为下次启动的基线
// Body: { campaigns: [{campaignId: "xxx", clicks: 123}] }
// ---------------------------------------------------------------
export async function POST(req: NextRequest) {
  const scriptUser = await getScriptUserFromRequest(req)
  if (!scriptUser) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHORIZED', message: '无效的 API Key' } },
      { status: 401 }
    )
  }

  let body: { campaigns?: { campaignId: string; clicks: number }[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { success: false, error: { code: 'BAD_REQUEST', message: '请求体解析失败' } },
      { status: 400 }
    )
  }

  const items = body.campaigns ?? []
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ success: true, updated: 0, skipped: 0 })
  }

  // 只处理合法条目（clicks 必须为非负整数）
  const valid = items.filter(
    (item) =>
      typeof item.campaignId === 'string' &&
      item.campaignId.length > 0 &&
      typeof item.clicks === 'number' &&
      item.clicks >= 0
  )

  if (valid.length === 0) {
    return NextResponse.json({ success: true, updated: 0, skipped: items.length })
  }

  const now = new Date()
  const campaignIds = valid.map((v) => v.campaignId)

  // 先查出属于当前用户的这批 campaign
  const owned = await prisma.campaigns.findMany({
    where: {
      user_id: scriptUser.userId,
      google_campaign_id: { in: campaignIds },
      is_deleted: 0,
    },
    select: { id: true, google_campaign_id: true },
  })

  const idMap = new Map(owned.map((r) => [r.google_campaign_id, r.id]))

  // 批量更新：每条独立 update（数量通常 <200，可接受）
  let updated = 0
  await Promise.all(
    valid.map(async (item) => {
      const internalId = idMap.get(item.campaignId)
      if (!internalId) return // 不属于当前用户，跳过
      await prisma.campaigns.update({
        where: { id: internalId },
        data: {
          suffix_click_baseline: item.clicks,
          suffix_click_checkpoint_at: now,
        },
      })
      updated++
    })
  )

  return NextResponse.json({
    success: true,
    updated,
    skipped: items.length - updated,
    checkpointAt: now.toISOString(),
  })
}
