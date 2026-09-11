/**
 * D-322 一次性清理：把同一物理联盟账户重复入库的打款单收敛成一行。
 *
 * 病灶（详见 prisma/migrations/20260911020000_d322_payment_account_identity）：
 * 联盟「支付/打款」接口是账户级返回，affiliate_payments 唯一键含 platform_connection_id，
 * 同一 payment_no 落到同账户的两条连接就是两行。三种漏法都已在写入侧修掉，本脚本清存量。
 *
 * 与 d080-dedup-affiliate-payments 的区别：
 *   - 只在**确认同一物理账户**（payment_account_key 相同，或 api_key 相同）的组内合并，
 *     不做全局 (platform, payment_no) 合并 —— 后者依赖「跨账户永不撞号」这个未来可能被打破的假设；
 *   - 会顺带修正保留行的 user_id（跨成员误挂时旧行归属人是错的，如 LH conn#243/#323）；
 *   - 分平台分批扫描，不把整表读进内存（生产机 3.66GB 且常在 swap）。
 *
 * 保留规则（组内择一，其余软删）：
 *   存活连接 > 交易数更多的连接 > 建连更早 > 行 id 更小（稳定）
 * 保留行的 user_id 一律改成**被保留连接的归属人**，与写入侧 D-322 口径一致。
 *
 * 安全约束：
 *   - 默认 dry-run，只打印计划；加 --apply 才写库；
 *   - 组内金额/币种不一致视为异常，整组跳过并告警；
 *   - 只软删（is_deleted=1），可回滚；
 *   - --platform=PM 可限定单平台先小范围验证。
 *
 * 用法（在 crm-mvp 目录，先备份 affiliate_payments）：
 *   预览：  npx tsx scripts/d322-dedup-payments-by-account.ts
 *   单平台：npx tsx scripts/d322-dedup-payments-by-account.ts --platform=PM
 *   执行：  npx tsx scripts/d322-dedup-payments-by-account.ts --apply
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

type PayRow = {
  id: bigint;
  user_id: bigint;
  platform: string;
  payment_no: string;
  platform_connection_id: bigint | null;
  amount: unknown;
  currency: string;
};

type ConnMeta = {
  id: bigint;
  user_id: bigint;
  platform: string;
  account_name: string | null;
  api_key: string | null;
  payment_account_key: string | null;
  is_deleted: number;
  created_at: Date | null;
  txns: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  const apply = process.argv.includes("--apply");
  const platformArg = process.argv.find((a) => a.startsWith("--platform="))?.split("=")[1];
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");

  try {
    // ── 1. 连接元信息 + 各连接存活交易数（用于挑保留行） ──
    const conns = await prisma.platform_connections.findMany({
      select: {
        id: true, user_id: true, platform: true, account_name: true,
        api_key: true, payment_account_key: true, is_deleted: true, created_at: true,
      },
    });
    const txnCounts = await prisma.$queryRawUnsafe<{ pc: bigint | number; n: bigint | number }[]>(
      `SELECT platform_connection_id pc, COUNT(*) n FROM affiliate_transactions
       WHERE is_deleted = 0 AND platform_connection_id IS NOT NULL
       GROUP BY platform_connection_id`,
    );
    const txnMap = new Map(txnCounts.map((r) => [String(r.pc), Number(r.n)]));
    const connMap = new Map<string, ConnMeta>(
      conns.map((c) => [String(c.id), { ...c, txns: txnMap.get(String(c.id)) ?? 0 }]),
    );

    /** 物理账户身份：显式 key 优先，回退 api_key，再回退连接自身（=不与任何人合并） */
    const acctIdentity = (cid: string | null): string | null => {
      if (!cid) return null;
      const c = connMap.get(cid);
      if (!c) return null;
      const explicit = (c.payment_account_key || "").trim().toLowerCase();
      if (explicit) return `${c.platform}|acct|${explicit}`;
      const key = (c.api_key || "").trim();
      if (key.length > 5) return `${c.platform}|key|${key}`;
      return `${c.platform}|conn|${cid}`;
    };

    const platforms = platformArg
      ? [platformArg]
      : [...new Set(conns.map((c) => c.platform))];

    let totalDupGroups = 0;
    let totalSkipped = 0;
    const toDelete: bigint[] = [];
    const userFixes: { id: bigint; from: bigint; to: bigint }[] = [];
    const samples: string[] = [];
    let inflatedUsd = 0;

    // ── 2. 分平台扫描，组内收敛 ──
    for (const platform of platforms) {
      const rows = (await prisma.affiliate_payments.findMany({
        where: { is_deleted: 0, platform },
        select: {
          id: true, user_id: true, platform: true, payment_no: true,
          platform_connection_id: true, amount: true, currency: true,
        },
        orderBy: { id: "asc" },
      })) as PayRow[];

      // 组键 = 物理账户 + 单号。归不出账户身份的行（conn 为 NULL/查不到）单独成组，不参与合并。
      const groups = new Map<string, PayRow[]>();
      for (const r of rows) {
        const ident = acctIdentity(r.platform_connection_id ? String(r.platform_connection_id) : null);
        const key = `${ident ?? `orphan|${r.id}`}::${r.payment_no}`;
        const g = groups.get(key);
        if (g) g.push(r);
        else groups.set(key, [r]);
      }

      for (const [key, g] of groups) {
        if (g.length <= 1) continue;

        // 金额/币种不一致 = 不是纯重复，整组跳过（宁可留重复，也不改错总额）
        const amounts = new Set(g.map((r) => Number(r.amount).toFixed(2)));
        const currencies = new Set(g.map((r) => r.currency));
        if (amounts.size > 1 || currencies.size > 1) {
          totalSkipped++;
          console.warn(
            `  [跳过-不一致] ${key} -> ${[...amounts].map((a) => "$" + a).join(" / ")}` +
            `${currencies.size > 1 ? ` 币种 ${[...currencies].join("/")}` : ""}`,
          );
          continue;
        }

        // 保留：存活连接 > 交易多 > 建连早 > 行 id 小
        const keep = [...g].sort((a, b) => {
          const ca = connMap.get(String(a.platform_connection_id));
          const cb = connMap.get(String(b.platform_connection_id));
          const la = ca && ca.is_deleted === 0 ? 1 : 0;
          const lb = cb && cb.is_deleted === 0 ? 1 : 0;
          if (la !== lb) return lb - la;
          const na = ca?.txns ?? 0;
          const nb = cb?.txns ?? 0;
          if (na !== nb) return nb - na;
          const ta = ca?.created_at ? new Date(ca.created_at).getTime() : Number.MAX_SAFE_INTEGER;
          const tb = cb?.created_at ? new Date(cb.created_at).getTime() : Number.MAX_SAFE_INTEGER;
          if (ta !== tb) return ta - tb;
          return Number(a.id) - Number(b.id);
        })[0];

        totalDupGroups++;
        const dels = g.filter((r) => r.id !== keep.id);
        for (const d of dels) {
          toDelete.push(d.id);
          inflatedUsd += Number(d.amount || 0);
        }

        // 保留行归属人对齐被保留连接的 owner（跨成员误挂的存量错归在此修正）
        const keepConn = connMap.get(String(keep.platform_connection_id));
        if (keepConn && String(keepConn.user_id) !== String(keep.user_id)) {
          userFixes.push({ id: keep.id, from: keep.user_id, to: keepConn.user_id });
        }

        if (samples.length < 15) {
          const desc = g
            .map((r) => {
              const c = connMap.get(String(r.platform_connection_id));
              return `conn#${r.platform_connection_id}(${c?.account_name ?? "?"}${c?.is_deleted ? ",已删" : ""},u${r.user_id})`;
            })
            .join(" + ");
          samples.push(
            `  ${platform} ${keep.payment_no} $${Number(keep.amount).toFixed(2)}  ${desc}` +
            ` → 保留 pay#${keep.id} @conn#${keep.platform_connection_id}`,
          );
        }
      }
    }

    console.log("==================== D-322 打款按物理账户去重 ====================");
    console.log(`扫描平台：${platforms.join(", ")}`);
    console.log(`重复组：${totalDupGroups}`);
    console.log(`不一致被跳过的组：${totalSkipped}`);
    console.log(`将软删的重复行：${toDelete.length}（合计 $${r2(inflatedUsd)}）`);
    console.log(`将修正 user_id 的保留行：${userFixes.length}`);
    if (samples.length) {
      console.log("样例：");
      for (const s of samples) console.log(s);
    }
    if (userFixes.length) {
      console.log("user_id 修正样例：");
      for (const f of userFixes.slice(0, 10)) {
        console.log(`  pay#${f.id}: user ${f.from} → ${f.to}`);
      }
    }

    if (!apply) {
      console.log("\n[DRY-RUN] 未做任何修改。确认无误后加 --apply 执行。");
      return;
    }

    let deleted = 0;
    for (let i = 0; i < toDelete.length; i += 500) {
      const batch = toDelete.slice(i, i + 500);
      const res = await prisma.affiliate_payments.updateMany({
        where: { id: { in: batch }, is_deleted: 0 },
        data: { is_deleted: 1 },
      });
      deleted += res.count;
    }
    let fixed = 0;
    for (const f of userFixes) {
      const res = await prisma.affiliate_payments.updateMany({
        where: { id: f.id, is_deleted: 0 },
        data: { user_id: f.to },
      });
      fixed += res.count;
    }
    console.log(`\n[APPLY] 已软删重复行：${deleted}；已修正归属人：${fixed}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
