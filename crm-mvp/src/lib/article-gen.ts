/**
 * 文章 AI 生成服务（移植自 article_gen_service.py）
 * 支持商家推广文章生成、去 AI 味处理、链接后处理
 */
import { callAiWithFallback } from "@/lib/ai-service";
import { humanize } from "@/lib/humanizer";
import prisma from "@/lib/prisma";
import { emphasizeArticleHyperlinks, stripReasoningArtifacts } from "@/lib/sanitize";

const COUNTRY_LANG_MAP: Record<string, string> = {
  US: "English", UK: "English", CA: "English", AU: "English",
  DE: "German", FR: "French", JP: "Japanese", BR: "Portuguese",
  ES: "Spanish", IT: "Italian", NL: "Dutch", SE: "Swedish",
  NO: "Norwegian", DK: "Danish", FI: "Finnish", PL: "Polish",
  KR: "Korean", SG: "English", NZ: "English", AT: "German",
  CH: "German", BE: "French", IE: "English", PT: "Portuguese",
};

function extractJson(raw: string): string {
  let text = raw.trim();
  // 去除 markdown 代码块包裹
  if (text.startsWith("```")) {
    const nl = text.indexOf("\n");
    if (nl > 0) text = text.slice(nl + 1);
    if (text.trimEnd().endsWith("```")) text = text.trimEnd().slice(0, -3);
    text = text.trim();
  }
  // 去除常见 AI 前缀（如 _json、json 等）
  text = text.replace(/^_?json\s*/i, "");
  if (text[0] === "{" || text[0] === "[") return text;
  for (const [o, c] of [["{", "}"], ["[", "]"]]) {
    const i = text.indexOf(o);
    if (i >= 0) { const j = text.lastIndexOf(c); if (j > i) return text.slice(i, j + 1); }
  }
  return text;
}

/** 从 AI 原始响应中尽力提取 content 字段 */
/**
 * 某些 OpenAI 兼容 provider（尤其是新接入的模型）会把 SSE 流原样塞进 message.content 返回，
 * 形如 "      data: {\"choices\":[{\"delta\":{\"content\":\"...\"}}]}\n      data: [DONE]"。
 * 把这种字符串重组回原始文本。
 */
