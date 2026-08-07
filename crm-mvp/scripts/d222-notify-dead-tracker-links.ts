/**
 * D-222 配套：把「跳板 token 已被联盟停用」的商家按归属人推站内通知待办。
 *
 * 前置是 d222-recruise-tracker-forbidden.ts —— 先按新的出口国逻辑重巡一遍，
 * 把「用错出口国导致的地区误判」摘掉，剩下的 tracking_status='tracker_forbidden'
 * 才是真失效（用系列投放国的出口 IP 去点也照样 4xx），只能人工到联盟平台重新取链接。
 *
 * 每个归属人一条通知，列出其名下全部失效商家 + 受影响的在投系列。
 * 同一批不重复推：24 小时内已推过同源通知的用户跳过。
 *
 * 用法：
 *   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
 *   npx tsx scripts/d222-notify-dead-tracker-links.ts            # 干跑，打印将发给谁、发什么
 *   npx tsx scripts/d222-notify-dead-tracker-links.ts --apply    # 实际写入 notifications
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

const APPLY = process.argv.includes("--apply");
const SOURCE = "D-222 dead-tracker-link";
const TITLE_PREFIX = "联盟追踪链接已失效，需人工重新获取";

async function main() {
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");

  const merchants = await prisma.user_merchants.findMany({
    where: { is_deleted: 0, tracking_status: "tracker_forbidden" },
    select: {
      id: true,
      user_id: true,
      platform: true,
      merchant_id: true,
      merchant_name: true,
      parent_check_reason: true,
    },
    orderBy: { id: "asc" },
  });

  if (merchants.length === 0) {
    console.log("没有失效商家，无需通知。");
    await prisma.$disconnect();
    return;
  }

  // 受影响的在投系列（换链接页标红的就是这些行）
  const campaigns = await prisma.campaigns.findMany({
    where: { is_deleted: 0, user_merchant_id: { in: merchants.map((m) => m.id) } },
    select: { user_merchant_id: true, campaign_name: true, status: true },
  });
  const campByMerchant = new Map<string, Set<string>>();
  for (const c of campaigns) {
    if (c.status !== "active") continue;
    const key = String(c.user_merchant_id);
    if (!campByMerchant.has(key)) campByMerchant.set(key, new Set());
    campByMerchant.get(key)!.add(c.campaign_name);
  }
  const campsOf = (merchantId: bigint): string[] => [...(campByMerchant.get(String(merchantId)) || [])];

  const byUser = new Map<string, typeof merchants>();
  for (const m of merchants) {
    const key = String(m.user_id);
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key)!.push(m);
  }

  const users = await prisma.users.findMany({
    where: { id: { in: [...byUser.keys()].map((k) => BigInt(k)) } },
    select: { id: true, username: true },
  });
  const nameOf = new Map(users.map((u) => [String(u.id), u.username]));

  // 24h 内已推过同源通知的不重复打扰
  const since = new Date(Date.now() - 24 * 3600_000);
  const recent = await prisma.notifications.findMany({
    where: { is_deleted: 0, created_at: { gte: since }, title: { startsWith: TITLE_PREFIX } },
    select: { user_id: true },
  });
  const alreadyNotified = new Set(recent.map((n) => String(n.user_id)));

  let sent = 0;
  let skipped = 0;

  for (const [uid, list] of byUser) {
    const username = nameOf.get(uid) || uid;
    if (alreadyNotified.has(uid)) {
      skipped++;
      console.log(`跳过 ${username}（24 小时内已推过）`);
      continue;
    }

    // 有在投系列的排前面——那些是正在烧钱却换不了链接的，先处理
    const sorted = [...list].sort((a, b) => campsOf(b.id).length - campsOf(a.id).length);
    const running = sorted.filter((m) => campsOf(m.id).length > 0).length;
    const lines = sorted.map((m) => {
      const camps = campsOf(m.id);
      const tail = camps.length > 0 ? `　在投系列：${camps.join("、")}` : "　（当前无在投系列，不急）";
      return `  • [${m.platform || "-"}] ${m.merchant_name}（MID ${m.merchant_id}）${tail}`;
    });

    const content = [
      `以下 ${list.length} 个商家的联盟追踪链接，跳板已直接拒绝点击（返回 4xx），换链接页显示为「失效」。`,
      ...(running > 0 ? [`其中 ${running} 个有在投系列，正在跑但换不了链接，建议优先处理。`] : []),
      ``,
      ...lines,
      ``,
      `已排除误判：这批链接用「系列投放国」的出口 IP 复测过，同样打不开，不是代理或地区门禁的问题，`,
      `是联盟侧把这个追踪 token 停用了。系统自动补货补不出新后缀，换链接会一直失败。`,
      ``,
      `处理办法：到对应联盟平台重新获取该商家的推广链接，在「换链接管理」里点链接旁的铅笔图标替换。`,
      `换好后会立即重新验证，通过即自动恢复补货。`,
    ].join("\n");

    const title = `${TITLE_PREFIX}（${list.length} 个商家）`;

    if (!APPLY) {
      console.log(`\n===== 将发给 ${username}（user_id=${uid}）=====`);
      console.log(title);
      console.log(content);
      continue;
    }

    await prisma.notifications.create({
      data: {
        user_id: BigInt(uid),
        type: "warning",
        title,
        content,
        metadata: JSON.stringify({
          source: SOURCE,
          merchant_ids: list.map((m) => m.id.toString()),
          mids: list.map((m) => m.merchant_id),
        }),
      },
    });
    sent++;
    console.log(`已通知 ${username}：${list.length} 个商家`);
  }

  console.log(
    APPLY
      ? `\n完成：发出 ${sent} 条通知，跳过 ${skipped} 个（24h 内已推过）。共涉及 ${merchants.length} 个失效商家。`
      : `\n（以上为干跑，共 ${byUser.size} 个归属人 / ${merchants.length} 个失效商家，确认后加 --apply 实际发送）`,
  );

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
