import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'

// PUT /api/user/settings/merchant-referer
// Body: { merchantId: string, refererUrl: string | null }
export async function PUT(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  const userId = BigInt(user.userId)

  let body: { merchantId?: string; refererUrl?: string | null }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ code: -1, message: '请求体解析失败' }, { status: 400 })
  }

  const { merchantId, refererUrl } = body
  if (!merchantId) return NextResponse.json({ code: -1, message: '缺少 merchantId' }, { status: 400 })

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: BigInt(merchantId), user_id: userId, is_deleted: 0 },
    select: { id: true },
  })
  if (!merchant) return NextResponse.json({ code: -1, message: '商家不存在或无权限' }, { status: 404 })

  await prisma.user_merchants.update({
    where: { id: merchant.id },
    data: { kyads_referer_url: refererUrl ?? null },
  })

  return NextResponse.json({ code: 0, message: '已保存' })
}
