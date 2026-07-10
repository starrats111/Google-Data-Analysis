/**
 * kylink 自动配置同步编排
 *
 * 对每个已配置 kylink API Key 的用户：
 * 1. 读取 kylink「未配置」广告系列
 * 2. 按广告系列名解析「平台 + mid」，在 CRM 商家库 user_merchants 查联盟链接
 * 3. 命中则回填到 kylink（POST inbound）；未命中保持原样（计入失败/未匹配）
 * 4. 回写当日成功/失败统计到 kylink
 *
 * 注：只回填 kylink 中「未配置」的广告系列，不覆盖用户已手动配置的链接。
 */

import { prisma } from '@/lib/prisma'
import { PLATFORMS } from '@/lib/constants'
import {
  listMissingCampaigns,
  pushInboundAffiliateLink,
  reportSyncStats,
  KylinkApiError,
  type KylinkMissingCampaign,
} from '@/lib/kylink-client'

const VALID_PLATFORM_CODES = new Set<string>(PLATFORMS.map((p) => p.code))

export interface UserSyncResult {
  userId: string
  username: string
  total: number
  success: number
  failed: number
  error?: string
}

export interface SyncRunResult {
  users: number
  totalSuccess: number
  totalFailed: number
  details: UserSyncResult[]
}

interface ParsedName {
  platform: string
  mid: string
  country: string | null
}

/**
 * 解析广告系列名 → 平台 + mid（+ 国家段）。
 * 规则与 CRM Google Ads 换链脚本一致：
 *   序号-平台-商家-国家-日期-MID，平台去尾数字（PM1→PM），mid 取最后一段。
 */
export function parseCampaignNameForLookup(campaignName: string | null): ParsedName | null {
  if (!campaignName) return null
  const parts = campaignName.split('-')
  if (parts.length < 3) return null

  const platform = parts[1].trim().toUpperCase().replace(/[0-9]+$/, '')
  const mid = parts[parts.length - 1].trim()
  if (!VALID_PLATFORM_CODES.has(platform) || !mid) return null

  // 国家段（按命名规范为 parts[3]，可能不存在或被自定义）
  let country: string | null = null
  if (parts.length >= 4) {
    const seg = parts[3].trim().toUpperCase()
    if (/^[A-Z]{2,3}$/.test(seg)) country = seg
  }

  return { platform, mid, country }
}

/** 从商家行解析联盟链接：账号级 > 通用 campaign_link > tracking_link */
function resolveMerchantLink(merchant: {
  platform_connection_id: bigint | null
  connection_campaign_links: unknown
  campaign_link: string | null
  tracking_link: string | null
}): string {
  let url = ''
  const connLinks = (merchant.connection_campaign_links || null) as Record<string, string> | null
  if (connLinks && merchant.platform_connection_id) {
    url = String(connLinks[String(merchant.platform_connection_id)] || '').trim()
  }
  if (!url) url = String(merchant.campaign_link || '').trim()
  if (!url) url = String(merchant.tracking_link || '').trim()
  return url
}

