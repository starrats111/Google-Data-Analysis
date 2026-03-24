/**
 * 初始化部署配置 — 将 SSH 配置 + Token 池写入 CRM 的 system_configs 表
 * 运行方式：npx tsx scripts/seed-deploy-config.ts
 */
import prisma from "../src/lib/prisma";

const DEPLOY_CONFIGS: { key: string; value: string; description: string }[] = [
  // 宝塔服务器 SSH（AWS 新加坡）
  { key: "bt_ssh_host", value: "52.74.221.116", description: "宝塔服务器 IP" },
  { key: "bt_ssh_port", value: "22", description: "SSH 端口" },
  { key: "bt_ssh_user", value: "ubuntu", description: "SSH 用户名" },
  { key: "bt_ssh_password", value: "", description: "SSH 密码（使用密钥时留空）" },
  { key: "bt_ssh_key_path", value: "", description: "SSH 密钥路径" },
  { key: "bt_site_root", value: "/www/wwwroot", description: "网站根目录" },

  // 后端服务器
  { key: "backend_api_url", value: "http://43.156.142.141:8000", description: "数据分析平台后端 API 地址" },
  { key: "backend_api_token", value: "", description: "后端 API Token（JWT）" },
];

// Token 值通过环境变量传入或部署后在管理界面手动填写，不硬编码到代码仓库
const TOKEN_POOL = {
  github_tokens: [
    { id: "gh-starrats111", label: "starrats111", org: "starrats111", token: process.env.GH_TOKEN_STARRATS111 || "" },
    { id: "gh-kagetsu12", label: "kagetsu12", org: "kagetsu12", token: process.env.GH_TOKEN_KAGETSU12 || "" },
    { id: "gh-kydomain1", label: "kydomain1", org: "kydomain1", token: process.env.GH_TOKEN_KYDOMAIN1 || "" },
  ],
  cf_tokens: [
    { id: "cf-kyreg", label: "kyreg@163.com", token: process.env.CF_TOKEN_KYREG || "" },
    { id: "cf-chatuan", label: "chatuan575@gmail.com", token: process.env.CF_TOKEN_CHATUAN || "" },
  ],
  bt_server_ip: "52.74.221.116",
};

const TOKEN_POOL_KEY = "deploy_credentials_json";

async function main() {
  console.log("开始写入部署配置...\n");

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const cfg of DEPLOY_CONFIGS) {
    const existing = await prisma.system_configs.findFirst({
      where: { config_key: cfg.key, is_deleted: 0 },
    });

    if (existing) {
      if (cfg.value && existing.config_value !== cfg.value) {
        await prisma.system_configs.update({
          where: { id: existing.id },
          data: { config_value: cfg.value, description: cfg.description },
        });
        console.log(`  ✓ 更新: ${cfg.key} = ${cfg.value.slice(0, 20)}${cfg.value.length > 20 ? "..." : ""}`);
        updated++;
      } else {
        console.log(`  - 跳过: ${cfg.key}（已存在且值相同）`);
        skipped++;
      }
    } else {
      await prisma.system_configs.create({
        data: {
          config_key: cfg.key,
          config_value: cfg.value || null,
          description: cfg.description,
        },
      });
      console.log(`  + 创建: ${cfg.key} = ${cfg.value.slice(0, 20)}${cfg.value.length > 20 ? "..." : ""}`);
      created++;
    }
  }

  // 写入 Token 池
  const poolJson = JSON.stringify(TOKEN_POOL);
  const existingPool = await prisma.system_configs.findFirst({
    where: { config_key: TOKEN_POOL_KEY, is_deleted: 0 },
  });

  if (existingPool) {
    if (existingPool.config_value !== poolJson) {
      await prisma.system_configs.update({
        where: { id: existingPool.id },
        data: { config_value: poolJson, description: "Token 池（GitHub + CF，JSON）" },
      });
      console.log(`  ✓ 更新: ${TOKEN_POOL_KEY}`);
      updated++;
    } else {
      console.log(`  - 跳过: ${TOKEN_POOL_KEY}（已存在且值相同）`);
      skipped++;
    }
  } else {
    await prisma.system_configs.create({
      data: { config_key: TOKEN_POOL_KEY, config_value: poolJson, description: "Token 池（GitHub + CF，JSON）" },
    });
    console.log(`  + 创建: ${TOKEN_POOL_KEY}`);
    created++;
  }

  console.log(`\n完成！创建 ${created} 条，更新 ${updated} 条，跳过 ${skipped} 条`);
  console.log(`\nToken 池概况：`);
  console.log(`  GitHub Tokens: ${TOKEN_POOL.github_tokens.length} 个`);
  for (const t of TOKEN_POOL.github_tokens) {
    console.log(`    - ${t.label} (org: ${t.org}) token: ${t.token.slice(0, 10)}...`);
  }
  console.log(`  CF Tokens: ${TOKEN_POOL.cf_tokens.length} 个`);
  for (const t of TOKEN_POOL.cf_tokens) {
    console.log(`    - ${t.label} token: ${t.token.slice(0, 15)}...`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("写入失败:", err);
  process.exit(1);
});
