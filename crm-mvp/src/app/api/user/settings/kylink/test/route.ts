import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'
import { pingKylink, KylinkApiError } from '@/lib/kylink-client'

/** 校验 kylink API Key 格式：ky_live_ + 32 位 = 40 */
function isValidKeyFormat(key: string): boolean {
  return /^ky_live_[a-f0-9]{32}$/.test(key)
}

// POST — 测试连接；成功则保存 Key 并标记已关联
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  let body: { apiKey?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }

  const apiKey = (body.apiKey || '').trim()
  if (!apiKey) {
    return NextResponse.json({ code: -1, message: '请输入 kylink API Key' }, { status: 400 })
  }
  if (!isValidKeyFormat(apiKey)) {
    return NextResponse.json(
      { code: -1, message: 'API Key 格式无效（应为 ky_live_ 开头的 40 位字符）' },
      { status: 400 }
    )
  }

  try {
    const kyUser = await pingKylink(apiKey)

    const now = new Date()
    await prisma.users.update({
      where: { id: BigInt(user.userId) },
      data: { kylink_api_key: apiKey, kylink_linked_at: now },
    })

    return NextResponse.json({
      code: 0,
      data: {
        ok: true,
        linkedAt: now,
        kylinkUser: { id: kyUser.id, name: kyUser.name, email: kyUser.email },
      },
    })
  } catch (e) {
    const message =
      e instanceof KylinkApiError
        ? e.status === 401 || e.status === 403
          ? 'API Key 无效或已被禁用'
          : e.message
        : 'kylink 连接失败'
    return NextResponse.json({ code: -1, message }, { status: 200 })
  }
}
