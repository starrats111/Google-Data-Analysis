import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'

async function requireAdmin(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user) return null
  if (user.role !== 'admin') return null
  return user
}

// ---------------------------------------------------------------
// GET /api/admin/proxies  查全部代理 + 每个代理绑定的用户数
// ---------------------------------------------------------------
export async function GET(req: NextRequest) {
  const user = await requireAdmin(req)
  if (!user) return NextResponse.json({ code: -1, message: '无权限' }, { status: 403 })

  const proxies = await prisma.kyads_proxies.findMany({
    where: { is_deleted: 0 },
    orderBy: [{ priority: 'asc' }, { created_at: 'desc' }],
  })

  // 查每个代理绑定的用户数
  const userCounts = await prisma.kyads_proxy_users.groupBy({
    by: ['proxy_id'],
    _count: { user_id: true },
  })
  const countMap = new Map(userCounts.map((r) => [r.proxy_id.toString(), r._count.user_id]))

  const data = proxies.map((p) => ({
    id: p.id.toString(),
    name: p.name,
    host: p.host,
    port: p.port,
    proxyType: p.proxy_type,
    priority: p.priority,
    status: p.status,
    userCount: countMap.get(p.id.toString()) ?? 0,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }))

  return NextResponse.json({ code: 0, data })
}

// ---------------------------------------------------------------
// POST /api/admin/proxies  新建代理
// ---------------------------------------------------------------
export async function POST(req: NextRequest) {
  const user = await requireAdmin(req)
  if (!user) return NextResponse.json({ code: -1, message: '无权限' }, { status: 403 })

  let body: {
    name?: string; host?: string; port?: number
    proxyType?: string; priority?: number; status?: string
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }

  if (!body.name || !body.host || !body.port) {
    return NextResponse.json({ code: -1, message: '名称、地址、端口为必填项' }, { status: 400 })
  }

  const proxy = await prisma.kyads_proxies.create({
    data: {
      name: body.name,
      host: body.host,
      port: Number(body.port),
      proxy_type: body.proxyType ?? 'http',
      priority: body.priority ?? 5,
      status: body.status ?? 'active',
    },
  })

  return NextResponse.json({ code: 0, data: { id: proxy.id.toString() } })
}

// ---------------------------------------------------------------
// PUT /api/admin/proxies  编辑代理
// ---------------------------------------------------------------
export async function PUT(req: NextRequest) {
  const user = await requireAdmin(req)
  if (!user) return NextResponse.json({ code: -1, message: '无权限' }, { status: 403 })

  let body: {
    id?: string; name?: string; host?: string; port?: number
    proxyType?: string; priority?: number; status?: string
  }
  try { body = await req.json() } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }

  if (!body.id) return NextResponse.json({ code: -1, message: '缺少 id' }, { status: 400 })

  const updateData: Record<string, unknown> = {}
  if (body.name !== undefined) updateData.name = body.name
  if (body.host !== undefined) updateData.host = body.host
  if (body.port !== undefined) updateData.port = Number(body.port)
  if (body.proxyType !== undefined) updateData.proxy_type = body.proxyType
  if (body.priority !== undefined) updateData.priority = body.priority
  if (body.status !== undefined) updateData.status = body.status

  await prisma.kyads_proxies.update({
    where: { id: BigInt(body.id) },
    data: updateData,
  })

  return NextResponse.json({ code: 0, message: '已更新' })
}

// ---------------------------------------------------------------
// DELETE /api/admin/proxies  软删除代理
// ---------------------------------------------------------------
export async function DELETE(req: NextRequest) {
  const user = await requireAdmin(req)
  if (!user) return NextResponse.json({ code: -1, message: '无权限' }, { status: 403 })

  let body: { id?: string }
  try { body = await req.json() } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }
  if (!body.id) return NextResponse.json({ code: -1, message: '缺少 id' }, { status: 400 })

  await prisma.kyads_proxies.update({
    where: { id: BigInt(body.id) },
    data: { is_deleted: 1 },
  })
  // 同时解绑用户
  await prisma.kyads_proxy_users.deleteMany({ where: { proxy_id: BigInt(body.id) } })

  return NextResponse.json({ code: 0, message: '已删除' })
}
