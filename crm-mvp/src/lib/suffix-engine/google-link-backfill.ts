/**
 * Google 回拉联盟链接（自愈链路 fallback）
 *
 * 场景：广告系列断链（孤儿/未匹配/商家缺链接），但该系列在 Google Ads 上仍带着发布时写入的
 * 联盟追踪后缀。完整联盟链接 = ad.final_url + (? | &) + campaign.final_url_suffix
 * （与服务器一次性「Google回填」脚本同源逻辑）。本函数从 Google Ads API 拉回后缀重建链接，
 * 自动接回/新建商家并写入 tracking_link，作为「CRM 商家同步拿不到链接」时的兜底。
 *
 * 注意：受 Google Ads API 配额限制，调用方应自行限流（见 merchant-link-health 的 budget）。
 */

import { prisma } from '@/lib/prisma'
import { queryGoogleAds } from '@/lib/google-ads/client'
import { ensureCampaignMerchant } from '@/lib/campaign-merchant-link'
import { resolveAlertsByType } from './alerts'

export interface BrokenCampaignRef {
  id: bigint
  google_campaign_id: string | null
  customer_id: string | null
  mcc_id: bigint | null
  campaign_name: string | null
  target_country: string | null
  user_merchant_id: bigint | null
}

export interface BackfillResult {
  ok: boolean
  reason: string
  merchantId?: string
  link?: string
}

/** 重建联盟链接：final_url + (? | &) + final_url_suffix；仅当 suffix 非空才有意义 */
function buildAffiliateUrl(finalUrl: string | null, suffix: string | null): string | null {
  const s = (suffix || '').trim()
  if (!s) return null
  const base = (finalUrl || '').trim()
  if (!base) {
    // 无落地页基址时，suffix 偶尔本身即完整可跟链 URL；否则无法重建
    return /^https?:\/\//i.test(s) ? s : null
  }
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}${s}`
}

export async function backfillTrackingLinkFromGoogle(
  userId: bigint,
  campaign: BrokenCampaignRef,
): Promise<BackfillResult> {
  if (!campaign.google_campaign_id || !campaign.customer_id || !campaign.mcc_id) {
    return { ok: false, reason: 'missing_google_ref' }
  }

  const mcc = await prisma.google_mcc_accounts.findFirst({
    where: { id: campaign.mcc_id, user_id: userId, is_deleted: 0 },
    select: { mcc_id: true, service_account_json: true, developer_token: true },
  })
  if (!mcc?.service_account_json || !mcc.developer_token) {
    return { ok: false, reason: 'no_mcc_credentials' }
  }

  const credentials = {
    mcc_id: mcc.mcc_id,
    developer_token: mcc.developer_token,
    service_account_json: mcc.service_account_json,
  }
  const gcid = campaign.google_campaign_id

  let suffix: string | null = null
  let finalUrl: string | null = null
  try {
    const rows = await queryGoogleAds(
      credentials,
      campaign.customer_id,
      `SELECT campaign.id, campaign.final_url_suffix FROM campaign WHERE campaign.id = ${gcid}`,
    )
    for (const r of rows) {
      const c = r.campaign as Record<string, unknown> | undefined
      const s = c?.finalUrlSuffix
      if (typeof s === 'string' && s.trim()) {
        suffix = s.trim()
        break
      }
    }
    if (suffix) {
      const adRows = await queryGoogleAds(
        credentials,
        campaign.customer_id,
        `SELECT ad_group_ad.ad.final_urls FROM ad_group_ad WHERE campaign.id = ${gcid} LIMIT 5`,
      )
      for (const r of adRows) {
        const ad = (r.adGroupAd as Record<string, unknown> | undefined)?.ad as Record<string, unknown> | undefined
        const urls = ad?.finalUrls
        if (Array.isArray(urls) && urls.length > 0 && typeof urls[0] === 'string') {
          finalUrl = urls[0]
          break
        }
      }
    }
  } catch (e) {
    return { ok: false, reason: `google_query_failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) }
  }

  const link = buildAffiliateUrl(finalUrl, suffix)
  if (!link || !/^https?:\/\//i.test(link)) {
    return { ok: false, reason: 'no_suffix_or_url' }
  }

  const merchantId = await ensureCampaignMerchant(userId, campaign)
  if (!merchantId) return { ok: false, reason: 'merchant_unresolvable' }

  // 仅当 suffix 非空才写（与一次性 Google回填 脚本一致）；写后重置校验状态等待重新巡航
  await prisma.user_merchants.update({
    where: { id: merchantId },
    data: {
      tracking_link: link,
      campaign_link: link,
      tracking_status: 'unchecked',
      link_status: 'unchecked',
      parent_network: null,
      parent_blacklisted: 0,
      parent_checked_at: null,
      parent_check_reason: null,
    },
  })
  await resolveAlertsByType(userId, campaign.id, ['merchant_not_found'])

  return { ok: true, reason: 'recovered', merchantId: merchantId.toString(), link }
}
