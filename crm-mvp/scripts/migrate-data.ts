/**
 * 数据迁移脚本：从数据分析平台（远程 SQLite）迁移数据到 CRM（MariaDB）
 * 
 * 迁移内容：
 * 1. 站点 (pub_sites → publish_sites)
 * 2. MCC 数据 (google_mcc_accounts → google_mcc_accounts)
 * 3. 商家库 (affiliate_merchants → user_merchants)
 * 4. API Token (affiliate_accounts → platform_connections)
 * 5. 文章列表 (pub_articles → articles)
 * 6. 推荐商家 (→ merchant_recommendations)
 * 7. 违规商家 (→ merchant_violations)
 * 
 * 注意：affiliate_transactions 因为 CRM 表要求 user_merchant_id 必填，
 *       需要先迁移商家再关联，此脚本仅迁移能直接映射的数据。
 * 
 * 用法: npx tsx scripts/migrate-data.ts
 */
import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { Client } from "ssh2";

// SSH 配置
const SSH_CONFIG = {
  host: process.env.BT_SSH_HOST || "52.74.221.116",
  port: parseInt(process.env.BT_SSH_PORT || "22"),
  username: process.env.BT_SSH_USER || "ubuntu",
  password: process.env.BT_SSH_PASSWORD || undefined,
  privateKeyPath: process.env.BT_SSH_KEY_PATH || "",
};

const REMOTE_DB = "/home/admin/Google-Data-Analysis/backend/google_analysis.db";

async function sshExec(client: Client, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let out = "";
      stream.on("data", (d: Buffer) => { out += d.toString(); });
      stream.stderr.on("data", () => { /* ignore */ });
      stream.on("close", () => resolve(out.trim()));
    });
  });
}

