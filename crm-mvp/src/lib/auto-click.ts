/**
 * 需求2：订单/点击比控制刷点击 —— 决策引擎（定版）
 *
 * 目标：让「订单/点击」落在 5%~10%（即每订单 10~20 次联盟点击），避免转化率过高被联盟风控。
 *
 * 逻辑（每个「已启用换链、已匹配带追踪链接商家」的广告系列，含已暂停——
 * 广告暂停后订单仍随 cookie 归因回传数天，同样必须按比例补点击，否则出现「只有订单没有点击」）：
 *   O = 最近 ARRIVAL_WINDOW_DAYS 天「入库」的该商家联盟订单数
 *   C = 同窗口该商家真实联盟点击（affiliate_click_daily）+ 我们已排程/已执行但可能尚未回流到聚合表的点击
 *   目标 T = O×rand(cpoMin,cpoMax)：订单倒推「应有点击数」，使转化率落在用户区间内。
 *   缺口 deficit = T − C；deficit ≤ 0 不刷；单轮封顶 MAX_DEFICIT_PER_ROUND，余量下轮续补。
 *   补刷窗口：紧急（几乎零点击）30 分钟内铺完，其余 120 分钟。click-execute 按 scheduled_at 先到先执行，
 *     故「窗口更短」天然等价于「优先级更高」——产能不足时先洗最扎眼的商家（D-207）。
 *   补刷复用 click-brush（startBrushTaskWindowed）。
 *
 * ★ D-207 口径改为「按订单入库时间」计账（07 2026-08-01 拍板）：
 *   原口径 O 只数「当天(CST)交易时间」的订单，但生产实测各平台订单回传严重滞后——
 *   MUI 仅 5.9% 的订单在自己那天入库（平均延迟 37h、最快 12h），RW 19.3%、LB 20.8%、BSH 27.3%。
 *   于是 94% 的 MUI 订单进 CRM 时「它那天」已过去，O(今天)=0 → skippedNoOrders 静默跳过，
 *   一次点击都不补也不报警 → 联盟后台长期呈现「有订单没有点击」（07 已反馈 6 次，见 D-182）。
 *   改为按「入库时间」滚动窗口后，隔天甚至隔 4 天才回传的订单一样会被补刷；
 *   自然点击照常抵扣（不抵扣的话全站日需 28,738 次点击，是执行器产能的 5.7 倍，不可行）。
 *   代价：点击落在「订单入库当天」而非「下单当天」，单日比例会前后错位——37h 的回传延迟下
 *   单日纯净本就物理不可能，滚动窗口保证的是周期比例与「有单无点击」这个硬伤不再出现。
 *
 * ★ 历史欠账不追补（07 拍板）：游标 system_configs(auto_click_debt_cutoff) 首轮初始化为「当时」，
 *   只有入库时间晚于游标的订单才计欠账。否则首轮会一次性吃下近 3 天约 15,400 次积压缺口，
 *   把低配机的执行队列彻底堵死。
 *
 * 触发：订单同步后（ontxn，见 txn-quick-sync 钩子）；仅对开启 click_control_enabled 的用户生效。
 */

import prisma from '@/lib/prisma'
import { todayCST, parseCSTDateEndExclusive } from '@/lib/date-utils'
import { normalizePlatformCode } from '@/lib/constants'
import { PLATFORM_CLICK_CONFIG } from '@/lib/platform-api'
import { randomInt } from '@/lib/suffix-engine/click-scheduler'
import { startBrushTaskWindowed } from '@/lib/suffix-engine/click-brush'
import { loadConnectionAliasMap, pickCampaignAffiliateLink } from '@/lib/merchant-connection'
import { raiseAlert, resolveAlertsByType } from '@/lib/suffix-engine/alerts'

