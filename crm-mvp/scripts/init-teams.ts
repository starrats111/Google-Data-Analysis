/**
 * 数据初始化脚本：创建小组 + 设置组长 + 分配组员
 * 
 * 运行方式：npx tsx scripts/init-teams.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("=== 开始初始化团队数据 ===\n");

  // 1. 创建 3 个小组
  const teamDefs = [
    { team_code: "wj", team_name: "文俊组" },
    { team_code: "jy", team_name: "静怡组" },
    { team_code: "yz", team_name: "雅芝组" },
  ];

  for (const def of teamDefs) {
    const existing = await prisma.teams.findFirst({ where: { team_code: def.team_code } });
    if (existing) {
      console.log(`小组 ${def.team_name} (${def.team_code}) 已存在，跳过`);
    } else {
      await prisma.teams.create({ data: def });
      console.log(`创建小组: ${def.team_name} (${def.team_code})`);
    }
  }

  // 获取小组 ID
  const teams = await prisma.teams.findMany({ where: { is_deleted: 0 } });
  const teamMap = new Map(teams.map((t) => [t.team_code, t]));

  // 2. 设置组长
  const leaderDefs = [
    { username: "wjzu", team_code: "wj" },
    { username: "jyzu", team_code: "jy" },
    { username: "yzzu", team_code: "yz" },
  ];

  for (const def of leaderDefs) {
    const team = teamMap.get(def.team_code);
    if (!team) { console.log(`找不到小组 ${def.team_code}，跳过`); continue; }

    const user = await prisma.users.findFirst({ where: { username: def.username, is_deleted: 0 } });
    if (!user) { console.log(`找不到用户 ${def.username}，跳过`); continue; }

    // 更新用户角色为 leader，关联 team_id
    await prisma.users.update({
      where: { id: user.id },
      data: { role: "leader", team_id: team.id },
    });

    // 更新小组的 leader_id
    await prisma.teams.update({
      where: { id: team.id },
      data: { leader_id: user.id },
    });

    console.log(`设置组长: ${def.username} → ${team.team_name}`);
  }

  // 3. 分配组员到对应小组
  // 规则：wj01-wj10 → wj组，jy01-jy10 → jy组，yz01-yz10 → yz组
  const prefixMap: Record<string, string> = { wj: "wj", jy: "jy", yz: "yz" };

  const allUsers = await prisma.users.findMany({
    where: { is_deleted: 0, role: "user" },
    select: { id: true, username: true, team_id: true },
  });

  let assignedCount = 0;
  for (const u of allUsers) {
    // 检查用户名前缀
    for (const [prefix, teamCode] of Object.entries(prefixMap)) {
      if (u.username.startsWith(prefix) && u.username !== `${prefix}zu`) {
        const team = teamMap.get(teamCode);
        if (!team) continue;

        if (u.team_id?.toString() !== team.id.toString()) {
          await prisma.users.update({
            where: { id: u.id },
            data: { team_id: team.id },
          });
          assignedCount++;
          console.log(`分配组员: ${u.username} → ${team.team_name}`);
        }
        break;
      }
    }
  }

  console.log(`\n=== 初始化完成 ===`);
  console.log(`小组数: ${teams.length}`);
  console.log(`组长数: ${leaderDefs.length}`);
  console.log(`新分配组员数: ${assignedCount}`);
}

main()
  .catch((e) => { console.error("初始化失败:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
