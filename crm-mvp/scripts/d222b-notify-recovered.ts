/**
 * D-222B 更正通知：撤回「链接已失效」待办里被误报的那几条。
 *
 * D-222 那批通知发出时，判定只经过了「出口国校对」这一关。后来发现机房出口同样会被广告主
 * 反爬拦成 403（见 设计方案.md D-222B 第五节），于是加了「403 换出口复核」，
 * 复核后有商家翻案成有效——归属人手上那条「请手动重新获取链接」的待办就成了白干。
 *
 * 本脚本从 24h 内发过的失效通知里取出商家清单，挑出现在已恢复 ok 的，给归属人发一条更正。
 *
 * 用法：
 *   cd /home/ubuntu/Google-Data-Analysis/crm-mvp
 *   npx tsx scripts/d222b-notify-recovered.ts            # 干跑
 *   npx tsx scripts/d222b-notify-recovered.ts --apply
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";

const APPLY = process.argv.includes("--apply");
const SOURCE = "D-222 dead-tracker-link";
const TITLE = "更正：之前报「失效」的链接里有误报，已恢复";

async function main() {
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");

  const since = new Date(Date.now() - 24 * 3600_000);
  const notices = await prisma.notifications.findMany({
    where: { is_deleted: 0, created_at: { gte: since } },
    select: { user_id: true, metadata: true },
  });

  // 归属人 → 当初被列为失效的商家 id
  const claimed = new Map<string, Set<string>>();
  for (const n of notices) {
    if (!n.metadata) continue;
    let meta: { source?: string; merchant_ids?: string[] };
    try {
      meta = JSON.parse(n.metadata) as typeof meta;
    } catch {
      continue;
    }
    if (meta.source !== SOURCE || !Array.isArray(meta.merchant_ids)) continue;
    const key = String(n.user_id);
    if (!claimed.has(key)) claimed.set(key, new Set());
    for (const id of meta.merchant_ids) claimed.get(key)!.add(String(id));
  }

  const allIds = [...new Set([...claimed.values()].flatMap((s) => [...s]))];
  if (allIds.length === 0) {
    console.log("24 小时内没有发过失效通知，无需更正。");
    await prisma.$disconnect();
    return;
  }

  const recovered = await prisma.user_merchants.findMany({
    where: { id: { in: allIds.map((s) => BigInt(s)) }, is_deleted: 0, tracking_status: "ok" },
    select: { id: true, user_id: true, merchant_name: true, merchant_id: true, platform: true },
  });
  if (recovered.length === 0) {
    console.log(`当初通知的 ${allIds.length} 个商家目前没有恢复的，无需更正。`);
    await prisma.$disconnect();
    return;
  }

  const byUser = new Map<string, typeof recovered>();
  for (const m of recovered) {
    const key = String(m.user_id);
    if (!claimed.get(key)?.has(String(m.id))) continue; // 只更正「确实通知过这个人」的
    if (!byUser.has(key)) byUser.set(key, []);
    byUser.get(key)!.push(m);
  }

  const users = await prisma.users.findMany({
    where: { id: { in: [...byUser.keys()].map((k) => BigInt(k)) } },
    select: { id: true, username: true },
  });
  const nameOf = new Map(users.map((u) => [String(u.id), u.username]));

  let sent = 0;
  for (const [uid, list] of byUser) {
    const username = nameOf.get(uid) || uid;
    const lines = list.map((m) => `  • [${m.platform || "-"}] ${m.merchant_name}（MID ${m.merchant_id}）`);
    const content = [
      `之前那条「链接已失效」的待办里，下面 ${list.length} 个商家是误报，链接一直是好的，不用去换：`,
      ``,
      ...lines,
      ``,
      `原因：巡航时代理抽到了机房 IP，被广告主反爬拦成 403，系统当成了链接失效。`,
      `已经改成拿到 403 时换一个出口复核一次，两次都被拒才判失效，同类误报不会再有。`,
      ``,
      `这几个商家已自动恢复，补货和换链接照常，不需要你做任何操作。`,
      `同一条通知里的其他商家仍然是真失效，还是要去联盟平台重新取链接。`,
    ].join("\n");

    if (!APPLY) {
      console.log(`\n===== 将发给 ${username}（user_id=${uid}）=====`);
      console.log(TITLE);
      console.log(content);
      continue;
    }

    await prisma.notifications.create({
      data: {
        user_id: BigInt(uid),
        type: "info",
        title: TITLE,
        content,
        metadata: JSON.stringify({
          source: "d222b-recovered",
          merchant_ids: list.map((m) => m.id.toString()),
        }),
      },
    });
    sent++;
    console.log(`已更正 ${username}：${list.length} 个商家`);
  }

  console.log(
    APPLY
      ? `\n完成：发出 ${sent} 条更正，共 ${recovered.length} 个商家恢复。`
      : `\n（干跑，共 ${byUser.size} 个归属人 / ${recovered.length} 个恢复商家，确认后加 --apply）`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
