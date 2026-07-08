/**
 * 全局住宅代理「并发会话」信号量（治 yz04 等重度用户打爆 kookeey 单子账号并发上限）
 *
 * 背景：本机 16 个用户共用同一个 kookeey 子账号（gate.kookeey.info，session-{n}-life-5m 粘性会话）。
 * 每次点击 + 每次 exit-ip 去重探测都会新建一个 SOCKS5 会话，粘性 5 分钟才释放；瞬时并发一旦
 * 超过子账号并发上限，超限连接被 kookeey 直接拒绝，客户端表现为「Socks5 Authentication failed」。
 *
 * 对策：所有经代理的请求（fetchViaProxy）在真正发起前先申请一个「会话名额」，把同时在飞的会话数
 * 压到安全线以下——超出的排队等待而非溢出失败。名额上限由 system_configs.proxy_max_concurrent_sessions
 * 配置（建议设为 kookeey 套餐并发上限的 ~80%），缺省 DEFAULT_MAX。
 *
 * 单实例（PM2 单进程）下进程内信号量即可覆盖全部代理消费方（刷点击/补货/换链/探活）。
 */
import { prisma } from '@/lib/prisma'

const CONFIG_KEY = 'proxy_max_concurrent_sessions'
/** 缺省并发上限（保守值；生产可用 system_configs 覆盖为 kookeey 套餐并发的 ~80%） */
const DEFAULT_MAX = 10
const CAP_CACHE_TTL_MS = 60_000

let cachedCap = DEFAULT_MAX
let capCachedAt = 0

async function getCap(): Promise<number> {
  if (Date.now() - capCachedAt < CAP_CACHE_TTL_MS) return cachedCap
  try {
    const row = await prisma.system_configs.findUnique({ where: { config_key: CONFIG_KEY } })
    const n = Number(row?.config_value)
    cachedCap = row && row.is_deleted === 0 && Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX
  } catch {
    // 读取失败保留上次值，不阻断代理
  }
  capCachedAt = Date.now()
  return cachedCap
}

let active = 0
const waiters: Array<() => void> = []

/**
 * 在「代理会话名额」内执行 fn。名额满时排队等待，释放时唤醒一个等待者（FIFO）。
 * 保证同时在飞的代理会话数 ≤ 上限，避免撞 kookeey 子账号并发上限。
 */
export async function withProxySlot<T>(fn: () => Promise<T>): Promise<T> {
  const cap = await getCap()
  if (active >= cap) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  active++
  try {
    return await fn()
  } finally {
    active--
    const next = waiters.shift()
    if (next) next()
  }
}