function tryParseSseStream(raw: string): string | null {
  if (!/^\s*data:\s*[\{\[]/m.test(raw)) return null;
  const lines = raw.split(/\r?\n/);
  let acc = "";
  let hits = 0;
  for (const line of lines) {
    const m = line.match(/^\s*data:\s*(.+?)\s*$/);
    if (!m) continue;
    const payload = m[1].trim();
    if (payload === "[DONE]") continue;
    try {
      const j = JSON.parse(payload);
      const piece =
        j?.choices?.[0]?.delta?.content ??
        j?.choices?.[0]?.message?.content ??
        "";
      if (typeof piece === "string" && piece) {
        acc += piece;
        hits++;
      }
    } catch {
      /* 单条无法解析跳过 */
    }
  }
  if (hits === 0 || !acc.trim()) return null;
  return acc.trim();
}

function extractContentFallback(raw: string): string | null {
  // 尝试匹配 "content":"..." 或 "content": "..."
  const m = raw.match(/"content"\s*:\s*"([\s\S]*?)"\s*[,}]/);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  // 如果内容中包含 HTML 标签，直接把 HTML 部分提取出来
  const htmlStart = raw.search(/<(?:h[1-6]|p|div|img|article)\b/i);
  if (htmlStart >= 0) {
    const htmlEnd = raw.lastIndexOf("</");
    if (htmlEnd > htmlStart) {
      const closeTag = raw.indexOf(">", htmlEnd);
      return raw.slice(htmlStart, closeTag >= 0 ? closeTag + 1 : undefined);
    }
    return raw.slice(htmlStart);
  }
  // C-028 v2：模型有时直接吐合法 markdown 文章而忘了包 JSON。
  // raw 已被 stripReasoningArtifacts 剥过 reasoning 块，且 API 层 (regenerate-clean-article)
  // 还会做第二道 isDirty 自检，所以这里只用长度阈值放过即可，避免因为标题写法不规整
  // （比如用 **xxx** 当伪标题而非 #）就把整篇文章丢掉。
  const trimmed = raw.trim();
  if (trimmed.length >= 800) {
    return simpleMarkdownToHtml(trimmed);
  }
  return null;
}

/**
 * 极简 markdown → HTML（仅覆盖文章常用结构，避免引入第三方依赖）
 * 仅用于 fallback：当 AI 直接吐 markdown 文章而非 JSON 时救场，否则文章会丢。
 */
function simpleMarkdownToHtml(md: string): string {
  const escapeAttr = (s: string) => s.replace(/"/g, "&quot;");
  const inline = (s: string): string => {
    let t = s;
    t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) =>
      `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" referrerpolicy="no-referrer" style="max-width:100%;border-radius:8px;margin:16px 0" loading="lazy" />`,
    );
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, url) =>
      `<a href="${escapeAttr(url)}" target="_blank" rel="noopener">${text}</a>`,
    );
    t = t.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
    t = t.replace(/`([^`\n]+)`/g, "<code>$1</code>");
    return t;
  };

  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let paraBuf: string[] = [];
  let listBuf: string[] = [];

  const flushPara = () => {
    if (paraBuf.length === 0) return;
    out.push(`<p>${inline(paraBuf.join(" ").trim())}</p>`);
    paraBuf = [];
  };
  const flushList = () => {
    if (listBuf.length === 0) return;
    out.push(`<ul>${listBuf.map((li) => `<li>${inline(li)}</li>`).join("")}</ul>`);
    listBuf = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      flushPara();
      flushList();
      const lvl = Math.min(h[1].length, 6);
      out.push(`<h${lvl}>${inline(h[2].trim())}</h${lvl}>`);
      continue;
    }
    const li = line.match(/^[-*]\s+(.+)$/);
    if (li) {
      flushPara();
      listBuf.push(li[1]);
      continue;
    }
    if (/^\s*<\/?(?:p|div|h[1-6]|img|ul|ol|li|a|strong|em|br|hr)\b/i.test(line)) {
      flushPara();
      flushList();
      out.push(line);
      continue;
    }
    paraBuf.push(line);
  }
  flushPara();
  flushList();
  return out.join("\n");
}

/** 分析商家 URL，推断品牌/品类/关键词/标题 */
export async function analyzeUrl(
  url: string,
  language = "en",
): Promise<{
  brandName: string; category: string; products: string[];
  sellingPoints: string[]; titles: { title: string; titleEn: string }[];
  keywords: string[];
}> {
  let domain: string;
  try { domain = new URL(url).hostname.replace("www.", ""); } catch { domain = url; }
  const brandGuess = domain.split(".")[0].charAt(0).toUpperCase() + domain.split(".")[0].slice(1);
  const langLabel = COUNTRY_LANG_MAP[language.toUpperCase()] || language;
  const year = new Date().getFullYear();

  const prompt = `You are a JSON API. Respond with ONLY a valid JSON object.
Based on the merchant website URL, infer the brand category and generate article titles and SEO keywords in ${langLabel}. Year: ${year}.

CRITICAL RULES:
- For "products": Only include product category names (e.g. "travel packages", "running shoes"). Do NOT invent specific product names or models that you cannot verify exist.
- For "selling_points": Use only general, verifiable selling points based on the brand category (e.g. "Wide selection", "Online shopping"). Do NOT fabricate specific claims like "50% off" or "Free shipping" unless you are certain they exist.
- Do NOT include any specific discount percentages, prices, or promotional claims.

URL: ${url}
Domain: ${domain}
Brand guess: ${brandGuess}

