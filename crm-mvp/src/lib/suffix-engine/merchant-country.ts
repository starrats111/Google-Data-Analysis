/**
 * 商家巡航出口国的选取（D-222）
 *
 * `user_merchants.target_country` 149 万行里只有 5 千行有值，巡航原先一律兜底 'US'。
 * 联盟跳板普遍做出口国门禁（实测 collabglow 对英国商家：US/JP 出口 100% 403
 * `Not supporting traffic in this region`，GB 出口 200），美国出口去点非美国商家的链接
 * 必然 403，被 evaluate() 判成 tracker_forbidden，换链接页直接标红「失效」。
 *
 * 商家自己没记国家时，改用**它在投广告系列的投放国**——那才是这条链接真正要服务的地区。
 * 不回填那 149 万行空值，只在巡航取数那一刻现查。
 */
import { prisma } from '@/lib/prisma'

/** 单次 IN 分片大小（与本目录其它批量查询一致） */
const CHUNK = 500

type Rank = { active: boolean; count: number; newest: bigint; country: string }

/** a 是否比 b 更能代表该商家：在投优先 → 系列数多优先 → 系列更新优先 */
function better(a: Rank, b: Rank | undefined): boolean {
  if (!b) return true
  if (a.active !== b.active) return a.active
  if (a.count !== b.count) return a.count > b.count
  return a.newest > b.newest
}

/**
 * 批量取「商家 → 其广告系列投放国」。
 * 同一商家挂多个系列且投放国不一致时，取在投的、系列数最多的那个国家。
 * 返回 Map<商家id字符串, 大写国家码>；没有任何系列的商家不入 Map。
 */
export async function getMerchantCampaignCountries(
  merchantIds: (bigint | null | undefined)[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const ids = [...new Set(merchantIds.filter((id): id is bigint => !!id && id > BigInt(0)))]
  if (ids.length === 0) return out

  const best = new Map<string, Rank>()
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await prisma.campaigns.groupBy({
      by: ['user_merchant_id', 'target_country', 'status'],
      where: { user_merchant_id: { in: ids.slice(i, i + CHUNK) }, is_deleted: 0 },
      _count: { _all: true },
      _max: { id: true },
    })
    for (const r of rows) {
      const country = String(r.target_country || '').trim().toUpperCase()
      if (!country) continue
      const key = String(r.user_merchant_id)
      const rank: Rank = {
        active: r.status === 'active',
        count: r._count._all,
        newest: r._max.id ?? BigInt(0),
        country,
      }
      if (better(rank, best.get(key))) best.set(key, rank)
    }
  }

  for (const [key, rank] of best) out.set(key, rank.country)
  return out
}

/** 巡航出口国逐级兜底：商家自记国家 → 其广告系列投放国 → US */
export function pickCruiseCountry(
  merchantCountry: string | null | undefined,
  campaignCountry?: string | null,
): string {
  const own = String(merchantCountry || '').trim()
  if (own) return own.toUpperCase()
  const camp = String(campaignCountry || '').trim()
  if (camp) return camp.toUpperCase()
  return 'US'
}
