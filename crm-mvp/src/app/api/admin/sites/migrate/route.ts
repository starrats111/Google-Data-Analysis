import { NextRequest } from "next/server";
import { serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { withAdmin } from "@/lib/api-handler";
import prisma from "@/lib/prisma";
import { getSiteRoot, registerBtPanelSite, verifySiteWithAutoRegister } from "@/lib/remote-publisher";
import { getTokenPool, findGitHubToken, findCFTokenForDomain, type GitHubTokenEntry } from "@/lib/deploy-credentials";

export const dynamic = "force-dynamic";

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

export const POST = withAdmin(async (req: NextRequest) => {
  const { domain, source_type, source_ref, site_name, standardize_a1 } = await req.json();
  if (!domain || !source_type) return apiError("域名和来源类型不能为空");
  if (!["github", "cloudflare"].includes(source_type)) return apiError("来源类型无效");

  const domainClean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");

  const pool = await getTokenPool();
  if (pool.github_tokens.length === 0 && pool.cf_tokens.length === 0) {
    return apiError("请先在服务器配置中添加 GitHub Token 或 CF Token");
  }

  const running = await prisma.site_migrations.findFirst({
    where: { domain: domainClean, status: { in: ["pending", "cloning", "dns", "ssl", "verifying"] }, is_deleted: 0 },
  });
  if (running) return apiError("该域名已有进行中的迁移任务");

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

  const adminUser = await prisma.users.findFirst({ where: { role: "admin", is_deleted: 0 } });

  const task = await prisma.site_migrations.create({
    data: {
      site_id: site.id,
      domain: domainClean,
      source_type,
      source_ref: source_ref || null,
      standardize_a1: standardize_a1 === false ? false : true,
      status: "pending",
      progress: 0,
      created_by: adminUser?.id || BigInt(1),
    },
  });

  runMigrationAsync(task.id).catch((err) => {
    console.error("[site-migration] async error:", err);
  });

  return apiSuccess(serializeData(task), "迁移任务已创建");
});

function shellSingleQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function stripTld(domain: string) {
  return domain.replace(/\.[a-z]{2,}$/, "");
}

function buildGitHubRepoCandidates(domain: string, sourceRef?: string | null) {
  const raw = sourceRef?.trim();
  if (raw) return [raw];

  const full = domain.trim().toLowerCase();
  const stripped = stripTld(full);
  const candidates = [full, stripped].filter(Boolean);
  return Array.from(new Set(candidates));
}

function buildGitHubCloneUrl(ghEntry: GitHubTokenEntry, repoRef: string) {
  if (repoRef.startsWith("http://") || repoRef.startsWith("https://")) {
    return repoRef.replace(/^https?:\/\//, `https://${ghEntry.token}@`);
  }

  const normalized = repoRef.replace(/^\/+|\/+$/g, "");
  const repoPath = normalized.includes("/")
    ? normalized
    : `${ghEntry.org}/${normalized}`;

  return `https://${ghEntry.token}@github.com/${repoPath}.git`;
}

// ─── 异步迁移执行器 ───
async function runMigrationAsync(taskId: bigint) {
  const update = async (data: Record<string, unknown>) => {
    await prisma.site_migrations.update({ where: { id: taskId }, data });
  };

  let sshClient: any = null;
  try {
    await update({ status: "cloning", progress: 10, step_detail: "正在准备环境...", started_at: new Date() });

    const serverConfigs = await prisma.system_configs.findMany({
      where: { is_deleted: 0, config_key: { in: ["bt_ssh_host", "bt_ssh_port", "bt_ssh_user", "bt_ssh_password", "bt_ssh_key_path", "bt_ssh_key_content", "bt_site_root"] } },
    });
    const cfg: Record<string, string> = {};
    for (const c of serverConfigs) {
      if (c.config_value) cfg[c.config_key] = c.config_value;
    }

    const pool = await getTokenPool();
    const task = await prisma.site_migrations.findUnique({ where: { id: taskId } });
    if (!task) return;

    const siteRoot = cfg.bt_site_root || "/www/wwwroot";
    const sitePath = `${siteRoot}/${task.domain}`;

    // Step 1: Clone/Download — 自动匹配 GitHub Token
    await update({ status: "cloning", progress: 15, step_detail: "正在自动匹配 Token..." });

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

    const exec = (cmd: string, failOnError = false): Promise<string> => new Promise((resolve, reject) => {
      client.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = "";
        stream.on("data", (d: Buffer) => { out += d.toString(); });
        stream.stderr.on("data", (d: Buffer) => { out += d.toString(); });
        stream.on("close", (code: number) => {
          if (failOnError && code !== 0) {
            reject(new Error(`命令执行失败 (exit ${code}): ${out.slice(0, 500)}`));
          } else {
            resolve(out);
          }
        });
      });
    });

    await exec(`sudo mkdir -p ${shellSingleQuote(sitePath)}`);

    if (task.source_type === "github") {
      const repoCandidates = buildGitHubRepoCandidates(task.domain, task.source_ref);
      const initialHint = repoCandidates[0] || task.domain;
      const initialOrgHint = initialHint.includes("/") ? initialHint.split("/")[0] : "";
      const ghEntry = findGitHubToken(pool, initialOrgHint || initialHint);

      if (!ghEntry) {
        throw new Error("Token 池中没有可用的 GitHub Token");
      }

      await update({ progress: 20, step_detail: `自动匹配 GitHub Token「${ghEntry.label}」(org: ${ghEntry.org})，正在尝试仓库...` });

      let cloneSucceeded = false;
      let cloneOut = "";
      const errors: string[] = [];

      for (const repoRef of repoCandidates) {
        const cloneUrl = buildGitHubCloneUrl(ghEntry, repoRef);
        await update({ progress: 30, step_detail: `正在尝试 GitHub 仓库：${repoRef}` });
        await exec(`sudo rm -rf ${shellSingleQuote(`${sitePath}/_tmp_clone`)}`);
        try {
          cloneOut = await exec(`cd ${shellSingleQuote(sitePath)} && sudo git clone --depth 1 ${shellSingleQuote(cloneUrl)} _tmp_clone 2>&1`, true);
          cloneSucceeded = true;
          await update({ progress: 40, step_detail: `GitHub 仓库匹配成功：${repoRef}` });
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${repoRef}: ${msg.slice(0, 180)}`);
        }
      }

      if (!cloneSucceeded) {
        throw new Error(`GitHub 仓库不存在或无权限访问。已尝试：${repoCandidates.join(", ")}。${errors[0] || ""}`);
      }

      await exec(`cd ${shellSingleQuote(sitePath)} && sudo cp -r _tmp_clone/. . && sudo rm -rf _tmp_clone`);
      const fileCount = await exec(`ls -1 ${shellSingleQuote(sitePath)} | wc -l`);
      if (parseInt(fileCount.trim(), 10) === 0) {
        throw new Error(`Clone 后站点目录为空，clone 输出: ${cloneOut.slice(0, 300)}`);
      }
      await update({ progress: 50, step_detail: "Clone 完成" });
    } else {
      const pagesUrl = task.source_ref?.trim() || `https://${stripTld(task.domain)}.pages.dev`;
      await update({ progress: 30, step_detail: `正在从 Cloudflare Pages 下载...` });

      const files = ["index.html", "about.html", "contact.html", "article.html", "category.html", "search.html", "js/main.js", "js/data.js", "js/articles-index.js", "css/style.css"];
      let downloaded = 0;
      let nonEmpty = 0;
      let hasNonEmptyIndex = false;
      const downloadErrors: string[] = [];

      for (const f of files) {
        const target = `${sitePath}/${f}`;
        const url = `${pagesUrl.replace(/\/+$/, "")}/${f}`;
        const result = await exec(`sudo mkdir -p $(dirname ${shellSingleQuote(target)}) 2>/dev/null; if curl -fsSL --max-time 20 ${shellSingleQuote(url)} -o ${shellSingleQuote(target)}; then stat -c %s ${shellSingleQuote(target)}; else rm -f ${shellSingleQuote(target)}; echo ERROR; fi`);
        const trimmed = result.trim();
        if (trimmed === "ERROR") {
          downloadErrors.push(f);
          continue;
        }
        const size = Number(trimmed.split(/\s+/).pop() || 0);
        downloaded += 1;
        if (size > 0) {
          nonEmpty += 1;
          if (f === "index.html") hasNonEmptyIndex = true;
        } else {
          await exec(`sudo rm -f ${shellSingleQuote(target)}`);
        }
      }

      if (!hasNonEmptyIndex) {
        throw new Error(`Cloudflare Pages 下载失败：index.html 不存在或为空。来源：${pagesUrl}`);
      }
      if (nonEmpty === 0) {
        throw new Error(`Cloudflare Pages 下载失败：未获取到任何有效文件。来源：${pagesUrl}`);
      }

      await update({ progress: 50, step_detail: `下载完成（有效文件 ${nonEmpty}/${files.length}${downloadErrors.length ? `，缺失 ${downloadErrors.length} 个` : ""}）` });
    }

    // Step 1b: 标准化为 A1（首页 + assets/js/main.js + posts，便于 CRM 统一发布）
    if (task.standardize_a1) {
      await update({ progress: 52, step_detail: "正在合并旧索引并标准化为 A1 架构..." });
      const { applyA1SiteStandard } = await import("@/lib/remote-publisher");
      const a1 = await applyA1SiteStandard(sitePath, task.domain);
      if (!a1.ok) {
        throw new Error(a1.error || "A1 标准化失败");
      }
      await update({
        progress: 54,
        step_detail: `A1 标准化完成（已合并约 ${a1.merged_count ?? 0} 条旧文章索引，主题/CSS/静态资源已尽量保留）`,
      });
    }

    // Step 2: DNS — 自动匹配 CF Token
    await update({ status: "dns", progress: 55, step_detail: "正在自动匹配 Cloudflare Token..." });

    const cfEntry = await findCFTokenForDomain(pool, task.domain);
    const btIp = pool.bt_server_ip || cfg.bt_ssh_host;

    if (cfEntry && btIp) {
      await update({ progress: 60, step_detail: `自动匹配 CF Token「${cfEntry.label}」，正在配置 DNS...` });

      try {
        const cfHeaders = { Authorization: `Bearer ${cfEntry.token}`, "Content-Type": "application/json" };

        const zonesRes = await fetch(`https://api.cloudflare.com/client/v4/zones?name=${task.domain}`, { headers: cfHeaders });
        const zonesData = await zonesRes.json() as { result?: { id: string }[] };
        const zoneId = zonesData.result?.[0]?.id;

        if (zoneId) {
          const dnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, { headers: cfHeaders });
          const dnsData = await dnsRes.json() as { result?: { id: string; name: string; type: string }[] };
          for (const rec of dnsData.result || []) {
            if ([task.domain, `www.${task.domain}`].includes(rec.name) && ["A", "AAAA", "CNAME"].includes(rec.type)) {
              await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${rec.id}`, { method: "DELETE", headers: cfHeaders });
            }
          }

          await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
            method: "POST", headers: cfHeaders,
            body: JSON.stringify({ type: "A", name: task.domain, content: btIp, ttl: 1, proxied: true }),
          });
          await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
            method: "POST", headers: cfHeaders,
            body: JSON.stringify({ type: "CNAME", name: `www.${task.domain}`, content: task.domain, ttl: 1, proxied: true }),
          });
          await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/settings/ssl`, {
            method: "PATCH", headers: cfHeaders,
            body: JSON.stringify({ value: "flexible" }),
          });

          await update({ progress: 75, step_detail: `DNS 配置完成（CF: ${cfEntry.label}）` });
        } else {
          await update({ step_detail: "DNS: 未找到 Cloudflare Zone，跳过" });
        }
      } catch (dnsErr) {
        await update({ step_detail: `DNS 配置异常: ${dnsErr instanceof Error ? dnsErr.message : String(dnsErr)}` });
      }
    } else if (!cfEntry) {
      await update({ progress: 75, step_detail: "Token 池中没有 CF Token，跳过 DNS 配置" });
    }

    // Step 2.5: 注册站点到宝塔面板数据库
    try {
      await update({ progress: 77, step_detail: "正在注册站点到宝塔面板..." });
      const panelRegistration = await registerBtPanelSite(task.domain, sitePath);
      if (panelRegistration.ok) {
        await update({
          step_detail: panelRegistration.created
            ? `宝塔面板站点已注册 (id=${panelRegistration.panelSiteId || "-"})`
            : `宝塔面板已存在该站点 (id=${panelRegistration.panelSiteId || "-"})`,
        });
      } else {
        await update({ step_detail: `宝塔注册异常（不影响迁移）: ${panelRegistration.error || "未知错误"}` });
      }
    } catch (btErr) {
      await update({ step_detail: `宝塔注册异常（不影响迁移）: ${btErr instanceof Error ? btErr.message : String(btErr)}` });
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

    // Step 4: 统一自动修复 + 验证 + 检测架构 + 公网连通性
    await update({ status: "verifying", progress: 95, step_detail: "正在自动修复并验证站点..." });

    const verifyResult = await verifySiteWithAutoRegister(task.domain, sitePath);
    const {
      checks,
      publicAccess,
      fullyVerified,
      autoStandardizeAttempted,
      a1Standardization,
      autoRegisterAttempted,
      panelRegistration,
    } = verifyResult;

    if (task.site_id) {
      await prisma.publish_sites.update({
        where: { id: task.site_id },
        data: {
          verified: fullyVerified ? 1 : 0,
          site_type: checks.site_type,
          data_js_path: checks.data_js_path,
          article_var_name: checks.article_var_name,
          article_html_pattern: checks.article_html_pattern,
        },
      });
    }

    client.end();

    const repairParts = [
      autoStandardizeAttempted
        ? (a1Standardization?.ok
          ? `已自动标准化 A1（合并约 ${a1Standardization.merged_count ?? 0} 条）`
          : `自动标准化失败：${a1Standardization?.error || "未知错误"}`)
        : "",
      autoRegisterAttempted
        ? (panelRegistration?.ok
          ? (panelRegistration.created ? `已自动补登记宝塔站点(id=${panelRegistration.panelSiteId || "-"})` : `已自动核对宝塔站点(id=${panelRegistration.panelSiteId || "-"})`)
          : `自动补登记失败：${panelRegistration?.error || "未知错误"}`)
        : "",
    ].filter(Boolean).join("；");

    const verifyMessage = fullyVerified
      ? ["迁移完成，站点已验证", repairParts].filter(Boolean).join("；")
      : `迁移完成，但验证未通过：${[
          repairParts,
          checks.valid ? "" : (checks.error || "站点结构校验失败"),
          publicAccess.ok ? "" : `公网访问未通过：${publicAccess.error || publicAccess.checked_url}`,
        ].filter(Boolean).join("；")}`;

    await update({
      status: "done",
      progress: 100,
      step_detail: verifyMessage,
      error_message: fullyVerified ? null : `site=${checks.error || "ok"}; public=${publicAccess.ok ? "ok" : (publicAccess.error || publicAccess.checked_url)}`,
      finished_at: new Date(),
    });
  } catch (err) {
    try { sshClient?.end(); } catch { /* ignore */ }
    const errorMessage = err instanceof Error ? err.message : String(err);
    try {
      const failedTask = await prisma.site_migrations.findUnique({ where: { id: taskId } });
      if (failedTask?.site_id) {
        await prisma.publish_sites.update({
          where: { id: failedTask.site_id },
          data: { verified: 0 },
        });
      }
    } catch {
      /* ignore */
    }
    await update({
      status: "failed",
      step_detail: "迁移失败",
      error_message: errorMessage,
      finished_at: new Date(),
    });
  }
}
