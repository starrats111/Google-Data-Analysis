/**
 * 远程网站发布服务（复用数据分析平台宝塔 SSH 方案）
 * 通过 SSH 连接宝塔服务器，验证目录、检测架构类型、发布/撤回文章
 * SSH 配置从管理员系统配置（system_configs 表）读取
 */
import { readFileSync } from "fs";
import { Client, SFTPWrapper } from "ssh2";
import JSON5 from "json5";
import { getBtSshConfig } from "@/lib/system-config";
import { ARTICLE_HYPERLINK_STYLE_BLOCK, cleanArticleContent, emphasizeArticleHyperlinks } from "@/lib/sanitize";

// ─── 网站架构类型常量（与 Python 后端一致）───
export const SITE_TYPES = {
  POSTS_ASSETS_JS: "posts_assets_js",       // A1: assets/js/main.js + const posts
  POSTS_ASSETS: "posts_assets",             // A2: assets/main.js + const posts
  ARTICLES_INDEX: "articles_index",         // B1: js/articles-index.js + articlesIndex
  ARTICLES_INLINE: "articles_inline",       // B2: js/main.js or js/data.js + const articles
  ARTICLES_DATA_WIN: "articles_data_win",   // C1: articles-data.js + window.__ARTICLES__
  BLOGPOSTS_DATA: "blogposts_data",         // C2: data.js + const blogPosts
  POSTS_SCRIPTS: "posts_scripts",           // D:  scripts.js + const POSTS
} as const;

export type SiteType = (typeof SITE_TYPES)[keyof typeof SITE_TYPES];

export interface SiteDetectionResult {
  site_type: string | null;
  data_js_path: string | null;
  article_var_name: string | null;
  article_html_pattern: string | null;
}

export interface VerifyResult {
  ssh_connected: boolean;
  site_dir_exists: boolean;
  main_js_exists: boolean;
  index_html_exists: boolean;
  site_type: string | null;
  data_js_path: string | null;
  article_var_name: string | null;
  article_html_pattern: string | null;
  valid: boolean;
  error?: string;
}

export interface PublicSiteAccessResult {
  ok: boolean;
  checked_url: string;
  final_url?: string;
  status?: number;
  error?: string;
}

export interface BtPanelRegistrationResult {
  ok: boolean;
  exists: boolean;
  created: boolean;
  panelSiteId?: string;
  domainLinked?: boolean;
  error?: string;
}

export interface A1StandardizationResult {
  ok: boolean;
  merged_count?: number;
  error?: string;
}

export interface VerifyWithAutoRegisterResult {
  checks: VerifyResult;
  publicAccess: PublicSiteAccessResult;
  fullyVerified: boolean;
  autoStandardizeAttempted: boolean;
  a1Standardization?: A1StandardizationResult;
  autoRegisterAttempted: boolean;
  panelRegistration?: BtPanelRegistrationResult;
}

export interface ArticlePresenceResult {
  validSite: boolean;
  jsonExists: boolean;
  detailExists: boolean;
  indexedInPrimaryData: boolean;
  indexedInHomepageData: boolean;
  checks?: VerifyResult;
  error?: string;
}

export interface RemoteSiteArticleIndexEntry {
  id: string;
  legacyId?: string;
  slug: string;
  title: string;
  detailUrl: string;
  legacyDetailUrl?: string;
  excerpt?: string;
  category?: string;
  date?: string;
  dateLabel?: string;
  image?: string;
  heroImage?: string;
}

export interface RemoteSiteArticleContentResult {
  content: string | null;
  source: "json" | "html" | "excerpt" | "none";
  publishedUrl: string;
  detailUrl: string;
}

// ─── SSH 配置（从管理员系统配置表读取）───
async function getSSHConfig() {
  const config = await getBtSshConfig();
  let privateKey: Buffer | undefined;

  // 优先使用上传的密钥内容，其次使用密钥路径
  if (config.keyContent) {
    const normalizedKey = config.keyContent.replace(/\\n/g, '\n');
    privateKey = Buffer.from(normalizedKey);
  } else if (config.keyPath) {
    try {
      privateKey = readFileSync(config.keyPath);
    } catch {
      // 密钥文件不存在，忽略
    }
  }

  return {
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password || undefined,
    privateKey,
  };
}

export async function getSiteRoot() {
  const config = await getBtSshConfig();
  return config.siteRoot;
}

// ─── SSH 连接工具 ───

async function connectSSH(): Promise<Client> {
  const config = await getSSHConfig();
  console.log(`[SSH] 连接 ${config.host}:${config.port} user=${config.username}`);
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timer = setTimeout(() => {
      client.end();
      reject(new Error(`SSH 连接超时（30秒），无法连接到 ${config.host}:${config.port}，请检查服务器网络和 SSH 配置`));
    }, 30000);
    client
      .on("ready", () => { clearTimeout(timer); resolve(client); })
      .on("error", (err) => { clearTimeout(timer); reject(new Error(`SSH 连接失败: ${err.message}`)); })
      .connect({ ...config, readyTimeout: 30000 });
  });
}

function getSFTP(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

function sftpReadFile(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.readFile(path, "utf8", (err, data) => {
      if (err) reject(err);
      else resolve(typeof data === "string" ? data : data.toString("utf8"));
    });
  });
}

function sftpWriteFile(sftp: SFTPWrapper, path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, content, "utf8", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpWriteBuffer(sftp: SFTPWrapper, path: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(path, data, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function sftpStat(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    sftp.stat(path, (err, stats) => {
      if (err) resolve(false);
      else resolve(true);
    });
  });
}

function sftpStatInfo(sftp: SFTPWrapper, path: string): Promise<{ exists: boolean; size: number; isDirectory: boolean }> {
  return new Promise((resolve) => {
    sftp.stat(path, (err, stats) => {
      if (err || !stats) {
        resolve({ exists: false, size: 0, isDirectory: false });
        return;
      }
      resolve({
        exists: true,
        size: Number(stats.size || 0),
        isDirectory: stats.isDirectory(),
      });
    });
  });
}

function sftpIsDir(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    sftp.stat(path, (err, stats) => {
      if (err) resolve(false);
      else resolve(stats.isDirectory());
    });
  });
}

function execCommand(client: Client, cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      let output = "";
      stream.on("data", (data: Buffer) => { output += data.toString(); });
      stream.stderr.on("data", (data: Buffer) => { output += data.toString(); });
      stream.on("close", () => resolve(output));
    });
  });
}

