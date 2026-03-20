/**
 * 初始化部署配置 — 将数据分析平台已有的配置写入 CRM 的 system_configs 表
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

  // 部署凭证
  { key: "github_token", value: "", description: "GitHub Token" },
  { key: "github_org", value: "starrats111", description: "GitHub 组织/用户名" },
  { key: "cf_token", value: "MlysGPG0UizFwaWK52quYpCJZA415HZPo-xg5zas", description: "Cloudflare API Token" },
  { key: "bt_server_ip", value: "52.74.221.116", description: "宝塔服务器公网 IP" },

  // 后端服务器
  { key: "backend_api_url", value: "http://47.239.193.33:8000", description: "数据分析平台后端 API 地址" },
  { key: "backend_api_token", value: "", description: "后端 API Token（JWT）" },
];

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

  console.log(`\n完成！创建 ${created} 条，更新 ${updated} 条，跳过 ${skipped} 条`);
  process.exit(0);
}

main().catch((err) => {
  console.error("写入失败:", err);
  process.exit(1);
});
