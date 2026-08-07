/**
 * 手动同步链接 —— 按用户「已启用广告系列」关联的商家，解析并校验联盟追踪链接 + 上级联盟。
 *
 * 与 /api/cron/parent-network-backfill 同源逻辑（resolveAffiliateLink 纯 HTTP 巡航），
 * 区别：本模块按 userId 范围、由「换链接管理」页手动触发，且不受 24h 重试窗口限制
 * （用户主动点同步即希望立即重跑），便于即时补上「未识别」的上级联盟与链接校验状态。
 */
import { prisma } from '@/lib/prisma'
import { resolveAffiliateLink } from '@/lib/affiliate-link-resolver'
import { pickCruiseAffiliateLink, loadConnectionAliasMap, type ConnectionAliasMap } from '@/lib/merchant-connection'
import { getMerchantCampaignCountries, pickCruiseCountry } from './merchant-country'

const ITEM_TIMEOUT_MS = 60000

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

async function resolveOne(
  m: {
    id: bigint
    platform: string | null
    merchant_url: string | null
    target_country: string | null
    tracking_link: string | null
    campaign_link: string | null
    connection_campaign_links: unknown
    platform_connection_id: bigint | null
  },
  userId?: bigint | null,
  /** D-222：该商家在投系列的投放国，商家自己没记国家时用它兜底 */
  campaignCountry?: string | null,
  /** D-224：触发本次校验的广告归属账号，与「保存链接」写入槽位的口径对齐 */
  campaignConnId?: bigint | null,
  aliasMap?: ConnectionAliasMap,
): Promise<void> {
  const affiliateUrl = pickCruiseAffiliateLink(m, campaignConnId, aliasMap)
  if (!affiliateUrl || !/^https?:\/\//i.test(affiliateUrl)) {
    await prisma.user_merchants
      .update({
        where: { id: m.id },
        data: { tracking_status: 'resolve_failed', parent_check_reason: '无可用联盟链接', parent_checked_at: new Date() },
      })
      .catch(() => {})
    return
  }
  const country = pickCruiseCountry(m.target_country, campaignCountry)
  try {
    const cruise = await Promise.race([
      // 开启无头浏览器兜底：no_tracking/停跳板时自动重试，纠正 pepperjam/impact 等 JS 联盟误判
      resolveAffiliateLink(affiliateUrl, country, m.platform || null, {
        userId,
        browserFallback: true,
        targetDomain: m.merchant_url,
      }),
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
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[link-sync] resolve error:', m.id.toString(), msg)
    // 抛错也落 parent_checked_at，避免该商家永远停在未校验、每次同步重复卡住
    await prisma.user_merchants
      .update({
        where: { id: m.id },
        data: { tracking_status: 'resolve_failed', parent_check_reason: `巡航异常：${msg}`.slice(0, 255), parent_checked_at: new Date() },
      })
      .catch(() => {})
  }
}

/**
 * 即时校验单个商家的联盟链接（用户手动填写/编辑链接后调用）。
 * 同步执行一次巡航并写回 tracking_status / parent_network，返回结果供前端即时展示。
 *
 * @param campaignConnId D-224 触发本次校验的广告归属账号。必须传：归属 ≠ 商家主连接时，
 *   刚存进归属账号槽位的链接只有按这个 id 才取得到，否则一律误报「无可用联盟链接」。
 */
export async function resolveMerchantNow(
  merchantId: bigint,
  userId: bigint,
  campaignConnId?: bigint | null,
): Promise<{ trackingStatus: string; parentNetwork: string | null } | null> {
  const m = await prisma.user_merchants.findFirst({
    where: { id: merchantId, user_id: userId, is_deleted: 0 },
    select: {
      id: true,
      platform: true,
      merchant_url: true,
      target_country: true,
      tracking_link: true,
      campaign_link: true,
      connection_campaign_links: true,
      platform_connection_id: true,
    },
  })
  if (!m) return null
  const campaignCountries = await getMerchantCampaignCountries([m.id])
  const aliasMap = await loadConnectionAliasMap(userId)
  await resolveOne(m, userId, campaignCountries.get(String(m.id)), campaignConnId, aliasMap)
  const updated = await prisma.user_merchants.findUnique({
    where: { id: merchantId },
    select: { tracking_status: true, parent_network: true },
  })
  return updated ? { trackingStatus: updated.tracking_status, parentNetwork: updated.parent_network } : null
}

/**
 * 同步指定用户的换链接（解析+校验商家联盟链接/上级联盟）。
 * 选取该用户「active + ENABLED + 有 google_campaign_id」广告系列关联的、
 * 「仍缺上级联盟(parent_network 为空) 或 上次校验失败(no_tracking/resolve_failed)」且已有链接的商家，
 * 后台并发巡航（手动同步即希望连失败项一并重试，配合无头浏览器兜底提升成功率）。
 * 立即返回排队数，巡航在后台进行（PM2 常驻进程，fire-and-forget 安全）。
 */
export async function syncUserLinks(
  userId: bigint,
  opts: { concurrency?: number } = {},
): Promise<{ queued: number }> {
  const concurrency = Math.min(Math.max(opts.concurrency ?? 2, 1), 4)

  const enabledCampaigns = await prisma.campaigns.findMany({
    where: { user_id: userId, status: 'active', google_status: 'ENABLED', is_deleted: 0, google_campaign_id: { not: null } },
    select: { user_merchant_id: true, platform_connection_id: true },
  })
  const merchantIds = [...new Set(enabledCampaigns.map((c) => c.user_merchant_id).filter((id) => id && id > BigInt(0)))]
  if (merchantIds.length === 0) return { queued: 0 }

  // D-224 商家 → 广告归属账号。同一商家的在投系列归属到不同账号时留空（按哪个号取都可能不是
  // 另一个号想验的那条），交给 pickCruiseAffiliateLink 的主连接/兜底逻辑。
  const connByMerchant = new Map<string, bigint | null>()
  for (const c of enabledCampaigns) {
    const key = c.user_merchant_id.toString()
    if (!connByMerchant.has(key)) connByMerchant.set(key, c.platform_connection_id)
    else if (connByMerchant.get(key)?.toString() !== c.platform_connection_id?.toString()) connByMerchant.set(key, null)
  }

  const rows = await prisma.user_merchants.findMany({
    where: {
      id: { in: merchantIds },
      user_id: userId,
      is_deleted: 0,
      // 缺上级联盟 或 上次巡航失败/未校验（no_tracking/resolve_failed/unchecked）都重跑
      OR: [
        { parent_network: null },
        { tracking_status: { in: ['no_tracking', 'resolve_failed', 'unchecked'] } },
      ],
      // D-224 刻意不再按 tracking_link/campaign_link 非空筛：链接只存在
      // connection_campaign_links 槽位里的商家（广告归属 ≠ 商家主连接时的常态）会被整批漏掉，
      // 点「同步链接」永远轮不到它们。有无可用链接改由下面 pickCruiseAffiliateLink 逐条判。
    },
    select: {
      id: true,
      platform: true,
      merchant_url: true,
      target_country: true,
      tracking_link: true,
      campaign_link: true,
      connection_campaign_links: true,
      platform_connection_id: true,
    },
  })
  const aliasMap = await loadConnectionAliasMap(userId)
  const candidates = rows.filter((m) => {
    const url = pickCruiseAffiliateLink(m, connByMerchant.get(m.id.toString()) ?? null, aliasMap)
    return !!url && /^https?:\/\//i.test(url)
  })
  if (candidates.length === 0) return { queued: 0 }

  const campaignCountries = await getMerchantCampaignCountries(candidates.map((m) => m.id))

  // fire-and-forget：后台巡航，不阻塞请求
  void runWithConcurrency(candidates, concurrency, (m) =>
    resolveOne(m, userId, campaignCountries.get(String(m.id)), connByMerchant.get(m.id.toString()) ?? null, aliasMap),
  ).catch((e) => console.error('[link-sync] batch error:', e instanceof Error ? e.message : e))

  return { queued: candidates.length }
}