/** 转化率目标改为按用户配置（click_control_ratio_min/max_pct）运行时计算，默认 5%~10%（每订单 10~20 点击） */
/**
 * 无点击 API 但仍需补刷的平台。
 * RW 的 click API 恒返回 total:0（38c90882 已从 PLATFORM_CLICK_CONFIG 摘除），
 * 但补刷不依赖平台点击回流：C 用我方 kyads_click_task_items 成功/在途数兜底（见 effectiveC）。
 * 若这里不放行，RW 会被「无点击 API 跳过」门卫整平台断供补刷——
 * 7-01~7-03 全站 RW 出现「只有订单没有点击」（yz03 Notino/GameCollection/AEO 等）即此回归。
 */
const BRUSHABLE_WITHOUT_CLICK_API = new Set(['RW'])
/**
 * D-207 欠账窗口：按「订单入库时间」回看几天。
 * 需覆盖各平台的订单回传延迟（MUI 平均 37h），又不能长到把陈年欠账一直背在身上。
 */
const ARRIVAL_WINDOW_DAYS = 3
/** 单个商家单轮补刷上限，余量下轮（每 30min）续补，避免一次性砸出不自然的尖峰 */
const MAX_DEFICIT_PER_ROUND = 80
/** 欠账起算游标：首轮写入「当时」，只对之后入库的订单计账（不追补历史，07 拍板） */
const DEBT_CUTOFF_KEY = 'auto_click_debt_cutoff'

