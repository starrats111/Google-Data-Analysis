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
    const normalizedKey = config.keyContent.replace(/\\n/g, '\n');
    privateKey = Buffer.from(normalizedKey);
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
}

interface SiteConfig {
  site_path: string;
  site_type: string | null;
  data_js_path: string | null;
  article_var_name: string | null;
  article_html_pattern: string | null;
  domain: string;
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
  const htmlPath = `${siteRoot}/${htmlFilename}`;

  // Always use index.html for template (correct site branding, not another post's theme)
  let templateHtml = "";
  try {
    templateHtml = await sftpReadFile(sftp, `${siteRoot}/index.html`);
  } catch { /* ignore */ }

  // Strip leading <h1> from article content to avoid duplicate title
  const cleanedContent = article.content.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/i, "").trim();

  let html: string;

  if (templateHtml) {
    const headMatch = templateHtml.match(/^[\s\S]*?<\/head>/i);
    let headSection = headMatch ? headMatch[0] : "";
    if (headSection) {
      headSection = headSection.replace(
        /<title>[^<]*<\/title>/i,
        `<title>${escapeHtml(article.title)}</title>`,
      );
      // Remove main.js to avoid loading article listing code on detail page
      headSection = headSection.replace(/<script[^>]*main\.js[^>]*><\/script>/gi, "");
    } else {
      headSection = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${escapeHtml(article.title)}</title>\n</head>`;
    }

    let headerNav = "";
    const headerMatch = templateHtml.match(/<header[\s\S]*?<\/header>/i);
    if (headerMatch) headerNav = headerMatch[0];

    let footer = "";
    const footerMatch = templateHtml.match(/<footer[\s\S]*?<\/footer>/i);
    if (footerMatch) footer = footerMatch[0];

    html = `${headSection}
<body>
  ${headerNav}
  <main style="max-width:800px;margin:40px auto;padding:0 20px;">
    <a href="/" style="color:#888;text-decoration:none;display:inline-block;margin-bottom:20px;">&larr; Back to articles</a>
    <article>
      <h1>${article.title}</h1>
      <div style="color:#888;margin-bottom:24px;font-size:14px;">${dateLabel}</div>
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
  <style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.8;color:#333}h1{font-size:2em}img{max-width:100%;height:auto}.meta{color:#888;margin-bottom:24px}a.back{color:#888;text-decoration:none}</style>
</head>
<body>
  <a class="back" href="/">&larr; Back</a>
  <h1>${article.title}</h1>
  <div class="meta">${dateLabel}</div>
  <div>${article.content}</div>
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
      const varMatch = content.match(
        /(?:const|var|let)\s+(articlesIndex|articles|posts|blogPosts|POSTS|articlesData)\s*=\s*\[/
      );
      if (!varMatch) continue;

      const hpVarName = varMatch[1];
      console.log(`[Publisher] 同步索引到首页文件: ${relPath} (var=${hpVarName})`);

      // 移除已有同 id 条目
      const removeRe = new RegExp(
        `\\{[^}]*"id"\\s*:\\s*"${articleId}"[^}]*\\},?\\s*`, "g"
      );
      content = content.replace(removeRe, "");

      // 在数组开头插入
      const arrRe = new RegExp(
        `(const|var|let)\\s+${hpVarName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*\\[`
      );
      const arrMatch = arrRe.exec(content);
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
  timeoutMs = 10000,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  for (const getReferer of REFERER_STRATEGIES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const referer = getReferer(imageUrl);
      const headers: Record<string, string> = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      };
      if (referer) headers["Referer"] = referer;

      const resp = await fetch(imageUrl, { headers, signal: controller.signal, redirect: "follow" });
      clearTimeout(timer);

      if (!resp.ok) continue;
      const ct = resp.headers.get("content-type") || "";
      if (!ct.startsWith("image/")) continue;

      const arrayBuf = await resp.arrayBuffer();
      if (arrayBuf.byteLength < 1024) continue;
      return { buffer: Buffer.from(arrayBuf), contentType: ct };
    } catch {
      continue;
    }
  }
  return null;
}

