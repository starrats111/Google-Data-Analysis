/**
 * 需求2：联盟点击同步 —— 拉各平台 click API，聚合成「商家×自然日」计数写入 affiliate_click_daily。
 *
 * 设计（低配机保护）：
 *   - 每个 platform_connection 维护一个游标 system_configs(key=click_sync_cursor_{connId})，存上次同步到的 UTC+8 wall time。
 *   - 每轮从游标向 now 推进，但单轮最多拉 MAX_SPAN_HOURS（逐轮追平），避免一次拉爆。
 *   - click API 各平台窗口/限频由 fetchAllClicks 内部按 PLATFORM_CLICK_CONFIG 切片+sleep。
 *   - 仅同步「开启 click_control_enabled」的用户，省配额/资源。
 *   - 拉取成功才 upsert(increment) 并推进游标；失败不推进，下轮重试（避免漏/重复计数）。
 *   - 基线 B(过去7天日均) 由本表数据自然累积；首周数据不足时引擎按现有天数取均值并保守处理。
 *
 * ⚠️ CG/CF/BSH/EV 的 click_report 接口为 SaaS 同构推断，需真 token 联调验证后才会真正产出数据。
 */

import prisma from '@/lib/prisma'
import dayjs from 'dayjs'
import { normalizePlatformCode } from '@/lib/constants'
import { nowCST, TZ } from '@/lib/date-utils'
import { fetchAllClicks, PLATFORM_CLICK_CONFIG } from '@/lib/platform-api'

/** 单连接单轮最多拉取的时间跨度（小时）；逐轮追平到当前 */
const MAX_SPAN_HOURS = 6
/** 无游标首轮回拉跨度（小时） */
const INITIAL_SPAN_HOURS = 6
const CURSOR_PREFIX = 'click_sync_cursor_'

/**
 * 进程内「每连接同步锁」：PM2 单实例下，txn-quick-sync 的 scoped click-sync 与全量 click-sync cron
 * 跑在同一 Node 进程，若并发同步同一连接，会各自读到旧游标、拉同一窗口、双双 increment → 重复计数。
 * 用连接级内存锁串行化同连接的同步；被锁跳过的连接不推进游标，下轮/另一路自然补上，不丢数据。
 */
const syncingConns = new Set<string>()

/** UTC+8 日期串 → DATE 列对应的 Date（按该日历日存储） */
function clickDateToDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`)
}

async function readCursor(connId: bigint): Promise<string | null> {
  const row = await prisma.system_configs.findUnique({ where: { config_key: `${CURSOR_PREFIX}${connId}` } })
  return row && row.is_deleted === 0 ? (row.config_value ?? null) : null
}

async function writeCursor(connId: bigint, value: string): Promise<void> {
  await prisma.system_configs.upsert({
    where: { config_key: `${CURSOR_PREFIX}${connId}` },
    create: {
      config_key: `${CURSOR_PREFIX}${connId}`,
      config_value: value,
      description: `需求2 点击同步游标 (conn ${connId})；value=UTC+8 wall time`,
      is_deleted: 0,
    },
    update: { config_value: value, is_deleted: 0 },
  })
}

export interface ClickSyncResult {
  connectionsSynced: number
  rowsUpserted: number
  clicksCounted: number
  errors: string[]
}

/**
 * 同步单个用户「有点击 API」的连接的点击数据。
 * @param onlyPlatforms 仅同步这些平台代码（ontxn 场景只拉有新订单的平台，做到「点击随订单一起返回」）；不传=全部
 */
export async function syncUserClicks(userId: bigint, onlyPlatforms?: Set<string>): Promise<ClickSyncResult> {
  const result: ClickSyncResult = { connectionsSynced: 0, rowsUpserted: 0, clicksCounted: 0, errors: [] }

  const conns = await prisma.platform_connections.findMany({
    where: { user_id: userId, is_deleted: 0, status: 'connected' },
    select: { id: true, platform: true, account_name: true, api_key: true },
  })

  for (const conn of conns) {
    const platform = normalizePlatformCode(conn.platform)
    if (!PLATFORM_CLICK_CONFIG[platform]) continue
    if (onlyPlatforms && !onlyPlatforms.has(platform)) continue
    if (!conn.api_key || conn.api_key.length < 5) continue

    // 连接级并发锁：正被另一路（scoped/全量）同步则本轮跳过，避免重复 increment
    const lockKey = String(conn.id)
    if (syncingConns.has(lockKey)) continue
    syncingConns.add(lockKey)
    try {
      const now = nowCST()
      const cursor = await readCursor(conn.id)
      const beginC = cursor ? dayjs.tz(cursor, TZ) : now.subtract(INITIAL_SPAN_HOURS, 'hour')
      if (!beginC.isValid() || now.diff(beginC, 'minute') < 1) continue // 不足 1 分钟无需拉

      // 单轮跨度封顶：超过 MAX_SPAN_HOURS 则只拉前段，剩余下轮续拉
      const endC = now.diff(beginC, 'hour', true) > MAX_SPAN_HOURS ? beginC.add(MAX_SPAN_HOURS, 'hour') : now
      const beginStr = beginC.format('YYYY-MM-DD HH:mm:ss')
      const endStr = endC.format('YYYY-MM-DD HH:mm:ss')

      let r: { clicks: { merchant_id: string; merchant_name: string; click_date: string; clicks: number }[]; error?: string }
      try {
        r = await fetchAllClicks(platform, conn.api_key, beginStr, endStr)
      } catch (e) {
        result.errors.push(`${conn.account_name || platform}: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }
      if (r.error) {
        // 拉取失败：不推进游标，下轮重试（避免漏计数）
        result.errors.push(`${conn.account_name || platform}: ${r.error}`)
        continue
      }

      for (const row of r.clicks) {
        if (!row.merchant_id || row.clicks <= 0) continue
        await prisma.affiliate_click_daily.upsert({
          where: {
            user_id_platform_merchant_id_click_date: {
              user_id: userId,
              platform,
              merchant_id: row.merchant_id,
              click_date: clickDateToDate(row.click_date),
            },
          },
          create: {
            user_id: userId,
            platform,
            merchant_id: row.merchant_id,
            platform_connection_id: conn.id,
            click_date: clickDateToDate(row.click_date),
            clicks: row.clicks,
          },
          update: { clicks: { increment: row.clicks }, platform_connection_id: conn.id, is_deleted: 0 },
        })
        result.rowsUpserted++
        result.clicksCounted += row.clicks
      }

      await writeCursor(conn.id, endStr)
      result.connectionsSynced++
    } finally {
      syncingConns.delete(lockKey)
    }
  }

  return result
}