/** UTC+8 日期串 → affiliate_click_daily.click_date 对应的 DATE */
function clickDateToDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`)
}

/**
 * 读取欠账起算游标；不存在则以「当前时刻」初始化并返回。
 * 首轮初始化保证不追补历史积压（07 拍板），之后该游标只作为窗口下界兜底。
 */
async function readOrInitDebtCutoff(): Promise<Date> {
  const row = await prisma.system_configs.findUnique({ where: { config_key: DEBT_CUTOFF_KEY } })
  if (row && row.is_deleted === 0 && row.config_value) {
    const t = new Date(row.config_value)
    if (!Number.isNaN(t.getTime())) return t
  }
  const now = new Date()
  await prisma.system_configs
    .upsert({
      where: { config_key: DEBT_CUTOFF_KEY },
      create: {
        config_key: DEBT_CUTOFF_KEY,
        config_value: now.toISOString(),
        description: 'D-207 订单欠账制补刷的起算时刻（UTC ISO）；只对之后入库的订单计欠账，不追补历史',
        is_deleted: 0,
      },
      update: { config_value: now.toISOString(), is_deleted: 0 },
    })
    .catch(() => {})
  return now
}

/**
 * 欠账窗口边界：订单侧按「入库时间」取 [windowStart, now]，点击侧按自然日取 windowClickDates。
 * windowStart 不早于欠账起算游标（不追补历史）。
 */
async function resolveDebtWindow(): Promise<{ windowStart: Date; windowClickDates: Date[] }> {
  const now = new Date()
  const cutoff = await readOrInitDebtCutoff()
  const windowStart = new Date(Math.max(now.getTime() - ARRIVAL_WINDOW_DAYS * 86_400_000, cutoff.getTime()))
  const todayDate = clickDateToDate(todayCST())
  // windowStart 所在的 CST 自然日（+8h 后取 ISO 日期部分）
  const startDayStr = new Date(windowStart.getTime() + 8 * 3_600_000).toISOString().slice(0, 10)
  const windowClickDates: Date[] = []
  for (let cursor = clickDateToDate(startDayStr); cursor <= todayDate; cursor = new Date(cursor.getTime() + 86_400_000)) {
    windowClickDates.push(cursor)
  }
  return { windowStart, windowClickDates }
}

export interface AutoClickResult {
  campaignsConsidered: number
  scheduled: number // 触发了补刷的系列数
  clicksScheduled: number // 排程的点击总数
  skippedRatioOk: number // C 已达标跳过
  skippedNoBaseline: number // 无基线数据跳过（D-207 后不再使用，保留字段兼容调用方）
  skippedNoOrders: number // 欠账窗口内无新入库订单跳过
  /** D-207 看板指标：本轮识别出的缺口总量（含被单轮上限截掉的部分） */
  deficitIdentified: number
  /** D-207 看板指标：其中「几乎零点击」的紧急商家数（优先排程） */
  urgentScheduled: number
  details: string[]
}

/**
 * 为某用户运行订单/点击比补刷。
 * @param onlyMerchantKeys 限定只处理这些「platform:merchant_id」（ontxn 钩子只传有新订单的商家）；不传=扫描全部启用系列
 */
export async function runAutoClickForUser(
  userId: bigint,
  onlyMerchantKeys?: Set<string>,
): Promise<AutoClickResult> {
  const res: AutoClickResult = {
    campaignsConsidered: 0,
    scheduled: 0,
    clicksScheduled: 0,
    skippedRatioOk: 0,
    skippedNoBaseline: 0,
    skippedNoOrders: 0,
    deficitIdentified: 0,
    urgentScheduled: 0,
    details: [],
  }

  // 用户级开关 + 转化率(订单/点击)区间配置。
  // ★ link_exchange_disabled=1（jy 交垟队等「只同步数据、不参与换链接/刷点击」）一律不补刷：
  //   此前 auto-click 只查 click_control_enabled，jy 组该开关仍为 1，导致订单同步后仍自动补刷，
  //   违反「只记录数据」约定（实测 jy06/jy09 RW 仍被刷）。在补刷唯一决策入口堵死。
  const user = await prisma.users.findFirst({
    where: { id: userId, is_deleted: 0, status: 'active', click_control_enabled: 1, link_exchange_disabled: 0 },
    select: { id: true, click_control_ratio_min_pct: true, click_control_ratio_max_pct: true },
  })
  if (!user) return res

  // 转化率区间(%) → 每订单点击数区间：cpoMin=100/maxPct, cpoMax=100/minPct
  // 例：5%~10% → 每订单 10~20 次点击。无效配置回退默认（RATIO_MIN/MAX）。
  const minPct = user.click_control_ratio_min_pct > 0 ? user.click_control_ratio_min_pct : 5
  const maxPct = user.click_control_ratio_max_pct > minPct ? user.click_control_ratio_max_pct : Math.max(minPct + 1, 10)
  const cpoMin = Math.max(1, Math.round(100 / maxPct)) // 达标所需最少点击/订单（C≥O×cpoMin ⇒ 转化率≤maxPct）
  const cpoMax = Math.max(cpoMin + 1, Math.round(100 / minPct)) // 补刷目标上限点击/订单

  // 候选系列：已启用换链、已匹配商家。
  // ★ active + paused 都参与：广告暂停后订单仍随 cookie 归因回传数天，联盟侧转化率风控
  //   与 Google 状态无关；只看 active 会造成「暂停商家只有订单没有点击」（wj02 Ballboyz 事故）。
  const allCampaigns = await prisma.campaigns.findMany({
    where: {
      user_id: userId,
      status: { in: ['active', 'paused'] },
      is_deleted: 0,
      suffix_exchange_enabled: 1,
      user_merchant_id: { not: BigInt(0) },
    },
    select: { id: true, user_merchant_id: true, campaign_name: true, platform_connection_id: true, status: true, google_status: true },
  })
  // 每个 (商家×连接) 只保留一个「载体」系列，优先 active+ENABLED > active > 最新的暂停系列，
  // 防止同商家多系列重复计算缺口、重复下任务。
  const rankOf = (c: { status: string; google_status: string | null }) =>
    c.status === 'active' && c.google_status === 'ENABLED' ? 2 : c.status === 'active' ? 1 : 0
  const byMerchantConn = new Map<string, (typeof allCampaigns)[number]>()
  const campaignIdsByKey = new Map<string, bigint[]>()
  for (const c of allCampaigns) {
    const key = `${c.user_merchant_id}:${c.platform_connection_id ?? 'null'}`
    const prev = byMerchantConn.get(key)
    if (!prev || rankOf(c) > rankOf(prev) || (rankOf(c) === rankOf(prev) && c.id > prev.id)) {
      byMerchantConn.set(key, c)
    }
    const ids = campaignIdsByKey.get(key) ?? []
    ids.push(c.id)
    campaignIdsByKey.set(key, ids)
  }
  const campaigns = [...byMerchantConn.values()]
  if (campaigns.length === 0) return res

  // 关联商家（platform / merchant_id / 各账号链接）
  const merchantIds = [...new Set(campaigns.map((c) => c.user_merchant_id).filter((id): id is bigint => !!id && id > BigInt(0)))]
  const merchants = await prisma.user_merchants.findMany({
    where: { id: { in: merchantIds }, user_id: userId, is_deleted: 0 },
    select: { id: true, platform: true, merchant_id: true, tracking_link: true, campaign_link: true, connection_campaign_links: true, platform_connection_id: true },
  })
  const merchantById = new Map(merchants.map((m) => [m.id.toString(), m]))
  // D-192：同一联盟账号被重复录成多条连接时，链接可能挂在另一条名下，取链接需按账号等价放行
  const connAliasMap = await loadConnectionAliasMap(userId)

  // 时间边界
  const todayStr = todayCST()
  const todayEndUTC = parseCSTDateEndExclusive(todayStr)
  const now = new Date()

  // D-207 欠账窗口：订单按入库时间回看 ARRIVAL_WINDOW_DAYS 天，点击侧天粒度对齐。
  // 天粒度会把「窗口起点当天、窗口开始前」的点击也算成抵扣，方向偏保守（少补），可接受。
  const { windowStart, windowClickDates } = await resolveDebtWindow()

  for (const c of campaigns) {
    const merchant = c.user_merchant_id ? merchantById.get(c.user_merchant_id.toString()) : undefined
    if (!merchant) continue
    const platform = normalizePlatformCode(merchant.platform || '')
    const mid = merchant.merchant_id || ''
    if (!platform || !mid) continue
    // 无点击 API 的平台默认跳过（无法控比）；白名单平台（RW）例外：
    // C 用我方任务成功/在途数兜底，只是看不到自然点击 → 至多多补一点，方向保守安全。
    if (!PLATFORM_CLICK_CONFIG[platform] && !BRUSHABLE_WITHOUT_CLICK_API.has(platform)) continue

    // 该广告归属的联盟账号（连接）。建广告时写入，是「这条广告用哪个号」的唯一可靠依据。
    // NULL=存量未回填，pickCampaignAffiliateLink 回退旧逻辑（主连接/tracking_link）。
    const connId = c.platform_connection_id ?? null

    if (onlyMerchantKeys && !onlyMerchantKeys.has(`${platform}:${mid}`)) continue

    res.campaignsConsidered++

    // O：欠账窗口内「入库」的订单数（D-207：按 created_at 而非 transaction_time——
    // 各平台订单回传延迟 12h~4 天，按交易时间数会让 94% 的 MUI 订单永远数不到，见文件头注释）。
    // 按该广告归属账号 platform_connection_id 拆分（affiliate_transactions 每行带真实连接，可靠可拆）；
    // 没出单的号 O=0 直接跳过，不会被误补刷（wj02 CG1/CG2 串号根治点）。
    // connId=NULL（存量未回填）时不按连接拆，退化为商家级（合并口径），行为与旧版一致。
    const O = await prisma.affiliate_transactions.count({
      where: {
        user_id: userId,
        platform,
        merchant_id: mid,
        ...(connId != null ? { platform_connection_id: connId } : {}),
        is_deleted: 0,
        created_at: { gte: windowStart },
      },
    })
    if (O <= 0) {
      res.skippedNoOrders++
      continue
    }

    // ★ 有订单 → 当天必须净化转化率。此时才校验链接：拿不到该号链接 = 「该刷却刷不了」，
    // 不再静默跳过，而是报警挂人工（D-186）——正是 lenstore 7/15「有单无链接被跳过」的堵漏。
    // 账号感知选链接：宁可不刷（也不刷到没配链接/别的号），但必须让人看见。
    const affiliateUrl = pickCampaignAffiliateLink(connId, merchant, connAliasMap)
    if (!affiliateUrl) {
      await raiseAlert(userId, {
        type: 'brush_blocked',
        campaignId: c.id,
        level: 'error',
        message: `广告系列「${c.campaign_name ?? c.id.toString()}」近 ${ARRIVAL_WINDOW_DAYS} 天入库 ${O} 单，但其所属联盟账号未配置追踪链接，无法补刷净化转化率，需人工补链接`,
        context: { platform, merchantId: mid, connId: connId != null ? connId.toString() : null, ordersInWindow: O },
      }).catch(() => {})
      res.details.push(`${platform}:${mid} O=${O} 无链接→挂人工`)
      continue
    }

    // C：欠账窗口内的真实点击（聚合表，天粒度）。
    // 注意：affiliate_click_daily 唯一键为 (user_id, platform, merchant_id, click_date)，不含连接，
    // 同商家跨账号的点击被合并成一行，无法按 connId 拆分，故 C 保持商家级（合并口径）。
    // 影响仅为「保守」：合并 C 偏大 → 至多少补一点，绝不会导致刷到错号（错号已被 O=0 拦下）。
    const windowAgg = await prisma.affiliate_click_daily.aggregate({
      where: { user_id: userId, platform, merchant_id: mid, click_date: { in: windowClickDates }, is_deleted: 0 },
      _sum: { clicks: true },
    })
    const realClicksInWindow = windowAgg._sum.clicks ?? 0

    // 我方在同窗口已排程/执行的点击（同商家×同连接的全部系列 → 任务 → 子项，避免载体系列切换后漏计已排点击）
    const keyForC = `${c.user_merchant_id}:${c.platform_connection_id ?? 'null'}`
    const siblingCampaignIds = campaignIdsByKey.get(keyForC) ?? [c.id]
    const windowTasks = await prisma.kyads_click_tasks.findMany({
      where: { campaign_id: { in: siblingCampaignIds }, user_id: userId, is_deleted: 0, created_at: { gte: windowStart } },
      select: { id: true },
    })
    const windowTaskIds = windowTasks.map((t) => t.id)
    let ourSuccess = 0
    let ourPending = 0
    if (windowTaskIds.length > 0) {
      ;[ourSuccess, ourPending] = await Promise.all([
        prisma.kyads_click_task_items.count({ where: { task_id: { in: windowTaskIds }, status: 'success', is_deleted: 0 } }),
        prisma.kyads_click_task_items.count({ where: { task_id: { in: windowTaskIds }, status: { in: ['pending', 'executing'] }, is_deleted: 0 } }),
      ])
    }

    // 估算窗口内在途点击 C：
    //   max(聚合表窗口内, 我方窗口内已成功)  —— 聚合表回流后用其(含自然点击)，未回流的平台(RW)用我方成功数兜底
    //   + 我方待执行(pending/executing) —— 即将成为点击，计入避免重复补
    const effectiveC = Math.max(realClicksInWindow, ourSuccess) + ourPending

    // 比值已达标（C ≥ O×cpoMin ⇒ 转化率 ≤ maxPct）→ 不刷。
    // 自然点击充足的商家在这里就被放行，这是把日需求从 28,738 压回 ~10,482 次的关键。
    if (effectiveC >= O * cpoMin) {
      res.skippedRatioOk++
      continue
    }

    // 目标 T = O×rand(cpoMin,cpoMax)：订单倒推「应有点击数」，使转化率(订单/点击)落在区间内。
    // 例：区间 5%~10% → 每订单 10~20 点击；O=2 → T=20~40。
    const T = O * randomInt(cpoMin, cpoMax)
    const fullDeficit = T - effectiveC
    if (fullDeficit <= 0) {
      res.skippedRatioOk++
      continue
    }
    res.deficitIdentified += fullDeficit
    // 单轮封顶：余量在下一轮（每 30min 的订单同步）续补。effectiveC 已含我方 pending，不会重复下单。
    const deficit = Math.min(fullDeficit, MAX_DEFICIT_PER_ROUND)

    // 优先级（D-207）：click-execute 按 scheduled_at 先到先执行，故「窗口越短 = 优先级越高」。
    // 几乎零点击的商家（联盟侧看到的转化率是目标上限的 3 倍以上）最扎眼，压到 30 分钟内洗完；
    // 其余铺 120 分钟。产能不足时，先被消化的自然是最危险的那批。
    const urgent = effectiveC * 3 < O * cpoMin
    if (urgent) res.urgentScheduled++
    // 距当日 CST 午夜的剩余分钟：仅用于避免把任务铺过午夜（跨日的点击对任何一天都不自然）。
    const minutesToMidnight = Math.max(1, Math.floor((todayEndUTC.getTime() - now.getTime()) / 60_000))
    const windowMinutes = Math.min(urgent ? 30 : 120, minutesToMidnight)
    const r = await startBrushTaskWindowed(c.id, userId, deficit, windowMinutes)
    if (r.ok) {
      res.scheduled++
      res.clicksScheduled += r.target
      res.details.push(
        `${platform}:${mid} O=${O}(入库${ARRIVAL_WINDOW_DAYS}天) C=${effectiveC} T=${T} 缺${fullDeficit} 铺${r.target}点击/${windowMinutes}min${urgent ? ' [紧急]' : ''}`,
      )
      // 补刷任务已成功创建 → 清掉该系列的「补刷受阻」挂人工告警（若有）。
      await resolveAlertsByType(userId, c.id, ['brush_blocked']).catch(() => {})
    } else {
      // 有订单、需补刷，但补刷任务创建失败（无链接/其他）→ 净化落空，报警挂人工（D-186）。
      await raiseAlert(userId, {
        type: 'brush_blocked',
        campaignId: c.id,
        level: 'error',
        message: `广告系列「${c.campaign_name ?? c.id.toString()}」近 ${ARRIVAL_WINDOW_DAYS} 天入库 ${O} 单、需补刷 ${deficit} 次，但补刷任务创建失败：${r.message}，需人工介入`,
        context: { platform, merchantId: mid, connId: connId != null ? connId.toString() : null, ordersInWindow: O, deficit, reason: r.message },
      }).catch(() => {})
      res.details.push(`${platform}:${mid} 补刷失败→挂人工: ${r.message}`)
    }
  }

  return res
}

export interface ClickDebtItem {
  platform: string
  merchantId: string
  orders: number
  clicks: number
  deficit: number
}
export interface ClickDebtSummary {
  windowDays: number
  /** 仍欠点击的商家数 */
  merchantsInDebt: number
  /** 欠账点击总量（未被自然点击与在途任务抵扣掉的部分） */
  deficitClicks: number
  /** 欠得最多的商家（看板列表用） */
  worst: ClickDebtItem[]
}

/**
 * D-207 看板指标：与补刷引擎完全同口径地算出「当前还欠多少点击」。
 * 07 定版「做成看板指标而不是告警」——补刷因口径/产能原因没跟上时，必须在换链接看板上看得见，
 * 而不是像旧版 skippedNoOrders 那样静默计数（正是「反馈 5 次都以为修好了」的直接原因）。
 */
export async function computeClickDebtSummary(userId: bigint, topN = 8): Promise<ClickDebtSummary> {
  const empty: ClickDebtSummary = { windowDays: ARRIVAL_WINDOW_DAYS, merchantsInDebt: 0, deficitClicks: 0, worst: [] }

  const user = await prisma.users.findFirst({
    where: { id: userId, is_deleted: 0, status: 'active', click_control_enabled: 1, link_exchange_disabled: 0 },
    select: { click_control_ratio_max_pct: true },
  })
  if (!user) return empty
  const maxPct = user.click_control_ratio_max_pct > 0 ? user.click_control_ratio_max_pct : 10
  const cpoMin = Math.max(1, Math.round(100 / maxPct))

  const { windowStart, windowClickDates } = await resolveDebtWindow()

  const [orderRows, clickRows] = await Promise.all([
    prisma.affiliate_transactions.groupBy({
      by: ['platform', 'merchant_id'],
      where: { user_id: userId, is_deleted: 0, created_at: { gte: windowStart } },
      _count: { _all: true },
    }),
    prisma.affiliate_click_daily.groupBy({
      by: ['platform', 'merchant_id'],
      where: { user_id: userId, is_deleted: 0, click_date: { in: windowClickDates } },
      _sum: { clicks: true },
    }),
  ])
  if (orderRows.length === 0) return empty

  const clicksByKey = new Map<string, number>()
  for (const r of clickRows) clicksByKey.set(`${normalizePlatformCode(r.platform)}:${r.merchant_id}`, r._sum.clicks ?? 0)

  // 我方在途/已成功但尚未回流的点击也算抵扣，否则正在补的商家会被重复计成欠账
  const ourByKey = new Map<string, number>()
  const tasks = await prisma.kyads_click_tasks.findMany({
    where: { user_id: userId, is_deleted: 0, created_at: { gte: windowStart } },
    select: { id: true, campaign_id: true },
  })
  if (tasks.length > 0) {
    const itemRows = await prisma.kyads_click_task_items.groupBy({
      by: ['task_id'],
      where: { task_id: { in: tasks.map((t) => t.id) }, is_deleted: 0, status: { in: ['success', 'pending', 'executing'] } },
      _count: { _all: true },
    })
    const countByTask = new Map(itemRows.map((r) => [r.task_id.toString(), r._count._all]))
    const campaigns = await prisma.campaigns.findMany({
      where: { id: { in: [...new Set(tasks.map((t) => t.campaign_id))] }, is_deleted: 0 },
      select: { id: true, user_merchant_id: true },
    })
    const merchantByCampaign = new Map(campaigns.map((c) => [c.id.toString(), c.user_merchant_id]))
    const merchantRows = await prisma.user_merchants.findMany({
      where: { id: { in: [...new Set(campaigns.map((c) => c.user_merchant_id).filter((id) => !!id && id > BigInt(0)))] }, is_deleted: 0 },
      select: { id: true, platform: true, merchant_id: true },
    })
    const keyByMerchant = new Map(
      merchantRows.map((m) => [m.id.toString(), `${normalizePlatformCode(m.platform || '')}:${m.merchant_id || ''}`]),
    )
    for (const t of tasks) {
      const umId = merchantByCampaign.get(t.campaign_id.toString())
      const key = umId ? keyByMerchant.get(umId.toString()) : undefined
      if (!key) continue
      ourByKey.set(key, (ourByKey.get(key) ?? 0) + (countByTask.get(t.id.toString()) ?? 0))
    }
  }

  const items: ClickDebtItem[] = []
  for (const r of orderRows) {
    const platform = normalizePlatformCode(r.platform)
    if (!PLATFORM_CLICK_CONFIG[platform] && !BRUSHABLE_WITHOUT_CLICK_API.has(platform)) continue
    const key = `${platform}:${r.merchant_id}`
    const orders = r._count._all
    const realClicks = clicksByKey.get(key) ?? 0
    const credit = Math.max(realClicks, ourByKey.get(key) ?? 0)
    const deficit = orders * cpoMin - credit
    if (deficit > 0) items.push({ platform, merchantId: r.merchant_id, orders, clicks: realClicks, deficit })
  }
  items.sort((a, b) => b.deficit - a.deficit)

  return {
    windowDays: ARRIVAL_WINDOW_DAYS,
    merchantsInDebt: items.length,
    deficitClicks: items.reduce((s, i) => s + i.deficit, 0),
    worst: items.slice(0, topN),
  }
}
