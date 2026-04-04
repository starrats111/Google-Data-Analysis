import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'

async function requireAdmin(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user || user.role !== 'admin') return null
  return user
}

// GET /api/admin/proxies/users?proxyId=xxx  查某代理已绑定的用户
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req)
  if (!admin) return NextResponse.json({ code: -1, message: '无权限' }, { status: 403 })

  const proxyId = req.nextUrl.searchParams.get('proxyId')
  if (!proxyId) return NextResponse.json({ code: -1, message: '缺少 proxyId' }, { status: 400 })

  const bindings = await prisma.kyads_proxy_users.findMany({
    where: { proxy_id: BigInt(proxyId) },
    select: { id: true, user_id: true, created_at: true },
  })

  const userIds = bindings.map((b) => b.user_id)
  const users = userIds.length > 0
    ? await prisma.users.findMany({
        where: { id: { in: userIds }, is_deleted: 0 },
        select: { id: true, username: true, display_name: true },
      })
    : []

  const userMap = new Map(users.map((u) => [u.id.toString(), u]))
  const data = bindings.map((b) => {
    const u = userMap.get(b.user_id.toString())
    return {
      bindingId: b.id.toString(),
      userId: b.user_id.toString(),
      username: u?.username ?? '—',
      displayName: u?.display_name ?? null,
      createdAt: b.created_at,
    }
  })

  return NextResponse.json({ code: 0, data })
}

// POST /api/admin/proxies/users  绑定用户到代理
// Body: { proxyId: string, userId: string }
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req)
  if (!admin) return NextResponse.json({ code: -1, message: '无权限' }, { status: 403 })

  let body: { proxyId?: string; userId?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }
  if (!body.proxyId || !body.userId) {
    return NextResponse.json({ code: -1, message: '缺少 proxyId 或 userId' }, { status: 400 })
  }

  // 检查是否已绑定
  const existing = await prisma.kyads_proxy_users.findFirst({
    where: { proxy_id: BigInt(body.proxyId), user_id: BigInt(body.userId) },
  })
  if (existing) return NextResponse.json({ code: -1, message: '该用户已绑定此代理' }, { status: 409 })

  await prisma.kyads_proxy_users.create({
    data: { proxy_id: BigInt(body.proxyId), user_id: BigInt(body.userId) },
  })

  return NextResponse.json({ code: 0, message: '绑定成功' })
}

// DELETE /api/admin/proxies/users  解绑
// Body: { bindingId: string }
export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req)
  if (!admin) return NextResponse.json({ code: -1, message: '无权限' }, { status: 403 })

  let body: { bindingId?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }
  if (!body.bindingId) return NextResponse.json({ code: -1, message: '缺少 bindingId' }, { status: 400 })

  await prisma.kyads_proxy_users.delete({ where: { id: BigInt(body.bindingId) } })

  return NextResponse.json({ code: 0, message: '已解绑' })
}
