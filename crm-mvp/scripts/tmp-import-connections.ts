/**
 * 将服务器导出的 platform_connections 按 username 映射导入本地数据库，
 * 跳过已存在的（同 user_id + platform + account_name）。
 */
import "dotenv/config";
import prisma from "../src/lib/prisma";

// 服务器导出的连接数据（只包含 wjzu 团队成员，排除 yz01 等非团队成员）
const SERVER_CONNECTIONS = [
  { username: "wj01", platform: "CG", account_name: "weili", api_key: "b72cfc46cca2074c7b7d6f0358a181ca" },
  { username: "wj01", platform: "BSH", account_name: "bloomroots", api_key: "4345f17b44350a803aec8484e9f50d39" },
  { username: "wj01", platform: "LB", account_name: "tuancha", api_key: "B5xLHKrpUf2JX7nN" },
  { username: "wj01", platform: "PM", account_name: "kivanta", api_key: "d05d02ebcedf20f3cdd6fd16c3950e30" },
  { username: "wj02", platform: "CG", account_name: "wenjun3", api_key: "6209b9550dd38b14e64e270397570c6f" },
  { username: "wj02", platform: "PM", account_name: "novanest", api_key: "f84a62602e6353f8e1f968ccf17e434b" },
  { username: "wj02", platform: "LH", account_name: "wenjun1", api_key: "tyPel61DpiDzOgWr" },
  { username: "wj03", platform: "CG", account_name: "novanest", api_key: "2b4a6a9ea3d3368ba7200c03b5fb8d51" },
  { username: "wj03", platform: "LH", account_name: "tuancha", api_key: "Fi4fqi91CzHaofmb" },
  { username: "wj03", platform: "RW", account_name: "wenjun03", api_key: "1833e8fe7d80670ddf470a203cd15d95" },
  { username: "wj03", platform: "CF", account_name: "allurahub", api_key: "b7c7e15c5cf814747750881a9830f932" },
  { username: "wj03", platform: "PM", account_name: "keymint", api_key: "b7c7e15c5cf814747750881a9830f932" },
  { username: "wj04", platform: "PM", account_name: "weilixia", api_key: "a9bd252639b4da479b67235bfa57d6c4" },
  { username: "wj04", platform: "CG", account_name: "keymint", api_key: "ca84b9aad99cf67a17c54134604ac1ae" },
  { username: "wj04", platform: "LH", account_name: "bloomroots", api_key: "xIRUdVZsskpkvqCO" },
  { username: "wj05", platform: "LH", account_name: "kagetsu", api_key: "5LabOMCN8XgtNIpH" },
  { username: "wj05", platform: "PM", account_name: "vitahaven", api_key: "4aa499b9b07dfcf539fd3d5bd1e43894" },
  { username: "wj05", platform: "RW", account_name: "everydayhaven", api_key: "75f19a305c0167802225503e2a165844" },
  { username: "wj05", platform: "CG", account_name: "vitasphere", api_key: "33ce595e3d71719f3e285df38e992251" },
  { username: "wj06", platform: "RW", account_name: "kaizenflowshop", api_key: "0dc77a64a310c2450453022e35b0b7e1" },
  { username: "wj06", platform: "CG", account_name: "wenjun2", api_key: "15db4459a7667065eb5b229b58481a81" },
  { username: "wj06", platform: "PM", account_name: "everydayhaven", api_key: "d7758e758a95cb8874df3bcbe2301b26" },
  { username: "wj07", platform: "LH", account_name: "wenjun3", api_key: "CuOwDFNfCruK2uOg" },
  { username: "wj07", platform: "RW", account_name: "parcelandplate", api_key: "41df7906743fceacaa16ca25abfa1ce4" },
  { username: "wj07", platform: "CG", account_name: "allurahub", api_key: "24b4cd7864da7511f0fe0611bf0a7db8" },
  { username: "wj08", platform: "PM", account_name: "tuancha", api_key: "535693d64a833ef998accb94de666066" },
  { username: "wj08", platform: "LH", account_name: "wenjun2", api_key: "f0k92Df5v8En15e2" },
  { username: "wj09", platform: "LB", account_name: "weilixia", api_key: "UqVgwfwK5J2kCYXq" },
  { username: "wj09", platform: "PM", account_name: "vitasphere", api_key: "5ca73b8d4ef45e0e94c0061a00aa554a" },
  { username: "wj09", platform: "RW", account_name: "bloomroots", api_key: "78d4c1af3f0335c2083d5774c5f70db9" },
  { username: "wj09", platform: "CG", account_name: "vitahaven", api_key: "916a0dbbfe6c3e7fb19fb5ee119b82a2" },
  { username: "wj10", platform: "CG", account_name: "bloomroots", api_key: "1da49f2ea25bd8dfd45337fc5e7154b5" },
  { username: "wj10", platform: "LH", account_name: "allurahub", api_key: "b73gSgP5YgFQMJMK" },
  { username: "wj10", platform: "PM", account_name: "bloomroots", api_key: "4f0e97bfe7ccd4c382390c93a90ef8b0" },
  { username: "wj10", platform: "RW", account_name: "thgoodsandguard", api_key: "e968d463555477ec728aca9732c568f0" },
];

