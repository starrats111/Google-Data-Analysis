/**
 * 从 kyads 批量导入联盟平台连接到 CRM（辅助脚本，手动运行）
 *
 * 作用：把 kyads 的 network_account_sources（员工配置的联盟平台 API Token）批量导入到
 * CRM 的 platform_connections，为「尚未配置该平台连接」的 CRM 员工补齐连接，之后由 CRM 的
 * 商家同步把联盟链接写入 user_merchants（供换链接使用）。
 *
 * ⚠️ 安全：
 *  - 默认 dry-run（仅预览，不写库）。确认无误后加 --commit 才会写入 CRM。
 *  - 只为「CRM 该员工 + 该平台尚无有效连接」的情况新增（--only-missing，默认开）。
 *  - 本脚本写的是 CRM 生产库，请务必先 dry-run 核对映射结果。
 *
 * 数据来源（二选一）：
 *  A. 导出文件： --file=./kyads-sources.json
 *     文件为数组，每项至少含：
 *       { network_account, network_type, account_name, api_token, payee_name, status,
 *         kyads_user_name, kyads_user_code, kyads_user_email }
 *  B. 直连 kyads 库： --kyads-url="mysql://user:pass@127.0.0.1:3308/dbname"
 *     （或设置环境变量 KYADS_DATABASE_URL；需先开 kyads SSH 隧道）
 *
 * 员工映射（kyads 员工 → CRM 用户）：
 *  --map=./user-map.json   形如 { "张三": "zhangsan", "u001": "zhangsan", "a@b.com": "zhangsan" }
 *  键可为 kyads 的 name / user_code / email；值为 CRM username。
 *  未提供映射时，自动按 (display_name==name) 或 (username==user_code) 或 (username==name) 匹配。
 *
 * 平台代码映射：
 *  --platform-map=./platform-map.json  形如 { "RAKUTEN": "RW" }
 *  默认把 kyads network_account 直接大写作为 CRM platform。
 *
 * 触发同步：
 *  --trigger-sync  导入完成后，对涉及到的 (用户, 平台) 触发一次 CRM 商家同步。
 *
 * 用法示例：
 *  预览：  npx tsx scripts/import-kyads-platform-connections.ts --file=./kyads-sources.json --map=./user-map.json
 *  执行：  npx tsx scripts/import-kyads-platform-connections.ts --file=./kyads-sources.json --map=./user-map.json --commit --trigger-sync
 */

import { readFileSync } from 'node:fs'
import prisma from '../src/lib/prisma'

interface KyadsSource {
  network_account: string
  network_type?: string
  account_name?: string
  api_token: string
  payee_name?: string | null
  status?: string
  kyads_user_name?: string | null
  kyads_user_code?: string | null
  kyads_user_email?: string | null
}

