import { NextRequest, NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/auth'
import { testProviderExitIp } from '@/lib/suffix-engine/proxy-provider'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// POST /api/admin/proxies/test  测试代理供应商出口 IP
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user || user.role !== 'admin') {
    return NextResponse.json({ code: -1, message: '无权限' }, { status: 403 })
  }

  let body: { id?: string; country?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }
  if (!body.id) return NextResponse.json({ code: -1, message: '缺少 id' }, { status: 400 })

  const result = await testProviderExitIp(BigInt(body.id), (body.country || 'US').toUpperCase())
  return NextResponse.json({ code: 0, data: result })
}
