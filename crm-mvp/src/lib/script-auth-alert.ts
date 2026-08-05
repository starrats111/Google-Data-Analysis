/**
 * D-212 脚本鉴权失效告警
 *
 * Google Ads 统一脚本里的 CONFIG.API_KEY 与库里的 users.script_api_key 不一致时，
 * 脚本调 /api/v1/* 全部 401：阶段 0 采集数据不需要 key 所以照常写表格，
 * 阶段 2 查联盟链接被拒后所有系列被标 hasAffiliate=NO，阶段 5 换链循环整轮跳过。
 * 换链接告警中心原有 7 种告警全都由补货/跟链流程触发，此时那些流程压根没被调用，
 * 页面上看不出任何异常 —— wj10 就这样静默停摆一个月（632 单共用一个跟踪码）。
 *
 * 401 时拿不到 user，改从请求携带的 campaignId 反查归属人。
 */

import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { raiseAlert, resolveAlertsByType } from '@/lib/suffix-engine/alerts'

/** 同一用户重复写告警的最小间隔：脚本每 30 分钟一轮，每轮几十次 401 */
const ALERT_THROTTLE_MS = 30 * 60 * 1000
/** 站内通知去重窗口（DB 查重，覆盖 PM2 重启清空内存的情况） */
const NOTIFY_DEDUP_MS = 24 * 3600 * 1000
const NOTIFY_TITLE = '换链接已停摆：Google Ads 脚本的 API Key 失效'

const lastAlertAt = new Map<string, number>()
const resolvedOnce = new Set<string>()

/**
 * key 只记前缀与长度，便于比对是「旧 key」还是「带了空格/引号」，不落全文。
 * 这里自己读 header 而不复用 script-auth 的同名函数，避免两个模块互相 import。
 */
function describeKey(req: NextRequest): string {
  const auth = req.headers.get('authorization')
  const key = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : req.headers.get('x-api-key')?.trim()
  if (!key) return '(请求未带 key)'
  return `${key.slice(0, 12)}… 长度${key.length}`
}

/** 从请求里捞出线索 campaignId：GET 走 query，POST 走 body */
async function extractCampaignIds(req: NextRequest): Promise<string[]> {
  const ids: string[] = []
  try {
    const raw = new URL(req.url).searchParams.get('campaignIds')
    if (raw) ids.push(...raw.split(',').map((s) => s.trim()).filter(Boolean))
  } catch {
    /* URL 解析失败忽略 */
  }

  if (ids.length === 0 && req.method !== 'GET') {
    try {
      // 401 分支不会再读 body，clone 一份避免影响调用方
      const body = (await req.clone().json()) as {
        campaigns?: { campaignId?: string }[]
        reports?: { campaignId?: string }[]
      }
      for (const c of [...(body?.campaigns ?? []), ...(body?.reports ?? [])]) {
        if (c?.campaignId) ids.push(String(c.campaignId))
      }
    } catch {
      /* 非 JSON 或空 body 忽略 */
    }
  }

  return ids.slice(0, 200)
}

/** 按 google_campaign_id 反查归属人，取命中最多的那个用户 */
async function resolveOwner(campaignIds: string[]): Promise<{ userId: bigint; matched: number } | null> {
  if (campaignIds.length === 0) return null
  const rows = await prisma.campaigns.groupBy({
    by: ['user_id'],
    where: { google_campaign_id: { in: campaignIds }, is_deleted: 0 },
    _count: { _all: true },
  })
  if (rows.length === 0) return null
  const top = rows.reduce((a, b) => (b._count._all > a._count._all ? b : a))
  return { userId: top.user_id, matched: top._count._all }
}

/**
 * 记录一次脚本鉴权失败。内部全程兜底，任何异常都不影响 401 响应。
 * 绝大多数调用命中内存节流后立即返回，不查库。
 */
export async function noteScriptAuthFailure(req: NextRequest, endpoint: string): Promise<void> {
  try {
    const keyDesc = describeKey(req)
    const campaignIds = await extractCampaignIds(req)
    const owner = await resolveOwner(campaignIds)

    if (!owner) {
      // 认领不到归属人（如 script-config 不带任何系列 ID）：只留日志，不惊动任何人
      console.warn(`[script-auth] 401 endpoint=${endpoint} key=${keyDesc} 无法认领归属人`)
      return
    }

    const userKey = owner.userId.toString()
    const now = Date.now()
    const last = lastAlertAt.get(userKey) ?? 0
    if (now - last < ALERT_THROTTLE_MS) return
    lastAlertAt.set(userKey, now)
    resolvedOnce.delete(userKey)

    const user = await prisma.users.findUnique({
      where: { id: owner.userId },
      select: { username: true, script_api_key: true },
    })
    const currentKey = user?.script_api_key ?? ''

    await raiseAlert(owner.userId, {
      type: 'script_auth_failed',
      level: 'error',
      campaignId: null,
      message:
        `Google Ads 脚本正在被拒绝（HTTP 401 无效的 API Key），换链接已整体停摆：` +
        `脚本每轮都拿不到联盟链接，所有系列会一直沿用同一个跟踪码。` +
        `脚本里填的 key（${keyDesc}）与系统当前的 key 不一致，需重新下发脚本。`,
      context: {
        endpoint,
        keyInScript: keyDesc,
        currentKeyPrefix: currentKey ? `${currentKey.slice(0, 12)}…` : '(系统未生成 key)',
        matchedCampaigns: owner.matched,
        sampleCampaignIds: campaignIds.slice(0, 5),
      },
    })

    const dup = await prisma.notifications.count({
      where: {
        user_id: owner.userId,
        type: 'alert',
        title: NOTIFY_TITLE,
        created_at: { gte: new Date(now - NOTIFY_DEDUP_MS) },
        is_deleted: 0,
      },
    })
    if (dup > 0) return

    await prisma.notifications.create({
      data: {
        user_id: owner.userId,
        type: 'alert',
        title: NOTIFY_TITLE,
        content: [
          '你的 Google Ads 脚本在调用 CRM 接口时被拒绝（HTTP 401：无效的 API Key）。',
          '',
          '后果：脚本每轮都查不到联盟追踪链接，换链接一次都不会执行，所有在投系列会长期沿用同一个跟踪码，联盟侧极可能判为异常。',
          '注意花费和点击数据仍在正常更新（那部分不需要 API Key），所以看数据是发现不了的。',
          '',
          `脚本里填的 key：${keyDesc}`,
          '',
          '修复方式（二选一）：',
          '  ① 到「设置 → Google MCC」重新生成统一脚本，整段覆盖 Google Ads 里的旧脚本（推荐，key 和表格地址会一起写对）；',
          '  ② 只把脚本 CONFIG 里的 API_KEY 一行换成设置页显示的当前 key。',
          '',
          '改完等一轮（约 30 分钟），本告警会在脚本鉴权成功后自动解除。',
        ].join('\n'),
        metadata: JSON.stringify({
          source: 'D-212 script-auth-alert',
          endpoint,
          username: user?.username ?? null,
          matchedCampaigns: owner.matched,
        }),
      },
    })
  } catch (err) {
    console.error('[script-auth] noteScriptAuthFailure failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * 鉴权成功时自愈：清掉该用户的 script_auth_failed 告警。
 * 每个进程对每个用户只执行一次，不给高频热路径加查询。
 */
export function noteScriptAuthSuccess(userId: bigint): void {
  const userKey = userId.toString()
  if (resolvedOnce.has(userKey)) return
  resolvedOnce.add(userKey)
  lastAlertAt.delete(userKey)
  void resolveAlertsByType(userId, null, ['script_auth_failed']).catch(() => {})
}
