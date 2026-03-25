import "dotenv/config";
import prisma from "../src/lib/prisma";

async function main() {
  // 查每个成员的交易来源：platform_connection_id 分布
  const members = await prisma.users.findMany({
    where: { team_id: BigInt(1), is_deleted: 0, role: { not: "admin" } },
    select: { id: true, username: true },
    orderBy: { id: "asc" },
  });

  for (const m of members) {
    const stats = await prisma.$queryRawUnsafe<
      { platform: string; conn_id: string; cnt: number }[]
    >(
      `SELECT platform, 
              CAST(platform_connection_id AS CHAR) as conn_id, 
              COUNT(*) as cnt 
       FROM affiliate_transactions 
       WHERE user_id = ? AND is_deleted = 0 
       GROUP BY platform, platform_connection_id 
       ORDER BY cnt DESC`,
      m.id,
    );

    const total = stats.reduce((s, r) => s + Number(r.cnt), 0);
    console.log(JSON.stringify({
      username: m.username,
      user_id: m.id.toString(),
      total_txns: total,
      sources: stats.map((r) => ({
        platform: r.platform,
        connection_id: r.conn_id,
        count: Number(r.cnt),
      })),
    }));
  }
}
main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma["$disconnect"]());