JSON format:
{"brand_name":"Name","category":"travel","products":["product category 1"],"selling_points":["general selling point"],
"titles":[{"title":"Title in ${langLabel}","title_en":"English translation"}],
"keywords":["kw1","kw2","kw3","kw4","kw5"]}`;

  try {
    const raw = await callAiWithFallback("article", [{ role: "user", content: prompt }], 4096);
    const result = JSON.parse(extractJson(raw));
    return {
      brandName: result.brand_name || brandGuess,
      category: result.category || "general",
      products: result.products || [],
      sellingPoints: result.selling_points || [],
      titles: (result.titles || []).map((t: any) => ({ title: t.title || "", titleEn: t.title_en || "" })),
      keywords: result.keywords || [brandGuess],
    };
  } catch (err) {
    console.error("[analyzeUrl] 失败:", err);
    return {
      brandName: brandGuess, category: "general", products: [], sellingPoints: [],
      titles: Array.from({ length: 5 }, (_, i) => ({ title: `${brandGuess} Review ${i + 1}`, titleEn: `${brandGuess} Review ${i + 1}` })),
      keywords: [brandGuess, "shopping", "deals", "review", "best"],
    };
  }
}

/** 生成商家推广文章（对齐数据分析平台 article_gen_service.py 的质量标准） */
export async function generateMerchantArticle(params: {
  title: string;
  merchantName: string;
  merchantUrl: string;
  trackingLink: string;
  country: string;
  products?: string[];
  sellingPoints?: string[];
  keywords?: string[];
  images?: string[];
  userId?: bigint;
}): Promise<{
  content: string; excerpt: string; metaTitle: string;
  metaDescription: string; metaKeywords: string; category: string;
}> {
  const { title, merchantName, trackingLink, country, products = [], sellingPoints = [], keywords = [], images = [] } = params;
  const langLabel = COUNTRY_LANG_MAP[country.toUpperCase()] || "English";
  const year = new Date().getFullYear();

  const articleType = "review", articleLength: string = "medium";
  const seoFocus: string[] = [], extraPrompt = "";

  const wordCount = articleLength === "short" ? "500-800" : articleLength === "long" ? "1500-2000" : "1000-1500";

  // 构建链接词列表：品牌名 + 产品名 + 关键词 → 都要做超链接
  const linkWords = [merchantName];
  for (const p of products) {
    if (p && p.toLowerCase() !== merchantName.toLowerCase()) linkWords.push(p);
  }
  for (const kw of keywords) {
    if (kw && !linkWords.some((w) => w.toLowerCase() === kw.toLowerCase())) linkWords.push(kw);
  }
  const linkExamples = linkWords.slice(0, 6).map((w) => `<a href="${trackingLink}">${w}</a>`).join(", ");

  // 构建图片嵌入指令
  const imageInstruction = images.length > 0
    ? `\n【Image Rules — CRITICAL】
You MUST insert images into the article HTML. Available images:${images.slice(0, 8).map((url, i) => `\n${i + 1}. ${url}`).join("")}

Rules:
1. HERO IMAGE: The FIRST image MUST be placed right after the article title (before the first paragraph) as a hero/banner image. Use full width:
   <img src="${images[0]}" alt="descriptive alt" referrerpolicy="no-referrer" style="width:100%;max-height:400px;object-fit:cover;border-radius:12px;margin:0 0 24px 0" />
2. BODY IMAGES: Insert ${Math.min(images.length - 1, 4)} more images evenly throughout the article between sections:
   <img src="URL" alt="descriptive alt" referrerpolicy="no-referrer" style="max-width:100%;border-radius:8px;margin:16px 0" />
3. Use ALL ${Math.min(images.length, 5)} of the first images. Do NOT skip any.
4. Every <img> tag must have a meaningful alt attribute describing the image content.`
    : "";

  const systemPrompt = `You are an experienced lifestyle content editor writing a soft-promotion article in ${langLabel}. Year: ${year}.

【Core Principles — MUST follow】
1. AUTHENTICITY FIRST: Write like a real human editor, NOT an AI. Use personal anecdotes, first-person perspective, casual observations, and genuine opinions. Imagine you are recommending something to a friend over coffee.
2. SOFT PLACEMENT: The brand should be woven in naturally — like a friend mentioning a product they genuinely like. NEVER open the article with the brand name. The brand should NOT appear in the first paragraph at all. Introduce it casually mid-article.
3. FACTUAL ACCURACY: Product names, features, and prices must match the merchant website.
4. NO HARD SELL: No advertising tone, no hype, no pressure language.

【BANNED words/phrases — NEVER use these】
revolutionizing, game-changer, elevate, seamlessly, cutting-edge, delve, comprehensive, landscape, foster, leverage, harness, robust, streamline, empower, curated, innovative, transformative, groundbreaking, it is worth noting, in today's world, without a doubt, needless to say, in conclusion, to sum up, furthermore, moreover, incredibly, absolutely, undoubtedly, embark, navigate, realm, pivotal, testament, beacon, tapestry, multifaceted, holistic, synergy, paradigm, ecosystem

