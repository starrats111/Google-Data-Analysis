import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getScriptUserFromRequest } from '@/lib/script-auth'

// 默认值（脚本侧也有同样的写死兜底，拉不到此接口时使用脚本内默认）
const DEFAULT_LOOP_INTERVAL_SECONDS = 15
const DEFAULT_CYCLE_MINUTES = 30

// 边界约束，防止误配导致脚本异常
const LOOP_INTERVAL_MIN = 5
const LOOP_INTERVAL_MAX = 300
const CYCLE_MINUTES_MIN = 5
const CYCLE_MINUTES_MAX = 60

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.round(n)))
}

async function readIntConfig(key: string, fallback: number, min: number, max: number): Promise<number> {
  try {
    const row = await prisma.system_configs.findFirst({
      where: { config_key: key, is_deleted: 0 },
      select: { config_value: true },
    })
    if (!row || row.config_value == null || row.config_value.trim() === '') return fallback
    const parsed = Number(row.config_value.trim())
    if (!Number.isFinite(parsed)) return fallback
    return clamp(parsed, min, max)
  } catch {
    return fallback
  }
}

/**
 * 脚本启动时拉取「运行时可调配置」，以便调速度等无需重新下发脚本。
 *
 * 轮询间隔取值优先级（用户自助 > 全局 > 默认）：
 *   1) 该用户 users.script_loop_interval_seconds（用户在换链接页自助设置）
 *   2) 全局 system_configs.script_loop_interval_seconds（兜底/批量）
 *   3) 脚本内写死默认 15
 * 周期 cycleMinutes 仅全局/默认。改后脚本下一轮启动自动生效，无需重发脚本。
 */
export async function GET(req: NextRequest) {
  const scriptUser = await getScriptUserFromRequest(req)
  if (!scriptUser) {
    return NextResponse.json(
      { success: false, error: { code: 'UNAUTHORIZED', message: '无效的 API Key' } },
      { status: 401 }
    )
  }

  // 1) 用户自助值优先
  let loopIntervalSeconds: number | null = null
  try {
    const u = await prisma.users.findUnique({
      where: { id: scriptUser.userId },
      select: { script_loop_interval_seconds: true },
    })
    const v = u?.script_loop_interval_seconds
    if (v != null && Number.isFinite(Number(v))) {
      loopIntervalSeconds = clamp(Number(v), LOOP_INTERVAL_MIN, LOOP_INTERVAL_MAX)
    }
  } catch {
    /* 忽略，回退全局/默认 */
  }

  // 2) 用户未设 → 全局；3) 全局未设 → 默认 15
  if (loopIntervalSeconds == null) {
    loopIntervalSeconds = await readIntConfig(
      'script_loop_interval_seconds',
      DEFAULT_LOOP_INTERVAL_SECONDS,
      LOOP_INTERVAL_MIN,
      LOOP_INTERVAL_MAX
    )
  }

  const cycleMinutes = await readIntConfig(
    'script_cycle_minutes',
    DEFAULT_CYCLE_MINUTES,
    CYCLE_MINUTES_MIN,
    CYCLE_MINUTES_MAX
  )

  return NextResponse.json({
    success: true,
    config: { loopIntervalSeconds, cycleMinutes },
  })
}
