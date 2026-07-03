/**
 * R-01 一次性迁移：platform_connections.payee 文本 → payment_methods 清单 + 绑定
 *
 * 逻辑：
 *   1. 找出所有 is_deleted=0 且 payee 非空的连接，按所属用户的 team_id 分组
 *   2. 每个 team 内按 payee 姓名去重，创建 payment_methods（卡号暂空，组长后续在 UI 补录）
 *   3. 把连接的 payment_method_id 回填为对应清单项
 *
 * 幂等：payment_methods 按 (team_id, payee_name) 查重，已绑定的连接跳过。
 * 服务器上运行：cd crm-mvp && npx tsx scripts/r01-migrate-payee.ts
 */
import "dotenv/config";
import prisma from "../src/lib/prisma";

async function main() {
  const conns = await prisma.platform_connections.findMany({
    where: { is_deleted: 0, payee: { not: null }, payment_method_id: null },
    select: { id: true, user_id: true, payee: true, platform: true, account_name: true },
  });
  const withPayee = conns.filter((c) => (c.payee || "").trim() !== "");
  console.log(`待迁移连接：${withPayee.length} 条`);
  if (withPayee.length === 0) return;

  const userIds = [...new Set(withPayee.map((c) => c.user_id))];
  const users = await prisma.users.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true, team_id: true },
  });
  const teamByUser = new Map(users.map((u) => [String(u.id), u.team_id]));

  // team_id + payee_name → payment_methods.id 缓存
  const methodCache = new Map<string, bigint>();

  let created = 0;
  let bound = 0;
  let skipped = 0;

  for (const conn of withPayee) {
    const teamId = teamByUser.get(String(conn.user_id));
    if (!teamId) {
      console.warn(`  跳过 conn#${conn.id}（用户 ${conn.user_id} 无 team_id）`);
      skipped++;
      continue;
    }
    const payeeName = (conn.payee || "").trim();
    const key = `${teamId}:${payeeName}`;

    let methodId = methodCache.get(key);
    if (!methodId) {
      const existing = await prisma.payment_methods.findFirst({
        where: { team_id: teamId, payee_name: payeeName, is_deleted: 0 },
      });
      if (existing) {
        methodId = existing.id;
      } else {
        const row = await prisma.payment_methods.create({
          data: { team_id: teamId, payee_name: payeeName, card_no: "" },
        });
        methodId = row.id;
        created++;
        console.log(`  新建收款方式 #${row.id} team=${teamId} ${payeeName}`);
      }
      methodCache.set(key, methodId);
    }

    await prisma.platform_connections.update({
      where: { id: conn.id },
      data: { payment_method_id: methodId },
    });
    bound++;
  }

  console.log(`完成：新建清单 ${created} 条，回填绑定 ${bound} 条，跳过 ${skipped} 条`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