async function syncArticleImages(
  sftp: SFTPWrapper,
  client: Client,
  siteRoot: string,
  articleId: string,
  content: string,
): Promise<string> {
  const imagesDir = `${siteRoot}/images/articles`;
  await execCommand(client, `mkdir -p ${imagesDir} || sudo mkdir -p ${imagesDir}`);

  const imgRegex = /<img\s[^>]*?src=["']([^"']+)["'][^>]*?\/?>/gi;
  let match: RegExpExecArray | null;
  const matches: { fullTag: string; url: string }[] = [];

  while ((match = imgRegex.exec(content)) !== null) {
    const url = match[1];
    if (url.startsWith("http://") || url.startsWith("https://")) {
      if (!url.includes("images/articles/")) {
        matches.push({ fullTag: match[0], url });
      }
    }
  }

  if (matches.length === 0) return content;

  let updatedContent = content;
  let processed = 0;

  for (const { fullTag, url } of matches) {
    if (processed >= MAX_IMAGES) break;

    try {
      const result = await downloadImageWithRetry(url);
      if (!result) continue;

      const ext = result.contentType.includes("png") ? ".png"
        : result.contentType.includes("webp") ? ".webp"
        : result.contentType.includes("gif") ? ".gif"
        : ".jpg";

      const filename = `${articleId}_${processed}${ext}`;
      const remotePath = `${imagesDir}/${filename}`;

      await sftpWriteBuffer(sftp, remotePath, result.buffer);

      const localUrl = `images/articles/${filename}`;
      const newTag = fullTag.replace(url, localUrl);
      updatedContent = updatedContent.replace(fullTag, newTag);
      processed++;
    } catch (err) {
      console.warn(`[Publisher] 图片下载失败 (${url}):`, err);
    }
  }

  console.log(`[Publisher] 文章 ${articleId}: 本地化 ${processed}/${matches.length} 张图片`);
  return updatedContent;
}

function extractHeroImage(content: string): string {
  const match = content.match(/<img\s[^>]*?src=["']([^"']+)["']/i);
  return match ? match[1] : "";
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

    // ─── 图片本地化（v3.0）───
    let workingContent = article.content;
    let updatedContent: string | undefined;
    try {
      workingContent = await syncArticleImages(sftp, client, siteRoot, article.id, article.content);
      if (workingContent !== article.content) {
        updatedContent = workingContent;
      }
    } catch (err) {
      console.warn("[Publisher] 图片本地化失败（不阻塞发布）:", err);
    }

    // 提取 hero image（优先从本地化后的 content 中取）
    let heroImage = article.image || "";
    if (!heroImage) {
      heroImage = extractHeroImage(workingContent);
    }
    // 如果 hero image 已被本地化，使用本地化路径
    if (heroImage && updatedContent && !heroImage.startsWith("images/")) {
      const localizedHero = extractHeroImage(updatedContent);
      if (localizedHero && localizedHero.startsWith("images/")) {
        heroImage = localizedHero;
      }
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

    // 1. 确保 js/articles 目录存在（存放 JSON 详情）
    const articlesDir = `${siteRoot}/js/articles`;
    await execCommand(client, `mkdir -p ${articlesDir} || sudo mkdir -p ${articlesDir}`);

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
      dataContent = `const ${varName} = [];\n`;
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
      dataContent = `const ${varName} = [\n  ${JSON.stringify(indexEntry)}\n];\n`;
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

    // 3. 删除文章详情 HTML 页面
    if (slug) {
      const pattern = site.article_html_pattern || "article.html?title={slug}";
      const detailUrl = pattern.replace("{slug}", slug);
      if (!detailUrl.includes("?")) {
        const htmlPath = `${siteRoot}/${detailUrl}`;
        try {
          await new Promise<void>((resolve, reject) => {
            sftp.unlink(htmlPath, (err) => { if (err) reject(err); else resolve(); });
          });
        } catch { /* 文件可能不存在 */ }
      }
    }

    client.end();
    return { success: true };
  } catch (err) {
    client?.end();
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

