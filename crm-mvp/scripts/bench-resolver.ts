/**
 * D-193 取链接引擎基准测试
 *
 * 对同一批真实联盟链接跑四个引擎，产出成功率 / 耗时 / 流量三维对比：
 *   legacy    CRM 现有 fetchChain（HTTP 手动跟跳）
 *   ky        移植自 kylink 的 trackRedirects（HTTP，跟跳逻辑更全）
 *   puppeteer 无头 Chrome + 分阶段拦截 + 落地页响应头掐断
 *   obscura   Obscura headless（CDP）+ 同一套拦截逻辑
 *
 * 流量口径：所有引擎的出站流量都经本地计数中继转发到住宅代理网关，
 * 因此四个引擎的字节数是同一把尺子量出来的（含 TLS 开销）。
 *
 * 用法（在 crm-mvp 下）：
 *   npx tsx scripts/bench-resolver.mts --engines legacy,ky --limit 5
 *   npx tsx scripts/bench-resolver.mts --engines legacy,ky,puppeteer,obscura
 */
import * as net from 'node:net'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { fetchChain } from '../src/lib/affiliate-link-resolver'
import { trackRedirects } from '../src/lib/link-resolver/tracker'
import { extractRootDomain } from '../src/lib/link-resolver/domain-validator'
import { generateFingerprint } from '../src/lib/link-resolver/browser-fingerprint'
import { processUsernameTemplate } from '../src/lib/suffix-engine/proxy-provider'
import { decryptPassword } from '../src/lib/crypto'

// ───────────────────────── 配置 ─────────────────────────

const WS = path.resolve(process.cwd(), '..')
const BENCHSET = path.join(WS, '_c193_benchset.tsv')
const PROXY_TSV = 'C:\\Users\\Administrator\\.infra\\crm-proxies.tsv'
const OBSCURA_BIN = 'C:\\tools\\obscura\\bin\\obscura.exe'
const OUT_JSON = path.join(WS, '_c193_bench_result.json')

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

/** 跳转途中就该拦掉的重资源（放行 Document/Script/XHR/Fetch，JS 跳转靠它们）。 */
const BLOCK_TYPES = new Set([
  'Image', 'Media', 'Font', 'Stylesheet', 'TextTrack', 'EventSource',
  'WebSocket', 'Manifest', 'SignedExchange', 'Ping', 'CSPViolationReport', 'Prefetch',
])

/** 广告 / 分析 / 像素类域名，任何阶段都拦。 */
const BLOCK_HOST_RE =
  /(google-analytics|googletagmanager|googlesyndication|doubleclick\.net|facebook\.(com|net)\/tr|connect\.facebook|hotjar|clarity\.ms|segment\.(io|com)|mixpanel|amplitude|fullstory|mouseflow|crisp\.chat|intercom|zendesk|tiktok\.com\/i18n|analytics\.|adservice\.|adsystem\.|criteo|taboola|outbrain|bing\.com\/bat|snap\.licdn|pinterest\.com\/ct|klaviyo|attentivemobile|bugsnag|sentry\.io|newrelic|optimizely|cdn\.cookielaw|onetrust|trustarc|adjust\.com)/i

const TRACKING_KEYS = new Set([
  'clickref', 'clickid', 'click_id', 'irclickid', 'ranmid', 'ranEAID', 'ranSiteID',
  'cjevent', 'sscid', 'awc', 'gclid', 'msclkid', 'subid', 'sub_id', 'aff_id', 'affid',
  'affiliate', 'partner', 'pid', 'sid', 'siteid', 'source', 'utm_source', 'utm_medium',
  'utm_campaign', 'utm_term', 'utm_content', 'sv1', 'sv_campaign_id', 'sscid',
  'transaction_id', 'tt', 'tduid', 'publisherId', 'wgu', 'wgexpiry', 'ssaid',
])

function hasTrackingParam(u: string): boolean {
  try {
    const url = new URL(u)
    if (!url.search) return false
    for (const k of url.searchParams.keys()) {
      if (TRACKING_KEYS.has(k) || TRACKING_KEYS.has(k.toLowerCase())) return true
    }
    // 未收录但形似点击令牌的长随机参数也算（联盟自定义键很多）
    for (const [k, v] of url.searchParams.entries()) {
      if (v.length >= 12 && /^[A-Za-z0-9_\-]+$/.test(v) && !/^https?/i.test(v)) return true
      if (/click|track|aff|ref|camp/i.test(k)) return true
    }
    return false
  } catch {
    return false
  }
}

