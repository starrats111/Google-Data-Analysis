import { NextRequest, NextResponse } from 'next/server'
import { replenishLowStock } from '@/lib/suffix-engine/stock-producer'

// ---------------------------------------------------------------
// GET /api/cron/click-tasks  （已弃用，保留向后兼容）
//
// 旧实现：读 kyads_click_tasks，单次 fetch follow 取 res.url 的 query 串作 suffix，
//   不跟 meta/js 跳转、不解 App 深链、不识别跳板域名，质量差。
// 新实现：委托给 suffix-engine 的自适应补货（按投放国住宅代理跟随完整重定向链）。
//   请将 crontab 改指向 /api/cron/suffix-replenish。
// ---------------------------------------------------------------

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // 兼容旧鉴权：x-cron-secret 头或 ?secret=，同时兼容 Bearer
  const CRON_SECRET = process.env.CRON_SECRET ?? ''
  const bearer = req.headers.get('authorization') === `Bearer ${CRON_SECRET}`
  const legacy = (req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret') ?? '') === CRON_SECRET
  if (CRON_SECRET && !bearer && !legacy) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const result = await replenishLowStock()
  return NextResponse.json({
    deprecated: true,
    message: '此端点已弃用，请改用 /api/cron/suffix-replenish',
    ...result,
  })
}
