/**
 * 手动同步链接 —— 按用户「已启用广告系列」关联的商家，解析并校验联盟追踪链接 + 上级联盟。
 *
 * 与 /api/cron/parent-network-backfill 同源逻辑（resolveAffiliateLink 纯 HTTP 巡航），
 * 区别：本模块按 userId 范围、由「换链接管理」页手动触发，且不受 24h 重试窗口限制
 * （用户主动点同步即希望立即重跑），便于即时补上「未识别」的上级联盟与链接校验状态。
 */
import { prisma } from '@/lib/prisma'
import { resolveAffiliateLink } from '@/lib/affiliate-link-resolver'

const ITEM_TIMEOUT_MS = 60000

/** 取商家可用联盟追踪链接（账号级优先，与 cruise/submit/backfill 一致） */
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

async function resolveOne(m: {
  id: bigint
  platform: string | null
  target_country: string | null
  tracking_link: string | null
  campaign_link: string | null
  connection_campaign_links: unknown
  platform_connection_id: bigint | null
}): Promise<void> {
  const affiliateUrl = pickAffiliateUrl(m)
  if (!affiliateUrl || !/^https?:\/\//i.test(affiliateUrl)) {
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
      await prisma.user_merchants
        .update({ where: { id: m.id }, data: { tracking_status: 'resolve_failed', parent_check_reason: '巡航超时', parent_checked_at: new Date() } })
        .catch(() => {})
      return
    }
    const isBlack = cruise.status === 'forbidden_network'
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
    console.warn('[link-sync] resolve error:', m.id.toString(), e instanceof Error ? e.message : e)
  }
}

/**
 * 同步指定用户的换链接（解析+校验商家联盟链接/上级联盟）。
 * 选取该用户「active + ENABLED + 有 google_campaign_id」广告系列关联的、
 * 仍缺上级联盟（parent_network 为空）但已有链接的商家，后台并发巡航。
 * 立即返回排队数，巡航在后台进行（PM2 常驻进程，fire-and-forget 安全）。
 */
export async function syncUserLinks(
  userId: bigint,
  opts: { concurrency?: number } = {},
): Promise<{ queued: number }> {
  const concurrency = Math.min(Math.max(opts.concurrency ?? 2, 1), 4)

  const enabledCampaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, status: 'active', google_status: 'ENABLED', is_deleted: 0, google_campaign_id: { not: null } },
    select: { user_merchant_id: true },
  })
  const merchantIds = [...new Set(enabledCampaigns.map((c) => c.user_merchant_id).filter((id) => id && id > BigInt(0)))]
  if (merchantIds.length === 0) return { queued: 0 }

  const candidates = await prisma.user_merchants.findMany({
    where: {
      id: { in: merchantIds },
      user_id: userId,
      is_deleted: 0,
      parent_network: null,
      OR: [{ tracking_link: { not: null } }, { campaign_link: { not: null } }],
    },
    select: {
      id: true,
      platform: true,
      target_country: true,
      tracking_link: true,
      campaign_link: true,
      connection_campaign_links: true,
      platform_connection_id: true,
    },
  })
  if (candidates.length === 0) return { queued: 0 }

  // fire-and-forget：后台巡航，不阻塞请求
  void runWithConcurrency(candidates, concurrency, resolveOne).catch((e) =>
    console.error('[link-sync] batch error:', e instanceof Error ? e.message : e),
  )

  return { queued: candidates.length }
}