// ───────────────────────── 计流量中继 ─────────────────────────

/** 共享字节计数器：socks 中继和 http 桥都往它记账，四个引擎才是同一把尺子。 */
class Meter {
  private total = 0
  add(n: number) { this.total += n }
  get bytes() { return this.total }
  reset() { this.total = 0 }
}

interface Relay {
  /** 明文 TCP 中继端口，给能直接说 SOCKS5 的引擎（legacy / ky / obscura）用 */
  socksPort: number
  /** 本地免认证 HTTP 代理端口，给 Chrome 用（Chrome 不支持带认证的 SOCKS5） */
  httpPort: number
  bytes: () => number
  reset: () => void
  close: () => void
}

async function startRelay(
  targetHost: string,
  targetPort: number,
  /** 每条链接的投放国不同 → 代理用户名不同，所以取凭据要延迟到建连那一刻 */
  socksAuth: () => { username: string; password: string },
): Promise<Relay> {
  const meter = new Meter()
  const sockets = new Set<net.Socket>()
  const track = (s: net.Socket) => {
    sockets.add(s)
    s.on('data', (d: Buffer) => meter.add(d.length))
    s.on('close', () => sockets.delete(s))
  }

  // ① 明文 TCP 中继：客户端自己讲 SOCKS5（含认证），我们只转发并计数
  const tcp = net.createServer((client) => {
    const upstream = net.connect(targetPort, targetHost)
    track(client); track(upstream)
    client.pipe(upstream); upstream.pipe(client)
    const kill = () => { client.destroy(); upstream.destroy() }
    client.on('error', kill); upstream.on('error', kill)
    client.on('close', kill); upstream.on('close', kill)
  })
  await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r))

  // ② HTTP CONNECT → SOCKS5 桥：kookeey 网关只认 SOCKS5，而 Chrome 不支持 SOCKS5 认证，
  //    所以本地开一个免认证 HTTP 代理，由它带凭据去连 SOCKS5 出口
  const { SocksClient } = await import('socks')
  const http = await import('node:http')
  const bridge = http.createServer((req, res) => {
    res.writeHead(405).end('only CONNECT supported')
  })
  bridge.on('connect', async (req, clientSocket: net.Socket, head: Buffer) => {
    const [h, p] = String(req.url).split(':')
    const auth = socksAuth()
    try {
      const { socket } = await SocksClient.createConnection({
        proxy: { host: targetHost, port: targetPort, type: 5, userId: auth.username, password: auth.password },
        command: 'connect',
        destination: { host: h, port: parseInt(p || '443', 10) },
        timeout: 20000,
      })
      track(clientSocket); track(socket)
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) socket.write(head)
      socket.pipe(clientSocket); clientSocket.pipe(socket)
      const kill = () => { socket.destroy(); clientSocket.destroy() }
      socket.on('error', kill); clientSocket.on('error', kill)
      socket.on('close', kill); clientSocket.on('close', kill)
    } catch {
      clientSocket.destroy()
    }
  })
  await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', r))

  return {
    socksPort: (tcp.address() as net.AddressInfo).port,
    httpPort: (bridge.address() as net.AddressInfo).port,
    bytes: () => meter.bytes,
    reset: () => meter.reset(),
    close: () => { for (const s of sockets) s.destroy(); tcp.close(); bridge.close() },
  }
}

// ───────────────────────── 数据加载 ─────────────────────────

interface BenchItem {
  grp: string
  umId: string
  platform: string
  merchantName: string
  merchantUrl: string
  country: string
  trackingStatus: string
  reason: string
  affiliateUrl: string
  targetDomain: string
}

