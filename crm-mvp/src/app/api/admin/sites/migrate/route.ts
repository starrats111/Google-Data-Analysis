import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { getSiteRoot } from "@/lib/remote-publisher";

// 获取迁移任务列表
export async function GET() {
  try {
    const tasks = await prisma.site_migrations.findMany({
      where: { is_deleted: 0 },
      orderBy: { created_at: "desc" },
      take: 50,
    });
    return apiSuccess(serializeData(tasks));
  } catch (err) {
    console.error("[admin/sites/migrate] GET error:", err);
    return apiSuccess([]);
  }
}

// 创建迁移任务（异步执行）
export const POST = withAdmin(async (req: NextRequest) => {
  const { domain, source_type, source_ref, site_name } = await req.json();
  if (!domain || !source_type) return apiError("域名和来源类型不能为空");
  if (!["github", "cloudflare"].includes(source_type)) return apiError("来源类型无效");

  const domainClean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");

  // 检查是否已有进行中的迁移
  const running = await prisma.site_migrations.findFirst({
    where: { domain: domainClean, status: { in: ["pending", "cloning", "dns", "ssl", "verifying"] }, is_deleted: 0 },
  });
  if (running) return apiError("该域名已有进行中的迁移任务");

  // 创建或获取站点记录
  let site = await prisma.publish_sites.findFirst({
    where: { domain: domainClean, is_deleted: 0 },
  });
  if (!site) {
    const siteRoot = await getSiteRoot();
    site = await prisma.publish_sites.create({
      data: {
        site_name: site_name || domainClean.split(".")[0],
        domain: domainClean,
        site_path: `${siteRoot}/${domainClean}`,
        deploy_type: "bt_ssh",
        verified: 0,
      },
    });
  }

  // 从 cookie 获取管理员 ID（简化处理，用 1 作为默认）
  const adminUser = await prisma.users.findFirst({ where: { role: "admin", is_deleted: 0 } });

  const task = await prisma.site_migrations.create({
    data: {
      site_id: site.id,
      domain: domainClean,
      source_type,
      source_ref: source_ref || null,
      status: "pending",
      progress: 0,
      created_by: adminUser?.id || BigInt(1),
    },
  });

  // 异步执行迁移（不阻塞响应）
  runMigrationAsync(task.id).catch((err) => {
    console.error("[site-migration] async error:", err);
  });

  return apiSuccess(serializeData(task), "迁移任务已创建");
});

