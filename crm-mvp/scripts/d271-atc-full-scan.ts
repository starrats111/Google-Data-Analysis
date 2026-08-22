/**
 * D-271（07 2026-08-22 拍板）：全量商家 ATC 竞争度扫描——查真帐第一步
 *
 * 口径：「在任何位置投放的广告」（region=ALL，不带国家筛选），与广告主在投数 D-259 口径一致。
 * 通道：仅直连 adstransparency.google.com（serpApiKeys 传空 = 明确禁烧 SerpApi 配额）。
 * 节奏：单并发 + 每域名 sleep（默认 2.5s+抖动）；连续失败 ≥5 视为被限频，冷却 15 分钟再继续
 *       （D-260 教训：批量打太快曾被封 IP 14 小时）。
 * 断点续跑：域名已有 7 天内的 ALL 快照即跳过，重启脚本自动接着跑。
 * 镜像：每 1000 个域名 + 结束时，把 ALL 快照按域名刷回所有用户的商家行（分 id 段执行防长锁）。
 *
 * 用法（生产服务器 crm-mvp 目录）：
 *   npx tsx scripts/d271-atc-full-scan.ts --phase=claimed    # 第一阶段：已认领+暂停（约 3204 域名）
 *   npx tsx scripts/d271-atc-full-scan.ts --phase=available  # 第二阶段：商家库其余（约 3.5 万域名）
 *   可选：--sleep-ms=2500 --limit=100（试跑用）
 */
process.loadEnvFile(".env");

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args.set(m[1], m[2]);
}
const PHASE = args.get("phase") === "available" ? "available" : "claimed";
const SLEEP_MS = Number(args.get("sleep-ms") ?? 2500);
const LIMIT = Number(args.get("limit") ?? 0); // 0 = 不限
const FRESH_DAYS = 7;
const MIRROR_EVERY = 1000;
const COOLDOWN_MS = 15 * 60_000;
const CONSEC_FAIL_THRESHOLD = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function main() {
  const { default: prisma } = await import("../src/lib/prisma");
  const { queryMerchantAtc, extractDomain } = await import("../src/lib/atc-service");

  // ── 1. 收集去重域名（代表行取第一条，claimed 优先靠 phase 顺序保证）──
  log(`phase=${PHASE} 开始收集域名…`);
  const statusFilter = PHASE === "claimed" ? ["claimed", "paused"] : ["available"];
  const domainRep = new Map<string, { id: bigint; name: string }>();

  let cursor = 0n;
  for (;;) {
    const rows: Array<{ id: bigint; merchant_url: string | null; merchant_name: string }> =
      await prisma.user_merchants.findMany({
        where: { id: { gt: cursor }, is_deleted: 0, status: { in: statusFilter }, merchant_url: { not: "" } },
        select: { id: true, merchant_url: true, merchant_name: true },
        orderBy: { id: "asc" },
        take: 50_000,
      });
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;
    for (const r of rows) {
      const d = extractDomain(r.merchant_url);
      if (d && !domainRep.has(d)) domainRep.set(d, { id: r.id, name: r.merchant_name });
    }
    log(`已扫 user_merchants 到 id=${cursor}，累计域名 ${domainRep.size}`);
  }
  log(`去重域名总数：${domainRep.size}`);

  // ── 2. 预加载 ALL 快照新鲜度，跳过 7 天内已查的（断点续跑）──
  const freshCutoff = new Date(Date.now() - FRESH_DAYS * 86400_000);
  const freshDomains = new Set<string>();
  const allDomains = Array.from(domainRep.keys());
  for (let i = 0; i < allDomains.length; i += 5000) {
    const snaps = await prisma.merchant_atc_snapshots.findMany({
      where: { domain: { in: allDomains.slice(i, i + 5000) }, region: "ALL", fetched_at: { gte: freshCutoff } },
      select: { domain: true },
    });
    for (const s of snaps) freshDomains.add(s.domain);
  }
  const todo = allDomains.filter((d) => !freshDomains.has(d));
  log(`已有 ${FRESH_DAYS} 天内 ALL 快照：${freshDomains.size} 个（跳过）；本轮待查：${todo.length} 个`);

  // ── 3. 逐域名查询（单并发 + 限速 + 连败冷却）──
  const mirror = async () => {
    log("镜像回写开始（ALL 快照 → 所有用户商家行，分 id 段防长锁）…");
    const bounds = await prisma.$queryRawUnsafe<Array<{ mn: bigint | null; mx: bigint | null }>>(
      `SELECT MIN(id) mn, MAX(id) mx FROM user_merchants WHERE is_deleted=0`,
    );
    const mn = bounds[0]?.mn, mx = bounds[0]?.mx;
    if (mn == null || mx == null) return;
    let touched = 0;
    const STEP = 200_000n;
    for (let lo = BigInt(mn); lo <= BigInt(mx); lo += STEP) {
      const hi = lo + STEP - 1n;
      const n = await prisma.$executeRawUnsafe(
        `UPDATE user_merchants um
           JOIN merchant_atc_snapshots s
             ON s.region='ALL'
            AND s.domain = TRIM(LEADING 'www.' FROM LOWER(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(REPLACE(REPLACE(um.merchant_url,'https://',''),'http://',''),'/',1),'?',1),'#',1),':',1)))
            SET um.atc_advertiser_count = s.real_advertiser_count,
                um.atc_last_synced_at   = s.fetched_at,
                um.atc_sync_status      = 'done'
          WHERE um.id BETWEEN ${lo} AND ${hi}
            AND um.is_deleted=0 AND um.merchant_url IS NOT NULL AND um.merchant_url <> ''
            AND (um.atc_last_synced_at IS NULL OR um.atc_last_synced_at < s.fetched_at)`,
      );
      touched += Number(n) || 0;
    }
    log(`镜像回写完成：更新 ${touched} 行`);
  };

  let done = 0, ok = 0, fail = 0, consecFail = 0;
  const total = LIMIT > 0 ? Math.min(LIMIT, todo.length) : todo.length;

  for (const domain of todo) {
    if (LIMIT > 0 && done >= LIMIT) break;
    const rep = domainRep.get(domain)!;
    try {
      const r = await queryMerchantAtc({
        merchantId: rep.id,
        merchantName: rep.name,
        domain,
        region: "ALL",
        serpApiKeys: [],       // 禁走 SerpApi
        forceRefresh: true,    // 新鲜度已在上面自筛，这里强制拉新
      });
      ok++;
      consecFail = 0;
      log(`[${done + 1}/${total}] ${domain} raw=${r.rawCount} real=${r.realCount}`);
    } catch (e) {
      fail++;
      consecFail++;
      log(`[${done + 1}/${total}] ${domain} FAIL: ${String(e).slice(0, 160)}`);
      if (consecFail >= CONSEC_FAIL_THRESHOLD) {
        log(`连续失败 ${consecFail} 次，疑似被限频，冷却 ${COOLDOWN_MS / 60000} 分钟…`);
        await sleep(COOLDOWN_MS);
        consecFail = 0;
      }
    }
    done++;
    if (done % MIRROR_EVERY === 0) await mirror();
    await sleep(SLEEP_MS + Math.floor(Math.random() * 500));
  }

  await mirror();
  log(`phase=${PHASE} 完成：done=${done} ok=${ok} fail=${fail}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("d271-atc-full-scan 失败:", e);
  process.exit(1);
});
