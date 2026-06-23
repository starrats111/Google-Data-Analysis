import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'

/** 掩码展示 API Key：保留前缀与后 4 位 */
function maskKey(key: string): string {
  if (key.length <= 12) return key
  return `${key.slice(0, 12)}****${key.slice(-4)}`
}

// GET — 当前 kylink 关联状态
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  const u = await prisma.users.findFirst({
    where: { id: BigInt(user.userId), is_deleted: 0 },
    select: { kylink_api_key: true, kylink_linked_at: true },
  })

  const key = u?.kylink_api_key || null

  return NextResponse.json({
    code: 0,
    data: {
      hasKey: Boolean(key),
      keyMasked: key ? maskKey(key) : null,
      linked: Boolean(u?.kylink_linked_at),
      linkedAt: u?.kylink_linked_at ?? null,
    },
  })
}

// DELETE — 解除 kylink 关联
export async function DELETE(req: NextRequest) {
  const user = getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  await prisma.users.update({
    where: { id: BigInt(user.userId) },
    data: { kylink_api_key: null, kylink_linked_at: null },
  })

  return NextResponse.json({ code: 0, data: { ok: true } })
}