/** 同步单个用户 */
export async function syncOneUser(params: {
  userId: bigint
  username: string
  apiKey: string
}): Promise<UserSyncResult> {
  const { userId, username, apiKey } = params
  const result: UserSyncResult = {
    userId: userId.toString(),
    username,
    total: 0,
    success: 0,
    failed: 0,
  }

  let missing: KylinkMissingCampaign[]
  try {
    missing = await listMissingCampaigns(apiKey)
  } catch (e) {
    result.error = e instanceof KylinkApiError ? e.message : 'kylink 拉取未配置列表失败'
    // 拉取失败：不回写统计（避免覆盖），直接返回
    return result
  }

  result.total = missing.length

  // 失败原因收集：此前逐系列 catch 后只 failed++，同一系列可连续失败数小时无人知晓（LE-01 #3）
  const failures: string[] = []
  const fail = (campaign: KylinkMissingCampaign, reason: string) => {
    result.failed++
    failures.push(`「${campaign.campaignName ?? campaign.campaignId}」${reason}`)
  }

  for (const campaign of missing) {
    const parsed = parseCampaignNameForLookup(campaign.campaignName)
    if (!parsed) {
      fail(campaign, '系列名无法解析出 平台+MID')
      continue
    }

    // 优先用「2-3 位字母」的干净国家码；否则回退广告系列名解析出的国家段，再回退原始值。
    // 避免 campaign.country 为全称/国家列表（VarChar(500)）时 inbound 因无法识别国家而误判失败。
    const rawCountry = (campaign.country || '').trim()
    const country = /^[A-Za-z]{2,3}$/.test(rawCountry) ? rawCountry : (parsed.country || rawCountry)
    if (!country) {
      fail(campaign, '无法确定国家')
      continue
    }

    try {
      const merchantSelect = {
        platform: true,
        platform_connection_id: true,
        connection_campaign_links: true,
        campaign_link: true,
        tracking_link: true,
      } as const
      let merchant = await prisma.user_merchants.findFirst({
        where: {
          user_id: userId,
          platform: parsed.platform,
          merchant_id: parsed.mid,
          is_deleted: 0,
        },
        select: merchantSelect,
      })

      // 平台段回退：kylink 系列名的平台段可能与商家实际平台不一致（如系列名写 MUI1、
      // 商家实际在 RW，wj07 johnnieO/106836 曾因此每轮静默失败）。
      // 按 MID 跨平台查，仅当「全库唯一命中」才采用，避免多平台同 MID 时串错链接。
      let fallbackPlatform: string | null = null
      if (!merchant) {
        const byMid = await prisma.user_merchants.findMany({
          where: { user_id: userId, merchant_id: parsed.mid, is_deleted: 0 },
          select: merchantSelect,
          take: 2,
        })
        if (byMid.length === 1) {
          merchant = byMid[0]
          fallbackPlatform = byMid[0].platform
        }
      }

      const link = merchant ? resolveMerchantLink(merchant) : ''
      if (!link) {
        fail(campaign, merchant ? `商家(${parsed.platform}:${parsed.mid})缺联盟链接` : `商家库无 ${parsed.platform}:${parsed.mid}`)
        continue
      }

      await pushInboundAffiliateLink(apiKey, {
        campaignId: campaign.campaignId,
        affiliateLink: link,
        country,
        campaignName: campaign.campaignName ?? undefined,
      })
      result.success++
      if (fallbackPlatform) {
        console.log(
          `[kylink-sync] ${username} 「${campaign.campaignName}」平台段(${parsed.platform})与商家库不符，按 MID 唯一命中回退到 ${fallbackPlatform}`
        )
      }
    } catch (e) {
      fail(campaign, `回填失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (failures.length > 0) {
    console.warn(
      `[kylink-sync] ${username} 未回填 ${failures.length}/${result.total} 条: ` +
        failures.slice(0, 5).join(' | ') +
        (failures.length > 5 ? ` ...等${failures.length}条` : '')
    )
  }

  // 回写当日统计（失败不阻断）
  try {
    await reportSyncStats(apiKey, { success: result.success, failed: result.failed })
  } catch {
    // 忽略回写失败
  }

  // 刷新关联时间
  try {
    await prisma.users.update({
      where: { id: userId },
      data: { kylink_linked_at: new Date() },
    })
  } catch {
    // 忽略
  }

  return result
}

/** 同步所有已配置 kylink Key 的用户 */
export async function syncAllUsers(): Promise<SyncRunResult> {
  const users = await prisma.users.findMany({
    where: {
      is_deleted: 0,
      status: 'active',
      kylink_api_key: { not: null },
    },
    select: { id: true, username: true, kylink_api_key: true },
  })

  const details: UserSyncResult[] = []
  for (const u of users) {
    const res = await syncOneUser({
      userId: u.id,
      username: u.username,
      apiKey: u.kylink_api_key as string,
    })
    details.push(res)
  }

  return {
    users: users.length,
    totalSuccess: details.reduce((s, d) => s + d.success, 0),
    totalFailed: details.reduce((s, d) => s + d.failed, 0),
    details,
  }
}
