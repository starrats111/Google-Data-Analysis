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

// 危险的 CSS 属性
const DANGEROUS_CSS = /expression|javascript|vbscript|url\s*\(/gi;

export const ARTICLE_HYPERLINK_CLASS = "crm-affiliate-link";
export const ARTICLE_HYPERLINK_INLINE_STYLE = [
  "color:#b42318 !important",
  "font-weight:700 !important",
  "text-decoration:underline !important",
  "text-decoration-thickness:2px",
  "text-underline-offset:3px",
  "background:linear-gradient(180deg,rgba(255,244,179,0) 0%,rgba(255,244,179,0.96) 100%) !important",
  "padding:0 0.18em",
  "border-radius:4px",
  "box-shadow:inset 0 -0.55em 0 rgba(255,244,179,0.96)",
].join(";") + ";";

export const ARTICLE_HYPERLINK_STYLE_BLOCK = `
.article-content a,
.${ARTICLE_HYPERLINK_CLASS} {
  color:#b42318 !important;
  font-weight:700 !important;
  text-decoration:underline !important;
  text-decoration-thickness:2px;
  text-underline-offset:3px;
  background:linear-gradient(180deg,rgba(255,244,179,0) 0%,rgba(255,244,179,0.96) 100%) !important;
  padding:0 0.18em;
  border-radius:4px;
  box-shadow:inset 0 -0.55em 0 rgba(255,244,179,0.96);
}
.article-content a:hover,
.${ARTICLE_HYPERLINK_CLASS}:hover {
  color:#8f1d15 !important;
  background:linear-gradient(180deg,rgba(255,230,109,0) 0%,rgba(255,230,109,1) 100%) !important;
}
`;

function escapeAttrValue(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function upsertAttr(
  attrs: string,
  attrName: string,
  nextValue: string,
  merge?: (current: string) => string,
): string {
  const re = new RegExp(`\\b${attrName}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const match = attrs.match(re);
  if (match) {
    const current = match[2] ?? match[3] ?? "";
    const value = merge ? merge(current) : nextValue;
    return attrs.replace(re, `${attrName}="${escapeAttrValue(value)}"`);
  }
  return `${attrs} ${attrName}="${escapeAttrValue(nextValue)}"`;
}

function mergeTokenAttr(current: string, required: string[]): string {
  const tokens = current.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  const merged = [...tokens];
  for (const token of required) {
    if (!merged.includes(token)) merged.push(token);
  }
  return merged.join(" ");
}

function mergeStyleAttr(current: string): string {
  const normalized = current.trim();
  if (normalized.includes("crm-affiliate-link") || normalized.includes("box-shadow:inset 0 -0.55em")) {
    return normalized;
  }
  if (!normalized) return ARTICLE_HYPERLINK_INLINE_STYLE;
  return `${normalized.replace(/;?\s*$/, ";")} ${ARTICLE_HYPERLINK_INLINE_STYLE}`;
}

export function emphasizeArticleHyperlinks(html: string): string {
  if (!html || !/<a\b/i.test(html)) return html;

  return html.replace(/<a\b([^>]*)>/gi, (_match, rawAttrs: string) => {
    let attrs = rawAttrs || "";
    attrs = upsertAttr(attrs, "class", ARTICLE_HYPERLINK_CLASS, (current) => mergeTokenAttr(current, [ARTICLE_HYPERLINK_CLASS]));
    attrs = upsertAttr(attrs, "target", "_blank");
    attrs = upsertAttr(attrs, "rel", "sponsored nofollow noopener noreferrer", (current) => mergeTokenAttr(current, ["sponsored", "nofollow", "noopener", "noreferrer"]));
    attrs = upsertAttr(attrs, "style", ARTICLE_HYPERLINK_INLINE_STYLE, mergeStyleAttr);
    return `<a${attrs}>`;
  });
}

export function needsArticleHyperlinkRefresh(html: string): boolean {
  return /<a\b/i.test(html || "") && !html.includes(ARTICLE_HYPERLINK_CLASS);
}

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
      return match;
    }
    return ""; // 移除不允许的标签
  });

  clean = emphasizeArticleHyperlinks(clean);

  return clean;
}

/**
 * 剥离推理模型的 reasoning 残留（<think>/<thinking>/<scratchpad>/<reasoning>/<reflection> 块）
 *
 * 背景（C-028）：DeepSeek-R1 / Gemini Thinking / 某些推理模型偶发会把 reasoning
 * 内容以 `<think>…</think>` 标签形式塞进 JSON 的 content 字段里。sanitizeHtml 的
 * 标签白名单只剥标签却保留内部文本，导致 `**Defining the Scope**` 这类 markdown
 * 字符原样泄漏到前端。这里统一把这些 reasoning 块（含内部文本）一次性删干净。
 *
 * 兼容：
 * - <think>…</think>、<thinking>…</thinking> 等闭合完整的情况
 * - 开头就是 `<think>`、但 AI 忘了写 `</think>`：从 `<think>` 删到第一个 HTML 块级标签前
 * - markdown fence 版本（```thinking … ```）
 */
const REASONING_TAG_NAMES = [
  "think",
  "thinking",
  "scratchpad",
  "reasoning",
  "reflection",
  "analysis",
  "plan",
];

export function stripReasoningArtifacts(raw: string): string {
  if (!raw || typeof raw !== "string") return raw || "";
  let text = raw;

  for (const tag of REASONING_TAG_NAMES) {
    // 1. 闭合完整：<tag …>…</tag>（包含可选属性 + 多行）
    const closedRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    text = text.replace(closedRe, "");

    // 2. 未闭合：开头直接 <tag>，但没有 </tag>
    //    只有当整段文本里有 <tag> 却没有 </tag> 时才兜底
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
    const closeRe = new RegExp(`<\\/${tag}>`, "gi");
    if (openRe.test(text) && !closeRe.test(text)) {
      // 从 <tag> 删到第一个 HTML 块级标签前（h1-h6 / p / article / section / div / img）
      text = text.replace(
        new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?=<(?:h[1-6]|p|article|section|div|img)\\b)`, "i"),
        "",
      );
      // 如果还没命中（没有任何 HTML 块），直接把 <tag> 开始到结尾全删（拒绝全 reasoning 的脏输出）
      text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "i"), "");
    }
  }

  // 3. markdown fence：```thinking … ``` / ```think … ```
  text = text.replace(/```(?:think|thinking|scratchpad|reasoning|reflection|analysis|plan)[\s\S]*?```/gi, "");

  return text.trim();
}