【Link Rules — CRITICAL】
Tracking link (use this for ALL hyperlinks): ${trackingLink}
Link method:
- Brand name link: use brand name as anchor text → <a href="${trackingLink}">${merchantName}</a>
- Product name link: use product name as anchor text
- Category/keyword link: use the keyword as anchor text
- Examples: ${linkExamples}
- TOTAL hyperlinks in the article: 10-15 (spread evenly across the article, not clustered)
- Every mention of the brand name, product names, and related keywords should be hyperlinked
- All links point to the SAME tracking URL above
${imageInstruction}
【Article Requirements】
- Type: ${articleType}
- Length: ${wordCount} words (comprehensive article)
- Language: ${langLabel}
- Category: judge based on the merchant's business (fashion/health/home/travel/finance/food/beauty/tech/lifestyle)
- Structure: HTML with h2 headings, 4-6 sections, use <p> tags
- Writing style: editor perspective, personal stories, conversational language, genuine views
- DO NOT start with the brand. Start with a relatable scenario, personal experience, or observation.
- DO NOT use consecutive paragraphs that all mention the brand.
${seoFocus.length > 0 ? `- SEO focus: ${seoFocus.join(", ")}` : ""}
${extraPrompt ? `- Additional instructions: ${extraPrompt}` : ""}

CRITICAL: Output ONLY raw JSON, no markdown, no explanation, no preamble.
Do NOT say 'I will write' or 'Let me create'. Start directly with {.
Do NOT include <think>, <thinking>, <scratchpad>, <reasoning>, <reflection>, <analysis>, <plan>, or ANY internal reasoning tags / tool-call blocks / chain-of-thought prefix. No **bold headers** summarizing your plan. Output the JSON object only.
JSON schema: {"content":"<full article HTML with h2/h3/p tags, 10-15 hyperlinks>","excerpt":"100-char plain text summary","meta_title":"SEO title","meta_description":"160-char description","meta_keywords":"comma separated","category":"one of: health,tech,lifestyle,fashion,beauty,fitness,food,travel,finance,general","author":"a realistic pen name matching the article language"}`;

  const keywordStr = keywords.length > 0 ? `\nSEO keywords (weave naturally): ${keywords.join(", ")}` : "";
  const userMsg = `Title: ${title}\nBrand: ${merchantName}\nProducts: ${products.join(", ")}\nSelling points: ${sellingPoints.join(", ")}\nPromo: \nLink: ${trackingLink}${keywordStr}`;

  try {
    let rawOriginal = await callAiWithFallback("article", [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg },
    ], 16384);

    // C-028 v3：部分 OpenAI 兼容 provider 把 SSE 流原样塞进 message.content 返回。
    // 在剥 reasoning 之前先识别并聚合 SSE 流，避免后续所有解析步骤都拿到 "data: {…}" 残骸。
    const sseAssembled = tryParseSseStream(rawOriginal);
    if (sseAssembled) {
      console.warn(`[generateMerchantArticle] 检测到 provider 把 SSE 流当 content 返回，已聚合（原 ${rawOriginal.length} 字 → ${sseAssembled.length} 字）`);
      rawOriginal = sseAssembled;
    }

    // C-028：AI 返回后、解析之前，先剥掉 <think>/<thinking>/<scratchpad> 等推理残留，
    // 避免这些标签把 JSON 包在外面、或被 extractJson 当成合法 content 吞进去。
    const raw = stripReasoningArtifacts(rawOriginal);
    if (raw !== rawOriginal) {
      console.warn(`[generateMerchantArticle] 检测并剥离 AI reasoning 残留（原 ${rawOriginal.length} 字 → ${raw.length} 字）`);
    }

    let result: any;
    try {
      const jsonStr = extractJson(raw);
      // 修复 JSON 中的字面换行符
      const fixedJson = jsonStr.replace(/(?<=":)\s*"([\s\S]*?)(?<!\\)"\s*(?=[,}])/g, (_, val) => {
        return `"${val.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
      });
      try {
        result = JSON.parse(fixedJson);
      } catch {
        result = JSON.parse(jsonStr);
      }
    } catch {
      // JSON 解析失败：尝试用正则提取 content 字段；仍失败则 throw，
      // 绝不把 raw 整段当成品落盘（C-028：老版本 <p>${raw}</p> fallback 会把
      // reasoning 写进 DB，导致前端看到 **Defining the Scope** 等脏字符）。
      const fallbackContent = extractContentFallback(raw);
      if (fallbackContent) {
        const plain = fallbackContent.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const excerpt = plain.slice(0, 200);
        const metaDesc = plain.slice(0, 160);
        console.warn(`[generateMerchantArticle] JSON parse 失败，已用 fallback 抢救 content（${fallbackContent.length} 字）`);
        result = { content: fallbackContent, excerpt, meta_title: title, meta_description: metaDesc, meta_keywords: title, category: "general" };
      } else {
        console.error(`[generateMerchantArticle] AI 返回无法解析为 JSON，也无法回退出 content 字段。head=${raw.slice(0, 200)}`);
        throw new Error("AI 返回内容无法解析为合法 JSON，拒绝落盘");
      }
    }

    // C-028：对 content/excerpt/meta_* 字段统一再过一遍 reasoning 剥离器
    // （有些模型把 <think> 嵌在 JSON 的 content 字段内部，JSON.parse 能成功但 content 已污染）
    for (const key of ["content", "excerpt", "meta_title", "meta_description"] as const) {
      if (typeof result[key] === "string" && result[key]) {
        const cleaned = stripReasoningArtifacts(result[key]);
        if (cleaned !== result[key]) {
          console.warn(`[generateMerchantArticle] 字段 ${key} 检测到 reasoning 残留，已清洗（原 ${result[key].length} 字 → ${cleaned.length} 字）`);
          result[key] = cleaned;
        }
      }
    }

    // 去 AI 味 + 用共享布局工具插入图片
    if (result.content) {
      result.content = humanize(result.content);
      result.content = ensureLinkCount(result.content, trackingLink, merchantName, products, keywords);
      result.content = emphasizeArticleHyperlinks(result.content);

      const { buildDefaultArticleImageLayout, rebuildArticleContentWithLayout, normalizeArticleImageList } = await import("@/lib/article-image-layout");
      const normalizedImages = normalizeArticleImageList(images);
      if (normalizedImages.length > 0) {
        const layout = buildDefaultArticleImageLayout(result.content, normalizedImages.slice(0, 5));
        result.content = rebuildArticleContentWithLayout(result.content, layout, title);
      }
    }

    return {
      content: result.content || "",
      excerpt: result.excerpt || "",
      metaTitle: result.meta_title || title,
      metaDescription: result.meta_description || "",
      metaKeywords: result.meta_keywords || "",
      category: result.category || "general",
    };
  } catch (err) {
    console.error("[generateMerchantArticle] 失败:", err);
    throw err;
  }
}

