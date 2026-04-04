import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getUserFromRequest } from '@/lib/auth'
import { generateScriptApiKey } from '@/lib/script-auth'

// GET — 查询当前 API Key
export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  const u = await prisma.users.findFirst({
    where: { id: BigInt(user.userId), is_deleted: 0 },
    select: { script_api_key: true },
  })

  return NextResponse.json({
    code: 0,
    data: { apiKey: u?.script_api_key ?? null },
  })
}

// POST — 生成或重置 API Key
export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req)
  if (!user) return NextResponse.json({ code: -1, message: '未登录' }, { status: 401 })

  const newKey = generateScriptApiKey()

  await prisma.users.update({
    where: { id: BigInt(user.userId) },
    data: { script_api_key: newKey },
  })

  return NextResponse.json({ code: 0, data: { apiKey: newKey } })
}