// ─── 异步迁移执行器 ───
async function runMigrationAsync(taskId: bigint) {
  const update = async (data: Record<string, unknown>) => {
    await prisma.site_migrations.update({ where: { id: taskId }, data });
  };

  let sshClient: any = null;
  try {
    await update({ status: "cloning", progress: 10, step_detail: "正在准备环境...", started_at: new Date() });

    // 读取系统配置
    const configs = await prisma.system_configs.findMany({
      where: { is_deleted: 0, config_key: { in: ["github_token", "github_org", "cf_token", "bt_server_ip", "bt_ssh_host", "bt_ssh_port", "bt_ssh_user", "bt_ssh_password", "bt_ssh_key_path", "bt_ssh_key_content", "bt_site_root"] } },
    });
    const cfg: Record<string, string> = {};
    for (const c of configs) {
      if (c.config_value) cfg[c.config_key] = c.config_value;
    }

    const task = await prisma.site_migrations.findUnique({ where: { id: taskId } });
    if (!task) return;

    const siteRoot = cfg.bt_site_root || "/www/wwwroot";
    const sitePath = `${siteRoot}/${task.domain}`;

    // Step 1: Clone/Download
    await update({ status: "cloning", progress: 20, step_detail: `正在从 ${task.source_type} 获取站点文件...` });

    const { Client } = await import("ssh2");
    const fs = await import("fs");
    let privateKey: Buffer | undefined;
    if (cfg.bt_ssh_key_content) {
      privateKey = Buffer.from(cfg.bt_ssh_key_content);
    } else if (cfg.bt_ssh_key_path) {
      try { privateKey = fs.readFileSync(cfg.bt_ssh_key_path); } catch { /* ignore */ }
    }
    const sshConfig = {
      host: cfg.bt_ssh_host,
      port: parseInt(cfg.bt_ssh_port || "22"),
      username: cfg.bt_ssh_user || "ubuntu",
      password: cfg.bt_ssh_password || undefined,
      privateKey,
    };

    const client = await new Promise<InstanceType<typeof Client>>((resolve, reject) => {
      const c = new Client();
      c.on("ready", () => resolve(c)).on("error", reject).connect({ ...sshConfig, readyTimeout: 15000 });
    });
    sshClient = client;

    const exec = (cmd: string): Promise<string> => new Promise((resolve, reject) => {
      client.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = "";
        stream.on("data", (d: Buffer) => { out += d.toString(); });
        stream.stderr.on("data", (d: Buffer) => { out += d.toString(); });
        stream.on("close", () => resolve(out));
      });
    });

    // 创建目录
    await exec(`sudo mkdir -p ${sitePath}`);

    if (task.source_type === "github") {
      const ghToken = cfg.github_token;
      const ghOrg = cfg.github_org || "";
      const repoRef = task.source_ref || task.domain.replace(/\.(top|com|net|org)$/, "");
      const cloneUrl = repoRef.startsWith("http")
        ? repoRef.replace("https://", `https://${ghToken}@`)
        : `https://${ghToken}@github.com/${ghOrg}/${repoRef}.git`;

      await update({ progress: 30, step_detail: `正在 clone GitHub 仓库...` });
      const cloneResult = await exec(`cd ${sitePath} && sudo git clone --depth 1 ${cloneUrl} _tmp_clone 2>&1 && sudo cp -r _tmp_clone/* . && sudo rm -rf _tmp_clone`);
      await update({ progress: 50, step_detail: `Clone 完成` });
    } else {
      // Cloudflare Pages: wget 下载
      const pagesUrl = task.source_ref || `https://${task.domain.replace(/\.(top|com|net|org)$/, "")}.pages.dev`;
      await update({ progress: 30, step_detail: `正在从 Cloudflare Pages 下载...` });

      const files = ["index.html", "about.html", "contact.html", "article.html", "category.html", "search.html", "js/main.js", "js/data.js", "js/articles-index.js", "css/style.css"];
      for (const f of files) {
        await exec(`sudo mkdir -p ${sitePath}/$(dirname ${f}) 2>/dev/null; sudo wget -q --timeout=15 -O "${sitePath}/${f}" "${pagesUrl}/${f}" 2>/dev/null`);
      }
      await update({ progress: 50, step_detail: `下载完成` });
    }

    // Step 2: DNS
    await update({ status: "dns", progress: 60, step_detail: "正在配置 Cloudflare DNS..." });

    const cfToken = cfg.cf_token;
    const btIp = cfg.bt_server_ip || cfg.bt_ssh_host;

    if (cfToken && btIp) {
      try {
        const cfHeaders = { Authorization: `Bearer ${cfToken}`, "Content-Type": "application/json" };

        // 查找 zone
        const zonesRes = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${task.domain}`, { headers: cfHeaders });
        const zonesData = await zonesRes.json() as { result?: { id: string }[] };
        const zoneId = zonesData.result?.[0]?.id;

        if (zoneId) {
          // 删除旧记录
          const dnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, { headers: cfHeaders });
          const dnsData = await dnsRes.json() as { result?: { id: string; name: string; type: string }[] };
          for (const rec of dnsData.result || []) {
            if ([task.domain, `www.${task.domain}`].includes(rec.name) && ["A", "AAAA", "CNAME"].includes(rec.type)) {
              await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${rec.id}`, { method: "DELETE", headers: cfHeaders });
            }
          }

          // 创建 A 记录
          await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
            method: "POST", headers: cfHeaders,
            body: JSON.stringify({ type: "A", name: task.domain, content: btIp, ttl: 1, proxied: true }),
          });
          // www CNAME
          await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
            method: "POST", headers: cfHeaders,
            body: JSON.stringify({ type: "CNAME", name: `www.${task.domain}`, content: task.domain, ttl: 1, proxied: true }),
          });
          // SSL flexible
          await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/ssl`, {
            method: "PATCH", headers: cfHeaders,
            body: JSON.stringify({ value: "flexible" }),
          });

          await update({ progress: 75, step_detail: "DNS 配置完成" });
        } else {
          await update({ step_detail: "DNS: 未找到 Cloudflare Zone，跳过" });
        }
      } catch (dnsErr) {
        await update({ step_detail: `DNS 配置异常: ${dnsErr instanceof Error ? dnsErr.message : String(dnsErr)}` });
      }
    }

    // Step 3: SSL
    await update({ status: "ssl", progress: 80, step_detail: "正在申请 SSL 证书..." });

    try {
      const certDir = `/www/server/panel/vhost/cert/${task.domain}`;
      await exec(`sudo mkdir -p ${certDir}`);
      const sslResult = await exec(`sudo /root/.acme.sh/acme.sh --issue -d ${task.domain} -d www.${task.domain} --webroot ${sitePath} --force 2>&1`);

      if (sslResult.includes("Cert success") || sslResult.includes("BEGIN CERTIFICATE")) {
        await exec(`sudo /root/.acme.sh/acme.sh --install-cert -d ${task.domain} --key-file ${certDir}/privkey.pem --fullchain-file ${certDir}/fullchain.pem --reloadcmd 'sudo nginx -s reload' 2>&1`);
        await update({ progress: 90, step_detail: "SSL 证书已安装" });
      } else {
        await update({ step_detail: "SSL: acme.sh 未成功，尝试 certbot..." });
        await exec(`sudo certbot certonly --webroot -w ${sitePath} -d ${task.domain} -d www.${task.domain} --non-interactive --agree-tos --email admin@${task.domain} 2>&1`);
        await exec(`sudo cp /etc/letsencrypt/live/${task.domain}/fullchain.pem ${certDir}/fullchain.pem 2>/dev/null`);
        await exec(`sudo cp /etc/letsencrypt/live/${task.domain}/privkey.pem ${certDir}/privkey.pem 2>/dev/null`);
        await exec(`sudo nginx -s reload 2>/dev/null`);
      }
    } catch (sslErr) {
      await update({ step_detail: `SSL 异常: ${sslErr instanceof Error ? sslErr.message : String(sslErr)}` });
    }

    // Step 4: 验证 + 检测架构
    await update({ status: "verifying", progress: 95, step_detail: "正在验证站点..." });

    const { verifyConnection } = await import("@/lib/remote-publisher");
    const checks = await verifyConnection(sitePath);

    if (checks.valid) {
      // 更新站点信息
      if (task.site_id) {
        await prisma.publish_sites.update({
          where: { id: task.site_id },
          data: {
            verified: 1,
            site_type: checks.site_type,
            data_js_path: checks.data_js_path,
            article_var_name: checks.article_var_name,
            article_html_pattern: checks.article_html_pattern,
          },
        });
      }
    }

    client.end();

    await update({
      status: "done",
      progress: 100,
      step_detail: checks.valid ? "迁移完成，站点已验证" : "迁移完成，但站点验证未通过",
      finished_at: new Date(),
    });
  } catch (err) {
    try { sshClient?.end(); } catch { /* ignore */ }
    await update({
      status: "failed",
      step_detail: "迁移失败",
      error_message: err instanceof Error ? err.message : String(err),
      finished_at: new Date(),
    });
  }
}