function shellSingleQuote(value: string) {
  return "'" + value.replace(/'/g, `'"'"'`) + "'";
}

async function registerBtPanelSiteInternal(client: Client, domain: string, sitePath: string): Promise<BtPanelRegistrationResult> {
  const domainClean = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const sitePathClean = sitePath.trim().replace(/\\/g, "/").replace(/\/+$/, "");

  if (!domainClean) {
    return { ok: false, exists: false, created: false, error: "域名不能为空" };
  }
  if (!sitePathClean) {
    return { ok: false, exists: false, created: false, error: "站点路径不能为空" };
  }

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const dbPath = "/www/server/panel/data/default.db";
  const escapedDomain = domainClean.replace(/'/g, "''");
  const escapedPath = sitePathClean.replace(/'/g, "''");
  const escapedNow = now.replace(/'/g, "''");

  try {
    const existing = await execCommand(
      client,
      `sudo sqlite3 ${shellSingleQuote(dbPath)} "SELECT id FROM sites WHERE name='${escapedDomain}' LIMIT 1;" 2>/dev/null`
    );
    const existingId = existing.trim();

    if (existingId) {
      const domainExisting = await execCommand(
        client,
        `sudo sqlite3 ${shellSingleQuote(dbPath)} "SELECT id FROM domain WHERE pid=${existingId} AND name='${escapedDomain}' LIMIT 1;" 2>/dev/null`
      );

      if (!domainExisting.trim()) {
        await execCommand(
          client,
          `sudo sqlite3 ${shellSingleQuote(dbPath)} "INSERT INTO domain (pid, name, port, addtime) VALUES (${existingId}, '${escapedDomain}', 80, '${escapedNow}');"`
        );
      }

      return {
        ok: true,
        exists: true,
        created: false,
        panelSiteId: existingId,
        domainLinked: true,
      };
    }

    await execCommand(
      client,
      `sudo sqlite3 ${shellSingleQuote(dbPath)} "INSERT INTO sites (name, path, status, [index], ps, addtime) VALUES ('${escapedDomain}', '${escapedPath}', '1', 'index.html', '${escapedDomain}', '${escapedNow}');"`
    );
    const sid = await execCommand(
      client,
      `sudo sqlite3 ${shellSingleQuote(dbPath)} "SELECT id FROM sites WHERE name='${escapedDomain}' ORDER BY id DESC LIMIT 1;"`
    );
    const siteId = sid.trim();

    if (siteId) {
      await execCommand(
        client,
        `sudo sqlite3 ${shellSingleQuote(dbPath)} "INSERT INTO domain (pid, name, port, addtime) VALUES (${siteId}, '${escapedDomain}', 80, '${escapedNow}');"`
      );
    }

    return {
      ok: !!siteId,
      exists: false,
      created: true,
      panelSiteId: siteId || undefined,
      domainLinked: !!siteId,
      error: siteId ? undefined : "宝塔站点创建后未获取到站点 ID",
    };
  } catch (err) {
    return {
      ok: false,
      exists: false,
      created: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function registerBtPanelSite(domain: string, sitePath: string): Promise<BtPanelRegistrationResult> {
  let client: Client | null = null;
  try {
    client = await connectSSH();
    const result = await registerBtPanelSiteInternal(client, domain, sitePath);
    client.end();
    return result;
  } catch (err) {
    client?.end();
    return {
      ok: false,
      exists: false,
      created: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function verifySiteWithAutoRegister(domain: string, sitePath: string): Promise<VerifyWithAutoRegisterResult> {
  let checks = await verifyConnection(sitePath);
  let publicAccess = await verifyPublicSiteAccess(domain);
  let a1Standardization: A1StandardizationResult | undefined;
  let panelRegistration: BtPanelRegistrationResult | undefined;
  let autoStandardizeAttempted = false;
  let autoRegisterAttempted = false;
  let fullyVerified = checks.valid && publicAccess.ok;

  if (!checks.valid && checks.site_dir_exists) {
    autoStandardizeAttempted = true;
    a1Standardization = await applyA1SiteStandard(sitePath, domain);
    if (a1Standardization.ok) {
      checks = await verifyConnection(sitePath);
      publicAccess = await verifyPublicSiteAccess(domain);
      fullyVerified = checks.valid && publicAccess.ok;
    }
  }

  if (!fullyVerified && checks.site_dir_exists) {
    autoRegisterAttempted = true;
    panelRegistration = await registerBtPanelSite(domain, sitePath);
    if (panelRegistration.ok) {
      checks = await verifyConnection(sitePath);
      publicAccess = await verifyPublicSiteAccess(domain);
      fullyVerified = checks.valid && publicAccess.ok;
    }
  }

  return {
    checks,
    publicAccess,
    fullyVerified,
    autoStandardizeAttempted,
    a1Standardization,
    autoRegisterAttempted,
    panelRegistration,
  };
}

// ─── 架构检测（与 Python 后端 _detect_site_type_inner 一致）───

async function sftpFileContains(sftp: SFTPWrapper, path: string, keyword: string): Promise<boolean> {
  try {
    const content = await sftpReadFile(sftp, path);
    return content.includes(keyword);
  } catch {
    return false;
  }
}

async function _detectSiteType(sftp: SFTPWrapper, siteRoot: string): Promise<SiteDetectionResult> {
  // A1: assets/js/main.js + const posts
  let p = `${siteRoot}/assets/js/main.js`;
  if (await sftpStat(sftp, p)) {
    try {
      const content = await sftpReadFile(sftp, p);
      if (content.includes("const posts") || content.includes("var posts")) {
        return {
          site_type: SITE_TYPES.POSTS_ASSETS_JS,
          data_js_path: "assets/js/main.js",
          article_var_name: "posts",
          article_html_pattern: "post-{slug}",
        };
      }
    } catch { /* skip */ }
  }

  // A2: assets/main.js + const posts
  p = `${siteRoot}/assets/main.js`;
  if (await sftpStat(sftp, p)) {
    try {
      const content = await sftpReadFile(sftp, p);
      if (content.includes("const posts") || content.includes("var posts")) {
        return {
          site_type: SITE_TYPES.POSTS_ASSETS,
          data_js_path: "assets/main.js",
          article_var_name: "posts",
          article_html_pattern: "post-{slug}",
        };
      }
    } catch { /* skip */ }
  }

  // 检测 article.html 和 js/articles 目录
  const hasArticleHtml = await sftpStat(sftp, `${siteRoot}/article.html`);
  const hasArticlesJsonDir = await sftpIsDir(sftp, `${siteRoot}/js/articles`);

  // 检测 URL 参数
  let articleUrlParam = "title";
  if (hasArticleHtml) {
    try {
      const mainJsPath = `${siteRoot}/js/main.js`;
      if (await sftpStat(sftp, mainJsPath)) {
        const mainContent = await sftpReadFile(sftp, mainJsPath);
        for (const candidate of ["slug", "title", "id"]) {
          if (mainContent.includes(`get('${candidate}')`) || mainContent.includes(`get("${candidate}")`)) {
            const idx = mainContent.indexOf(`get('${candidate}')`) >= 0
              ? mainContent.indexOf(`get('${candidate}')`)
              : mainContent.indexOf(`get("${candidate}")`);
            const context = mainContent.slice(Math.max(0, idx - 200), idx + 200).toLowerCase();
            if (context.includes("article") || context.includes("detail") || context.includes("slug")) {
              articleUrlParam = candidate;
              break;
            }
          }
        }
      }
    } catch { /* skip */ }
  }

  const spaPattern = (slug: string) =>
    hasArticleHtml ? `article.html?${articleUrlParam}=${slug}` : `article-${slug}`;

  // B1: js/articles-index.js + articlesIndex
  p = `${siteRoot}/js/articles-index.js`;
  if (await sftpStat(sftp, p) && await sftpFileContains(sftp, p, "articlesIndex")) {
    return {
      site_type: SITE_TYPES.ARTICLES_INDEX,
      data_js_path: "js/articles-index.js",
      article_var_name: "articlesIndex",
      article_html_pattern: spaPattern("{slug}"),
    };
  }

  // B2: js/data.js + const articles
  p = `${siteRoot}/js/data.js`;
  if (await sftpStat(sftp, p)) {
    try {
      const content = await sftpReadFile(sftp, p);
      if (content.includes("const articles ") || content.includes("const articles=")) {
        return {
          site_type: SITE_TYPES.ARTICLES_INLINE,
          data_js_path: "js/data.js",
          article_var_name: "articles",
          article_html_pattern: spaPattern("{slug}"),
        };
      }
    } catch { /* skip */ }
  }

  // B2-fallback: js/main.js + const articles
  p = `${siteRoot}/js/main.js`;
  if (await sftpStat(sftp, p)) {
    try {
      const content = await sftpReadFile(sftp, p);
      if (content.includes("const articles ") || content.includes("const articles=") ||
          content.includes("const articlesData ") || content.includes("const articlesData=")) {
        const varName = (content.includes("articlesData")) ? "articlesData" : "articles";
        return {
          site_type: SITE_TYPES.ARTICLES_INLINE,
          data_js_path: "js/main.js",
          article_var_name: varName,
          article_html_pattern: spaPattern("{slug}"),
        };
      }
    } catch { /* skip */ }
  }

  // C1: articles-data.js + window.__ARTICLES__
  p = `${siteRoot}/articles-data.js`;
  if (await sftpStat(sftp, p) && await sftpFileContains(sftp, p, "__ARTICLES__")) {
    return {
      site_type: SITE_TYPES.ARTICLES_DATA_WIN,
      data_js_path: "articles-data.js",
      article_var_name: "window.__ARTICLES__",
      article_html_pattern: spaPattern("{slug}"),
    };
  }

  // C2: data.js + const blogPosts
  p = `${siteRoot}/data.js`;
  if (await sftpStat(sftp, p) && await sftpFileContains(sftp, p, "blogPosts")) {
    return {
      site_type: SITE_TYPES.BLOGPOSTS_DATA,
      data_js_path: "data.js",
      article_var_name: "blogPosts",
      article_html_pattern: spaPattern("{slug}"),
    };
  }

  // D: scripts.js + const POSTS
  p = `${siteRoot}/scripts.js`;
  if (await sftpStat(sftp, p) && await sftpFileContains(sftp, p, "POSTS")) {
    return {
      site_type: SITE_TYPES.POSTS_SCRIPTS,
      data_js_path: "scripts.js",
      article_var_name: "POSTS",
      article_html_pattern: "post-{slug}",
    };
  }

  return { site_type: null, data_js_path: null, article_var_name: null, article_html_pattern: null };
}

// ─── 验证连接（与 Python 后端 verify_connection 一致）───
export async function verifyConnection(sitePath: string): Promise<VerifyResult> {
  let client: Client | null = null;
  try {
    client = await connectSSH();
    const sftp = await getSFTP(client);

    const checks: VerifyResult = {
      ssh_connected: true,
      site_dir_exists: false,
      main_js_exists: false,
      index_html_exists: false,
      site_type: null,
      data_js_path: null,
      article_var_name: null,
      article_html_pattern: null,
      valid: false,
    };

    checks.site_dir_exists = await sftpIsDir(sftp, sitePath);

    let dataJsInfo: { exists: boolean; size: number; isDirectory: boolean } | null = null;
    let indexHtmlInfo = { exists: false, size: 0, isDirectory: false };

    if (checks.site_dir_exists) {
      const detected = await _detectSiteType(sftp, sitePath);
      checks.site_type = detected.site_type;
      checks.data_js_path = detected.data_js_path;
      checks.article_var_name = detected.article_var_name;
      checks.article_html_pattern = detected.article_html_pattern;
      if (detected.data_js_path) {
        dataJsInfo = await sftpStatInfo(sftp, `${sitePath}/${detected.data_js_path}`);
        checks.main_js_exists = dataJsInfo.exists && !dataJsInfo.isDirectory && dataJsInfo.size > 0;
      }
    }

    indexHtmlInfo = await sftpStatInfo(sftp, `${sitePath}/index.html`);
    checks.index_html_exists = indexHtmlInfo.exists && !indexHtmlInfo.isDirectory && indexHtmlInfo.size > 0;
    checks.valid = checks.ssh_connected && checks.site_dir_exists && checks.index_html_exists && checks.main_js_exists;

    if (!checks.valid) {
      const parts: string[] = [];
      if (!checks.site_dir_exists) {
        parts.push(`站点目录不存在或不可读：${sitePath}（请核对「服务器配置」网站根目录与站点记录中的路径是否一致）`);
      } else {
        if (!indexHtmlInfo.exists) parts.push("根目录缺少 index.html");
        else if (indexHtmlInfo.size <= 0) parts.push("根目录 index.html 为空，说明迁移下载不完整或来源页不存在");

        if (checks.data_js_path) {
          if (!dataJsInfo?.exists) parts.push(`站点数据文件缺失：${checks.data_js_path}`);
          else if ((dataJsInfo?.size || 0) <= 0) parts.push(`站点数据文件为空：${checks.data_js_path}`);
        }

        if (!checks.main_js_exists) {
          parts.push(
            "未识别到支持的站点架构：需在站点根下存在其一，例如 assets/js/main.js（含 const/var posts）、js/data.js（含 const articles）、js/articles-index.js（含 articlesIndex）、data.js（含 blogPosts）等，且文件内容不能为空"
          );
        }
      }
      checks.error = parts.join("；");
    }

    client.end();
    return checks;
  } catch (err) {
    client?.end();
    return {
      ssh_connected: false,
      site_dir_exists: false,
      main_js_exists: false,
      index_html_exists: false,
      site_type: null,
      data_js_path: null,
      article_var_name: null,
      article_html_pattern: null,
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkPublicUrl(url: string, allowedHosts: Set<string>): Promise<PublicSiteAccessResult> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "crm-site-verifier/1.0" },
    });
    const finalUrl = res.url || url;
    const finalHost = new URL(finalUrl).hostname.toLowerCase();
    const hostMatched = allowedHosts.has(finalHost);
    const ok = res.ok && hostMatched;
    return {
      ok,
      checked_url: url,
      final_url: finalUrl,
      status: res.status,
      error: ok ? undefined : [!res.ok ? `HTTP ${res.status}` : "", !hostMatched ? `最终跳转到 ${finalHost}` : ""].filter(Boolean).join("；"),
    };
  } catch (err) {
    return {
      ok: false,
      checked_url: url,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function verifyPublicSiteAccess(domain: string): Promise<PublicSiteAccessResult> {
  const normalized = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const allowedHosts = new Set([normalized, `www.${normalized}`]);
  const urls = [`https://${normalized}`, `https://www.${normalized}`, `http://${normalized}`, `http://www.${normalized}`];

  let firstFailure: PublicSiteAccessResult | null = null;
  for (const url of urls) {
    const result = await checkPublicUrl(url, allowedHosts);
    if (result.ok) return result;
    if (!firstFailure) firstFailure = result;
  }

  return firstFailure || {
    ok: false,
    checked_url: `https://${normalized}`,
    error: "公网访问校验失败",
  };
}

// ─── A1 标准化：统一为 assets/js/main.js + const posts（与 CRM 发布逻辑一致）───

/** 从 JS 文件中解析 const/var name = [ ... ]; 的 JSON 兼容数组（条目须为合法 JSON 对象） */
function findArrayLiteralBounds(content: string, startIndex: number): { openBracket: number; closeBracket: number } | null {
  const openBracket = content.indexOf("[", startIndex);
  if (openBracket < 0) return null;

  let depth = 0;
  let inString: '"' | "'" | "`" | null = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openBracket; i < content.length; i++) {
    const char = content[i];
    const next = content[i + 1];

    if (inLineComment) {
      if (char === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = char as '"' | "'" | "`";
      continue;
    }

    if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) {
        return { openBracket, closeBracket: i };
      }
    }
  }

  return null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findArrayAssignmentMatch(content: string, varName: string): RegExpExecArray | null {
  const escaped = escapeRegExp(varName);
  const patterns = [new RegExp(`(?:const|var|let)\\s+${escaped}\\s*=\\s*\\[`, "m")];
  if (varName.includes(".") || varName.includes("[")) {
    patterns.unshift(new RegExp(`${escaped}\\s*=\\s*\\[`, "m"));
  } else {
    patterns.push(new RegExp(`${escaped}\\s*=\\s*\\[`, "m"));
  }

  for (const re of patterns) {
    const match = re.exec(content);
    if (match) return match;
  }
  return null;
}

function buildArrayAssignmentStatement(varName: string, entries: Record<string, unknown>[]) {
  const serialized = JSON.stringify(entries, null, 2);
  if (varName.includes(".") || varName.includes("[")) {
    return `${varName} = ${serialized};`;
  }
  return `const ${varName} = ${serialized};`;
}

function parseJsArrayLiteral(content: string, varName: string): Record<string, unknown>[] | null {
  const match = findArrayAssignmentMatch(content, varName);
  if (!match || match.index === undefined) return null;

  const bounds = findArrayLiteralBounds(content, match.index + match[0].length - 1);
  if (!bounds) return null;

  const slice = content.slice(bounds.openBracket, bounds.closeBracket + 1);
  const candidates = [slice, slice.replace(/,\s*([}\]])/g, "$1")];
  for (const candidate of candidates) {
    try {
      const arr = JSON5.parse(candidate) as unknown;
      return Array.isArray(arr) ? (arr.filter((x) => x && typeof x === "object") as Record<string, unknown>[]) : null;
    } catch {
      /* try next */
    }
  }

  return null;
}

function normalizeEntryForA1(entry: Record<string, unknown>): Record<string, unknown> {
  const title = typeof entry.title === "string" && entry.title.trim()
    ? entry.title.trim()
    : String(entry.id ?? "Untitled");
  const legacyDetailUrl = typeof entry.detailUrl === "string"
    ? entry.detailUrl
    : (typeof entry.url === "string" ? entry.url : "");
  let slug = typeof entry.slug === "string" ? entry.slug.trim() : "";

  if (!slug && legacyDetailUrl) {
    const clean = legacyDetailUrl.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/+/, "");
    const pathOnly = clean.split("?")[0].replace(/\/index\.html$/i, "").replace(/\.html$/i, "").replace(/\/+$/, "");
    const pathMatch = pathOnly.match(/(?:post|article)-([^/]+)/i);
    if (pathMatch?.[1]) {
      slug = decodeURIComponent(pathMatch[1]);
    } else if (clean.includes("?")) {
      const params = new URLSearchParams(clean.split("?")[1] || "");
      const fromParam = params.get("slug") || params.get("title") || params.get("id");
      if (fromParam) slug = decodeURIComponent(fromParam);
    }
  }

  if (!slug) slug = slugify(title) || `article-${Date.now()}`;

  const id = typeof entry.id === "string" && entry.id
    ? entry.id
    : slug || String(entry.id ?? Date.now());

  return {
    ...entry,
    id,
    title,
    slug,
    legacyDetailUrl: legacyDetailUrl || undefined,
    detailUrl: `post-${slug}`,
  };
}

function buildA1IndexHtml(cacheVersion: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>首页</title>
  <style>
    body{font-family:system-ui,-apple-system,sans-serif;max-width:900px;margin:0 auto;padding:24px;line-height:1.6;color:#222}
    h1{font-size:1.5rem;font-weight:600}
    .list{list-style:none;padding:0;margin:24px 0}
    .list li{border-bottom:1px solid #eee;padding:16px 0}
    .list a{color:#1677ff;text-decoration:none;font-weight:600;font-size:1.05rem}
    .list .meta{color:#888;font-size:.85rem;margin-top:6px}
  </style>
</head>
<body>
  <header><h1>文章列表</h1></header>
  <main><ul id="article-list" class="list"></ul></main>
  <footer style="margin-top:48px;color:#888;font-size:.85rem">CRM 统一管理站点</footer>
  <script src="assets/js/main.js?v=${cacheVersion}"></script>
</body>
</html>
`;
}

function buildA1MainJs(postsJson: string): string {
  return `const posts = ${postsJson};

(function () {
  var ul = document.getElementById("article-list");
  if (!ul) return;
  if (!posts.length) {
    ul.innerHTML = '<li style="color:#888">暂无文章，可在 CRM 中发布到本站</li>';
    return;
  }
  posts.forEach(function (p) {
    var li = document.createElement("li");
    var a = document.createElement("a");
    var path = (p.detailUrl || ("post-" + (p.slug || ""))).replace(/^\\/+/, "");
    if (path.indexOf("?") >= 0) {
      a.href = "/" + path;
    } else {
      a.href = "/" + path.replace(/\\/$/, "") + "/";
    }
    a.textContent = p.title || p.slug || "Untitled";
    li.appendChild(a);
    var meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = (p.dateLabel || p.date || "") + (p.readTime ? " · " + p.readTime : "");
    li.appendChild(meta);
    ul.appendChild(li);
  });
})();
`;
}

function replaceJsArrayLiteral(content: string, varName: string, entries: Record<string, unknown>[]): string | null {
  const match = findArrayAssignmentMatch(content, varName);
  if (!match || match.index === undefined) return null;

  const bounds = findArrayLiteralBounds(content, match.index + match[0].length - 1);
  if (!bounds) return null;

  const serialized = JSON.stringify(entries, null, 2);
  const suffix = content.slice(bounds.closeBracket + 1).replace(/^\s*;?/, ";");
  return `${content.slice(0, bounds.openBracket)}${serialized}${suffix}`;
}

function getSupportedIndexFiles(indexHtml = "", primaryDataJsPath = ""): string[] {
  const candidates = new Set<string>();
  const scriptRe = /<script[^>]+src=["']([^"'?]+)[^"']*["']/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(indexHtml)) !== null) {
    const src = match[1].replace(/^\.\//, "").replace(/^\/+/, "");
    if (!src || src.includes("main.js")) continue;
    candidates.add(src);
  }

  const knownIndexFiles = [
    primaryDataJsPath,
    "js/articles-index.js",
    "js/data.js",
    "data.js",
    "articles-data.js",
    "assets/js/main.js",
    "assets/main.js",
  ];
  for (const known of knownIndexFiles) {
    const normalized = (known || "").replace(/^\.\//, "").replace(/^\/+/, "");
    if (normalized && (normalized === primaryDataJsPath || indexHtml.includes(normalized))) {
      candidates.add(normalized);
    }
  }

  return [...candidates];
}

function buildDetailUrl(slug: string, pattern: string) {
  return pattern.replace("{slug}", slug);
}

function buildPublishedUrl(domain: string, detailUrl: string) {
  return `https://${domain}/${detailUrl.replace(/^\/+/, "")}`;
}

function parseDateValue(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const date = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const date = new Date(`${trimmed}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const direct = new Date(trimmed);
  return Number.isNaN(direct.getTime()) ? null : direct;
}

function removeArticleEntriesByIdentity(
  content: string,
  identities: { id?: string; slug?: string; detailUrl?: string; title?: string },
  preferredVarName?: string,
) {
  const detectedVarName = preferredVarName
    || content.match(/(?:const|var|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\[/)?.[1]
    || (content.includes("window.__ARTICLES__") ? "window.__ARTICLES__" : undefined);
  if (!detectedVarName) return content;

  const entries = parseJsArrayLiteral(content, detectedVarName);
  if (!entries) return content;

  const normalizedSlug = (identities.slug || "").trim().toLowerCase();
  const normalizedDetailUrl = (identities.detailUrl || "").trim().replace(/^\/+/, "").toLowerCase();
  const normalizedTitle = (identities.title || "").trim().toLowerCase();
  const normalizedId = identities.id ? String(identities.id).trim() : "";

  const filtered = entries.filter((entry) => {
    const entryId = entry.id == null ? "" : String(entry.id).trim();
    const entrySlug = typeof entry.slug === "string" ? entry.slug.trim().toLowerCase() : "";
    const entryTitle = typeof entry.title === "string" ? entry.title.trim().toLowerCase() : "";
    const entryDetailUrlRaw = typeof entry.detailUrl === "string"
      ? entry.detailUrl
      : (typeof entry.url === "string" ? entry.url : "");
    const entryDetailUrl = entryDetailUrlRaw.trim().replace(/^\/+/, "").toLowerCase();

    if (normalizedId && entryId === normalizedId) return false;
    if (normalizedSlug && entrySlug === normalizedSlug) return false;
    if (normalizedDetailUrl && entryDetailUrl === normalizedDetailUrl) return false;
    if (normalizedTitle && normalizedTitle.length >= 8 && entryTitle === normalizedTitle) return false;
    return true;
  });

  if (filtered.length === entries.length) return content;
  return replaceJsArrayLiteral(content, detectedVarName, filtered) || content;
}

function resolveLegacyDateLabel(entry: Record<string, unknown>): string {
  const direct = [entry.dateLabel, entry.date, entry.published_at, entry.publishedAt]
    .find((v) => typeof v === "string" && v.trim()) as string | undefined;
  if (direct) return direct;
  return new Date().toLocaleDateString("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function buildSlugRedirectHtml(target: string, title: string): string {
  const safeTarget = target.startsWith("/") ? target : `/${target}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="0;url=${safeTarget}" />
  <link rel="canonical" href="${safeTarget}" />
  <title>${escapeHtml(title)}</title>
  <script>location.replace(${JSON.stringify(safeTarget)});</script>
</head>
<body>
  <p>Redirecting to <a href="${safeTarget}">${safeTarget}</a>...</p>
</body>
</html>`;
}

async function materializeLegacySlugPages(
  sftp: SFTPWrapper,
  client: Client,
  siteRoot: string,
  domain: string,
  entries: Record<string, unknown>[],
): Promise<void> {
  for (const raw of entries) {
    const entry = normalizeEntryForA1(raw);
    const slug = typeof entry.slug === "string" ? entry.slug : "";
    if (!slug) continue;

    const slugDir = `${siteRoot}/post-${slug}`;
    await execCommand(client, `sudo mkdir -p "${slugDir}" && sudo chown ubuntu:www "${slugDir}" && sudo chmod 775 "${slugDir}" 2>/dev/null; true`);

    let wrote = false;
    const id = typeof entry.id === "string" ? entry.id : "";
    if (id && await sftpStat(sftp, `${siteRoot}/js/articles/${id}.json`)) {
      try {
        const json = await sftpReadFile(sftp, `${siteRoot}/js/articles/${id}.json`);
        const article = JSON.parse(json) as Record<string, unknown>;
        const title = typeof article.title === "string" ? article.title : String(entry.title || slug);
        const content = typeof article.content === "string" ? article.content : "";
        if (content) {
          await createArticleHtmlPage(
            sftp,
            client,
            siteRoot,
            { title, content },
            `post-${slug}`,
            domain,
            resolveLegacyDateLabel(article),
          );
          wrote = true;
        }
      } catch {
        /* ignore */
      }
    }

    if (!wrote) {
      const legacyDetailUrl = typeof entry.legacyDetailUrl === "string" ? entry.legacyDetailUrl : "";
      if (legacyDetailUrl) {
        const clean = legacyDetailUrl.replace(/^https?:\/\/[^/]+/i, "").replace(/^\/+/, "");
        if (clean.includes("?")) {
          await sftpWriteFile(sftp, `${slugDir}/index.html`, buildSlugRedirectHtml(clean, String(entry.title || slug)));
          wrote = true;
        } else {
          const candidates = clean.endsWith(".html")
            ? [`${siteRoot}/${clean}`, `${siteRoot}/${clean.replace(/\.html$/i, "")}/index.html`]
            : [`${siteRoot}/${clean}/index.html`, `${siteRoot}/${clean}.html`, `${siteRoot}/${clean}`];
          for (const candidate of candidates) {
            try {
              const html = await sftpReadFile(sftp, candidate);
              await sftpWriteFile(sftp, `${slugDir}/index.html`, rewriteHtmlRelativeUrls(html));
              wrote = true;
              break;
            } catch {
              /* try next */
            }
          }
        }
      }
    }

    if (!wrote) {
      const title = String(entry.title || slug);
      const excerpt = typeof entry.excerpt === "string" ? entry.excerpt : "";
      await createArticleHtmlPage(
        sftp,
        client,
        siteRoot,
        { title, content: excerpt ? `<p>${excerpt}</p>` : `<p>${title}</p>` },
        `post-${slug}`,
        domain,
        resolveLegacyDateLabel(entry),
      );
    }
  }
}

/**
 * 将远程站点补齐为 A1 架构（assets/js/main.js + const posts），同时尽量保留原站主题、CSS 与旧文章。
 * 规则：保留现有首页/静态资源；写入 A1 数据层；将旧文章补齐为 slug 目录页 post-{slug}/index.html。
 */
export async function applyA1SiteStandard(sitePath: string, domain = ""): Promise<A1StandardizationResult> {
  let client: Client | null = null;
  try {
    client = await connectSSH();
    const sftp = await getSFTP(client);

    await execCommand(client, `sudo mkdir -p "${sitePath}" "${sitePath}/assets/js" "${sitePath}/js/articles" "${sitePath}/images/articles" && sudo chown ubuntu:www "${sitePath}" 2>/dev/null; sudo chmod 775 "${sitePath}" 2>/dev/null; sudo chown -R ubuntu:www "${sitePath}/assets" "${sitePath}/js" "${sitePath}/images" 2>/dev/null; sudo chmod -R 775 "${sitePath}/assets" "${sitePath}/js" "${sitePath}/images" 2>/dev/null; true`);

    const detected = await _detectSiteType(sftp, sitePath);
    let initial: Record<string, unknown>[] = [];

    if (detected.data_js_path && detected.article_var_name) {
      try {
        const sourcePath = `${sitePath}/${detected.data_js_path}`;
        const raw = await sftpReadFile(sftp, sourcePath);
        const parsed = parseJsArrayLiteral(raw, detected.article_var_name);
        if (parsed?.length) {
          initial = parsed.map(normalizeEntryForA1);
          const rewritten = replaceJsArrayLiteral(raw, detected.article_var_name, initial);
          if (rewritten && sourcePath !== `${sitePath}/assets/js/main.js`) {
            await sftpWriteFile(sftp, sourcePath, rewritten);
          }
        }
      } catch {
        /* 无法解析则空列表 */
      }
    }

    await materializeLegacySlugPages(sftp, client, sitePath, domain, initial);

    const postsJson = JSON.stringify(initial, null, 2);
    const mainJs = buildA1MainJs(postsJson);
    await sftpWriteFile(sftp, `${sitePath}/assets/js/main.js`, mainJs);

    const indexInfo = await sftpStatInfo(sftp, `${sitePath}/index.html`);
    if (!indexInfo.exists || indexInfo.size <= 0 || indexInfo.isDirectory) {
      const cacheVersion = String(Math.floor(Date.now() / 1000));
      await sftpWriteFile(sftp, `${sitePath}/index.html`, buildA1IndexHtml(cacheVersion));
    }

    await execCommand(
      client,
      `sudo chown ubuntu:www "${sitePath}/assets/js/main.js" 2>/dev/null; sudo chmod 664 "${sitePath}/assets/js/main.js" 2>/dev/null; test -f "${sitePath}/index.html" && sudo chown ubuntu:www "${sitePath}/index.html" && sudo chmod 664 "${sitePath}/index.html" 2>/dev/null; true`,
    );

    client.end();
    return { ok: true, merged_count: initial.length };
  } catch (err) {
    client?.end();
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function listRemoteSiteArticles(site: SiteConfig): Promise<RemoteSiteArticleIndexEntry[]> {
  let client: Client | null = null;
  try {
    client = await connectSSH();
    const sftp = await getSFTP(client);
    const siteRoot = site.site_path;
    const checks = await verifyConnection(siteRoot);
    if (!checks.valid) {
      client.end();
      return [];
    }

    const dataJsPath = site.data_js_path || checks.data_js_path || "js/articles-index.js";
    const varName = site.article_var_name || checks.article_var_name || "articlesIndex";
    const sourcePath = `${siteRoot}/${dataJsPath}`;
    let raw = "";
    try {
      raw = await sftpReadFile(sftp, sourcePath);
    } catch {
      try {
        const indexHtml = await sftpReadFile(sftp, `${siteRoot}/index.html`);
        const candidates = getSupportedIndexFiles(indexHtml, dataJsPath);
        for (const relPath of candidates) {
          try {
            raw = await sftpReadFile(sftp, `${siteRoot}/${relPath}`);
            if (raw) break;
          } catch {
            /* try next */
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (!raw) {
      client.end();
      return [];
    }

    const parsed = parseJsArrayLiteral(raw, varName)
      || ["posts", "articlesIndex", "articles", "blogPosts", "POSTS", "articlesData"]
        .filter((name) => name !== varName)
        .map((name) => parseJsArrayLiteral(raw, name))
        .find((entries): entries is Record<string, unknown>[] => Array.isArray(entries) && entries.length > 0)
      || [];

    const normalized = parsed
      .map(normalizeEntryForA1)
      .filter((entry) => typeof entry.slug === "string" && typeof entry.title === "string")
      .map((entry) => ({
        id: String(entry.id || entry.slug),
        legacyId: entry.id == null ? undefined : String(entry.id),
        slug: String(entry.slug),
        title: String(entry.title),
        detailUrl: typeof entry.detailUrl === "string" ? entry.detailUrl : `post-${String(entry.slug)}`,
        legacyDetailUrl: typeof entry.legacyDetailUrl === "string" ? entry.legacyDetailUrl : undefined,
        excerpt: typeof entry.excerpt === "string" ? entry.excerpt : undefined,
        category: typeof entry.category === "string" ? entry.category : undefined,
        date: typeof entry.date === "string" ? entry.date : undefined,
        dateLabel: typeof entry.dateLabel === "string" ? entry.dateLabel : undefined,
        image: typeof entry.image === "string" ? entry.image : undefined,
        heroImage: typeof entry.heroImage === "string" ? entry.heroImage : undefined,
      }));

    client.end();
    return normalized;
  } catch {
    client?.end();
    return [];
  }
}

export async function readRemoteSiteArticleContent(
  entry: RemoteSiteArticleIndexEntry,
  site: SiteConfig,
): Promise<RemoteSiteArticleContentResult> {
  let client: Client | null = null;
  try {
    client = await connectSSH();
    const sftp = await getSFTP(client);
    const siteRoot = site.site_path;
    const checks = await verifyConnection(siteRoot);
    const pattern = site.article_html_pattern || checks.article_html_pattern || "post-{slug}";
    const detailUrl = entry.detailUrl || buildDetailUrl(entry.slug, pattern);
    const publishedUrl = buildPublishedUrl(site.domain, detailUrl);

    const jsonCandidates = new Set<string>();
    if (entry.legacyId) jsonCandidates.add(entry.legacyId);
    jsonCandidates.add(entry.id);

    for (const candidateId of jsonCandidates) {
      if (!candidateId) continue;
      try {
        const raw = await sftpReadFile(sftp, `${siteRoot}/js/articles/${candidateId}.json`);
        const data = JSON.parse(raw) as Record<string, unknown>;
        const content = typeof data.content === "string" ? data.content.trim() : "";
        if (content) {
          client.end();
          return { content, source: "json", publishedUrl, detailUrl };
        }
      } catch {
        /* try next */
      }
    }

    const htmlCandidates = !detailUrl.includes("?")
      ? [
          `${siteRoot}/${detailUrl}/index.html`,
          `${siteRoot}/${detailUrl}.html`,
          `${siteRoot}/${detailUrl}`,
        ]
      : [];

    for (const candidate of htmlCandidates) {
      try {
        const html = await sftpReadFile(sftp, candidate);
        const bodyMatch = html.match(/<article[\s\S]*?<\/article>/i)
          || html.match(/<main[\s\S]*?<\/main>/i)
          || html.match(/<body[\s\S]*?<\/body>/i);
        const block = bodyMatch?.[0] || html;
        const content = block
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/^[\s\S]*?<h1[^>]*>[\s\S]*?<\/h1>/i, "")
          .trim();
        if (content) {
          client.end();
          return { content, source: "html", publishedUrl, detailUrl };
        }
      } catch {
        /* try next */
      }
    }

    client.end();
    if (entry.excerpt?.trim()) {
      return {
        content: `<p>${escapeHtml(entry.excerpt.trim())}</p>`,
        source: "excerpt",
        publishedUrl,
        detailUrl,
      };
    }
    return { content: null, source: "none", publishedUrl, detailUrl };
  } catch {
    client?.end();
    const detailUrl = entry.detailUrl || buildDetailUrl(entry.slug, site.article_html_pattern || "post-{slug}");
    return { content: null, source: "none", publishedUrl: buildPublishedUrl(site.domain, detailUrl), detailUrl };
  }
}

// ─── 发布文章到站点（通过 SSH 推送文件）───

function slugify(title: string): string {
  return title.toLowerCase().trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface ArticlePayload {
  id: string;
  title: string;
  slug: string;
  content: string;
  category?: string;
  image?: string;
  images?: unknown;
  trackingLink?: string | null;
}

interface SiteConfig {
  site_path: string;
  site_type: string | null;
  data_js_path: string | null;
  article_var_name: string | null;
  article_html_pattern: string | null;
  domain: string;
}

const ABSOLUTE_OR_SPECIAL_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:|mailto:|tel:)/i;

function rewriteUrlToRoot(url: string): string {
  const value = url.trim();
  if (!value || value.startsWith("/") || value.startsWith("?") || ABSOLUTE_OR_SPECIAL_URL_RE.test(value)) {
    return value;
  }

  const match = value.match(/^([^?#]*)([?#][\s\S]*)?$/);
  const pathname = match?.[1] ?? value;
  const suffix = match?.[2] ?? "";
  const normalizedPath = pathname
    .replace(/^(\.\/)+/, "")
    .replace(/^(?:\.\.\/)+/, "")
    .replace(/^\/+/, "");

  if (!normalizedPath) {
    return suffix || "/";
  }

  return `/${normalizedPath}${suffix}`;
}

function rewriteSrcSetToRoot(srcset: string): string {
  return srcset
    .split(",")
    .map((item) => {
      const trimmed = item.trim();
      if (!trimmed) return trimmed;
      const [url, ...descriptors] = trimmed.split(/\s+/);
      return [rewriteUrlToRoot(url), ...descriptors].join(" ");
    })
    .join(", ");
}

function rewriteHtmlRelativeUrls(html: string): string {
  if (!html) return html;

  return html
    .replace(/(\s(?:href|src|poster)=["'])([^"']+)(["'])/gi, (_match, prefix: string, url: string, suffix: string) => {
      return `${prefix}${rewriteUrlToRoot(url)}${suffix}`;
    })
    .replace(/(\ssrcset=["'])([^"']+)(["'])/gi, (_match, prefix: string, srcset: string, suffix: string) => {
      return `${prefix}${rewriteSrcSetToRoot(srcset)}${suffix}`;
    })
    .replace(/url\((["']?)([^)'"\s]+)\1\)/gi, (_match, quote: string, url: string) => {
      const rewritten = rewriteUrlToRoot(url);
      return `url(${quote}${rewritten}${quote})`;
    });
}

/**
 * 从已有 post 页面提取 head/header/footer，组装新文章页面。
 * 如果找不到模板，回退为独立页面。
 */
async function createArticleHtmlPage(
  sftp: SFTPWrapper,
  client: Client,
  siteRoot: string,
  article: { title: string; content: string },
  htmlFilename: string,
  domain: string,
  dateLabel: string,
): Promise<void> {
  // 目录模式：post-slug → post-slug/index.html（实现无 .html 的 clean URL）
  let htmlPath: string;
  if (htmlFilename.endsWith(".html")) {
    htmlPath = `${siteRoot}/${htmlFilename}`;
  } else {
    const dirPath = `${siteRoot}/${htmlFilename}`;
    await execCommand(client, `sudo mkdir -p "${dirPath}" && sudo chown ubuntu:www "${dirPath}" && sudo chmod 775 "${dirPath}" 2>/dev/null; true`);
    htmlPath = `${dirPath}/index.html`;
  }

  // Always use index.html for template (correct site branding, not another post's theme)
  let templateHtml = "";
  try {
    templateHtml = await sftpReadFile(sftp, `${siteRoot}/index.html`);
  } catch { /* ignore */ }

  const normalizedArticle = cleanArticleContent(article.content).cleaned || article.content;
  // Strip leading <h1> from article content to avoid duplicate title
  const cleanedContent = rewriteHtmlRelativeUrls(
    normalizedArticle.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, "").trim()
  );

  let html: string;

  if (templateHtml) {
    const htmlOpenTag = templateHtml.match(/<html\b[^>]*>/i)?.[0] || '<html lang="en">';
    const bodyOpenTag = templateHtml.match(/<body\b[^>]*>/i)?.[0] || "<body>";

    const headMatch = templateHtml.match(/<head\b[^>]*>[\s\S]*?<\/head>/i);
    let headSection = headMatch ? headMatch[0] : "";
    if (headSection) {
      headSection = rewriteHtmlRelativeUrls(headSection);
      if (/<title>[^<]*<\/title>/i.test(headSection)) {
        headSection = headSection.replace(
          /<title>[^<]*<\/title>/i,
          `<title>${escapeHtml(article.title)}</title>`,
        );
      } else {
        headSection = headSection.replace(/<\/head>/i, `  <title>${escapeHtml(article.title)}</title>\n</head>`);
      }
      // Remove main.js to avoid loading article listing code on detail page
      headSection = headSection.replace(/<script[^>]*main\.js[^>]*><\/script>\s*/gi, "");
      if (!headSection.includes("crm-affiliate-link")) {
        headSection = headSection.replace(/<\/head>/i, `  <style>${ARTICLE_HYPERLINK_STYLE_BLOCK}</style>\n</head>`);
      }
    } else {
      headSection = `<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${escapeHtml(article.title)}</title>\n<style>${ARTICLE_HYPERLINK_STYLE_BLOCK}</style>\n</head>`;
    }

    let headerNav = "";
    const headerMatch = templateHtml.match(/<header[\s\S]*?<\/header>/i);
    if (headerMatch) headerNav = rewriteHtmlRelativeUrls(headerMatch[0]);

    let footer = "";
    const footerMatch = templateHtml.match(/<footer[\s\S]*?<\/footer>/i);
    if (footerMatch) footer = rewriteHtmlRelativeUrls(footerMatch[0]);

    html = `<!DOCTYPE html>
${htmlOpenTag}
${headSection}
${bodyOpenTag}
  ${headerNav}
  <main style="max-width:800px;margin:40px auto;padding:0 20px;">
    <a href="/" style="color:#888;text-decoration:none;display:inline-block;margin-bottom:20px;">&larr; Back to articles</a>
    <article>
      <h1>${escapeHtml(article.title)}</h1>
      <div style="color:#888;margin-bottom:24px;font-size:14px;">${escapeHtml(dateLabel)}</div>
      <div class="article-content" style="line-height:1.8;">
        ${cleanedContent}
      </div>
    </article>
  </main>
  ${footer}
</body>
</html>`;
  } else {
    html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(article.title)}</title>
  <style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.8;color:#333}h1{font-size:2em}img{max-width:100%;height:auto}.meta{color:#888;margin-bottom:24px}a.back{color:#888;text-decoration:none}${ARTICLE_HYPERLINK_STYLE_BLOCK}</style>
</head>
<body>
  <a class="back" href="/">&larr; Back</a>
  <h1>${escapeHtml(article.title)}</h1>
  <div class="meta">${escapeHtml(dateLabel)}</div>
  <div>${cleanedContent}</div>
</body>
</html>`;
  }

  await sftpWriteFile(sftp, htmlPath, html);
}

/**
 * 解析 index.html 中引用的数据 JS 文件路径，
 * 确保新文章也写入首页实际加载的索引文件。
 */
async function syncToHomepageDataFile(
  sftp: SFTPWrapper,
  siteRoot: string,
  primaryDataJsPath: string,
  indexEntry: Record<string, unknown>,
  articleId: string,
): Promise<void> {
  try {
    const indexHtml = await sftpReadFile(sftp, `${siteRoot}/index.html`);

    // 从 <script src="..."> 标签中提取所有 JS 路径
    const scriptRe = /<script[^>]+src=["']([^"'?]+)/gi;
    let m: RegExpExecArray | null;
    const candidates: string[] = [];
    while ((m = scriptRe.exec(indexHtml)) !== null) {
      const src = m[1].replace(/^\.\//, "");
      if (src !== primaryDataJsPath && !src.includes("main.js")) {
        candidates.push(src);
      }
    }

    // 同时检测 main.js 引用但非当前数据文件的索引 JS
    const knownIndexFiles = [
      "js/articles-index.js", "js/data.js", "data.js",
      "articles-data.js", "assets/js/main.js", "assets/main.js",
    ];
    for (const known of knownIndexFiles) {
      if (known !== primaryDataJsPath && indexHtml.includes(known)) {
        if (!candidates.includes(known)) candidates.push(known);
      }
    }

    for (const relPath of candidates) {
      const fullPath = `${siteRoot}/${relPath}`;
      if (!(await sftpStat(sftp, fullPath))) continue;

      let content = "";
      try { content = await sftpReadFile(sftp, fullPath); } catch { continue; }

      // 检测文件中的数组变量名
      const candidateVarNames = ["articlesIndex", "articles", "posts", "blogPosts", "POSTS", "articlesData", "window.__ARTICLES__"];
      const hpVarName = candidateVarNames.find((name) => Boolean(findArrayAssignmentMatch(content, name)));
      if (!hpVarName) continue;

      console.log(`[Publisher] 同步索引到首页文件: ${relPath} (var=${hpVarName})`);

      content = removeArticleEntriesByIdentity(content, {
        id: articleId,
        slug: String(indexEntry.slug || ""),
        detailUrl: String(indexEntry.detailUrl || ""),
        title: String(indexEntry.title || ""),
      }, hpVarName);

      // 在数组开头插入
      const arrMatch = findArrayAssignmentMatch(content, hpVarName);
      if (arrMatch) {
        const pos = (arrMatch.index || 0) + arrMatch[0].length;
        const entryStr = "\n  " + JSON.stringify(indexEntry) + ",";
        content = content.slice(0, pos) + entryStr + content.slice(pos);
        await sftpWriteFile(sftp, fullPath, content);
      }
    }
  } catch (err) {
    console.warn(`[Publisher] 同步首页数据文件时出错（非致命）:`, err);
  }
}

// ─── 图片下载与本地化（v3.0 新增）───

const MAX_IMAGES = 25;

const REFERER_STRATEGIES: ((url: string) => string)[] = [
  (url: string) => {
    try { return new URL(url).origin + "/"; } catch { return ""; }
  },
  () => "",
  () => "https://www.google.com/",
];

async function downloadImageWithRetry(
  imageUrl: string,
  baseTimeoutMs = 15000,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  for (let attempt = 0; attempt < REFERER_STRATEGIES.length; attempt++) {
    const getReferer = REFERER_STRATEGIES[attempt];
    const timeoutMs = baseTimeoutMs + attempt * 5000;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const referer = getReferer(imageUrl);
      const headers: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/webp,image/apng,image/*,*/*;q=0.8",
      };
      if (referer) headers["Referer"] = referer;

      const resp = await fetch(imageUrl, { headers, signal: controller.signal, redirect: "follow" });
      clearTimeout(timer);

      if (!resp.ok) {
        console.warn(`[Publisher] 图片下载 HTTP ${resp.status} (attempt ${attempt + 1}): ${imageUrl.slice(0, 80)}`);
        continue;
      }
      const ct = resp.headers.get("content-type") || "";
      if (!ct.startsWith("image/") && !ct.includes("octet-stream")) continue;

      const arrayBuf = await resp.arrayBuffer();
      if (arrayBuf.byteLength < 100) continue;
      return { buffer: Buffer.from(arrayBuf), contentType: ct.startsWith("image/") ? ct : "image/jpeg" };
    } catch (err) {
      console.warn(`[Publisher] 图片下载异常 (attempt ${attempt + 1}): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
  }
  return null;
}

function normalizeArticleImagePaths(content: string): string {
  if (!content) return content;
  return content.replace(
    /(<img\s[^>]*?(?:src|data-src)=["'])(\.?\/?images\/articles\/[^"']+)(["'][^>]*?>)/gi,
    (_match, prefix: string, path: string, suffix: string) => {
      const normalizedPath = path.replace(/^\.?\/?/, "");
      return `${prefix}/${normalizedPath}${suffix}`;
    }
  );
}

async function syncArticleImages(
  sftp: SFTPWrapper,
  client: Client,
  siteRoot: string,
  articleId: string,
  content: string,
): Promise<string> {
  const imagesDir = `${siteRoot}/images/articles`;

  const imgRegex = /<img\s[^>]*?(?:src|data-src)=["']([^"']+)["'][^>]*?\/?>/gi;
  let match: RegExpExecArray | null;
  const matches: { fullTag: string; url: string; attr: string; isInternal: boolean }[] = [];

  while ((match = imgRegex.exec(content)) !== null) {
    const url = match[1];
    // 已本地化的图片跳过
    if (url.includes("images/articles/")) continue;

    const attrMatch = match[0].match(/\b(src|data-src)=["']/);
    const attr = attrMatch?.[1] || "src";

    if (url.startsWith("http://") || url.startsWith("https://")) {
      matches.push({ fullTag: match[0], url, attr, isInternal: false });
    } else if (/^\/api\/user\/ad-creation\/upload-image\//i.test(url)) {
      matches.push({ fullTag: match[0], url, attr, isInternal: true });
    }
  }

  if (matches.length === 0) return content;

  let updatedContent = content;
  let processed = 0;
  let failed = 0;

  for (const { fullTag, url, attr, isInternal } of matches) {
    if (processed >= MAX_IMAGES) break;

    try {
      let buffer: Buffer | null = null;
      let contentType = "";

      if (isInternal) {
        // 内部上传图片：直接从本地文件系统读取
        const { readUploadedImageBuffer } = await import("@/lib/upload-image-reader");
        const result = await readUploadedImageBuffer(url);
        if (result) {
          buffer = result.buffer;
          contentType = result.contentType;
        }
      } else {
        const result = await downloadImageWithRetry(url);
        if (result) {
          buffer = result.buffer;
          contentType = result.contentType;
        }
      }

      if (!buffer) {
        failed++;
        console.warn(`[Publisher] 图片获取失败，保留原 URL: ${url.slice(0, 80)}`);
        continue;
      }

      const ext = contentType.includes("png") ? ".png"
        : contentType.includes("webp") ? ".webp"
        : contentType.includes("gif") ? ".gif"
        : ".jpg";

      const filename = `${articleId}_${processed}${ext}`;
      const remotePath = `${imagesDir}/${filename}`;

      await sftpWriteBuffer(sftp, remotePath, buffer);

      const localUrl = `/images/articles/${filename}`;
      let newTag = fullTag.replace(url, localUrl);
      if (attr === "data-src") {
        newTag = newTag.replace("data-src=", "src=");
      }
      updatedContent = updatedContent.replace(fullTag, newTag);
      processed++;
    } catch (err) {
      failed++;
      console.warn(`[Publisher] 图片处理异常 (${url.slice(0, 60)}):`, err);
    }
  }

  console.log(`[Publisher] 文章 ${articleId}: 本地化 ${processed}/${matches.length} 张图片` + (failed > 0 ? ` (${failed} 张失败)` : ""));
  return updatedContent;
}

function buildArticleImageTag(src: string, alt: string, isHero: boolean): string {
  const safeAlt = alt.replace(/"/g, "&quot;");
  return isHero
    ? `<img src="${src}" alt="${safeAlt}" style="width:100%;max-height:400px;object-fit:cover;border-radius:12px;margin:0 0 24px 0" loading="lazy" />`
    : `<img src="${src}" alt="${safeAlt}" style="max-width:100%;border-radius:8px;margin:16px 0" loading="lazy" />`;
}

function ensurePublishContentImages(content: string, title: string, imagesJson?: unknown): string {
  const images = Array.isArray(imagesJson)
    ? imagesJson.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u)).slice(0, 5)
    : [];

  if (!content || images.length === 0) return content;

  const imgRegex = /<img\s[^>]*?(?:src|data-src)=["']([^"']+)["'][^>]*?\/?>/gi;
  const existingCount = [...content.matchAll(imgRegex)].length;
  if (existingCount > 0) return content;

  const blocks = content.match(/(<(?:h[1-6]|p|div|ul|ol|blockquote|table|figure|section)[\s>][\s\S]*?<\/(?:h[1-6]|p|div|ul|ol|blockquote|table|figure|section)>)/gi) || [];
  const hero = buildArticleImageTag(images[0], `${title} hero image`, true);
  const body = images.slice(1).map((src, index) => buildArticleImageTag(src, `${title} image ${index + 1}`, false));

  if (blocks.length === 0) {
    return [hero, content, ...body].join("\n");
  }

  let result = "";
  let cursor = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const start = content.indexOf(block, cursor);
    if (start < 0) continue;
    const end = start + block.length;
    result += content.slice(cursor, end);
    cursor = end;
    if (i === 0) {
      result += `\n${hero}`;
    }
  }
  result += content.slice(cursor);

  if (body.length > 0) {
    result += `\n${body.join("\n")}`;
  }
  return result;
}

function extractHeroImage(content: string, imagesJson?: unknown): string {
  // 1. 从 HTML content 中匹配（跳过小图标/追踪像素）
  const imgRegex = /<img\s[^>]*?(?:src|data-src)=["']([^"']+)["'][^>]*?\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRegex.exec(content)) !== null) {
    const url = m[1];
    if (!url || url.length < 10) continue;
    if (/width=["']?1["']?/i.test(m[0]) && /height=["']?1["']?/i.test(m[0])) continue;
    if (url.endsWith(".svg") || url.includes("tracking") || url.includes("pixel")) continue;
    return url;
  }

  // 2. 从 images JSON 字段提取第一张（回退，因为可能还是外链图）
  if (imagesJson) {
    const arr = Array.isArray(imagesJson) ? imagesJson : [];
    const first = arr.find((u: unknown) => typeof u === "string" && u.length > 5);
    if (first) return first as string;
  }

  return "";
}

async function ensureSiteWritable(client: Client, siteRoot: string, dataJsPath: string): Promise<void> {
  const dirs = [`${siteRoot}/js`, `${siteRoot}/js/articles`, `${siteRoot}/images`, `${siteRoot}/images/articles`];
  for (const dir of dirs) {
    await execCommand(client, `sudo mkdir -p ${dir} && sudo chown ubuntu:www ${dir} && sudo chmod 775 ${dir} 2>/dev/null; true`);
  }
  const dataFile = `${siteRoot}/${dataJsPath}`;
  await execCommand(client, `test -f ${dataFile} && sudo chown ubuntu:www ${dataFile} && sudo chmod 664 ${dataFile} 2>/dev/null; true`);
  for (const html of ["index.html", "article.html", "articles.html"]) {
    await execCommand(client, `test -f ${siteRoot}/${html} && sudo chown ubuntu:www ${siteRoot}/${html} && sudo chmod 664 ${siteRoot}/${html} 2>/dev/null; true`);
  }
}

export async function verifyArticlePresenceOnSite(
  article: { id: string; slug?: string | null },
  site: SiteConfig,
): Promise<ArticlePresenceResult> {
  let client: Client | null = null;
  try {
    client = await connectSSH();
    const sftp = await getSFTP(client);
    const siteRoot = site.site_path;
    const checks = await verifyConnection(siteRoot);
    if (!checks.valid) {
      client.end();
      return { validSite: false, jsonExists: false, detailExists: false, indexedInPrimaryData: false, indexedInHomepageData: false, checks, error: checks.error };
    }

    const articleId = String(article.id);
    const slug = article.slug?.trim() || "";
    const jsonExists = await sftpStat(sftp, `${siteRoot}/js/articles/${articleId}.json`);

    const pattern = site.article_html_pattern || checks.article_html_pattern || "article.html?title={slug}";
    const detailUrl = slug ? pattern.replace("{slug}", slug) : "";
    let detailExists = false;
    if (detailUrl && !detailUrl.includes("?")) {
      detailExists = await sftpStat(sftp, `${siteRoot}/${detailUrl}`)
        || await sftpStat(sftp, `${siteRoot}/${detailUrl}/index.html`)
        || await sftpStat(sftp, `${siteRoot}/${detailUrl}.html`);
    } else if (detailUrl) {
      detailExists = true;
    }

    const containsIdentity = (content: string) => {
      const escapedId = articleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\"id\"\\s*:\\s*\"?${escapedId}\"?`).test(content)) return true;
      if (slug && new RegExp(`\"slug\"\\s*:\\s*\"${escapedSlug}\"`).test(content)) return true;
      if (slug && content.includes(`post-${slug}`)) return true;
      return false;
    };

    let indexedInPrimaryData = false;
    const primaryDataPath = `${siteRoot}/${site.data_js_path || checks.data_js_path || "js/articles-index.js"}`;
    try {
      const primaryContent = await sftpReadFile(sftp, primaryDataPath);
      indexedInPrimaryData = containsIdentity(primaryContent);
    } catch { /* ignore */ }

    let indexedInHomepageData = indexedInPrimaryData;
    try {
      const indexHtml = await sftpReadFile(sftp, `${siteRoot}/index.html`);
      const candidates = new Set<string>();
      const scriptRe = /<script[^>]+src=["']([^"'?]+)[^"']*["']/gi;
      let m: RegExpExecArray | null;
      while ((m = scriptRe.exec(indexHtml)) !== null) {
        const src = m[1].replace(/^\.\//, "");
        if (!src.includes("main.js")) candidates.add(src);
      }
      for (const relPath of ["js/articles-index.js", "js/data.js", "data.js", "articles-data.js", "assets/js/main.js", "assets/main.js"]) {
        if (indexHtml.includes(relPath)) candidates.add(relPath);
      }
      for (const relPath of candidates) {
        const fullPath = `${siteRoot}/${relPath}`;
        if (!(await sftpStat(sftp, fullPath))) continue;
        const content = await sftpReadFile(sftp, fullPath);
        if (containsIdentity(content)) {
          indexedInHomepageData = true;
          break;
        }
      }
    } catch { /* ignore */ }

    client.end();
    return {
      validSite: true,
      jsonExists,
      detailExists,
      indexedInPrimaryData,
      indexedInHomepageData,
      checks,
    };
  } catch (err) {
    client?.end();
    return {
      validSite: false,
      jsonExists: false,
      detailExists: false,
      indexedInPrimaryData: false,
      indexedInHomepageData: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function publishArticleToSite(
  article: ArticlePayload,
  site: SiteConfig
): Promise<{ success: boolean; url?: string; error?: string; updatedContent?: string }> {
  let client: Client | null = null;
  try {
    client = await connectSSH();
    const sftp = await getSFTP(client);
    const siteRoot = site.site_path;
    const slug = article.slug || slugify(article.title);
    const dataJsPath = site.data_js_path || "js/articles-index.js";
    const varName = site.article_var_name || "articlesIndex";
    const fullDataPath = `${siteRoot}/${dataJsPath}`;
    const pattern = site.article_html_pattern || "article.html?title={slug}";
    const detailUrl = pattern.replace("{slug}", slug);
    const isStaticHtml = !detailUrl.includes("?");

    await ensureSiteWritable(client, siteRoot, dataJsPath);

    const cleanedArticle = cleanArticleContent(article.content);

    // ─── 图片路径规范化 + 本地化（v4.0 — 不再自动补图/重排）───
    let workingContent = cleanedArticle.cleaned || article.content;
    workingContent = emphasizeArticleHyperlinks(workingContent);
    workingContent = normalizeArticleImagePaths(workingContent);
    let updatedContent: string | undefined = workingContent !== article.content ? workingContent : undefined;
    try {
      workingContent = await syncArticleImages(sftp, client, siteRoot, article.id, workingContent);
      if (workingContent !== article.content) {
        updatedContent = workingContent;
      }
    } catch (err) {
      console.warn("[Publisher] 图片本地化失败（不阻塞发布）:", err);
    }

    // 提取 hero image：优先使用文章正文中的首图（尤其是已本地化后的首图），再回退到预设图片
    let heroImage = extractHeroImage(workingContent);
    if (!heroImage) {
      heroImage = article.image || "";
    }
    if (!heroImage) {
      heroImage = extractHeroImage(workingContent, article.images);
    }
    // 如果 hero image 已被本地化，优先使用本地化路径
    if (updatedContent) {
      const localizedHero = extractHeroImage(updatedContent);
      if (localizedHero && localizedHero.startsWith("/images/")) {
        heroImage = localizedHero;
      }
    }
    if (heroImage) {
      console.log(`[Publisher] 文章 ${article.id} heroImage: ${heroImage.slice(0, 80)}`);
    } else {
      console.warn(`[Publisher] 文章 ${article.id} 未找到头图`);
    }

    const now = new Date();
    const dateLabel = now.toLocaleDateString("en-US", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
    const dateISO = now.toISOString().slice(0, 10);

    const plainText = workingContent.replace(/<[^>]*>/g, "");
    const wordCount = plainText.split(/\s+/).filter(Boolean).length;
    const readTime = `${Math.max(1, Math.ceil(wordCount / 200))} min read`;

    // 1. js/articles 目录（ensureSiteWritable 已创建并修正权限）
    const articlesDir = `${siteRoot}/js/articles`;

    // 2. 写入文章 JSON 详情（使用本地化后的 content）
    const articleJson = JSON.stringify({
      id: article.id,
      title: article.title,
      slug,
      content: workingContent,
      category: article.category || "General",
      date: dateLabel,
    });
    await sftpWriteFile(sftp, `${articlesDir}/${article.id}.json`, articleJson);

    // 3. 更新数据索引文件（articles-index.js / main.js 等）
    let dataContent = "";
    try {
      dataContent = await sftpReadFile(sftp, fullDataPath);
    } catch {
      dataContent = `${buildArrayAssignmentStatement(varName, [])}\n`;
    }

    // 构建索引条目 — 同时兼容两种字段名：
    //   旧模板用 date / image，CRM 模板用 dateISO / dateLabel / heroImage
    const excerpt = plainText.slice(0, 160).trim() + "...";
    const indexEntry: Record<string, unknown> = {
      id: article.id,
      slug,
      title: article.title,
      category: (article.category || "general").toLowerCase(),
      date: dateISO,
      dateISO,
      dateLabel,
      readTime,
      excerpt,
      image: heroImage,
      heroImage,
      detailUrl,
      tags: [(article.category || "general").toLowerCase()],
    };

    // 解析现有数组并追加
    const existingMatch = findArrayAssignmentMatch(dataContent, varName);

    if (existingMatch) {
      dataContent = removeArticleEntriesByIdentity(dataContent, {
        id: article.id,
        slug,
        detailUrl,
        title: article.title,
      }, varName);

      const updatedMatch = findArrayAssignmentMatch(dataContent, varName);
      if (updatedMatch) {
        const insertPos = (updatedMatch.index || 0) + updatedMatch[0].length;
        const entryStr = "\n  " + JSON.stringify(indexEntry) + ",";
        dataContent = dataContent.slice(0, insertPos) + entryStr + dataContent.slice(insertPos);
      } else {
        dataContent = `${buildArrayAssignmentStatement(varName, [indexEntry])}\n`;
      }
    } else {
      dataContent = `${buildArrayAssignmentStatement(varName, [indexEntry])}\n`;
    }

    await sftpWriteFile(sftp, fullDataPath, dataContent);

    // 3b. 同步更新首页实际加载的数据文件（解决检测结果与首页引用不一致的问题）
    await syncToHomepageDataFile(sftp, siteRoot, dataJsPath, indexEntry, article.id);

    // 4. 创建文章详情 HTML 页面（使用本地化后的 content）
    if (isStaticHtml) {
      await createArticleHtmlPage(
        sftp, client, siteRoot,
        { title: article.title, content: workingContent },
        detailUrl, site.domain, dateLabel,
      );
    }

    // 5. CDN 缓存刷新（更新 HTML 中所有数据 JS 的 ?v= 参数）
    const ts = String(Math.floor(Date.now() / 1000));
    // 收集所有需要刷新缓存的 JS 文件名
    const jsBasenames = new Set<string>();
    const primaryBasename = dataJsPath.split("/").pop() || "";
    if (primaryBasename) jsBasenames.add(primaryBasename);
    jsBasenames.add("articles-index.js");

    for (const htmlName of ["article.html", "articles.html", "index.html"]) {
      const htmlPath = `${siteRoot}/${htmlName}`;
      try {
        let html = await sftpReadFile(sftp, htmlPath);
        let changed = false;
        for (const basename of jsBasenames) {
          if (!html.includes(basename)) continue;
          const escaped = basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          // 匹配 ?v= 后的任意非引号字符（支持字母+数字混合版本号如 20260314b）
          const re = new RegExp(escaped + "\\?v=[^\"'\\s>]+", "g");
          if (re.test(html)) {
            re.lastIndex = 0;
            html = html.replace(re, `${basename}?v=${ts}`);
            changed = true;
          } else {
            const r1 = html.replace(`${basename}"`, `${basename}?v=${ts}"`);
            const r2 = r1.replace(`${basename}'`, `${basename}?v=${ts}'`);
            if (r2 !== html) { html = r2; changed = true; }
          }
        }
        if (changed) {
          await sftpWriteFile(sftp, htmlPath, html);
        }
      } catch { /* skip */ }
    }

    // 6. 构建发布 URL
    const articleUrl = `https://${site.domain}/${detailUrl}`;

    client.end();
    return { success: true, url: articleUrl, updatedContent };
  } catch (err) {
    client?.end();
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── 撤回文章（从站点移除）───
export async function unpublishArticleFromSite(
  articleId: string,
  slug: string,
  site: {
    site_path: string;
    site_type: string | null;
    data_js_path: string | null;
    article_var_name: string | null;
    article_html_pattern: string | null;
  }
): Promise<{ success: boolean; error?: string }> {
  let client: Client | null = null;
  try {
    client = await connectSSH();
    const sftp = await getSFTP(client);
    const siteRoot = site.site_path;
    const dataJsPath = site.data_js_path || "js/articles-index.js";
    const fullDataPath = `${siteRoot}/${dataJsPath}`;

    // 1. 删除文章 JSON 详情
    const jsonPath = `${siteRoot}/js/articles/${articleId}.json`;
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(jsonPath, (err) => { if (err) reject(err); else resolve(); });
      });
    } catch { /* 文件可能不存在 */ }

    // 2. 从所有索引文件中移除条目（包括首页数据文件）
    const entryRegex = new RegExp(
      `\\{[^}]*"id"\\s*:\\s*"${articleId}"[^}]*\\},?\\s*`,
      "g"
    );
    // 收集需要清理的数据文件
    const filesToClean = new Set<string>([fullDataPath]);
    try {
      const indexHtml = await sftpReadFile(sftp, `${siteRoot}/index.html`);
      const knownFiles = [
        "js/articles-index.js", "js/data.js", "data.js",
        "articles-data.js", "assets/js/main.js", "assets/main.js",
      ];
      for (const f of knownFiles) {
        if (indexHtml.includes(f)) filesToClean.add(`${siteRoot}/${f}`);
      }
    } catch { /* ignore */ }
    for (const fp of filesToClean) {
      try {
        const content = await sftpReadFile(sftp, fp);
        const cleaned = content.replace(entryRegex, "");
        if (cleaned !== content) await sftpWriteFile(sftp, fp, cleaned);
      } catch { /* 文件可能不存在 */ }
    }

    // 3. 删除文章详情 HTML 页面（兼容旧 .html 文件和新目录模式）
    if (slug) {
      const pattern = site.article_html_pattern || "article.html?title={slug}";
      const detailUrl = pattern.replace("{slug}", slug);
      if (!detailUrl.includes("?")) {
        // 删除旧的 .html 文件（如果存在）
        const oldHtmlPath = `${siteRoot}/${detailUrl}.html`;
        try {
          await new Promise<void>((resolve, reject) => {
            sftp.unlink(oldHtmlPath, (err) => { if (err) reject(err); else resolve(); });
          });
        } catch { /* 文件可能不存在 */ }
        // 删除新的目录模式
        try {
          await execCommand(client, `rm -rf "${siteRoot}/${detailUrl}" 2>/dev/null; true`);
        } catch { /* 目录可能不存在 */ }
      }
    }

    client.end();
    return { success: true };
  } catch (err) {
    client?.end();
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

