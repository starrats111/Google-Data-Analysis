import { NextRequest, NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/auth'
import { listAlerts, resolveAlerts, type SuffixAlertType } from '@/lib/suffix-engine/alerts'

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const status = (sp.get('status') as 'open' | 'resolved' | null) ?? 'open'
  const type = (sp.get('type') as SuffixAlertType | null) ?? undefined
  const limit = Math.min(parseInt(sp.get('limit') ?? '100', 10) || 100, 200)
  const offset = parseInt(sp.get('offset') ?? '0', 10) || 0

  const { rows, total } = await listAlerts(BigInt(user.userId), { status, type, limit, offset })

  return NextResponse.json({
    code: 0,
    data: {
      rows: rows.map((r) => ({
        id: r.id.toString(),
        campaignId: r.campaign_id?.toString() ?? null,
        type: r.type,
        level: r.level,
        message: r.message,
        context: r.context,
        status: r.status,
        occurCount: r.occur_count,
        lastSeenAt: r.last_seen_at,
        resolvedAt: r.resolved_at,
        createdAt: r.created_at,
      })),
      total,
    },
  })
}

// POST { ids: string[] } — 标记已解决
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  let body: { ids?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }
  const ids = (body.ids ?? []).map((x) => BigInt(x))
  const count = await resolveAlerts(BigInt(user.userId), ids)
  return NextResponse.json({ code: 0, data: { resolved: count } })
}
