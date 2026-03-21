/**
 * HTML 消毒工具 — 防止 XSS 攻击
 *
 * 用于 dangerouslySetInnerHTML 之前对内容进行清洗
 * 轻量级实现，不依赖 DOMPurify（可后续替换）
 */

// 允许的 HTML 标签白名单
const ALLOWED_TAGS = new Set([
  "p", "br", "b", "i", "u", "strong", "em", "s", "del",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li",
  "a", "img",
  "table", "thead", "tbody", "tr", "th", "td",
  "blockquote", "pre", "code",
  "div", "span",
  "hr",
]);

// 允许的属性白名单
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title", "target", "rel"]),
  img: new Set(["src", "alt", "width", "height", "loading"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
  "*": new Set(["class", "style"]),
};

// 危险的 CSS 属性
const DANGEROUS_CSS = /expression|javascript|vbscript|url\s*\(/gi;

/**
 * 清洗 HTML 内容，移除危险标签和属性
 */
export function sanitizeHtml(html: string): string {
  if (!html) return "";

  // 修复 AI 生成的脏内容（JSON 包裹等）
  let { cleaned: clean } = cleanArticleContent(html);

  // 移除 script 标签及内容
  clean = clean.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");

  // 移除 style 标签及内容
  clean = clean.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");

  // 移除事件处理器属性 (on*)
  clean = clean.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, "");

  // 移除 javascript: 协议
  clean = clean.replace(/href\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, 'href="#"');
  clean = clean.replace(/src\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, 'src=""');

  // 清洗 style 属性中的危险内容
  clean = clean.replace(/style\s*=\s*"([^"]*)"/gi, (match, style) => {
    if (DANGEROUS_CSS.test(style)) return "";
    return match;
  });

  // 移除不在白名单中的标签（保留内容）
  clean = clean.replace(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi, (match, tag) => {
    const tagLower = tag.toLowerCase();
    if (ALLOWED_TAGS.has(tagLower)) {
      // 对 a 标签强制添加 rel="noopener noreferrer" 和 target="_blank"
      if (tagLower === "a" && !match.startsWith("</")) {
        if (!match.includes("rel=")) {
          match = match.replace(">", ' rel="noopener noreferrer">');
        }
      }
      return match;
    }
    return ""; // 移除不允许的标签
  });

  return clean;
}

/**
 * 清洗 AI 生成的脏内容（JSON 包裹、转义符等），提取纯净 HTML
 * 用于修复数据库中已损坏的文章内容
 */
export function cleanArticleContent(raw: string): { cleaned: string; wasDirty: boolean } {
  if (!raw) return { cleaned: "", wasDirty: false };

  let content = raw;
  let wasDirty = false;

  // 去掉外层 <p>...</p> 包裹
  const stripped = content.replace(/^<p>\s*/i, "").replace(/\s*<\/p>\s*$/i, "");

  // 检测 JSON 包裹
  if (/(?:^|\s)_?json\s*\{/i.test(stripped) || /^\s*\{\s*"content"\s*:/i.test(stripped)) {
    wasDirty = true;

    // 方式1：尝试完整 JSON.parse
    try {
      const jsonStr = stripped.replace(/^_?json\s*/i, "");
      const obj = JSON.parse(jsonStr);
      if (obj.content) {
        content = obj.content;
        return { cleaned: content, wasDirty };
      }
    } catch { /* continue to regex fallback */ }

    // 方式2：正则提取 "content":"..." 字段值
    const contentMatch = stripped.match(new RegExp('"content"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', "s"));
    if (contentMatch) {
      content = contentMatch[1]
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "")
        .replace(/\\t/g, " ")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    } else {
      // 方式3：直接截取第一个 HTML 标签开始的部分
      const firstTag = stripped.search(/<(?:h[1-6]|p|div|img|article|section)\b/i);
      if (firstTag >= 0) {
        content = stripped.slice(firstTag);
        content = content.replace(/"\s*,\s*"(?:excerpt|meta_title|meta_description|meta_keywords|category|author)"[\s\S]*$/, "");
      }
    }
  }
  // 检测内容开头有非 HTML 文本垃圾
  else if (!/^\s*</.test(content)) {
    const firstTag = content.search(/<(?:h[1-6]|p|div|img|article|section)\b/i);
    if (firstTag > 0) {
      content = content.slice(firstTag);
      wasDirty = true;
    }
  }

  return { cleaned: content, wasDirty };
}

/**
 * 纯文本提取（移除所有 HTML 标签）
 */
export function stripHtml(html: string): string {
  if (!html) return "";
  return html.replace(/<[^>]*>/g, "").trim();
}
