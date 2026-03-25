import "dotenv/config";
import prisma from "../src/lib/prisma";

async function main() {
  // 查所有 platform_connections（不限 user、不限 status、不限 is_deleted）
  const all = await prisma.platform_connections.findMany({
    select: {
      id: true,
      user_id: true,
      platform: true,
      status: true,
      account_name: true,
      api_key: true,
      is_deleted: true,
    },
    orderBy: { id: "asc" },
  });

  // 关联用户名
  const userIds = [...new Set(all.map((c) => c.user_id))];
  const users = await prisma.users.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true },
  });
  const userMap = new Map(users.map((u) => [u.id.toString(), u.username]));

  for (const c of all) {
    console.log(JSON.stringify({
      id: c.id.toString(),
      user_id: c.user_id.toString(),
      username: userMap.get(c.user_id.toString()) || "?",
      platform: c.platform,
      status: c.status,
      account_name: c.account_name || "",
      has_api_key: !!(c.api_key && c.api_key.length > 5),
      is_deleted: c.is_deleted,
    }));
  }
  console.log(`\ntotal: ${all.length}`);
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma["$disconnect"]());
