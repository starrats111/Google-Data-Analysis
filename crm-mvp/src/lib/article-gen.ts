/**
 * 文章 AI 生成服务（移植自 article_gen_service.py）
 * 支持商家推广文章生成、去 AI 味处理、链接后处理
 */
import { callAiWithFallback } from "@/lib/ai-service";
import { humanize } from "@/lib/humanizer";
import prisma from "@/lib/prisma";

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
  return null;
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
Based on the merchant website URL, generate promotional content. Year: ${year}.
Use the domain name to infer products, brand positioning, target audience.
Generate 5 article titles and 5 SEO keywords in ${langLabel}.

URL: ${url}
Domain: ${domain}
Brand guess: ${brandGuess}

JSON format:
{"brand_name":"Name","category":"travel","products":["p1"],"selling_points":["sp1"],
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

  const articleType = "review", articleLength = "medium";
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
   <img src="${images[0]}" alt="descriptive alt" style="width:100%;max-height:400px;object-fit:cover;border-radius:12px;margin:0 0 24px 0" />
2. BODY IMAGES: Insert ${Math.min(images.length - 1, 4)} more images evenly throughout the article between sections:
   <img src="URL" alt="descriptive alt" style="max-width:100%;border-radius:8px;margin:16px 0" />
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
JSON schema: {"content":"<full article HTML with h2/h3/p tags, 10-15 hyperlinks>","excerpt":"100-char plain text summary","meta_title":"SEO title","meta_description":"160-char description","meta_keywords":"comma separated","category":"one of: health,tech,lifestyle,fashion,beauty,fitness,food,travel,finance,general","author":"a realistic pen name matching the article language"}`;

  const keywordStr = keywords.length > 0 ? `\nSEO keywords (weave naturally): ${keywords.join(", ")}` : "";
  const userMsg = `Title: ${title}\nBrand: ${merchantName}\nProducts: ${products.join(", ")}\nSelling points: ${sellingPoints.join(", ")}\nPromo: \nLink: ${trackingLink}${keywordStr}`;

  try {
    const raw = await callAiWithFallback("article", [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMsg },
    ], 16384);

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
      // JSON 解析失败，尝试用正则提取 content 字段
      const fallbackContent = extractContentFallback(raw);
      if (fallbackContent) {
        result = { content: fallbackContent, excerpt: "", meta_title: title, meta_description: "", meta_keywords: title, category: "general" };
      } else {
        result = { content: `<p>${raw}</p>`, excerpt: raw.slice(0, 100), meta_title: title, meta_description: raw.slice(0, 160), meta_keywords: title, category: "general" };
      }
    }

    // 去 AI 味
    if (result.content) {
      result.content = humanize(result.content);
      result.content = ensureLinkCount(result.content, trackingLink, merchantName, products, keywords);
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
