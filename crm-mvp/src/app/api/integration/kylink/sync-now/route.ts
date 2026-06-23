/**
 * POST /api/integration/kylink/sync-now - kylink 端「刷新广告系列」按需触发的单用户同步
 *
 * 鉴权：共享密钥 KYLINK_INTEGRATION_SECRET（Authorization: Bearer ...）
 * 请求体：{ apiKeyPrefix: string }  // kylink 用户的 API Key 前缀（ky_live_xxxx，仅前 12 位）
 *
 * 由于 kylink 仅保存 API Key 的哈希，无法回传明文，这里以「前缀匹配」定位对应 CRM 用户：
 * 在 users.kylink_api_key 上做 startsWith 匹配（前缀已含 ky_live_ + 4 位，足够区分小团队；
 * 万一多个用户命中同一前缀，则全部同步，互不影响）。
 *
 * 防滥用：每个用户 15s 冷却；同一前缀在途请求加锁，避免重复点击叠加。
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncOneUser } from '@/lib/kylink-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const COOLDOWN_MS = 15_000
const lastSyncByUser = new Map<string, number>()
const inFlightPrefixes = new Set<string>()

function verifySecret(req: NextRequest): boolean {
  const secret = process.env.KYLINK_INTEGRATION_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

export async function POST(req: NextRequest) {
  if (!verifySecret(req)) {
    return NextResponse.json({ code: -1, message: '未授权', data: null }, { status: 401 })
  }

  let body: { apiKeyPrefix?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ code: -1, message: '请求体不是有效 JSON', data: null }, { status: 422 })
  }

  const prefix = typeof body.apiKeyPrefix === 'string' ? body.apiKeyPrefix.trim() : ''
  if (!/^ky_(live|test)_[A-Za-z0-9]{2,}$/.test(prefix)) {
    return NextResponse.json({ code: -1, message: 'apiKeyPrefix 非法', data: null }, { status: 422 })
  }

  if (inFlightPrefixes.has(prefix)) {
    return NextResponse.json({ code: 0, data: { skipped: true, reason: 'in_flight' } })
  }
  inFlightPrefixes.add(prefix)

  try {
    const users = await prisma.users.findMany({
      where: {
        is_deleted: 0,
        status: 'active',
        kylink_api_key: { startsWith: prefix },
      },
      select: { id: true, username: true, kylink_api_key: true },
    })

    if (users.length === 0) {
      // 该 kylink 账号未在任何 CRM 用户处配置 → 未关联
      return NextResponse.json({ code: 0, data: { linked: false, totalSuccess: 0, totalFailed: 0 } })
    }

    let totalSuccess = 0
    let totalFailed = 0
    let ran = 0
    const now = Date.now()

    for (const u of users) {
      const last = lastSyncByUser.get(u.id.toString()) ?? 0
      if (now - last < COOLDOWN_MS) {
        continue // 冷却中，跳过
      }
      lastSyncByUser.set(u.id.toString(), now)
      ran++
      const res = await syncOneUser({
        userId: u.id,
        username: u.username,
        apiKey: u.kylink_api_key as string,
      })
      totalSuccess += res.success
      totalFailed += res.failed
    }

    return NextResponse.json({
      code: 0,
      data: { linked: true, ran, totalSuccess, totalFailed },
    })
  } catch (error) {
    console.error('[integration/kylink/sync-now] error:', error)
    return NextResponse.json(
      { code: -1, message: error instanceof Error ? error.message : 'kylink 按需同步失败', data: null },
      { status: 500 }
    )
  } finally {
    inFlightPrefixes.delete(prefix)
  }
}