async function main() {
  // 1. 获取本地用户 ID 映射
  const usernames = [...new Set(SERVER_CONNECTIONS.map((c) => c.username))];
  const users = await prisma.users.findMany({
    where: { username: { in: usernames }, is_deleted: 0 },
    select: { id: true, username: true },
  });
  const userMap = new Map(users.map((u) => [u.username, u.id]));

  console.log("本地用户映射:");
  for (const u of users) {
    console.log(`  ${u.username} -> id=${u.id}`);
  }

  // 2. 获取本地已有连接
  const existingConns = await prisma.platform_connections.findMany({
    where: { is_deleted: 0 },
    select: { id: true, user_id: true, platform: true, account_name: true },
  });
  const existingKeys = new Set(
    existingConns.map((c) => `${c.user_id}_${c.platform}_${(c.account_name || "").trim()}`),
  );

  console.log(`\n本地已有连接: ${existingConns.length} 条`);

  // 3. 导入缺失的连接
  let created = 0;
  let skipped = 0;

  for (const conn of SERVER_CONNECTIONS) {
    const localUserId = userMap.get(conn.username);
    if (!localUserId) {
      console.log(`  [跳过] ${conn.username} 在本地不存在`);
      skipped++;
      continue;
    }

    const key = `${localUserId}_${conn.platform}_${conn.account_name.trim()}`;
    if (existingKeys.has(key)) {
      console.log(`  [已存在] ${conn.username} ${conn.platform}/${conn.account_name}`);
      skipped++;
      continue;
    }

    await prisma.platform_connections.create({
      data: {
        user_id: localUserId,
        platform: conn.platform,
        account_name: conn.account_name.trim(),
        api_key: conn.api_key,
        status: "connected",
      },
    });
    console.log(`  [创建] ${conn.username}(${localUserId}) ${conn.platform}/${conn.account_name.trim()}`);
    created++;
    existingKeys.add(key);
  }

  console.log(`\n完成: 创建 ${created} 条, 跳过 ${skipped} 条`);

  // 4. 验证最终状态
  const finalConns = await prisma.platform_connections.findMany({
    where: { is_deleted: 0, status: "connected" },
    select: { id: true, user_id: true, platform: true, account_name: true, api_key: true },
    orderBy: { user_id: "asc" },
  });
  const finalUsers = await prisma.users.findMany({
    where: { id: { in: finalConns.map((c) => c.user_id) } },
    select: { id: true, username: true },
  });
  const finalUserMap = new Map(finalUsers.map((u) => [u.id.toString(), u.username]));

  console.log("\n最终连接状态:");
  const byUser = new Map<string, string[]>();
  for (const c of finalConns) {
    const name = finalUserMap.get(c.user_id.toString()) || "?";
    if (!byUser.has(name)) byUser.set(name, []);
    byUser.get(name)!.push(`${c.platform}(${(c.account_name || "").trim()})`);
  }
  for (const [name, platforms] of [...byUser.entries()].sort()) {
    console.log(`  ${name}: ${platforms.join(", ")}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma["$disconnect"]());
