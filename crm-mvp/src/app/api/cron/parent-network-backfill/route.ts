/**
 * GET /api/cron/parent-network-backfill - 批量「上级联盟巡航」验证回填
 *
 * 场景：很多商家已有联盟链接（tracking_link / campaign_link），但从未经过巡航验证，
 * 导致 user_merchants.parent_network 为空 → 换链接管理「上级联盟」列显示「未识别」。
 * 本端点扫描「有链接但 parent_network 为空」的商家，按投放国住宅代理跟随整条跳转链，
 * 识别上级联盟 + 黑名单 + 追踪参数，结果写回（与 ad-creation/submit 的 D-101 巡航同源，纯 HTTP）。
 *
 * 既可一次性回填（手动多次触发直到 remaining=0），也适合挂 30 分钟定时做持续验证。
 *
 * 参数：?limit=25（单轮处理数，默认 25）&concurrency=2（并发，默认 2，低配机保守）
 * 鉴权：CRON_SECRET（Authorization: Bearer ...）
 *
 * crontab 示例（每 30 分钟）：
 *   星/30 * * * * curl -s -H 'Authorization: Bearer ${CRON_SECRET}' 'http://localhost:20050/api/cron/parent-network-backfill?limit=25' >> /var/log/cron-parent-backfill.log 2>&1
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { resolveAffiliateLink } from '@/lib/affiliate-link-resolver'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const ITEM_TIMEOUT_MS = 60000

let isRunning = false

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  return req.headers.get('authorization') === `Bearer ${secret}`
}

/** 取商家可用联盟追踪链接（账号级优先，与 cruise/submit 一致） */
function pickAffiliateUrl(m: {
  tracking_link: string | null
  campaign_link: string | null
  connection_campaign_links: unknown
  platform_connection_id: bigint | null
}): string {
  const connLinks = (m.connection_campaign_links || null) as Record<string, string> | null
  if (connLinks && m.platform_connection_id) {
    const v = String(connLinks[String(m.platform_connection_id)] || '').trim()
    if (v) return v
  }
  const camp = String(m.campaign_link || '').trim()
  if (camp) return camp
  return String(m.tracking_link || '').trim()
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) break
      await worker(items[i])
    }
  })
  await Promise.all(runners)
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ code: -1, message: '未授权' }, { status: 401 })
  }
  if (isRunning) {
    return NextResponse.json({ code: 0, data: { skipped: true, reason: 'already_running' } })
  }
  isRunning = true

  const startedAt = Date.now()
  const url = new URL(req.url)
  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '25', 10) || 25, 1), 200)
  const concurrency = Math.min(Math.max(parseInt(url.searchParams.get('concurrency') || '2', 10) || 2, 1), 4)

  try {
    const whereHasLinkNoParent = {
      is_deleted: 0,
      parent_network: null,
      OR: [{ tracking_link: { not: null } }, { campaign_link: { not: null } }],
    }

    const candidates = await prisma.user_merchants.findMany({
      where: whereHasLinkNoParent,
      select: {
        id: true,
        platform: true,
        target_country: true,
        tracking_link: true,
        campaign_link: true,
        connection_campaign_links: true,
        platform_connection_id: true,
      },
      orderBy: { updated_at: 'desc' },
      take: limit,
    })

    let resolved = 0
    let blacklisted = 0
    let failed = 0
    let noUrl = 0

    await runWithConcurrency(candidates, concurrency, async (m) => {
      const affiliateUrl = pickAffiliateUrl(m)
      if (!affiliateUrl || !/^https?:\/\//i.test(affiliateUrl)) {
        noUrl++
        // 标记已检查（reason=no_link），避免每轮重复扫描
        await prisma.user_merchants
          .update({
            where: { id: m.id },
            data: { tracking_status: 'resolve_failed', parent_check_reason: '无可用联盟链接', parent_checked_at: new Date() },
          })
          .catch(() => {})
        return
      }
      const country = (m.target_country || 'US').toUpperCase()
      try {
        const cruise = await Promise.race([
          resolveAffiliateLink(affiliateUrl, country, m.platform || null),
          new Promise<null>((r) => setTimeout(() => r(null), ITEM_TIMEOUT_MS)),
        ])
        if (!cruise) {
          failed++
          await prisma.user_merchants
            .update({ where: { id: m.id }, data: { tracking_status: 'resolve_failed', parent_check_reason: '巡航超时', parent_checked_at: new Date() } })
            .catch(() => {})
          return
        }
        const isBlack = cruise.status === 'forbidden_network'
        if (cruise.parentNetwork) resolved++
        else failed++
        if (isBlack) blacklisted++
        await prisma.user_merchants.update({
          where: { id: m.id },
          data: {
            parent_network: cruise.parentNetwork,
            parent_blacklisted: isBlack ? 1 : 0,
            tracking_status: cruise.status,
            resolved_final_url: cruise.finalUrl?.slice(0, 1024) || null,
            resolve_chain: cruise.chain.slice(0, 20) as unknown as object,
            parent_checked_at: new Date(),
            parent_check_reason: (cruise.error || (cruise.status === 'ok' ? '巡航通过' : cruise.status)).slice(0, 255),
          },
        })
      } catch (e) {
        failed++
        console.warn('[cron/parent-network-backfill] resolve error:', m.id.toString(), e instanceof Error ? e.message : e)
      }
    })

    const remaining = await prisma.user_merchants.count({ where: whereHasLinkNoParent })

    console.log(
      `[cron/parent-network-backfill] processed=${candidates.length} resolved=${resolved} blacklisted=${blacklisted} failed=${failed} noUrl=${noUrl} remaining=${remaining} cost=${Date.now() - startedAt}ms`,
    )
    return NextResponse.json({
      code: 0,
      data: { processed: candidates.length, resolved, blacklisted, failed, noUrl, remaining },
    })
  } catch (error) {
    console.error('[cron/parent-network-backfill] error:', error)
    return NextResponse.json({ code: -1, message: error instanceof Error ? error.message : '回填失败' }, { status: 500 })
  } finally {
    isRunning = false
  }
}