async function queryRemoteSqlite(client: Client, sql: string): Promise<Record<string, unknown>[]> {
  const escaped = sql.replace(/'/g, "'\\''");
  const cmd = `sqlite3 -json '${REMOTE_DB}' '${escaped}'`;
  const result = await sshExec(client, cmd);
  if (!result || result.startsWith("Error")) return [];
  try {
    return JSON.parse(result);
  } catch {
    console.warn("  ⚠ JSON 解析失败");
    return [];
  }
}

async function main() {
  const { PrismaMariaDb } = await import("@prisma/adapter-mariadb");
  const fs = await import("fs");

  const adapter = new PrismaMariaDb({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "3306"),
    user: process.env.DB_USER || "google-data-analysis",
    password: process.env.DB_PASSWORD || "Aa147258!",
    database: process.env.DB_NAME || "google-data-analysis",
  });

  const prisma = new PrismaClient({ adapter });

  // SSH 连接
  const sshClient = new Client();
  const sshConfig: Record<string, unknown> = {
    host: SSH_CONFIG.host,
    port: SSH_CONFIG.port,
    username: SSH_CONFIG.username,
    readyTimeout: 15000,
  };

  if (SSH_CONFIG.password) {
    sshConfig.password = SSH_CONFIG.password;
  } else if (SSH_CONFIG.privateKeyPath) {
    sshConfig.privateKey = fs.readFileSync(SSH_CONFIG.privateKeyPath);
  }

  await new Promise<void>((resolve, reject) => {
    sshClient.on("ready", () => resolve()).on("error", reject).connect(sshConfig as never);
  });

  console.log("✅ SSH + DB 连接成功");

  const defaultUser = await prisma.users.findFirst({ where: { role: "user", is_deleted: 0 } });
  const defaultUserId = defaultUser?.id || BigInt(1);
  const batchId = `migration_${Date.now()}`;

  try {
    // ─── 1. 迁移站点 (pub_sites → publish_sites) ───
    console.log("\n=== 1. 迁移站点 ===");
    const sites = await queryRemoteSqlite(sshClient, "SELECT * FROM pub_sites WHERE deleted_at IS NULL");
    let siteCount = 0;
    const siteIdMap = new Map<number, bigint>();

    for (const s of sites) {
      const domain = String(s.domain || "").trim().toLowerCase();
      if (!domain) continue;

      const existing = await prisma.publish_sites.findFirst({ where: { domain, is_deleted: 0 } });
      if (existing) { siteIdMap.set(Number(s.id), existing.id); continue; }

      const created = await prisma.publish_sites.create({
        data: {
          site_name: String(s.site_name || domain.split(".")[0]),
          domain,
          site_path: String(s.site_path || `/www/wwwroot/${domain}`),
          site_type: s.site_type ? String(s.site_type) : null,
          data_js_path: String(s.data_js_path || "js/articles-index.js"),
          article_var_name: s.article_var_name ? String(s.article_var_name) : null,
          article_html_pattern: s.article_html_pattern ? String(s.article_html_pattern) : null,
          deploy_type: "bt_ssh",
          verified: Number(s.migrated || 0) === 1 ? 1 : 0,
        },
      });
      siteIdMap.set(Number(s.id), created.id);
      siteCount++;
    }
    console.log(`   ✓ 站点: ${siteCount} 条新增, ${sites.length - siteCount} 条已存在`);

    // ─── 2. 迁移 MCC 数据 (→ google_mcc_accounts) ───
    console.log("\n=== 2. 迁移 MCC 数据 ===");
    const mccs = await queryRemoteSqlite(sshClient, "SELECT * FROM google_mcc_accounts WHERE is_active = 1");
    let mccCount = 0;

    for (const m of mccs) {
      const mccId = String(m.mcc_id || "").trim();
      if (!mccId) continue;

      const existing = await prisma.google_mcc_accounts.findFirst({
        where: { mcc_id: mccId, is_deleted: 0 },
      });
      if (existing) continue;

      await prisma.google_mcc_accounts.create({
        data: {
          user_id: defaultUserId,
          mcc_id: mccId,
          mcc_name: String(m.mcc_name || ""),
          currency: String(m.currency || "USD"),
          service_account_json: m.service_account_json ? String(m.service_account_json) : null,
          sheet_url: m.google_sheet_url ? String(m.google_sheet_url) : null,
          developer_token: m.developer_token ? String(m.developer_token) : null,
          is_active: 1,
        },
      });
      mccCount++;
    }
    console.log(`   ✓ MCC 账户: ${mccCount} 条迁移`);

    // ─── 3. 迁移商家库 (affiliate_merchants → user_merchants) ───
    console.log("\n=== 3. 迁移商家库 ===");
    const merchants = await queryRemoteSqlite(sshClient, "SELECT * FROM affiliate_merchants LIMIT 5000");
    let merchantCount = 0;

    for (const m of merchants) {
      const merchantName = String(m.merchant_name || "").trim();
      if (!merchantName) continue;

      const existing = await prisma.user_merchants.findFirst({
        where: { merchant_name: merchantName, platform: String(m.platform || ""), user_id: defaultUserId, is_deleted: 0 },
      });
      if (existing) continue;

      await prisma.user_merchants.create({
        data: {
          user_id: defaultUserId,
          merchant_id: m.merchant_id ? String(m.merchant_id) : null,
          merchant_name: merchantName,
          platform: String(m.platform || ""),
          category: m.category ? String(m.category) : null,
          commission_rate: m.commission_rate ? String(m.commission_rate) : null,
          logo_url: m.logo_url ? String(m.logo_url) : null,
          merchant_url: null,
          tracking_link: null,
          status: "available",
        },
      });
      merchantCount++;
    }
    console.log(`   ✓ 商家: ${merchantCount} 条迁移`);

    // ─── 4. 迁移 API Token (affiliate_accounts → platform_connections) ───
    console.log("\n=== 4. 迁移 API Token ===");
    const accounts = await queryRemoteSqlite(sshClient, `
      SELECT aa.*, ap.platform_code 
      FROM affiliate_accounts aa 
      LEFT JOIN affiliate_platforms ap ON aa.platform_id = ap.id 
      WHERE aa.is_active = 1
    `);
    let tokenCount = 0;

    for (const a of accounts) {
      const platform = String(a.platform_code || "").toUpperCase();
      if (!platform) continue;

      const existing = await prisma.platform_connections.findFirst({
        where: { user_id: defaultUserId, platform, is_deleted: 0 },
      });
      if (existing) continue;

      await prisma.platform_connections.create({
        data: {
          user_id: defaultUserId,
          platform,
          api_key: a.api_token_encrypted ? String(a.api_token_encrypted) : null,
          status: "connected",
        },
      });
      tokenCount++;
    }
    console.log(`   ✓ API Token: ${tokenCount} 条迁移`);

    // ─── 5. 迁移文章列表 (pub_articles → articles) ───
    console.log("\n=== 5. 迁移文章列表 ===");
    const articles = await queryRemoteSqlite(sshClient, "SELECT * FROM pub_articles WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 2000");
    let articleCount = 0;

    for (const a of articles) {
      const title = String(a.title || "").trim();
      if (!title) continue;

      const existing = await prisma.articles.findFirst({ where: { title, user_id: defaultUserId, is_deleted: 0 } });
      if (existing) continue;

      const siteId = a.site_id ? siteIdMap.get(Number(a.site_id)) : null;

      await prisma.articles.create({
        data: {
          user_id: defaultUserId,
          // user_merchant_id 可选，迁移时不关联
          title,
          slug: a.slug ? String(a.slug) : null,
          content: a.content ? String(a.content) : null,
          excerpt: a.excerpt ? String(a.excerpt) : null,
          language: String(a.language || "en"),
          status: Number(a.published_to_site || 0) === 1 ? "published" : String(a.status || "draft"),
          publish_site_id: siteId || null,
          merchant_name: a.merchant_name ? String(a.merchant_name) : null,
          tracking_link: a.tracking_link ? String(a.tracking_link) : null,
          meta_title: a.meta_title ? String(a.meta_title) : null,
          meta_description: a.meta_description ? String(a.meta_description) : null,
        },
      });
      articleCount++;
    }
    console.log(`   ✓ 文章: ${articleCount} 条迁移`);

    // ─── 6. 迁移推荐商家 (→ merchant_recommendations) ───
    console.log("\n=== 6. 迁移推荐商家 ===");
    const recommended = await queryRemoteSqlite(sshClient, "SELECT * FROM affiliate_merchants WHERE recommendation_status = 'recommended'");
    let recCount = 0;

    for (const m of recommended) {
      const merchantName = String(m.merchant_name || "").trim();
      if (!merchantName) continue;

      const existing = await prisma.merchant_recommendations.findFirst({ where: { merchant_name: merchantName, is_deleted: 0 } });
      if (existing) continue;

      await prisma.merchant_recommendations.create({
        data: {
          merchant_name: merchantName,
          commission_info: m.commission_rate ? String(m.commission_rate) : null,
          remark: m.category ? `平台: ${m.platform || ""}, 分类: ${m.category}` : `平台: ${m.platform || ""}`,
          upload_batch: batchId,
        },
      });
      recCount++;
    }
    console.log(`   ✓ 推荐商家: ${recCount} 条迁移`);

    // ─── 7. 迁移违规商家 (→ merchant_violations) ───
    console.log("\n=== 7. 迁移违规商家 ===");
    const violated = await queryRemoteSqlite(sshClient, "SELECT * FROM affiliate_merchants WHERE violation_status = 'violated'");
    let violCount = 0;

    for (const m of violated) {
      const merchantName = String(m.merchant_name || "").trim();
      if (!merchantName) continue;

      const existing = await prisma.merchant_violations.findFirst({ where: { merchant_name: merchantName, is_deleted: 0 } });
      if (existing) continue;

      await prisma.merchant_violations.create({
        data: {
          merchant_name: merchantName,
          platform: String(m.platform || ""),
          violation_reason: "从数据分析平台迁移",
          source: `平台: ${m.platform || ""}`,
          upload_batch: batchId,
        },
      });
      violCount++;
    }
    console.log(`   ✓ 违规商家: ${violCount} 条迁移`);

    console.log("\n" + "=".repeat(50));
    console.log("✅ 数据迁移完成！");
    console.log(`   站点: ${siteCount}, MCC: ${mccCount}, 商家: ${merchantCount}`);
    console.log(`   Token: ${tokenCount}, 文章: ${articleCount}`);
    console.log(`   推荐: ${recCount}, 违规: ${violCount}`);
    console.log(`\n⚠ 注意: affiliate_transactions 需要手动迁移（依赖 user_merchant_id 关联）`);
  } finally {
    await prisma.$disconnect();
    sshClient.end();
  }
}

main().catch(console.error);
