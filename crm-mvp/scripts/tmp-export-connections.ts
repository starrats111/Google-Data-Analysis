import "dotenv/config";
import prisma from "../src/lib/prisma";

async function main() {
  const all = await prisma.platform_connections.findMany({
    where: { is_deleted: 0, status: "connected" },
    select: {
      id: true,
      user_id: true,
      platform: true,
      status: true,
      account_name: true,
      api_key: true,
    },
    orderBy: { id: "asc" },
  });

  const userIds = [...new Set(all.map((c) => c.user_id))];
  const users = await prisma.users.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true },
  });
  const userMap = new Map(users.map((u) => [u.id.toString(), u.username]));

  // 只导出有 api_key 的
  const valid = all.filter((c) => c.api_key && c.api_key.length > 5);

  const output = valid.map((c) => ({
    username: userMap.get(c.user_id.toString()) || "unknown",
    server_user_id: c.user_id.toString(),
    server_conn_id: c.id.toString(),
    platform: c.platform,
    account_name: c.account_name || "",
    api_key: c.api_key,
  }));

  console.log(JSON.stringify(output, null, 2));
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma["$disconnect"]());