/**
 * 将文章中的图片重新均匀分布到各段落之间。
 * 第一张图保持为 hero image（标题后），其余图片按等间距插入到段落间。
 */
function buildImageTag(src: string, alt: string, isHero: boolean): string {
  const safeAlt = alt.replace(/"/g, "&quot;");
  // C-028：外链图（如 aerosus.be）常开启 hotlink / referer 保护，
  // 加 referrerpolicy="no-referrer" 后，浏览器不发送 Referer，可绕过绝大多数
  // 图床的跨域图片防盗链；对自家 /api/user/ad-creation/upload-image 也无负面影响。
  return isHero
    ? `<img src="${src}" alt="${safeAlt}" referrerpolicy="no-referrer" style="width:100%;max-height:400px;object-fit:cover;border-radius:12px;margin:0 0 24px 0" loading="lazy" />`
    : `<img src="${src}" alt="${safeAlt}" referrerpolicy="no-referrer" style="max-width:100%;border-radius:8px;margin:16px 0" loading="lazy" />`;
}

function ensureImagesPresent(html: string, images: string[], merchantName: string, title: string): string {
  if (!html || images.length === 0) return html;

  const imgRegex = /<img\s[^>]*?\/?>/gi;
  const existingCount = [...html.matchAll(imgRegex)].length;
  if (existingCount > 0) return html;

  const usableImages = images
    .filter((url) => typeof url === "string" && /^https?:\/\//i.test(url))
    .slice(0, 5);
  if (usableImages.length === 0) return html;

  const blocks = html.match(/(<(?:h[1-6]|p|div|ul|ol|blockquote|table|figure|section)[\s>][\s\S]*?<\/(?:h[1-6]|p|div|ul|ol|blockquote|table|figure|section)>)/gi) || [];
  if (blocks.length === 0) {
    return `${buildImageTag(usableImages[0], `${merchantName} featured image`, true)}\n${html}`;
  }

  const heroAlt = `${merchantName} featured image for ${title}`;
  const bodyImages = usableImages.slice(1);
  let result = "";
  let cursor = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const start = html.indexOf(block, cursor);
    if (start < 0) continue;
    const end = start + block.length;
    result += html.slice(cursor, end);
    cursor = end;

    if (i === 0) {
      result += `\n${buildImageTag(usableImages[0], heroAlt, true)}`;
    }
  }

  result += html.slice(cursor);

  if (bodyImages.length === 0) {
    return result;
  }

  const redistributed = `${result}\n${bodyImages.map((src, index) => buildImageTag(src, `${merchantName} article image ${index + 1}`, false)).join("\n")}`;
  return redistributed;
}

function redistributeImages(html: string): string {
  const imgRegex = /<img\s[^>]*?\/?>/gi;
  const allImages = [...html.matchAll(imgRegex)].map((m) => m[0]);
  if (allImages.length <= 1) return html;

  // 移除所有图片
  let cleaned = html.replace(imgRegex, "");
  // 清理移除图片后产生的连续空行
  cleaned = cleaned.replace(/(<\/(?:p|div|section)>)\s*(<(?:p|div|section)[\s>])/gi, "$1\n$2");

  // 按段落级元素分割（h2/h3/p/div/ul/ol/blockquote/table/figure）
  const blockRegex = /(<(?:h[1-6]|p|div|ul|ol|blockquote|table|figure|section)[\s>][\s\S]*?<\/(?:h[1-6]|p|div|ul|ol|blockquote|table|figure|section)>)/gi;
  const blocks = [...cleaned.matchAll(blockRegex)].map((m) => m[0]);
  if (blocks.length === 0) return html;

  const heroImg = allImages[0];
  const bodyImages = allImages.slice(1);

  if (bodyImages.length === 0) {
    // 只有 hero 图：放在第一个块之后
    const firstBlockEnd = cleaned.indexOf(blocks[0]) + blocks[0].length;
    return cleaned.slice(0, firstBlockEnd) + "\n" + heroImg + cleaned.slice(firstBlockEnd);
  }

  // 计算 body 图片的插入位置：均匀分布在所有块之间
  // 跳过第一个块（hero 图会放在它后面），从第二个块开始计算分布
  const availableSlots = blocks.length - 1; // 第一个块之后到最后一个块之间的间隙数
  const insertPositions: number[] = [];

  for (let i = 0; i < bodyImages.length; i++) {
    // 均匀映射：将 bodyImages[i] 映射到 blocks 间隙中
    const pos = Math.round(((i + 1) * availableSlots) / (bodyImages.length + 1));
    insertPositions.push(pos);
  }

  // 重建 HTML：逐块拼接，在合适的位置插入图片
  let result = "";
  let searchFrom = 0;

  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    const blockStart = cleaned.indexOf(blocks[blockIdx], searchFrom);
    // 保留块前面的内容（空白、注释等）
    result += cleaned.slice(searchFrom, blockStart + blocks[blockIdx].length);
    searchFrom = blockStart + blocks[blockIdx].length;

    // 在第一个块后面插入 hero 图
    if (blockIdx === 0) {
      result += "\n" + heroImg;
    }

    // 检查是否需要在这个间隙插入 body 图片
    for (let imgIdx = 0; imgIdx < bodyImages.length; imgIdx++) {
      if (insertPositions[imgIdx] === blockIdx + 1) {
        result += "\n" + bodyImages[imgIdx];
      }
    }
  }

  // 拼接剩余内容
  result += cleaned.slice(searchFrom);
  return result;
}

/** 确保文章中超链接数量在 10-15 之间 */
function ensureLinkCount(
  content: string, trackingLink: string, brand: string,
  products: string[], keywords: string[],
  minLinks = 10, maxLinks = 15,
): string {
  const linkRegex = /<a\s+[^>]*href=["'][^"']*["'][^>]*>([^<]+)<\/a>/gi;
  const existing = [...content.matchAll(linkRegex)];
  let count = existing.length;

  if (count >= minLinks) return content;

  // 补充链接
  const candidates = [brand, ...products, ...keywords].filter(Boolean);
  const linkedTexts = new Set(existing.map((m) => m[1].toLowerCase()));
  let result = content;
  let added = 0;
  const needed = minLinks - count;

  for (const word of candidates) {
    if (added >= needed) break;
    if (linkedTexts.has(word.toLowerCase())) continue;

    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<!</a>)(?<!["\'>])\\b(${escaped})\\b(?![^<]*</a>)`, "i");
    const match = pattern.exec(result);
    if (match) {
      const replacement = `<a href="${trackingLink}">${match[1]}</a>`;
      result = result.slice(0, match.index) + replacement + result.slice(match.index + match[0].length);
      added++;
      linkedTexts.add(word.toLowerCase());
    }
  }

  return result;
}
