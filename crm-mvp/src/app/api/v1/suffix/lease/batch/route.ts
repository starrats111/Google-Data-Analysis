import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getScriptUserFromRequest } from '@/lib/script-auth'
import { v4 as uuidv4 } from 'uuid'
import { triggerReplenishAsync } from '@/lib/suffix-engine/stock-producer'
import { STOCK_CONFIG } from '@/lib/suffix-engine/config'

interface LeaseCampaign {
  campaignId: string
  nowClicks: number
  todayClicks?: number
  observedAt: string
  windowStartEpochSeconds: number
  idempotencyKey: string
  meta?: {
    campaignName?: string
    country?: string
    finalUrl?: string
    cid?: string
    mccId?: string
  }
}

type LeaseResult =
  | { campaignId: string; action: 'APPLY'; finalUrlSuffix: string; assignmentId: string; availableStock: number; isIdempotent: boolean }
  | { campaignId: string; action: 'NOOP'; reason: string }
  | { campaignId: string; code: 'NO_STOCK'; message: string; availableStock: 0 }
  | { campaignId: string; code: 'NOT_FOUND'; message: string }
  | { campaignId: string; code: 'EXCHANGE_DISABLED'; message: string }
  | { campaignId: string; code: 'INTERNAL_ERROR'; message: string }

/** 处理单个 campaign 的 lease；抛错由调用方兜底，避免一条失败拖垮整批（D-163①） */
async function leaseOne(
  c: LeaseCampaign,
  userId: bigint,
  scriptInstanceId: string | null,
): Promise<LeaseResult> {
  const { campaignId, nowClicks, windowStartEpochSeconds, idempotencyKey, meta } = c

  // 查找 CRM 中对应的 campaign 记录
  const campaign = await prisma.campaigns.findFirst({
    where: { google_campaign_id: campaignId, user_id: userId, is_deleted: 0 },
    select: { id: true, suffix_exchange_enabled: true, user_merchant_id: true },
  })

  if (!campaign) {
    return { campaignId, code: 'NOT_FOUND', message: '广告系列未找到' }
  }

  if (!campaign.suffix_exchange_enabled) {
    return { campaignId, code: 'EXCHANGE_DISABLED', message: '该广告系列已关闭换链接' }
  }

  // 「从 Google 侧回填」的系列入库时 user_merchant_id=0，待关联到 CRM 商家库才有值。
  // 商家未进库时一直为 0：此类系列无追踪链接可换，直接当作未启用返回，避免触发 force 补货、
  // 进而刷出 merchant_not_found 告警（治本闸门，与单系列补货 replenishCampaign 一致）。
  if (!campaign.user_merchant_id || campaign.user_merchant_id <= BigInt(0)) {
    return { campaignId, code: 'EXCHANGE_DISABLED', message: '该广告系列未匹配商家，暂不可换链接' }
  }

  // 幂等检查：同一 idempotencyKey 已存在分配记录则直接返回
  const existing = await prisma.suffix_assignments.findFirst({
    where: { idempotency_key: idempotencyKey, is_deleted: 0 },
  })

  if (existing) {
    let existingSuffix = ''
    if (existing.suffix_pool_id) {
      const sp = await prisma.suffix_pool.findUnique({
        where: { id: existing.suffix_pool_id },
        select: { suffix_content: true },
      })
      existingSuffix = sp?.suffix_content ?? ''
    }
    return {
      campaignId,
      action: 'APPLY',
      finalUrlSuffix: existingSuffix,
      assignmentId: existing.assignment_id,
      availableStock: 0,
      isIdempotent: true,
    }
  }

  // 可用库存条件：available 且未过期（expires_at 为空或晚于当前）
  const now = new Date()
  const availableWhere = {
    campaign_id: campaign.id,
    status: 'available',
    is_deleted: 0,
    OR: [{ expires_at: null }, { expires_at: { gt: now } }],
  }

  // 从库存池中原子取一条可用 suffix（优先取快过期的，先用先回收）
  const available = await prisma.suffix_pool.findFirst({
    where: availableWhere,
    orderBy: { created_at: 'asc' },
  })

  // 统计剩余库存数
  const stockCount = await prisma.suffix_pool.count({ where: availableWhere })

  if (!available) {
    // 无库存：立即异步触发补货（强制补到目标水位），下个 lease 周期即可取到
    triggerReplenishAsync(campaign.id, { force: true })
    return { campaignId, code: 'NO_STOCK', message: '库存不足，已触发补货', availableStock: 0 }
  }

  const assignmentId = uuidv4()

  // 原子操作：标记 suffix 为 leased，写入分配记录，更新 campaign 最近换链字段
  await prisma.$transaction([
    prisma.suffix_pool.update({
      where: { id: available.id },
      data: { status: 'leased', leased_assignment_id: assignmentId },
    }),
    prisma.suffix_assignments.create({
      data: {
        user_id: userId,
        campaign_id: campaign.id,
        suffix_pool_id: available.id,
        assignment_id: assignmentId,
        idempotency_key: idempotencyKey,
        clicks_at_assignment: nowClicks,
        window_start_epoch: BigInt(windowStartEpochSeconds),
        script_instance_id: scriptInstanceId,
        meta: meta ?? {},
      },
    }),
    prisma.campaigns.update({
      where: { id: campaign.id },
      data: {
        suffix_last_content: available.suffix_content,
        suffix_last_apply_at: new Date(),
      },
    }),
  ])

  const remainingStock = Math.max(0, stockCount - 1)

  // 取后库存跌破低水位 → 异步补货，提前蓄水避免下次 NO_STOCK
  if (remainingStock <= STOCK_CONFIG.LOW_WATERMARK) {
    triggerReplenishAsync(campaign.id)
  }

  return {
    campaignId,
    action: 'APPLY',
    finalUrlSuffix: available.suffix_content,
    assignmentId,
    availableStock: remainingStock,
    isIdempotent: false,
  }
}

export async function POST(req: NextRequest) {
  const scriptUser = await getScriptUserFromRequest(req)
  if (!scriptUser) {
    return NextResponse.json({ success: false, error: { code: 'UNAUTHORIZED', message: '无效的 API Key' } }, { status: 401 })
  }

  let body: { campaigns?: LeaseCampaign[]; scriptInstanceId?: string; cycleMinutes?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ success: false, error: { code: 'BAD_REQUEST', message: '请求体解析失败' } }, { status: 400 })
  }

  const campaigns: LeaseCampaign[] = body.campaigns ?? []
  if (!Array.isArray(campaigns) || campaigns.length === 0) {
    return NextResponse.json({ success: true, results: [] })
  }

  const scriptInstanceId = body.scriptInstanceId ?? null
  const results: LeaseResult[] = []

  for (const c of campaigns) {
    try {
      results.push(await leaseOne(c, scriptUser.userId, scriptInstanceId))
    } catch (e) {
      // D-163①：DB 事务超时（P2028）等单条失败不再让整批 500，脚本下个周期会带同一 idempotencyKey 重试
      console.error(`[SuffixLease] campaign=${c.campaignId} 处理失败:`, e instanceof Error ? e.message : e)
      results.push({ campaignId: c.campaignId, code: 'INTERNAL_ERROR', message: '服务端处理失败，请下周期重试' })
    }
  }

  return NextResponse.json({ success: true, results })
}