function pickAffiliateUrl(trackingLink: string, campaignLink: string, connLinks: string): string {
  if (connLinks && connLinks.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(connLinks) as Record<string, string>
      const first = Object.values(obj).find((v) => typeof v === 'string' && /^https?:\/\//i.test(v))
      if (first) return first
    } catch { /* 落到下一优先级 */ }
  }
  if (campaignLink && /^https?:\/\//i.test(campaignLink)) return campaignLink
  if (trackingLink && /^https?:\/\//i.test(trackingLink)) return trackingLink
  return ''
}

function loadBenchset(): BenchItem[] {
  const raw = fs.readFileSync(BENCHSET, 'utf8').replace(/^\uFEFF/, '')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  const out: BenchItem[] = []
  for (const line of lines.slice(1)) {
    const c = line.split('\t')
    if (c.length < 11) continue
    const affiliateUrl = pickAffiliateUrl(c[8], c[9], c[10])
    if (!affiliateUrl) continue
    const targetDomain = extractRootDomain(c[4]) || extractRootDomain('http://' + c[4]) || ''
    out.push({
      grp: c[0].replace(/^\uFEFF/, ''),
      umId: c[1],
      platform: c[2],
      merchantName: c[3],
      merchantUrl: c[4],
      country: (c[5] || 'US').toUpperCase(),
      trackingStatus: c[6],
      reason: c[7],
      affiliateUrl,
      targetDomain,
    })
  }
  return out
}

interface ProxyCfg {
  host: string
  port: number
  usernameTemplate: string
  password: string
  countryCodeMap: Record<string, string> | null
}

function loadProxy(): ProxyCfg {
  const raw = fs.readFileSync(PROXY_TSV, 'utf8').replace(/^\uFEFF/, '')
  const c = raw.split(/\r?\n/).filter(Boolean)[0].split('\t')
  let ccMap: Record<string, string> | null = null
  if (c[8] && c[8].trim().startsWith('{')) { try { ccMap = JSON.parse(c[8]) } catch { /* 忽略 */ } }
  return {
    host: c[2],
    port: parseInt(c[3], 10),
    usernameTemplate: c[6] || '',
    password: decryptPassword(c[7] || ''),
    countryCodeMap: ccMap,
  }
}

/** 组装指向本地中继的代理 URL；scheme 由引擎决定（浏览器只认带认证的 http 代理）。 */
function buildProxyUrl(cfg: ProxyCfg, country: string, relayPort: number, scheme: 'socks5' | 'http') {
  const username = processUsernameTemplate(cfg.usernameTemplate, country, cfg.countryCodeMap)
  return {
    url: `${scheme}://${encodeURIComponent(username)}:${encodeURIComponent(cfg.password)}@127.0.0.1:${relayPort}`,
    username,
    password: cfg.password,
  }
}

// ───────────────────────── 结果模型 ─────────────────────────

interface EngineResult {
  engine: string
  umId: string
  ok: boolean
  finalUrl: string
  domainMatch: boolean
  hasTracking: boolean
  ms: number
  bytes: number
  hops: number
  error: string
}

function judge(item: BenchItem, finalUrl: string): { domainMatch: boolean; hasTracking: boolean; ok: boolean } {
  const domainMatch = !!finalUrl && !!item.targetDomain &&
    extractRootDomain(finalUrl) === item.targetDomain
  const tracking = hasTrackingParam(finalUrl)
  // 07 拍板的严格双条件：域名命中 + 有追踪参数才算直出
  return { domainMatch, hasTracking: tracking, ok: domainMatch && tracking }
}

// ───────────────────────── 引擎 1：legacy ─────────────────────────

async function runLegacy(item: BenchItem, proxyUrl: string): Promise<Partial<EngineResult>> {
  const r = await fetchChain(item.affiliateUrl, proxyUrl, 10, 18000, {}, 2)
  return {
    finalUrl: r.finalUrl || '',
    hops: Array.isArray(r.chain) ? r.chain.length : 0,
    error: r.error || '',
  }
}

// ───────────────────────── 引擎 2：ky ─────────────────────────

async function runKy(item: BenchItem, cfg: ProxyCfg, country: string, relayPort: number): Promise<Partial<EngineResult>> {
  const username = processUsernameTemplate(cfg.usernameTemplate, country, cfg.countryCodeMap)
  const r = await trackRedirects({
    url: item.affiliateUrl,
    proxy: {
      url: `socks5://127.0.0.1:${relayPort}`,
      username,
      password: cfg.password,
      protocol: 'socks5',
    },
    targetDomain: item.targetDomain || undefined,
    maxRedirects: 15,
    requestTimeout: 18000,
    totalTimeout: 55000,
    retryCount: 2,
  })
  return {
    finalUrl: r.finalUrl || '',
    hops: r.redirectCount ?? 0,
    error: r.errorMessage || '',
  }
}

// ───────── 引擎 3/4 共用：CDP 拦截跑法（分阶段 + 落地页响应头掐断）─────────

interface CdpRunOpts {
  targetDomain: string
  navTimeoutMs: number
  settleMs: number
  /** 代理认证。自己接管 Fetch 域后，page.authenticate 就失效了，必须自己应答 407。 */
  auth?: { username: string; password: string }
}

/**
 * 用原始 CDP Fetch 域做两阶段拦截：
 *  - 请求阶段：重资源 / 广告域名直接 fail；到达落地页后非 Document 一律 fail
 *  - 响应阶段：只对 Document 开；3xx 放行继续跟跳，2xx 且根域命中目标 → 记下 URL 后
 *    立即 fail，落地页正文一个字节都不下载
 */
async function runViaCdp(
  cdp: {
    send: (m: string, p?: unknown) => Promise<unknown>
    on: (e: string, cb: (p: never) => void) => void
  },
  navigate: (url: string) => Promise<void>,
  currentUrlRaw: () => string | Promise<string>,
  startUrl: string,
  opts: CdpRunOpts,
): Promise<{ finalUrl: string; hops: number; error: string }> {
  let reachedLanding = false
  let landingUrl = ''
  let hops = 0
  // puppeteer 的 page.url() 是同步的，playwright 也是；统一包成 Promise 便于容错
  const currentUrl = async () => { try { return await currentUrlRaw() } catch { return '' } }

  await cdp.send('Fetch.enable', {
    handleAuthRequests: !!opts.auth,
    patterns: [
      { urlPattern: '*', requestStage: 'Request' },
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
    ],
  })

  if (opts.auth) {
    cdp.on('Fetch.authRequired', ((p: { requestId: string }) => {
      cdp.send('Fetch.continueWithAuth', {
        requestId: p.requestId,
        authChallengeResponse: {
          response: 'ProvideCredentials',
          username: opts.auth!.username,
          password: opts.auth!.password,
        },
      }).catch(() => {})
    }) as (p: never) => void)
  }

  cdp.on('Fetch.requestPaused', (async (p: {
    requestId: string
    request: { url: string }
    resourceType: string
    responseStatusCode?: number
  }) => {
    const { requestId, request, resourceType, responseStatusCode } = p
    const isResponseStage = typeof responseStatusCode === 'number'
    let host = ''
    try { host = new URL(request.url).hostname } catch { /* 非法 URL 直接放行判断 */ }

    const fail = () => cdp.send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(() => {})
    const cont = () => cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
    const contResp = () => cdp.send('Fetch.continueResponse', { requestId }).catch(() => {})

    if (isResponseStage) {
      hops += 1
      // 目标域早停（与 kylink tracker 同语义）：请求已发出、联盟点击已登记，此刻的 URL
      // 就是带联盟参数的落地地址。不能再跟 3xx——商家自己的规范化跳转会把追踪参数洗掉。
      const root = extractRootDomain(request.url)
      if (root && opts.targetDomain && root === opts.targetDomain) {
        landingUrl = request.url
        reachedLanding = true
        return fail()
      }
      // 不是目标域 = 跳板/中转页：3xx 放行继续跟，2xx 正文要留给 JS 解析跳转
      return contResp()
    }

    if (BLOCK_TYPES.has(resourceType)) return fail()
    if (host && BLOCK_HOST_RE.test(host)) return fail()
    if (reachedLanding && resourceType !== 'Document') return fail()
    return cont()
  }) as (p: never) => void)

  const deadline = Date.now() + opts.navTimeoutMs
  try {
    await navigate(startUrl)
  } catch {
    // 我们主动 abort 落地页会让 goto 抛错，属预期
  }
  // 掐断后再等一小会，捕捉 load 之后才发生的二次跳转
  while (!reachedLanding && Date.now() < deadline) {
    await sleep(250)
    const u = await currentUrl()
    if (u && opts.targetDomain && extractRootDomain(u) === opts.targetDomain) {
      landingUrl = u
      reachedLanding = true
      break
    }
  }
  if (!reachedLanding) {
    await sleep(opts.settleMs)
    landingUrl = (await currentUrl()) || ''
  }
  return { finalUrl: landingUrl, hops, error: reachedLanding ? '' : 'no_landing' }
}

// ───────────────────────── 引擎 3：puppeteer ─────────────────────────

let chromePath = ''
function findChrome(): string {
  if (chromePath) return chromePath
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) { chromePath = p; return p }
  throw new Error('本机找不到 Chrome/Edge')
}

async function runPuppeteer(item: BenchItem, httpPort: number): Promise<Partial<EngineResult>> {
  // 用 CRM 已有的 stealth 启动器（与生产浏览器兜底同一条路径），指纹与 HTTP 引擎同源
  const { getStealthLauncher } = await import('../src/lib/puppeteer-browser-registry')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let launcher: any
  try {
    launcher = await getStealthLauncher()
  } catch {
    const puppeteerCore = await import('puppeteer-core')
    launcher = (puppeteerCore as unknown as { default?: unknown }).default ?? puppeteerCore
  }
  const fp = generateFingerprint()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const browser: any = await launcher.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: [
      // 本地桥免认证，凭据由桥在建 SOCKS5 连接时带上
      `--proxy-server=http://127.0.0.1:${httpPort}`,
      `--user-agent=${fp.userAgent}`,
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
      '--disable-component-update', '--disable-sync', '--metrics-recording-only',
    ],
  })
  try {
    const page = await browser.newPage()
    await page.setUserAgent(fp.userAgent)
    await page.setExtraHTTPHeaders({ ...fp.headers, Referer: 'https://t.co' })
    const client = await page.createCDPSession()
    const r = await runViaCdp(
      { send: (m, p) => client.send(m, p), on: (e, cb) => client.on(e, cb) },
      (u) => page.goto(u, { waitUntil: 'domcontentloaded', timeout: 35000 }),
      () => page.url(),
      item.affiliateUrl,
      { targetDomain: item.targetDomain, navTimeoutMs: 35000, settleMs: 2500 },
    )
    return r
  } finally {
    await browser.close().catch(() => {})
  }
}

