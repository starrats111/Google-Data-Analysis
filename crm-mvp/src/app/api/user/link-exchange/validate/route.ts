import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'

interface ValidateResult {
  merchantId: string
  trackingLink: string | null
  status: 'valid' | 'invalid' | 'skipped'
  reason?: string
}

async function checkUrl(url: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    })
    clearTimeout(timer)
    if (res.status >= 200 && res.status < 400) return { ok: true }
    return { ok: false, reason: `HTTP ${res.status}` }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('abort') || msg.includes('timeout')) return { ok: false, reason: '请求超时' }
    if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND'))
      return { ok: false, reason: '无法连接' }
    return { ok: false, reason: msg.slice(0, 80) }
  }
}

// POST /api/user/link-exchange/validate
// Body: { merchantIds: string[] }   ← 内部 DB id
export async function POST(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ code: -1, message: 'Not Found' }, { status: 404 })
  }
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  const userId = BigInt(user.userId)

  let body: { merchantIds?: string[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }

  const rawIds = body.merchantIds ?? []
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return NextResponse.json({ code: -1, message: '请提供 merchantIds' }, { status: 400 })
  }

  const ids = rawIds.map((id) => BigInt(id))

  // 校验归属
  const merchants = await prisma.user_merchants.findMany({
    where: { id: { in: ids }, user_id: userId, is_deleted: 0 },
    select: { id: true, tracking_link: true },
  })

  const now = new Date()
  const results: ValidateResult[] = []

  // 并发验证，最多同时 5 个
  const CONCURRENCY = 5
  for (let i = 0; i < merchants.length; i += CONCURRENCY) {
    const batch = merchants.slice(i, i + CONCURRENCY)
    await Promise.all(
      batch.map(async (m) => {
        const mId = m.id.toString()
        if (!m.tracking_link) {
          results.push({ merchantId: mId, trackingLink: null, status: 'skipped', reason: '无追踪链接' })
          await prisma.user_merchants.update({
            where: { id: m.id },
            data: { link_status: 'unchecked', link_checked_at: now, link_check_reason: '无追踪链接' },
          })
          return
        }

        const { ok, reason } = await checkUrl(m.tracking_link)
        const linkStatus = ok ? 'valid' : 'invalid'
        results.push({ merchantId: mId, trackingLink: m.tracking_link, status: linkStatus, reason })

        await prisma.user_merchants.update({
          where: { id: m.id },
          data: {
            link_status: linkStatus,
            link_checked_at: now,
            link_check_reason: reason ?? null,
          },
        })
      })
    )
  }

  const valid = results.filter((r) => r.status === 'valid').length
  const invalid = results.filter((r) => r.status === 'invalid').length

  return NextResponse.json({
    code: 0,
    data: { results, stats: { total: results.length, valid, invalid } },
  })
}