/**
 * 清洗 AI 生成的脏内容（JSON 包裹、转义符等），提取纯净 HTML
 * 用于修复数据库中已损坏的文章内容
 */
export function cleanArticleContent(raw: string): { cleaned: string; wasDirty: boolean } {
  if (!raw) return { cleaned: "", wasDirty: false };

  let content = raw;
  let wasDirty = false;

  // C-028：先剥掉 <think>/<thinking>/<scratchpad> 等 reasoning 残留，
  // 避免它们把后续 JSON 检测 / HTML 起始位置判断带偏。
  const deReasoned = stripReasoningArtifacts(content);
  if (deReasoned !== content) {
    content = deReasoned;
    wasDirty = true;
  }

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

/**
 * 将文章 HTML 中的外部图片 src 替换为经 image-proxy 代理的路径。
 * 用于文章预览渲染，绕过商家 CDN 的 geo-block / 热链保护。
 * 仅处理 http(s):// 开头的外部 URL，本地路径不变。
 */
export function proxifyImgSrcs(html: string): string {
  if (!html || !/<img\b/i.test(html)) return html;
  return html.replace(
    /(<img\b[^>]*?\s)src=(["'])(https?:\/\/[^"']+)\2/gi,
    (_match, prefix, _quote, src) => {
      const proxied = `/api/user/ad-creation/image-proxy?url=${encodeURIComponent(src)}`;
      return `${prefix}src="${proxied}"`;
    },
  );
}
