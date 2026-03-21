/**
 * 远程网站发布服务（复用数据分析平台宝塔 SSH 方案）
 * 通过 SSH 连接宝塔服务器，验证目录、检测架构类型、发布/撤回文章
 * SSH 配置从管理员系统配置（system_configs 表）读取
 */
import { Client, SFTPWrapper } from "ssh2";
import { getBtSshConfig } from "@/lib/system-config";

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

// ─── SSH 配置（从管理员系统配置表读取）───
async function getSSHConfig() {
  const config = await getBtSshConfig();
  let privateKey: Buffer | undefined;

  // 优先使用上传的密钥内容，其次使用密钥路径
  if (config.keyContent) {
    privateKey = Buffer.from(config.keyContent);
  } else if (config.keyPath) {
    try {
      privateKey = require("fs").readFileSync(config.keyPath);
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

function sftpStat(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    sftp.stat(path, (err, stats) => {
      if (err) resolve(false);
      else resolve(true);
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
          article_html_pattern: "post-{slug}.html",
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
          article_html_pattern: "post-{slug}.html",
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
    hasArticleHtml ? `article.html?${articleUrlParam}=${slug}` : `article-${slug}.html`;

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
      article_html_pattern: "post-{slug}.html",
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

    if (checks.site_dir_exists) {
      const detected = await _detectSiteType(sftp, sitePath);
      checks.site_type = detected.site_type;
      checks.data_js_path = detected.data_js_path;
      checks.article_var_name = detected.article_var_name;
      checks.article_html_pattern = detected.article_html_pattern;
      if (detected.data_js_path) checks.main_js_exists = true;
    }

    checks.index_html_exists = await sftpStat(sftp, `${sitePath}/index.html`);
    checks.valid = checks.ssh_connected && checks.site_dir_exists && checks.index_html_exists;

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

// ─── 发布文章到站点（通过 SSH 推送文件）───

function slugify(title: string): string {
  return title.toLowerCase().trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface ArticlePayload {
  id: string;
  title: string;
  slug: string;
  content: string;
  category?: string;
  image?: string;
}

interface SiteConfig {
  site_path: string;
  site_type: string | null;
  data_js_path: string | null;
  article_var_name: string | null;
  article_html_pattern: string | null;
  domain: string;
}

export async function publishArticleToSite(
  article: ArticlePayload,
  site: SiteConfig
): Promise<{ success: boolean; url?: string; error?: string }> {
  let client: Client | null = null;
  try {
    client = await connectSSH();
    const sftp = await getSFTP(client);
    const siteRoot = site.site_path;
    const slug = article.slug || slugify(article.title);
    const dataJsPath = site.data_js_path || "js/articles-index.js";
    const varName = site.article_var_name || "articlesIndex";
    const fullDataPath = `${siteRoot}/${dataJsPath}`;

    // 1. 确保 js/articles 目录存在（存放 JSON 详情）
    const articlesDir = `${siteRoot}/js/articles`;
    await execCommand(client, `mkdir -p ${articlesDir} || sudo mkdir -p ${articlesDir}`);

    // 2. 写入文章 JSON 详情
    const articleJson = JSON.stringify({
      id: article.id,
      title: article.title,
      slug,
      content: article.content,
      category: article.category || "General",
      date: new Date().toLocaleDateString("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "short", day: "numeric" }),
    });
    await sftpWriteFile(sftp, `${articlesDir}/${article.id}.json`, articleJson);

    // 3. 更新数据索引文件（articles-index.js / main.js 等）
    let dataContent = "";
    try {
      dataContent = await sftpReadFile(sftp, fullDataPath);
    } catch {
      // 文件不存在，创建新的
      dataContent = `const ${varName} = [];\n`;
    }

    // 构建索引条目
    const indexEntry = {
      id: article.id,
      title: article.title,
      slug,
      categoryName: article.category || "General",
      date: new Date().toLocaleDateString("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "short", day: "numeric" }),
      excerpt: article.content.replace(/<[^>]*>/g, "").slice(0, 160) + "...",
      image: article.image || "",
    };

    // 解析现有数组并追加
    const arrayRegex = new RegExp(
      `(const|var|let)\\s+${varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*\\[`
    );
    const match = arrayRegex.exec(dataContent);

    if (match) {
      // 检查是否已存在同 id 的文章，先移除
      const entryRegex = new RegExp(
        `\\{[^}]*"id"\\s*:\\s*"${article.id}"[^}]*\\},?\\s*`,
        "g"
      );
      dataContent = dataContent.replace(entryRegex, "");

      // 在数组开头插入新条目
      const insertPos = (match.index || 0) + match[0].length;
      const entryStr = "\n  " + JSON.stringify(indexEntry) + ",";
      dataContent = dataContent.slice(0, insertPos) + entryStr + dataContent.slice(insertPos);
    } else {
      // 无法解析，重写整个文件
      dataContent = `const ${varName} = [\n  ${JSON.stringify(indexEntry)}\n];\n`;
    }

    await sftpWriteFile(sftp, fullDataPath, dataContent);

    // 4. CDN 缓存刷新（更新 HTML 中的 ?v=timestamp）
    const ts = String(Math.floor(Date.now() / 1000));
    const jsBasename = dataJsPath.split("/").pop() || "";
    const cacheRe = new RegExp(jsBasename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\?v=\\d+", "g");

    for (const htmlName of ["article.html", "articles.html", "index.html"]) {
      const htmlPath = `${siteRoot}/${htmlName}`;
      try {
        let html = await sftpReadFile(sftp, htmlPath);
        if (!html.includes(jsBasename)) continue;
        let newHtml: string;
        if (cacheRe.test(html)) {
          cacheRe.lastIndex = 0;
          newHtml = html.replace(cacheRe, `${jsBasename}?v=${ts}`);
        } else {
          newHtml = html
            .replace(`${jsBasename}"`, `${jsBasename}?v=${ts}"`)
            .replace(`${jsBasename}'`, `${jsBasename}?v=${ts}'`);
        }
        if (newHtml !== html) {
          await sftpWriteFile(sftp, htmlPath, newHtml);
        }
      } catch { /* skip */ }
    }

    // 5. 构建发布 URL
    const pattern = site.article_html_pattern || `article.html?title={slug}`;
    const articleUrl = `https://${site.domain}/${pattern.replace("{slug}", slug)}`;

    client.end();
    return { success: true, url: articleUrl };
  } catch (err) {
    client?.end();
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── 撤回文章（从站点移除）───
export async function unpublishArticleFromSite(
  articleId: string,
  site: { site_path: string; site_type: string | null; data_js_path: string | null; article_var_name: string | null; }
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

    // 2. 从索引文件中移除条目
    try {
      let dataContent = await sftpReadFile(sftp, fullDataPath);
      const entryRegex = new RegExp(
        `\\{[^}]*"id"\\s*:\\s*"${articleId}"[^}]*\\},?\\s*`,
        "g"
      );
      const newContent = dataContent.replace(entryRegex, "");
      if (newContent !== dataContent) {
        await sftpWriteFile(sftp, fullDataPath, newContent);
      }
    } catch { /* 索引文件可能不存在 */ }

    client.end();
    return { success: true };
  } catch (err) {
    client?.end();
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