interface Args {
  file?: string
  kyadsUrl?: string
  map?: string
  platformMap?: string
  excludePlatforms: Set<string>
  commit: boolean
  onlyMissing: boolean
  triggerSync: boolean
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const get = (k: string) => {
    const p = argv.find((a) => a.startsWith(`--${k}=`))
    return p ? p.slice(k.length + 3) : undefined
  }
  const has = (k: string) => argv.includes(`--${k}`)
  const exclude = (get('exclude-platforms') ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
  return {
    file: get('file'),
    kyadsUrl: get('kyads-url') ?? process.env.KYADS_DATABASE_URL,
    map: get('map'),
    platformMap: get('platform-map'),
    excludePlatforms: new Set(exclude),
    commit: has('commit'),
    onlyMissing: !has('no-only-missing'),
    triggerSync: has('trigger-sync'),
  }
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/** 从 kyads 库直连读取 network_account_sources + users（用 mariadb 驱动，CRM 已安装） */
async function readFromKyadsDb(url: string): Promise<KyadsSource[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mariadb: any = await import('mariadb')
  const u = new URL(url)
  const conn = await mariadb.createConnection({
    host: u.hostname,
    port: u.port ? parseInt(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    connectTimeout: 15000,
  })
  try {
    const rows = await conn.query(
      `SELECT s.network_account, s.network_type, s.account_name, s.api_token, s.payee_name, s.status,
              u.name AS kyads_user_name, u.user_code AS kyads_user_code, u.email AS kyads_user_email
       FROM network_account_sources s
       LEFT JOIN users u ON u.id = s.user_id AND u.delete_token = 0
       WHERE s.is_deleted = 0 AND s.delete_token = 0 AND s.status = 'active'`,
    )
    return (rows as KyadsSource[]).map((r) => ({ ...r }))
  } finally {
    await conn.end()
  }
}

async function main() {
  const args = parseArgs()

  if (!args.file && !args.kyadsUrl) {
    console.error('错误：必须提供 --file=<json> 或 --kyads-url=<mysql url>（或环境变量 KYADS_DATABASE_URL）')
    process.exit(1)
  }

  console.log(`模式：${args.commit ? '⚠️ 提交写入 (--commit)' : '预览 dry-run（不写库）'}`)

  // 1. 读取 kyads 源
  let sources: KyadsSource[]
  if (args.file) {
    sources = loadJson<KyadsSource[]>(args.file)
    console.log(`从文件读取 ${sources.length} 条 kyads 联盟平台账号`)
  } else {
    sources = await readFromKyadsDb(args.kyadsUrl!)
    console.log(`从 kyads 库读取 ${sources.length} 条 active 联盟平台账号`)
  }

  // 2. 加载映射
  const userMap: Record<string, string> = args.map ? loadJson(args.map) : {}
  const platformMap: Record<string, string> = args.platformMap ? loadJson(args.platformMap) : {}

  // 3. 预载 CRM 用户用于自动匹配
  const crmUsers = await prisma.users.findMany({
    where: { is_deleted: 0 },
    select: { id: true, username: true, display_name: true },
  })
  const byUsername = new Map(crmUsers.map((u) => [u.username.toLowerCase(), u]))
  const byDisplay = new Map(crmUsers.filter((u) => u.display_name).map((u) => [u.display_name!.toLowerCase(), u]))

  const resolveCrmUser = (s: KyadsSource): { id: bigint; username: string } | null => {
    const keys = [s.kyads_user_name, s.kyads_user_code, s.kyads_user_email].filter(Boolean) as string[]
    // 优先映射文件
    for (const k of keys) {
      const mapped = userMap[k]
      if (mapped) {
        const u = byUsername.get(mapped.toLowerCase())
        if (u) return { id: u.id, username: u.username }
      }
    }
    // 自动匹配：display_name==name / username==user_code / username==name
    if (s.kyads_user_name) {
      const u = byDisplay.get(s.kyads_user_name.toLowerCase()) ?? byUsername.get(s.kyads_user_name.toLowerCase())
      if (u) return { id: u.id, username: u.username }
    }
    if (s.kyads_user_code) {
      const u = byUsername.get(s.kyads_user_code.toLowerCase())
      if (u) return { id: u.id, username: u.username }
    }
    return null
  }

  // 平台代码取 network_type（干净代码，如 BSH/PM/RW）；kyads 的 network_account 是「代码+账号序号」
  // （如 BSH1/PM2），不能直接当平台代码。兜底：用 network_account 去掉尾部数字。
  const resolvePlatform = (s: KyadsSource): string => {
    const raw = (s.network_type || s.network_account || '').trim()
    const up = raw.toUpperCase().replace(/\d+$/, '')
    return (platformMap[up] ?? platformMap[raw.toUpperCase()] ?? up).slice(0, 8)
  }

  // 4. 规划导入
  type Plan = { userId: bigint; username: string; platform: string; accountName: string; apiKey: string; payee: string | null }
  const toCreate: Plan[] = []
  const skipped: { reason: string; detail: string }[] = []
  const affectedSync = new Set<string>() // `${userId}:${platform}`

  for (const s of sources) {
    if (!s.api_token || s.api_token.trim().length < 4) {
      skipped.push({ reason: 'no_token', detail: `${s.network_account}/${s.account_name}` })
      continue
    }
    const crmUser = resolveCrmUser(s)
    if (!crmUser) {
      skipped.push({ reason: 'user_unmatched', detail: `${s.kyads_user_name ?? ''}/${s.kyads_user_code ?? ''}/${s.network_account}` })
      continue
    }
    const platform = resolvePlatform(s)
    if (!platform) {
      skipped.push({ reason: 'platform_empty', detail: `${s.network_account}` })
      continue
    }
    if (args.excludePlatforms.has(platform)) {
      skipped.push({ reason: 'excluded_platform', detail: `${crmUser.username}/${platform}` })
      continue
    }

    // only-missing：CRM 该用户该平台已有有效连接则跳过
    if (args.onlyMissing) {
      const exists = await prisma.platform_connections.count({
        where: { user_id: crmUser.id, platform, is_deleted: 0 },
      })
      if (exists > 0) {
        skipped.push({ reason: 'already_configured', detail: `${crmUser.username}/${platform}` })
        continue
      }
    }

    const accountName = (s.account_name || '').trim() || `${platform}1`
    toCreate.push({
      userId: crmUser.id,
      username: crmUser.username,
      platform,
      accountName,
      apiKey: s.api_token.trim(),
      payee: (s.payee_name || '').trim() || null,
    })
    affectedSync.add(`${crmUser.id.toString()}:${platform}`)
  }

  // 5. 输出计划
  console.log('\n===== 导入计划 =====')
  console.log(`将新增连接：${toCreate.length} 条`)
  for (const p of toCreate) {
    console.log(`  + ${p.username} | ${p.platform} | ${p.accountName} | key=${p.apiKey.slice(0, 6)}*** | payee=${p.payee ?? '-'}`)
  }
  const skipGroups = skipped.reduce<Record<string, number>>((acc, s) => { acc[s.reason] = (acc[s.reason] ?? 0) + 1; return acc }, {})
  console.log(`\n跳过：${skipped.length} 条`, skipGroups)
  if (skipped.length > 0) {
    const unmatched = skipped.filter((s) => s.reason === 'user_unmatched').slice(0, 20)
    if (unmatched.length > 0) {
      console.log('  未匹配到 CRM 用户的样例（请补充 --map 映射）：')
      unmatched.forEach((s) => console.log('    - ' + s.detail))
    }
  }

  if (!args.commit) {
    console.log('\n[dry-run] 未写入任何数据。确认无误后加 --commit 执行。')
    await prisma.$disconnect()
    return
  }

  // 6. 提交写入
  let created = 0
  for (const p of toCreate) {
    await prisma.platform_connections.create({
      data: {
        user_id: p.userId,
        platform: p.platform,
        account_name: p.accountName,
        api_key: p.apiKey,
        payee: p.payee,
        status: 'unverified',
      },
    })
    created++
  }
  console.log(`\n✅ 已写入 ${created} 条 platform_connections`)

  // 7. 触发同步（可选）
  if (args.triggerSync && affectedSync.size > 0) {
    console.log(`\n触发商家同步（${affectedSync.size} 组 用户×平台）...`)
    try {
      const { doSyncInBackground } = await import('../src/app/api/user/merchants/sync/route')
      for (const key of affectedSync) {
        const [uid, platform] = key.split(':')
        const userId = BigInt(uid)
        const conns = await prisma.platform_connections.findMany({
          where: { user_id: userId, platform, is_deleted: 0 },
          select: { id: true, platform: true, account_name: true, api_key: true, channel_id: true },
        })
        const valid = conns.filter((c) => c.api_key && c.api_key.length > 5)
        if (valid.length === 0) continue
        try {
          await doSyncInBackground(userId, valid, platform)
          console.log(`  ✓ 同步完成 user=${uid} platform=${platform}`)
        } catch (e) {
          console.warn(`  ✗ 同步失败 user=${uid} platform=${platform}: ${e instanceof Error ? e.message : e}`)
        }
      }
    } catch (e) {
      console.warn('触发同步失败（可改为在 CRM 后台/cron 手动同步）：', e instanceof Error ? e.message : e)
    }
  }

  await prisma.$disconnect()
  console.log('\n完成。')
}

main().catch(async (e) => {
  console.error('脚本异常：', e)
  await prisma.$disconnect().catch(() => {})
  process.exit(1)
})
