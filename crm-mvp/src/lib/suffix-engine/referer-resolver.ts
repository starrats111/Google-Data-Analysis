/**
 * 来路（Referer）解析器 —— 统一刷点击 / 补货追链的来路来源
 *
 * 「来路」= 访问联盟追踪链接时带上的 HTTP Referer，模拟「真人从某来源页点进联盟链接」，
 * 用于反风控 + 点击归因（让联盟相信流量来自正常网站，从而正常计点击/给佣金）。
 *
 * 优先级（按真实度从高到低）：
 *   1. manual  — 商家手动配置的来路 user_merchants.kyads_referer_url（显式覆盖，最高优先）
 *   2. article — 该商家最新已发布文章 articles.published_url（广告系列 → mid → 商家 → 文章）
 *   3. website — 商家所属联盟账号绑定的发布网站 publish_sites.domain 首页
 *               （user_merchants.platform_connection_id → platform_connections.publish_site_id → publish_sites）
 *   4. none    — 都没有（调用方回退随机来路池 REFERERS）
 */

import { prisma } from '@/lib/prisma'

export type RefererSource = 'manual' | 'article' | 'website' | 'none'

export interface MerchantReferer {
  url: string | null
  source: RefererSource
}

/** 把裸域名规范成首页 URL；已带协议则原样去尾斜杠 */
function normalizeSiteUrl(domain: string): string {
  const d = domain.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(d) ? d : `https://${d}`
}

/**
 * 解析单个商家（广告系列）的来路。每条 1~3 次轻量查询，供刷点击/补货按系列调用。
 */
export async function resolveMerchantReferer(
  userMerchantId: bigint | null | undefined,
): Promise<MerchantReferer> {
  if (!userMerchantId || userMerchantId <= BigInt(0)) return { url: null, source: 'none' }

  const m = await prisma.user_merchants.findFirst({
    where: { id: userMerchantId, is_deleted: 0 },
    select: { kyads_referer_url: true, platform_connection_id: true },
  })
  if (!m) return { url: null, source: 'none' }

  // 1) 手动配置
  const manual = m.kyads_referer_url?.trim()
  if (manual) return { url: manual, source: 'manual' }

  // 2) 最新已发布文章
  const article = await prisma.articles.findFirst({
    where: {
      user_merchant_id: userMerchantId,
      status: 'published',
      published_url: { not: null },
      is_deleted: 0,
    },
    orderBy: { published_at: 'desc' },
    select: { published_url: true },
  })
  const articleUrl = article?.published_url?.trim()
  if (articleUrl) return { url: articleUrl, source: 'article' }

  // 3) 联盟账号绑定的发布网站首页
  if (m.platform_connection_id) {
    const conn = await prisma.platform_connections.findFirst({
      where: { id: m.platform_connection_id, is_deleted: 0 },
      select: { publish_site_id: true },
    })
    if (conn?.publish_site_id) {
      const site = await prisma.publish_sites.findFirst({
        where: { id: conn.publish_site_id, is_deleted: 0 },
        select: { domain: true },
      })
      const domain = site?.domain?.trim()
      if (domain) return { url: normalizeSiteUrl(domain), source: 'website' }
    }
  }

  return { url: null, source: 'none' }
}
