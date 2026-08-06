/**
 * 对 status='error' 的联盟连接逐个做真实 API 验证，通过的恢复为 connected。
 *
 *   npx tsx scripts/revalidate-error-connections.ts [--dry] [--user=wj11]
 *
 * 背景：进程内存打爆导致事件循环冻结时，undici 会把所有出网请求误判成
 * UND_ERR_CONNECT_TIMEOUT，连续 3 次即被 markConnectionFailure 切成 error，
 * UI 显示成「API Key 已失效」。密钥本身没问题。
 *
 * 这里不直接改状态：复用 test-connection 同款口径（fetchAllTransactions 拉 1 天
 * 窗口），API 真的返回数据才写 connected，拉不通的保持 error 并打印真实错误。
 * 串行执行，生产机内存有限。
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";
import { fetchAllTransactions } from "../src/lib/platform-api";
import dayjs from "dayjs";

async function main() {
  loadEnvFromProjectRoot();
  const { default: prisma } = await import("../src/lib/prisma");
  const { markConnectionUserVerified, markConnectionFailure } = await import(
    "../src/lib/connection-health"
  );

  const dry = process.argv.includes("--dry");
  const userArg = process.argv.find((a) => a.startsWith("--user="))?.slice(7);

  // platform_connections 无到 users 的 relation，用户名单独查一次在内存里配对
  const users = await prisma.users.findMany({
    where: { is_deleted: 0, ...(userArg ? { username: userArg } : {}) },
    select: { id: true, username: true },
  });
  const nameOf = new Map(users.map((u) => [u.id.toString(), u.username]));

  const conns = await prisma.platform_connections.findMany({
    where: {
      is_deleted: 0,
      status: "error",
      ...(userArg ? { user_id: { in: users.map((u) => u.id) } } : {}),
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      user_id: true,
      platform: true,
      account_name: true,
      api_key: true,
      consecutive_failures: true,
      last_error: true,
    },
  });

  console.log(`待验证连接 ${conns.length} 个${dry ? "（dry-run，不写库）" : ""}\n`);

  const yesterday = dayjs().subtract(1, "day").format("YYYY-MM-DD");
  const today = dayjs().format("YYYY-MM-DD");

  let recovered = 0;
  let stillBad = 0;

  for (const c of conns) {
    const tag = `${nameOf.get(c.user_id.toString()) ?? "?"} ${c.platform} ${c.account_name}(id=${c.id})`;
    if (!c.api_key || c.api_key.length < 5) {
      console.log(`  ${tag}: 跳过，无 api_key`);
      stillBad++;
      continue;
    }

    const t0 = Date.now();
    try {
      const r = await fetchAllTransactions(c.platform, c.api_key, yesterday, today);
      const ms = Date.now() - t0;
      if (r.error) {
        console.log(`  ${tag}: 仍失败 (${ms}ms) — ${r.error}`);
        if (!dry) await markConnectionFailure(c.id, r.error);
        stillBad++;
      } else {
        console.log(
          `  ${tag}: 通过 (${ms}ms, ${r.transactions.length} 条样本, 原失败 ${c.consecutive_failures} 次) → connected`
        );
        if (!dry) await markConnectionUserVerified(c.id);
        recovered++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${tag}: 异常 (${Date.now() - t0}ms) — ${msg}`);
      if (!dry) await markConnectionFailure(c.id, `${c.platform}: ${msg}`);
      stillBad++;
    }
  }

  console.log(`\n恢复 ${recovered} 个，仍异常 ${stillBad} 个`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
