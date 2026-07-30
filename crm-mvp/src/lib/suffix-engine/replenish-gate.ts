/**
 * D-201 补货闸门判定（纯函数，无 prisma/网络依赖，便于单测）
 *
 * 为什么单独成文件：这里是四个条件（是否冷却中 / 是否 force / 是否人工 / 连续零参数轮次）的
 * 交叉判定，任一方向错了都是**静默**故障——
 *   - 放得太松：卡死系列继续每次 lease 白开一次浏览器（D-201 病灶，实测 130 次/天）；
 *   - 收得太紧：健康系列真没货时也补不上，广告直接断供。
 * 两种后果都不会抛错、日志上也看不出来，只能靠测试钉住。
 */

import { STOCK_CONFIG } from './config'

/** 达到该连续轮次即判定「链接活着但不记点击」 */
export function isNoTrackingStuck(streak: number): boolean {
  return streak >= STOCK_CONFIG.ALIVE_NO_TRACKING_STREAK_THRESHOLD
}

/**
 * 又一轮「跟到官网但零追踪参数」后的处置：累加轮次，未达阈值维持短冷却重试，
 * 达阈值升级长冷却（并由调用方抛 no_tracking_stuck 告警）。
 */
export function classifyNoTrackingRound(prevStreak: number): {
  streak: number
  stuck: boolean
  cooldownMs: number
} {
  const streak = prevStreak + 1
  const stuck = isNoTrackingStuck(streak)
  return {
    streak,
    stuck,
    cooldownMs: stuck ? STOCK_CONFIG.DEAD_LINK_COOLDOWN_MS : STOCK_CONFIG.ALIVE_LINK_COOLDOWN_MS,
  }
}

export interface CooldownGateInput {
  /** 落库的冷却截止时间；null = 无冷却 */
  cooldownUntil: Date | null
  /** 连续「落官网零参数」轮次 */
  noTrackingStreak: number
  /** 忽略低水位强制补到目标（lease NO_STOCK 按需路径 / 人工入口都会带） */
  force: boolean
  /** 人工发起（页面补货/重验/换链接后验证）。只有它能穿透卡死长冷却 */
  manual: boolean
  now?: Date
}

export type CooldownSkipReason = 'fail_cooldown' | 'no_tracking_stuck_cooldown'

/**
 * 是否应因冷却而跳过本轮补货。
 *
 * 规则（在 D-177 原语义上只加一条例外）：
 *   1. 不在冷却期 → 一律放行。
 *   2. 冷却期内且非 force → 跳过（reason=fail_cooldown），与 D-177 一致。
 *   3. 冷却期内且 force → 原本一律放行；D-201 起，若已判定 no_tracking 卡死且**非人工**，
 *      则同样跳过（reason=no_tracking_stuck_cooldown）。人工入口永远放行，保证换了新链接能当场重试。
 */
export function evaluateCooldownGate(input: CooldownGateInput): {
  skip: boolean
  reason?: CooldownSkipReason
} {
  const now = input.now ?? new Date()
  const inCooldown = !!input.cooldownUntil && input.cooldownUntil > now
  if (!inCooldown) return { skip: false }

  if (!input.force) return { skip: true, reason: 'fail_cooldown' }

  if (isNoTrackingStuck(input.noTrackingStreak) && !input.manual) {
    return { skip: true, reason: 'no_tracking_stuck_cooldown' }
  }
  return { skip: false }
}
