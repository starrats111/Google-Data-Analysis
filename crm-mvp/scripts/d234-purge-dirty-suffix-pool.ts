/**
 * D-234 存量清理：把后缀池里带「脏参数」的待投池行作废，让补货按新规则重新生成。
 *
 * 脏参数指两类（判定口径与 `sanitizeTrackingQuery()` 完全一致）：
 *   · `referer=` / `referrer=` —— 值是我方联盟中转链接，进了到达网址就是把发布者身份交给广告主
 *   · `url=<一个 URL>`         —— 跳板的深链目标参数（值即落地页自己），会让展示网址与到达网址不一致
 *
 * 只动 `status='available'`（还没投出去的）：
 *   · `consumed` 已经投过了，改它不影响 Google 上的现状，只会破坏历史对账；
 *   · `expired` 本来就不可用。
 *
 * 作废方式为 `status='expired'` 而**不是** `is_deleted=1`：这些池行代表真实发生过的一次联盟点击，
 * 「昨日点击」等统计口径按 `created_at` 数行数，软删会把真实点击从账上抹掉。
 *
 * 用法：
 *   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
 *   npx tsx scripts/d234-purge-dirty-suffix-pool.ts              # 干跑，只报数
 *   npx tsx scripts/d234-purge-dirty-suffix-pool.ts --apply      # 实际作废
 *   npx tsx scripts/d234-purge-dirty-suffix-pool.ts --campaign=17377 --apply   # 只处理一条系列
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

const APPLY = process.argv.includes("--apply");
const campaignArg = process.argv.find((a) => a.startsWith("--campaign="));
const ONLY_CAMPAIGN = campaignArg ? BigInt(campaignArg.split("=")[1]) : null;

/** 与 sanitizeTrackingQuery 同口径：这条后缀里是否含必须剔除的参数 */
function isDirtySuffix(suffix: string): boolean {
  return suffix.split("&").some((seg) => {
    if (!seg) return false;
    const eq = seg.indexOf("=");
    const key = (eq === -1 ? seg : seg.slice(0, eq)).toLowerCase();
    if (key === "referer" || key === "referrer") return true;
    if (key === "url") {
      const val = eq === -1 ? "" : seg.slice(eq + 1);
      return /^https?(:|%3a)/i.test(val);
    }
    return false;
  });
}

async function main() {
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");

  // SQL 侧先用 LIKE 粗筛（把绝大多数干净行挡在外面），再用与线上完全一致的分段判定精筛。
  // 光靠 LIKE '%referer=%' 会误伤 Kelkoo 的 originReferer=，所以精筛这一步不能省。
  const candidates = await prisma.$queryRawUnsafe<
    { id: bigint; campaign_id: bigint; suffix_content: string }[]
  >(
    `SELECT id, campaign_id, suffix_content
       FROM suffix_pool
      WHERE is_deleted = 0
        AND status = 'available'
        AND (suffix_content LIKE '%referer=%' OR suffix_content LIKE '%url=http%')
        ${ONLY_CAMPAIGN ? `AND campaign_id = ${ONLY_CAMPAIGN}` : ""}`,
  );

  const dirty = candidates.filter((r) => isDirtySuffix(r.suffix_content));
  const byCampaign = new Map<string, number>();
  for (const r of dirty) {
    const k = String(r.campaign_id);
    byCampaign.set(k, (byCampaign.get(k) ?? 0) + 1);
  }

  console.log(`[d234] LIKE 粗筛 ${candidates.length} 行 → 精筛确认脏行 ${dirty.length} 行，涉及 ${byCampaign.size} 个系列`);
  for (const [cid, n] of [...byCampaign].sort((a, b) => b[1] - a[1])) {
    console.log(`[d234]   campaign ${cid}: ${n} 行`);
  }
  if (candidates.length !== dirty.length) {
    console.log(`[d234] 其中 ${candidates.length - dirty.length} 行是 LIKE 误伤（如 Kelkoo 的 originReferer=），已放过`);
  }

  if (dirty.length === 0) {
    console.log("[d234] 无需处理");
    return;
  }
  if (!APPLY) {
    console.log("[d234] 干跑结束，加 --apply 才实际作废");
    console.log(`[d234] 样例：${dirty[0].suffix_content.slice(0, 160)}`);
    return;
  }

  // 分批 update，避免一次锁太多行（生产机 2 核）
  const ids = dirty.map((r) => r.id);
  let done = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const r = await prisma.suffix_pool.updateMany({
      where: { id: { in: batch }, status: "available", is_deleted: 0 },
      data: { status: "expired" },
    });
    done += r.count;
  }
  console.log(`[d234] 已作废 ${done} 行（status → expired），补货下一轮会按新规则重新生成`);
}

main()
  .catch((e) => {
    console.error("[d234] 失败:", e);
    process.exit(1);
  })
  .finally(async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    await prisma.$disconnect();
  });
