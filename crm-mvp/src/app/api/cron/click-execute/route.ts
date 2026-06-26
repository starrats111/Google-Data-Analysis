import { NextRequest, NextResponse } from 'next/server'
import { executeClickTaskItems } from '@/lib/suffix-engine/click-brush'

// ---------------------------------------------------------------
// GET /api/cron/click-execute
// 真人自然刷点击执行器：取到期的点击子项执行（建议每 1-2 分钟一次）。
// 任务按目标国作息曲线排程到当天，本端点逐批到期执行，跨任务受限并行、组内串行。
// ---------------------------------------------------------------

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  const CRON_SECRET = process.env.CRON_SECRET ?? ''
  const bearer = req.headers.get('authorization') === `Bearer ${CRON_SECRET}`
  const legacy = (req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret') ?? '') === CRON_SECRET
  if (CRON_SECRET && !bearer && !legacy) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await executeClickTaskItems()
  return NextResponse.json({ ok: true, ...result })
}