// ───────────────────────── 引擎 4：obscura ─────────────────────────

/**
 * Obscura 只能走 CLI 模式，**没有任何拦截能力**。
 *
 * 实测（2026-07-29 v0.1.11）：CDP 的 Fetch 域是个空壳——`Fetch.enable` 返回成功，
 * 但只在 Request 阶段触发一次 requestPaused，`continueRequest` 之后导航永久挂起
 * （不开 Fetch 域时同一个页面 734ms 就导航完）；Response 阶段一次都不触发。
 * 所以「分阶段拦截 + 落地页响应头掐断」在 Obscura 上做不了，这里只量它的
 * 成功率与裸流量，作为选型的对照面。
 */
async function runObscura(item: BenchItem, cfg: ProxyCfg, relayPort: number): Promise<Partial<EngineResult>> {
  const { url } = buildProxyUrl(cfg, item.country, relayPort, 'socks5')
  const fp = generateFingerprint()
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  try {
    const { stdout } = await run(
      OBSCURA_BIN,
      ['fetch', item.affiliateUrl, '--proxy', url, '--quiet', '--wait', '4', '--timeout', '35',
        '--user-agent', fp.userAgent, '-e', 'window.location.href'],
      { timeout: 55000, maxBuffer: 8 * 1024 * 1024 },
    )
    const finalUrl = (stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
    return { finalUrl: /^https?:\/\//i.test(finalUrl) ? finalUrl : '', hops: 0, error: finalUrl ? '' : 'no_output' }
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; killed?: boolean; message?: string }
    // 超时被 kill 时 obscura 可能已经把 URL 打到 stdout 了，别浪费这次点击
    const partial = (x.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || ''
    if (/^https?:\/\//i.test(partial)) return { finalUrl: partial, hops: 0, error: 'timeout_partial' }
    const why = x.killed ? 'cli_timeout' : (x.stderr || x.message || '').replace(/\s+/g, ' ').trim().slice(0, 90)
    return { finalUrl: '', hops: 0, error: why || 'cli_fail' }
  }
}


// ───────────────────────── 主流程 ─────────────────────────

function arg(name: string, def = ''): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

async function main() {
  const engines = arg('engines', 'legacy,ky').split(',').map((s) => s.trim()).filter(Boolean)
  const limit = parseInt(arg('limit', '0'), 10)
  const onlyGrp = arg('grp', '')

  let items = loadBenchset()
  if (onlyGrp) items = items.filter((i) => i.grp === onlyGrp)
  if (limit > 0) items = items.slice(0, limit)

  const cfg = loadProxy()
  // 当前处理的投放国，桥建 SOCKS5 连接时按它拼用户名
  let currentCountry = 'US'
  const relay = await startRelay(cfg.host, cfg.port, () => ({
    username: processUsernameTemplate(cfg.usernameTemplate, currentCountry, cfg.countryCodeMap),
    password: cfg.password,
  }))
  console.log(`[bench] socks 中继 :${relay.socksPort} / http 桥 :${relay.httpPort} → ${cfg.host}:${cfg.port}`)
  console.log(`[bench] ${items.length} 条链接 × ${engines.length} 个引擎 = ${items.length * engines.length} 次取链`)

  const results: EngineResult[] = []

  for (const engine of engines) {
    console.log(`\n===== 引擎 ${engine} =====`)
    // obscura 按国家分组以复用同一个 serve 实例（代理是启动参数写死的）
    const ordered = engine === 'obscura'
      ? [...items].sort((a, b) => a.country.localeCompare(b.country))
      : items

    for (let i = 0; i < ordered.length; i++) {
      const item = ordered[i]
      currentCountry = item.country
      relay.reset()
      const t0 = Date.now()
      let part: Partial<EngineResult> = {}
      try {
        if (engine === 'legacy') {
          const { url } = buildProxyUrl(cfg, item.country, relay.socksPort, 'socks5')
          part = await runLegacy(item, url)
        } else if (engine === 'ky') {
          part = await runKy(item, cfg, item.country, relay.socksPort)
        } else if (engine === 'puppeteer') {
          part = await runPuppeteer(item, relay.httpPort)
        } else if (engine === 'obscura') {
          part = await runObscura(item, cfg, relay.socksPort)
        }
      } catch (e) {
        part = { finalUrl: '', error: e instanceof Error ? e.message.slice(0, 120) : String(e) }
      }
      const ms = Date.now() - t0
      const bytes = relay.bytes()
      const finalUrl = part.finalUrl || ''
      const j = judge(item, finalUrl)
      const row: EngineResult = {
        engine, umId: item.umId, ok: j.ok, finalUrl,
        domainMatch: j.domainMatch, hasTracking: j.hasTracking,
        ms, bytes, hops: part.hops ?? 0, error: part.error || '',
      }
      results.push(row)
      const flag = j.ok ? 'OK ' : j.domainMatch ? 'DOM' : '   '
      console.log(
        `[${engine}] ${String(i + 1).padStart(2)}/${ordered.length} ${flag} ${item.grp} ${item.platform.padEnd(4)} ` +
        `${item.merchantName.slice(0, 18).padEnd(18)} ${String(ms).padStart(6)}ms ${(bytes / 1024).toFixed(0).padStart(6)}KB ` +
        `${row.error ? '! ' + row.error.slice(0, 40) : finalUrl.slice(0, 60)}`,
      )
      fs.writeFileSync(OUT_JSON, JSON.stringify({ items, results }, null, 1))
    }
  }

  relay.close()
  printSummary(items, results, engines)
}

function printSummary(items: BenchItem[], results: EngineResult[], engines: string[]) {
  const byId = new Map(items.map((i) => [i.umId, i]))
  console.log('\n\n================ 汇总 ================')
  console.log('引擎        组   条数  直出  域名命中  中位耗时  中位流量')
  for (const engine of engines) {
    for (const grp of ['A', 'B', 'C']) {
      const rows = results.filter((r) => r.engine === engine && byId.get(r.umId)?.grp === grp)
      if (!rows.length) continue
      const ok = rows.filter((r) => r.ok).length
      const dm = rows.filter((r) => r.domainMatch).length
      const med = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0 }
      console.log(
        `${engine.padEnd(11)} ${grp}   ${String(rows.length).padStart(4)}  ${String(ok).padStart(4)}  ` +
        `${String(dm).padStart(8)}  ${String(med(rows.map((r) => r.ms))).padStart(7)}ms  ` +
        `${(med(rows.map((r) => r.bytes)) / 1024).toFixed(0).padStart(6)}KB`,
      )
    }
  }
  console.log(`\n明细已写入 ${OUT_JSON}`)
}

main()
  .catch((e) => { console.error('[bench] 失败:', e); process.exitCode = 1 })

