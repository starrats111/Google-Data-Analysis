import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { HttpsProxyAgent } from 'https-proxy-agent'

// ---------------------------------------------------------------
// GET /api/cron/click-tasks
// 内部 Cron Worker：处理待执行的点击任务
// 每次最多处理 20 条 pending 任务，每任务按 target_count 发起代理点击
// ---------------------------------------------------------------

const CRON_SECRET = process.env.CRON_SECRET ?? ''
const BATCH_SIZE = 20       // 每次 cron 处理的最大任务数
const CLICK_TIMEOUT_MS = 10000  // 单次点击超时

// 从追踪 URL 的响应中提取 suffix token
// 策略：取最终落地 URL 的 query string 作为 suffix，或取特定 param
function extractSuffixFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    // 常见联盟平台 token 参数
    const tokenParams = ['clickid', 'click_id', 'subid', 'sub_id', 'aff_click_id', 'tid', 'transaction_id']
    for (const p of tokenParams) {
      const v = u.searchParams.get(p)
      if (v) return `${p}=${v}`
    }
    // 退而取整个 query string 作为 suffix
    if (u.search && u.search.length > 1) return u.search.slice(1)
    return null
  } catch {
    return null
  }
}

// 通过代理发送一次点击请求，返回最终落地 URL
async function simulateClick(
  affiliateUrl: string,
  refererUrl: string,
  proxyUrl: string | null
): Promise<{ finalUrl: string | null; error?: string }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CLICK_TIMEOUT_MS)

    const fetchOptions: RequestInit & { agent?: unknown } = {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(refererUrl ? { Referer: refererUrl } : {}),
      },
    }

    if (proxyUrl) {
      fetchOptions.agent = new HttpsProxyAgent(proxyUrl)
    }

    // Node 18+ 的 fetch 不支持 agent，需要用 node-fetch 或 undici
    // 这里用 undici dispatcher 兜底
    const res = await fetch(affiliateUrl, fetchOptions as RequestInit)
    clearTimeout(timer)

    return { finalUrl: res.url }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { finalUrl: null, error: msg.slice(0, 120) }
  }
}

export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not Found' }, { status: 404 })
  }
  // 简单鉴权：验证 cron secret（生产中通过 Vercel/GitHub Actions 传入）
  const secret = req.headers.get('x-cron-secret') ?? req.nextUrl.searchParams.get('secret') ?? ''
  if (CRON_SECRET && secret !== CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // 1. 取最多 BATCH_SIZE 条 pending 任务
  const tasks = await prisma.kyads_click_tasks.findMany({
    where: { status: 'pending', is_deleted: 0 },
    orderBy: { created_at: 'asc' },
    take: BATCH_SIZE,
    select: {
      id: true,
      user_id: true,
      campaign_id: true,
      proxy_id: true,
      affiliate_url: true,
      referer_url: true,
      target_count: true,
      done_count: true,
    },
  })

  if (tasks.length === 0) {
    return NextResponse.json({ processed: 0, message: '无待处理任务' })
  }

  // 2. 标记为 running
  const taskIds = tasks.map((t) => t.id)
  await prisma.kyads_click_tasks.updateMany({
    where: { id: { in: taskIds } },
    data: { status: 'running', started_at: new Date() },
  })

  let totalInserted = 0
  const errors: string[] = []

  // 3. 逐任务处理
  for (const task of tasks) {
    // 3a. 选代理
    let proxyUrl: string | null = null
    if (task.proxy_id) {
      // 任务指定了代理
      const proxy = await prisma.kyads_proxies.findFirst({
        where: { id: task.proxy_id, status: 'active', is_deleted: 0 },
        select: { host: true, port: true, proxy_type: true },
      })
      if (proxy) proxyUrl = `${proxy.proxy_type}://${proxy.host}:${proxy.port}`
    } else {
      // 从用户绑定的代理中按优先级选一个
      const userProxy = await prisma.kyads_proxy_users.findFirst({
        where: { user_id: task.user_id },
        orderBy: { created_at: 'asc' },
      })
      if (userProxy) {
        const proxy = await prisma.kyads_proxies.findFirst({
          where: { id: userProxy.proxy_id, status: 'active', is_deleted: 0 },
          orderBy: { priority: 'asc' },
          select: { host: true, port: true, proxy_type: true },
        })
        if (proxy) proxyUrl = `${proxy.proxy_type}://${proxy.host}:${proxy.port}`
      }
    }

    // 3b. 按 target_count 发送点击，每次收到 suffix 就入库
    const needed = task.target_count - task.done_count
    let successCount = 0

    for (let i = 0; i < needed; i++) {
      const { finalUrl, error } = await simulateClick(task.affiliate_url, task.referer_url, proxyUrl)
      if (!finalUrl) {
        errors.push(`task ${task.id.toString()} click ${i + 1}: ${error}`)
        continue
      }

      const suffix = extractSuffixFromUrl(finalUrl)
      if (!suffix) continue

      // 写入 suffix_pool
      await prisma.suffix_pool.create({
        data: {
          user_id: task.user_id,
          campaign_id: task.campaign_id,
          suffix_content: suffix,
          status: 'available',
        },
      })
      successCount++
      totalInserted++
    }

    // 3c. 更新任务状态
    const newDone = task.done_count + successCount
    const done = newDone >= task.target_count
    await prisma.kyads_click_tasks.update({
      where: { id: task.id },
      data: {
        done_count: newDone,
        status: done ? 'done' : 'pending', // 若未完成，重置回 pending 等下次 cron
        finished_at: done ? new Date() : null,
        error_message: errors.length > 0 ? errors.slice(-3).join('; ') : null,
      },
    })
  }

  return NextResponse.json({
    processed: tasks.length,
    inserted: totalInserted,
    errors: errors.length,
  })
}
