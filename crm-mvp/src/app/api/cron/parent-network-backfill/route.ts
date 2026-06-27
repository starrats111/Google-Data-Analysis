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
import { resolveAffiliateLink, detectParentNetworkFromText } from '@/lib/affiliate-link-resolver'

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
    // 仅处理「启用中（active + ENABLED）广告系列关联的商家」——即换链接管理里实际展示、
    // 会出现「上级联盟 未识别」的那批；全表 user_merchants 高达百万级，不应也无法全量巡航。
    const enabledCampaigns = await prisma.campaigns.findMany({
      where: { status: 'active', google_status: 'ENABLED', is_deleted: 0, google_campaign_id: { not: null } },
      select: { user_merchant_id: true, final_url_suffix: true },
    })
    const merchantIds = [...new Set(enabledCampaigns.map((c) => c.user_merchant_id))]

    // 商家 → 关联在投系列的 final_url_suffix 合并串（离线识别快路径用）。
    // final_url_suffix 由换链脚本从 Google 反向回填，含上级联盟铁证（pzevent/irclickid/ranMID…）。
    const suffixByMerchant = new Map<string, string>()
    for (const c of enabledCampaigns) {
      if (!c.user_merchant_id || !c.final_url_suffix) continue
      const key = c.user_merchant_id.toString()
      const prev = suffixByMerchant.get(key)
      suffixByMerchant.set(key, prev ? `${prev} ${c.final_url_suffix}` : c.final_url_suffix)
    }

    if (merchantIds.length === 0) {
      return NextResponse.json({ code: 0, data: { processed: 0, resolved: 0, blacklisted: 0, failed: 0, noUrl: 0, remaining: 0 } })
    }

    // 跳过最近 24h 内已巡航过的（含失败）——失败项不应每轮被反复重选阻塞队列；
    // 24h 后允许重试（应对临时坏链接/代理抖动）。一次性回填会在单轮跑内自然收敛。
    const retryCutoff = new Date(Date.now() - 24 * 3600_000)
    const whereHasLinkNoParent = {
      id: { in: merchantIds },
      is_deleted: 0,
      parent_network: null,
      OR: [{ tracking_link: { not: null } }, { campaign_link: { not: null } }],
      AND: [{ OR: [{ parent_checked_at: null }, { parent_checked_at: { lt: retryCutoff } }] }],
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
      orderBy: { parent_checked_at: 'asc' },
      take: limit,
    })

    let resolved = 0
    let blacklisted = 0
    let failed = 0
    let noUrl = 0
    let offlineResolved = 0

    await runWithConcurrency(candidates, concurrency, async (m) => {
      // ── 快路径：先用已回填的 final_url_suffix 离线识别上级联盟（零网络成本，无需巡航）──
      // 解决 rewardoo 等 JS 跳转跟不动、但 Google 落地后缀里已含网络铁证的系列。
      const offlineText = suffixByMerchant.get(m.id.toString())
      if (offlineText) {
        const off = await detectParentNetworkFromText(offlineText, m.platform || null).catch(() => null)
        if (off && off.parentNetwork) {
          resolved++
          offlineResolved++
          if (off.blacklisted) blacklisted++
          await prisma.user_merchants
            .update({
              where: { id: m.id },
              data: {
                parent_network: off.parentNetwork,
                parent_blacklisted: off.blacklisted ? 1 : 0,
                tracking_status: off.blacklisted ? 'forbidden_network' : 'ok',
                parent_checked_at: new Date(),
                parent_check_reason: '后缀离线识别',
              },
            })
            .catch(() => {})
          return
        }
      }

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
          // 开启无头浏览器兜底：纠正 pepperjam/impact 等 JS 联盟的 no_tracking 误判
          // （受 limit 每轮条数 + puppeteer 信号量限并发，低配机安全）
          resolveAffiliateLink(affiliateUrl, country, m.platform || null, { browserFallback: true }),
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
        const msg = e instanceof Error ? e.message : String(e)
        console.warn('[cron/parent-network-backfill] resolve error:', m.id.toString(), msg)
        // 关键：抛错也要落 parent_checked_at，否则该商家永远停在 NULL，
        // 每轮按 NULL 优先被反复重选、阻塞队列、其它商家永远轮不到（低配机 puppeteer OOM 时尤甚）
        await prisma.user_merchants
          .update({
            where: { id: m.id },
            data: { tracking_status: 'resolve_failed', parent_check_reason: `巡航异常：${msg}`.slice(0, 255), parent_checked_at: new Date() },
          })
          .catch(() => {})
      }
    })

    const remaining = await prisma.user_merchants.count({ where: whereHasLinkNoParent })

    console.log(
      `[cron/parent-network-backfill] processed=${candidates.length} resolved=${resolved} (offline=${offlineResolved}) blacklisted=${blacklisted} failed=${failed} noUrl=${noUrl} remaining=${remaining} cost=${Date.now() - startedAt}ms`,
    )
    return NextResponse.json({
      code: 0,
      data: { processed: candidates.length, resolved, offlineResolved, blacklisted, failed, noUrl, remaining },
    })
  } catch (error) {
    console.error('[cron/parent-network-backfill] error:', error)
    return NextResponse.json({ code: -1, message: error instanceof Error ? error.message : '回填失败' }, { status: 500 })
  } finally {
    isRunning = false
  }
}
