/**
 * POST /api/integration/kylink/sync-now - kylink 端「刷新广告系列」按需触发的单用户同步
 *
 * 鉴权：API Key 本身即凭证。kylink 已以明文存储 API Key，回传真实 Key，
 * 这里在 users.kylink_api_key 上做「完整精确匹配」定位对应 CRM 用户。
 * 未匹配到即视为未关联（无副作用），无需额外共享密钥。
 *
 * 请求体：{ apiKey: string }  // kylink 用户的完整 API Key（ky_live_xxxx）
 *
 * 防滥用：每个用户 15s 冷却；同一 Key 在途请求加锁，避免重复点击叠加。
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { syncOneUser } from '@/lib/kylink-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const COOLDOWN_MS = 15_000
const lastSyncByUser = new Map<string, number>()
const inFlightKeys = new Set<string>()

export async function POST(req: NextRequest) {
  let body: { apiKey?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ code: -1, message: '请求体不是有效 JSON', data: null }, { status: 422 })
  }

  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  // 完整 Key 格式：ky_live_/ky_test_ 前缀 + 32 位随机，总长 40
  if (!/^ky_(live|test)_[A-Za-z0-9]{32}$/.test(apiKey)) {
    return NextResponse.json({ code: -1, message: 'apiKey 非法', data: null }, { status: 422 })
  }

  if (inFlightKeys.has(apiKey)) {
    return NextResponse.json({ code: 0, data: { skipped: true, reason: 'in_flight' } })
  }
  inFlightKeys.add(apiKey)

  try {
    const users = await prisma.users.findMany({
      where: {
        is_deleted: 0,
        status: 'active',
        kylink_api_key: apiKey,
      },
      select: { id: true, username: true, kylink_api_key: true },
    })

    if (users.length === 0) {
      // 该 API Key 未在任何 CRM 用户处配置 → 未关联
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
    inFlightKeys.delete(apiKey)
  }
}
