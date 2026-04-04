import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { getScriptUserFromRequest } from '@/lib/script-auth'
import { v4 as uuidv4 } from 'uuid'

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
    const { campaignId, nowClicks, windowStartEpochSeconds, idempotencyKey, meta } = c

    // 查找 CRM 中对应的 campaign 记录
    const campaign = await prisma.campaigns.findFirst({
      where: { google_campaign_id: campaignId, user_id: scriptUser.userId, is_deleted: 0 },
      select: { id: true, suffix_exchange_enabled: true },
    })

    if (!campaign) {
      results.push({ campaignId, code: 'NOT_FOUND', message: '广告系列未找到' })
      continue
    }

    if (!campaign.suffix_exchange_enabled) {
      results.push({ campaignId, code: 'EXCHANGE_DISABLED', message: '该广告系列已关闭换链接' })
      continue
    }

    // 幂等检查：同一 idempotencyKey 已存在分配记录则直接返回
    const existing = await prisma.suffix_assignments.findFirst({
      where: { idempotency_key: idempotencyKey, is_deleted: 0 },
      include: { suffix_pool: true },
    })

    if (existing) {
      results.push({
        campaignId,
        action: 'APPLY',
        finalUrlSuffix: existing.suffix_pool?.suffix_content ?? '',
        assignmentId: existing.assignment_id,
        availableStock: 0,
        isIdempotent: true,
      })
      continue
    }

    // 从库存池中原子取一条可用 suffix
    const available = await prisma.suffix_pool.findFirst({
      where: { campaign_id: campaign.id, status: 'available', is_deleted: 0 },
      orderBy: { created_at: 'asc' },
    })

    // 统计剩余库存数
    const stockCount = await prisma.suffix_pool.count({
      where: { campaign_id: campaign.id, status: 'available', is_deleted: 0 },
    })

    if (!available) {
      results.push({ campaignId, code: 'NO_STOCK', message: '库存不足，请补货', availableStock: 0 })
      continue
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
          user_id: scriptUser.userId,
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

    results.push({
      campaignId,
      action: 'APPLY',
      finalUrlSuffix: available.suffix_content,
      assignmentId,
      availableStock: Math.max(0, stockCount - 1),
      isIdempotent: false,
    })
  }

  return NextResponse.json({ success: true, results })
}
