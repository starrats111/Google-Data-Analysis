/**
 * 统一爬取管线 — 一次爬取，缓存复用
 * 被 merchants/route.ts（认领时缓存）和 generate-extensions/route.ts（AI 生成时读取）共用
 */
import {
  crawlPage, fetchUrlMeta, fetchPageImages, searchMerchantImages, crawlViaSitemap,
  batchFetchMetaViaPuppeteer, crawlWithPuppeteerFull, crawlPageWithPuppeteer,
  extractLinksAndImages, assessCrawlQuality, isQualityImageUrl,
  harvestImagesFromPagesWithPuppeteer, getAcceptLanguage,
} from "@/lib/crawler";
import { getAdMarketConfig } from "@/lib/ad-market";
import { getProxyUrlForCountry, getHttpProxyUrlForCountry } from "@/lib/crawl-proxy";
import { isLowValueSitelink } from "@/lib/sitelink-filter";
// C-016: ccTLD 切换逻辑移出 crawl-pipeline，改由 country-url-resolver 在 route 层调度

// 全局爬取并发控制：最多 2 个同时执行
let _crawlActive = 0;
const MAX_CONCURRENT_CRAWLS = 2;

async function acquireCrawlSlot(): Promise<void> {
  while (_crawlActive >= MAX_CONCURRENT_CRAWLS) {
    await new Promise(r => setTimeout(r, 1000));
  }
  _crawlActive++;
}

function releaseCrawlSlot(): void {
  _crawlActive = Math.max(0, _crawlActive - 1);
}

// ─── 类型定义 ───

export interface CrawledProduct {
  name: string;
  url: string;
  price?: number;
  currency?: string;
  description?: string;
  imageUrl?: string;
}

/** 从完整 HTML 直接采集的原始文字片段，按类型分桶，供 AI 润色时用作 grounding 数据 */
export interface RawMentions {
  promo: string[];    // 促销原文（含百分比折扣/首单/注册优惠等）
  shipping: string[]; // 物流/售后原文（免运费/免费退换等）
  features: string[]; // 品牌/商家特性原文（工艺/产地/认证等）
}

export interface CrawlCache {
  links: { url: string; text: string }[];
  images: string[];
  pageText: string;
  features: string[];
  navItems: string[];
  phoneCandidates: { country_code: string; phone_number: string }[];
  sitelinkCandidates: { url: string; title: string; description: string }[];
  semrushTitles: string[];
  semrushDescriptions: string[];
  promoRegex: Record<string, unknown> | null;
  priceRegex: { header: string; description: string; price: number; currency: string; url: string }[];
  crawledProducts: CrawledProduct[];
  crawledAt: string;
  crawlMethod: string;
  crawlFailed: boolean;
  localizedMerchantUrl?: string;
  // C-016: resolvedMerchantUrl 已废弃 — ccTLD 切换由 country-url-resolver 在 route 层完成
  crawlQualityScore?: number;    // 0-100，本次爬取质量评分
  crawlQualityIssues?: string[]; // 质量问题标签，如 ['no_links','splash_page']
  rawMentions?: RawMentions;     // 全量 HTML 直接提取的原文片段，不依赖 htmlToText 管道
  /** 从爬取 HTML lang 属性或本地化 URL 检测到的实际语言 code（如 "nl", "fr", "en"），优先于国家默认语言 */
  detectedLanguageCode?: string;
  /**
   * C-014 §3：Puppeteer 从真实 DOM（扩容后的选择器）抽取的导航链接。
   * 与 `navItems`（纯文字数组，用于 Structured Snippet）不同，这里是 { url, text } 对，
   * 供 `discoverSitelinkCandidates` 作为 Sitelinks 候选来源之一。
   */
  navLinks?: { url: string; text: string }[];
}

// ─── 共享常量和工具函数 ───

const BAD_SITELINK_PATTERNS = [
  /\/httpservice\//i, /\/enablejs/i, /\/cdn-cgi\//i, /\/captcha/i,
  /\/turnstile\//i, /\/bot-check/i, /\/challenge[\/\?]/i, /[\?&]__cf_chl/i,
  /\/human-verification/i, /\/verify\?/i, /\/consent\//i, /\/cookie-consent/i,
  /\/(login|signup|register|cart|checkout|account|wishlist|password|privacy|terms|imprint|impressum|datenschutz|agb|cookie-policy|unsubscribe)\b/i,
];

export function isBadSitelinkUrl(url: string): boolean {
  if (BAD_SITELINK_PATTERNS.some((p) => p.test(url))) return true;
  const lower = url.toLowerCase();
  if (lower.includes("/search?q=cache:") || lower.includes("webcache.googleusercontent.com")) return true;
  if (/google\.\w+\/search/i.test(url) || /bing\.com\/search/i.test(url)) return true;
  // C-016: 非页面资源（sitemap 索引、静态资源、媒体文件）禁用为 sitelink
  try {
    const pathname = new URL(url).pathname;
    if (/\.(xml|xml\.gz|txt|gz|pdf|jpe?g|png|gif|webp|svg|ico|css|js|zip|tar|mp4|mp3|woff2?)$/i.test(pathname)) return true;
  } catch {
    return false;
  }
  return false;
}

export function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&apos;/gi, "'")
    .replace(/&ndash;/gi, "\u2013").replace(/&mdash;/gi, "\u2014").replace(/&nbsp;/gi, " ")
    .replace(/&laquo;/gi, "\u00AB").replace(/&raquo;/gi, "\u00BB")
    .replace(/&copy;/gi, "\u00A9").replace(/&reg;/gi, "\u00AE").replace(/&trade;/gi, "\u2122")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function smartTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.5) return truncated.slice(0, lastSpace).replace(/[,.\-\u2013\u2014:;]+$/, "").trim();
  return truncated.replace(/[,.\-\u2013\u2014:;\s]+$/, "").trim();
}

const BLOCKED_PAGE_TITLES = [
  "just a moment", "attention required", "access denied",
  "you have been blocked", "security check", "checking your browser",
  "please wait", "one moment", "verify you are human",
  "un instant", "einen moment", "bot verification",
  "ddos protection", "pardon our interruption",
];

export function isBlockedTitle(title: string): boolean {
  const t = title.toLowerCase().replace(/[.\u2026]+$/, "").trim();
  return BLOCKED_PAGE_TITLES.some((b) => t.includes(b) || t === b);
}

export function titleFromUrlPath(url: string): string {
  try {
    const segments = new URL(url).pathname
      .replace(/\.(html?|php|aspx?)$/i, "")
      .split("/").filter(Boolean)
      .filter((s) => s.length > 1);
    if (segments.length === 0) return "";
    const raw = segments
      .map((s) => decodeURIComponent(s).replace(/[-_+]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
      .join(" ").slice(0, 25);
    return sanitizeAdText(raw);
  } catch { return ""; }
}

/**
 * Google Ads 文案规范化：修复大写、标点、符号问题
 * - 全大写 → Title Case（除品牌名）
 * - 移除多余标点（!!!, ???, ...）
 * - 移除感叹号（Google Ads sitelink 不允许）
 * - 移除开头/结尾的多余标点
 */
export function sanitizeAdText(text: string, opts?: { allowExclamation?: boolean }): string {
  let s = text.trim();
  if (!s) return s;

  // 修复全大写：如果超过 50% 是大写字母，转为 Title Case
  const letters = s.replace(/[^a-zA-Z]/g, "");
  if (letters.length >= 3) {
    const upperCount = (s.match(/[A-Z]/g) || []).length;
    if (upperCount / letters.length > 0.5) {
      s = s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }

  // 移除多余/重复标点
  s = s.replace(/([!?.])\1+/g, "$1");     // "!!!" → "!"  "???" → "?"
  s = s.replace(/[!?]{2,}/g, "!");         // "!?" → "!"
  s = s.replace(/\.{2,}/g, "…");           // ".." → "…"

  // sitelink 标题中不允许感叹号（Google Ads 政策）
  if (!opts?.allowExclamation) {
    s = s.replace(/!/g, "");
  }

  // 移除开头/结尾的多余标点符号
  s = s.replace(/^[.,;:!?\-–—]+\s*/, "").replace(/\s*[.,;:!?\-–—]+$/, "");

  // 清理多余空格
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

export function extractJsonFromAi(raw: string): string {
  let text = raw.trim();
  if (text.startsWith("```")) {
    const nl = text.indexOf("\n");
    if (nl > 0) text = text.slice(nl + 1);
    if (text.trimEnd().endsWith("```")) text = text.trimEnd().slice(0, -3);
    text = text.trim();
  }
  // 不做早返回：即使文本以 { 或 [ 开头，AI 也可能在 JSON 后追加说明文字，
  // 必须始终用 lastIndexOf 定位最后一个合法闭括号并裁切，避免 JSON.parse 报
  // "Unexpected non-whitespace character after JSON at position N"。
  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    const idx = text.indexOf(open);
    if (idx >= 0) {
      const ridx = text.lastIndexOf(close);
      if (ridx > idx) return text.slice(idx, ridx + 1);
    }
  }
  return text;
}

export function extractMerchantFeatures(html: string, extraFeatures?: string[]): string[] {
  const features: string[] = [];
  const lower = html.toLowerCase();

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch?.[1]) features.push(`Page title: ${decodeHtmlEntities(titleMatch[1].trim())}`);
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)
    || html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']description["']/i);
  if (descMatch?.[1]) features.push(`Meta description: ${decodeHtmlEntities(descMatch[1].trim())}`);

  const featurePatterns: { pattern: RegExp; label: string }[] = [
    { pattern: /free\s*shipping|free\s*deliver|kostenlos(?:e|er)?\s+versand|livraison\s+offerte|env[ií]o\s+gratis|spedizione\s+gratuita/i, label: "Free Shipping" },
    { pattern: /(\d+)[%\s-]*day[s]?\s*(return|refund|money.back)|rückgabe|retour|retours|devoluci|resi/i, label: "Return/Refund Policy" },
    { pattern: /money[- ]?back\s*guarantee/i, label: "Money-Back Guarantee" },
    { pattern: /satisfaction\s*guarantee/i, label: "Satisfaction Guaranteed" },
    { pattern: /price\s*match/i, label: "Price Match" },
    { pattern: /(\d+)\s*%\s*off/i, label: "Discount Available" },
    { pattern: /24\s*\/?\s*7/i, label: "24/7 Service" },
    { pattern: /same[- ]?day\s*(shipping|dispatch)/i, label: "Same-Day Shipping" },
    { pattern: /next[- ]?day\s*(shipping|deliver)/i, label: "Next-Day Delivery" },
    { pattern: /award[- ]?winning/i, label: "Award-Winning" },
    { pattern: /hand[- ]?(made|crafted)/i, label: "Handcrafted" },
    { pattern: /organic|natural/i, label: "Organic/Natural" },
    { pattern: /sustainab|eco[- ]?friend/i, label: "Sustainable/Eco-Friendly" },
    { pattern: /made\s*in\s*(the\s*)?(usa|america|uk|europe|france|germany|italy|japan)/i, label: "Made In Origin" },
    { pattern: /family[- ]?owned/i, label: "Family-Owned" },
    { pattern: /since\s*\d{4}/i, label: "Established Brand" },
    { pattern: /best\s*seller/i, label: "Best Sellers" },
    { pattern: /loyalty\s*(program|reward)/i, label: "Loyalty Program" },
    { pattern: /gift\s*card/i, label: "Gift Cards Available" },
    { pattern: /wholesale/i, label: "Wholesale Available" },
  ];

  const found: string[] = [];
  for (const { pattern, label } of featurePatterns) {
    if (pattern.test(lower)) found.push(label);
  }
  if (found.length > 0) features.push(`Detected features: ${found.join(", ")}`);

  const bannerRegex = /<(?:div|span|p|a)[^>]*class=["'][^"']*(?:banner|announcement|promo|hero|notice|topbar|top-bar)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p|a)>/gi;
  let bannerMatch;
  const bannerTexts: string[] = [];
  while ((bannerMatch = bannerRegex.exec(html)) !== null && bannerTexts.length < 3) {
    const text = decodeHtmlEntities(bannerMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (text.length > 5 && text.length < 200) bannerTexts.push(text);
  }
  if (bannerTexts.length > 0) features.push(`Banner text: ${bannerTexts.join(" | ")}`);

  if (extraFeatures && extraFeatures.length > 0) {
    for (const ef of extraFeatures) {
      const trimmed = ef.trim();
      if (trimmed.length >= 5 && !features.includes(trimmed)) features.push(trimmed);
    }
  }

  return features;
}

// ─── 全量 HTML 原文采集（不走 htmlToText 管道）───────────────────────────────
/**
 * 直接从完整原始 HTML 中提取各类原文片段，绕过 htmlToText 截断/解析问题。
 * 适用于超大页面（如 Next.js App Router 生成的 1MB+ HTML），专门用于给 AI 提供 grounding 数据。
 */
export function extractRawMentions(rawHtml: string): RawMentions {
  const promo: string[] = [];
  const shipping: string[] = [];
  const features: string[] = [];

  // 匹配 inline 标签（a/h1-6/p/li/span/strong/div 单行内容），提取纯文字
  const TAG_RE = /<(?:a|h[1-6]|p|li|span|strong|em|b|td|th)[^>]*>([^<\n]{8,300})<\/(?:a|h[1-6]|p|li|span|strong|em|b|td|th)>/gi;

  // 促销：含折扣数字 + 触发词（off/discount/sale），或首单/新用户/注册/订阅 + 折扣
  const PROMO_RE =
    /(\d{1,2})\s*%\s*(?:off|discount|sale|rabatt|remise|sconto|descuento|korting)|(?:save|get|earn|enjoy|receive)\s+(?:up\s+to\s+)?(\d{1,2})\s*%|(?:first[\s-]?order|new[\s-]?customer|new[\s-]?subscriber|sign[\s-]?up|subscri(?:be|ption))[^%<]{0,80}(\d{1,2})\s*%|(\d{1,2})\s*%[^<]{0,80}(?:first[\s-]?order|new[\s-]?customer|sign[\s-]?up|subscri(?:be|ption))/i;

  // 物流售后：免运费/免费退换/隔日达等
  const SHIP_RE =
    /free\s*(?:standard\s*)?(?:shipping|delivery|returns?)|(?:next|same)[\s-]?day[\s-]?(?:shipping|delivery)|(?:\d{1,3})[\s-]?day[\s-]?(?:returns?|refund)|express\s*(?:shipping|delivery)/i;

  // 品牌特性：产地/工艺/认证/材质等高信任词
  const FEAT_RE =
    /hand[\s-]?craft|made\s+in\s+(?:italy|france|usa|uk|germany|japan|spain|portugal)|premium\s+(?:leather|material|quality)|luxury|award[\s-]?win|certified|genuine\s+(?:leather|suede)|artisan|bespoke|sustainabl/i;

  const seen = new Set<string>();

  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = TAG_RE.exec(rawHtml)) !== null) {
    const text = m[1].trim().replace(/\s+/g, " ");
    const key = text.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);

    const snippet = text.slice(0, 200);
    if (PROMO_RE.test(text) && promo.length < 10) {
      promo.push(snippet);
    } else if (SHIP_RE.test(text) && shipping.length < 6) {
      shipping.push(snippet);
    } else if (FEAT_RE.test(text) && features.length < 8) {
      features.push(snippet);
    }
  }

  // 补充：从 meta description 和 og:description 提取（未被 htmlToText 去掉的高密度摘要）
  // 需兼容两种属性顺序：name/property 在前 或 content 在前
  const META_TAG_RE = /<meta\s[^>]+>/gi;
  const META_CONTENT_RE = /content=["']([^"']{20,400})["']/i;
  const META_NAME_RE = /(?:name|property)=["'](?:description|og:description)["']/i;
  let metaTagM: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((metaTagM = META_TAG_RE.exec(rawHtml)) !== null) {
    const tag = metaTagM[0];
    if (!META_NAME_RE.test(tag)) continue;
    const contentMatch = META_CONTENT_RE.exec(tag);
    if (!contentMatch) continue;
    const text = contentMatch[1].replace(/&amp;/gi, "&").replace(/&#\d+;|&[a-z]+;/gi, " ").trim();
    if (PROMO_RE.test(text) && promo.length < 10) promo.push(text.slice(0, 200));
    if (SHIP_RE.test(text) && shipping.length < 6) shipping.push(text.slice(0, 200));
  }

  return { promo, shipping, features };
}

export function extractPromotionInfo(html: string, sourceUrl: string, country: string): Record<string, unknown> | null {
  if (!html) return null;
  const result: Record<string, unknown> = {};
  const market = getAdMarketConfig(country);

  // ─── 优先：从 <meta name="description"> / <meta property="og:description"> 提取（head 被 htmlToText 删除前保存）
  const metaDescMatch =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,300})["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']{10,300})["'][^>]+name=["']description["']/i) ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,300})["']/i);
  const metaDesc = metaDescMatch ? metaDescMatch[1].replace(/&amp;/gi, "&").replace(/&#\d+;|&[a-z]+;/gi, " ") : "";

  // 用 htmlToText 得到 body 纯文本（head 已被移除，用 metaDesc 补充）
  const bodyText = htmlToText(html);
  // 合并搜索文本：meta description 优先放前面
  const plainText = (metaDesc ? metaDesc + " " : "") + bodyText;

  // ─── 步骤1：从纯文本直接搜索折扣百分比 ───
  // 搜索 "up to 40% off" / "save 30%" / "enjoy 20% off" 等模式
  const percentMatch =
    plainText.match(/(?:up\s+to\s+)?(\d{1,2})\s*%\s*(?:off|discount|sale|rabatt|remise|sconto)/i) ||
    plainText.match(/(?:save|get|enjoy)\s+(\d{1,2})\s*%/i);
  if (percentMatch) {
    const pct = parseInt(percentMatch[1], 10);
    if (pct >= 5 && pct <= 90) {
      result.discount_type = "PERCENT";
      result.discount_percent = pct;
      // 提取该折扣所在的上下文句子作为 promotion_target 原始文本
      const ctx = plainText.slice(
        Math.max(0, (percentMatch.index ?? 0) - 60),
        (percentMatch.index ?? 0) + 80,
      ).replace(/\s+/g, " ").trim();
      result._promo_context = ctx;
    }
  }

  // ─── 步骤2：搜索金额折扣（$X off / save $X） ───
  if (!result.discount_type) {
    const moneyMatch =
      plainText.match(/(?:save|get|rabatt|remise|sconto|descuento)\s*[$€£]?\s*(\d{1,4})/i) ||
      plainText.match(/[$€£](\d{1,4})\s*(?:off|rabatt|remise|sconto|descuento)/i);
    if (moneyMatch) {
      const amt = parseInt(moneyMatch[1], 10);
      if (amt >= 1 && amt <= 5000) {
        result.discount_type = "MONETARY";
        result.discount_amount = amt;
        result.currency_code = market.currencyCode;
        const ctx = plainText.slice(
          Math.max(0, (moneyMatch.index ?? 0) - 60),
          (moneyMatch.index ?? 0) + 80,
        ).replace(/\s+/g, " ").trim();
        result._promo_context = ctx;
      }
    }
  }

  // ─── 步骤3：优惠码（必须有 code/coupon 关键词，避免 "use strict" 误匹配）───
  const codeMatch =
    html.match(/(?:coupon|voucher|gutschein|codice)[:\s]+["']?([A-Z0-9]{4,20})["']?/i) ||
    html.match(/(?:use|enter|apply)\s+(?:the\s+)?code\s+["']?([A-Z0-9]{4,20})["']?/i) ||
    html.match(/promo(?:tion)?\s+code[:\s]+["']?([A-Z0-9]{4,20})["']?/i);
  if (codeMatch) result.promo_code = codeMatch[1].toUpperCase();

  // ─── 步骤4：设置 promotion_target（活动名称，去掉折扣数字） ───
  if (result.discount_type) {
    // 优先尝试从 sourceUrl 的 path 段提取活动名（最准确）
    // 例：/collections/friends-and-family-event → "Friends & Family"
    let targetFromUrl = "";
    try {
      const urlPath = new URL(sourceUrl).pathname;
      const lastSegment = urlPath.split("/").filter(Boolean).pop() || "";
      // 移除无意义后缀 event/sale/deals/collection
      const cleanedSegment = lastSegment
        .replace(/[-_]?(?:event|sale|deals?|collection|shop)s?$/i, "")
        .replace(/[-_]/g, " ")
        .trim();
      if (cleanedSegment.length >= 3 && !/^(home|index|products|collections|pages|categories)$/i.test(cleanedSegment)) {
        // 首字母大写
        targetFromUrl = cleanedSegment.replace(/\b\w/g, (c) => c.toUpperCase());
        // "and" → "&" 简化
        targetFromUrl = targetFromUrl.replace(/\band\b/gi, "&");
      }
    } catch {}

    if (targetFromUrl.length >= 3) {
      result.promotion_target = smartTruncate(targetFromUrl, 20);
    } else if (result._promo_context) {
      // 备用：从上下文提取，优先找 "during [event]" / "for [event]" 模式
      const ctx = String(result._promo_context);
      const eventMatch = ctx.match(/(?:during|for)\s+(?:our|the|a)?\s*([A-Z][a-zA-Z &'-]{2,30}?)(?:\s+(?:event|sale|deals?|offer))?[.,!]/i) ||
        ctx.match(/([A-Z][a-zA-Z &'-]{2,30}?)\s+(?:event|sale|deals?)/i);
      if (eventMatch?.[1]?.trim().length >= 3) {
        result.promotion_target = smartTruncate(eventMatch[1].trim(), 20);
      } else {
        // ── 专项场景识别（优先级高于通用事件名提取）──
        // 1. "first order" / "new customer" / "first purchase" → promotion_target = "First Order"
        if (/first[\s-]?order|new[\s-]?customer|new[\s-]?subscriber|first[\s-]?purchase|first[\s-]?time/i.test(ctx)) {
          result.promotion_target = "First Order";
        }
        // 2. "newsletter" / "subscribe" / "sign up" / "email" → promotion_target = "Newsletter"
        else if (/newsletter|subscri(?:be|ption)|email\s*sign[\s-]?up|join\s*(our|the)\s*(list|club|newsletter)/i.test(ctx)) {
          result.promotion_target = "Newsletter";
        }
        // 3. "referral" / "refer a friend" → promotion_target = "Referral"
        else if (/refer(?:ral|a\s*friend)|invite\s*a?\s*friend/i.test(ctx)) {
          result.promotion_target = "Referral";
        }
        // 4. 通用事件名提取：去折扣词后尝试，必须通过"像活动名"的验证
        else {
          const eventName = ctx
            .replace(/,?\s*up\s+to\s+\d+\s*%\s*(?:off|discount)/gi, "")
            .replace(/,?\s*\d+\s*%\s*(?:off|discount)/gi, "")
            .replace(/,?\s*[$€£]\d+\s*(?:off)/gi, "")
            .replace(/,?\s*save\s+\d+%/gi, "")
            .replace(/\s+/g, " ").trim();
          const cleanName = eventName.replace(/[\.\!\?].*$/, "").replace(/\(.*$/, "").trim();
          // 验证：不能以介词/冠词/连词结尾（说明是句子碎片，不是活动名称）
          const STOP_WORD_ENDS = /\b(on|the|a|an|for|to|in|at|from|with|and|or|but|of|men|women|all)\s*$/i;
          // 验证：不能包含超过 4 个单词且不以大写开头（不像专有名词/标题）
          const words = cleanName.split(/\s+/).filter(Boolean);
          const looksLikeEventName = cleanName.length >= 3
            && !STOP_WORD_ENDS.test(cleanName)
            && words.length <= 5
            && words.length > 0
            && /^[A-Z&]/.test(cleanName);
          if (looksLikeEventName) result.promotion_target = smartTruncate(cleanName, 20);
          // 验证不通过时不设置 promotion_target，让步骤4.5的通用兜底接管
        }
      }
    }
  }
  delete result._promo_context;

  // ─── 步骤4.5：找到折扣但未能提取活动名时，用通用兜底补充 promotion_target ───
  // 场景：页面有 "15% off" 但没有明确的活动名称（如只写 "Enjoy 15% off all orders"）
  if (result.discount_type && !result.promotion_target) {
    result.promotion_target = market.genericPromotionTarget;
  }

  // ─── 步骤5：通用优惠兜底（无具体折扣但有 sale/deals 关键词） ───
  if (!result.discount_type) {
    const hasFreeShipping = /free\s*(?:standard\s*)?(?:shipping|delivery)|kostenlos(?:e|er)?\s+versand|livraison\s+offerte|env[ií]o\s+gratis|spedizione\s+gratuita/i.test(plainText);
    const hasGenericPromo = /(?:sale|deals?|special\s+offer|limited\s+time|clearance)\b/i.test(plainText);
    if (hasFreeShipping && !result.promotion_target) result.promotion_target = market.genericPromotionTarget;
    if (hasGenericPromo && !result.promotion_target) {
      result.promotion_target = market.genericPromotionTarget;
      result.has_generic_promo = true;
    }
  }

  result.final_url = sourceUrl;
  if (result.promotion_target) {
    result.promotion_target = smartTruncate(String(result.promotion_target), 20);
    result.language_code = market.promotionLanguageCode;
  }
  if (result.discount_type === "MONETARY" && !result.currency_code) result.currency_code = market.currencyCode;

  console.log(`[PromoExtract] discount=${result.discount_type || "none"}, pct=${result.discount_percent ?? "-"}, target="${result.promotion_target ?? ""}"`);
  return Object.keys(result).length > 1 ? result : null;
}

export function extractPriceInfo(html: string, country: string, sourceUrl?: string): { header: string; description: string; price: number; currency: string; url: string }[] {
  if (!html) return [];
  const items: { header: string; description: string; price: number; currency: string; url: string }[] = [];
  const market = getAdMarketConfig(country);

  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      const products = Array.isArray(data) ? data : [data];
      for (const p of products) {
        if (p["@type"] === "Product" && p.name && p.offers) {
          const offers = Array.isArray(p.offers) ? p.offers : [p.offers];
          for (const o of offers) {
            const price = parseFloat(o.price || o.lowPrice || "0");
            if (price > 0 && items.length < 8) {
              // 不在提取层截断，route.ts 会做 AI 精简
              const fullName = String(p.name).trim();
              items.push({
                header: fullName,
                description: String(p.description || p.name).slice(0, 80),
                price, currency: o.priceCurrency || market.currencyCode, url: o.url || p.url || sourceUrl || "",
              });
            }
          }
        }
      }
    } catch {}
  }

  if (items.length === 0) {
    const productBlockRegex = /<(?:div|li|article|section)[^>]*class=["'][^"']*(?:product|item|card)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|li|article|section)>/gi;
    let blockMatch;
    while ((blockMatch = productBlockRegex.exec(html)) !== null && items.length < 8) {
      const block = blockMatch[1];
      const priceMatch = block.match(/(?:[$€£¥]|(?:USD|EUR|GBP)\s*)\s*([\d,.]+)/i)
        || block.match(/([\d,.]+)\s*(?:[$€£¥]|(?:USD|EUR|GBP))/i);
      if (!priceMatch) continue;
      const price = parseFloat(priceMatch[1].replace(",", ""));
      if (price <= 0 || price >= 100000) continue;

      let productName = "";
      const nameMatch = block.match(/<(?:h[1-6]|a|span|strong)[^>]*class=["'][^"']*(?:product[_-]?(?:name|title)|item[_-]?(?:name|title)|card[_-]?title)[^"']*["'][^>]*>([^<]+)</i)
        || block.match(/<(?:h[2-4]|a)[^>]*>([^<]{3,60})<\/(?:h[2-4]|a)>/i);
      if (nameMatch?.[1]) {
        // 保留完整名称，不在提取层截断
        productName = decodeHtmlEntities(nameMatch[1].trim());
      }
      const linkMatch = block.match(/<a[^>]+href=["']([^"'#][^"']*?)["']/i);
      const productUrl = linkMatch?.[1] || sourceUrl || "";

      if (productName && productName.length >= 2) {
        // 尝试从 block 中提取短描述（副标题/meta-description 类文本）
        let shortDesc = "";
        const descMatch = block.match(/<(?:p|span|div)[^>]*class=["'][^"']*(?:desc|subtitle|sub-title|tagline|caption)[^"']*["'][^>]*>([^<]{5,80})<\/(?:p|span|div)>/i);
        if (descMatch?.[1]) shortDesc = decodeHtmlEntities(descMatch[1].trim()).slice(0, 80);
        items.push({ header: productName, description: shortDesc, price, currency: market.currencyCode, url: productUrl });
      }
    }
  }
  return items;
}

/**
 * 从 HTML 提取真实产品信息（名称、URL、价格、图片）
 * 优先 JSON-LD 结构化数据，其次从商品卡片 DOM 结构提取
 */
export function extractProducts(html: string, sourceUrl: string, country: string): CrawledProduct[] {
  if (!html) return [];
  const products: CrawledProduct[] = [];
  const seenNames = new Set<string>();
  const market = getAdMarketConfig(country);

  // 1. JSON-LD Product（最可靠）
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(jsonLdMatch[1]);
      const items = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      for (const p of items) {
        if (p["@type"] !== "Product" || !p.name) continue;
        const name = String(p.name).trim();
        if (name.length < 2 || seenNames.has(name.toLowerCase())) continue;
        seenNames.add(name.toLowerCase());

        const offers = p.offers ? (Array.isArray(p.offers) ? p.offers : [p.offers]) : [];
        const firstOffer = offers[0] || {};
        const price = parseFloat(firstOffer.price || firstOffer.lowPrice || "0");
        const img = p.image ? (Array.isArray(p.image) ? p.image[0] : (typeof p.image === "string" ? p.image : p.image?.url)) : undefined;

        products.push({
          name: name.slice(0, 80),
          url: firstOffer.url || p.url || sourceUrl,
          price: price > 0 ? price : undefined,
          currency: firstOffer.priceCurrency || market.currencyCode,
          description: p.description ? String(p.description).slice(0, 120) : undefined,
          imageUrl: img || undefined,
        });
        if (products.length >= 20) break;
      }
    } catch {}
  }

  // 2. 从商品卡片 DOM 结构提取（仅当 JSON-LD 不足时）
  if (products.length < 5) {
    const cardRegex = /<(?:div|li|article|section)[^>]*class=["'][^"']*(?:product(?:-card|-item|-tile)?|item-card|grid-item|card)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|li|article|section)>/gi;
    let cardMatch;
    while ((cardMatch = cardRegex.exec(html)) !== null && products.length < 20) {
      const block = cardMatch[1];
      // 提取产品名
      const nameMatch = block.match(/<(?:h[1-6]|a|span|strong)[^>]*class=["'][^"']*(?:product[_-]?(?:name|title)|item[_-]?(?:name|title)|card[_-]?title)[^"']*["'][^>]*>([^<]{2,80})</i)
        || block.match(/<(?:h[2-5])[^>]*>([^<]{2,80})<\/h[2-5]>/i)
        || block.match(/<a[^>]+(?:title=["']([^"']{2,80})["'])/i);
      let name = nameMatch ? decodeHtmlEntities((nameMatch[1] || "").trim()) : "";
      if (!name) {
        const aMatch = block.match(/<a[^>]+href=["'][^"'#]+["'][^>]*>([^<]{2,60})<\/a>/i);
        if (aMatch) name = decodeHtmlEntities(aMatch[1].trim());
      }
      if (!name || name.length < 2 || seenNames.has(name.toLowerCase())) continue;
      seenNames.add(name.toLowerCase());

      // 提取链接
      const linkMatch = block.match(/<a[^>]+href=["']([^"'#][^"']*?)["']/i);
      let productUrl = linkMatch?.[1] || "";
      if (productUrl && !productUrl.startsWith("http")) {
        try { productUrl = new URL(productUrl, sourceUrl).href; } catch { productUrl = ""; }
      }

      // 提取价格
      let price: number | undefined;
      const priceMatch = block.match(/(?:[$€£¥])\s*([\d,.]+)/i)
        || block.match(/([\d,.]+)\s*(?:[$€£¥])/i);
      if (priceMatch) {
        const parsed = parseFloat(priceMatch[1].replace(",", ""));
        if (parsed > 0 && parsed < 100000) price = parsed;
      }

      // 提取图片
      const imgMatch = block.match(/<img[^>]+src=["']([^"']+?)["']/i);
      const imageUrl = imgMatch?.[1] || undefined;

      products.push({
        name: name.slice(0, 80),
        url: productUrl || sourceUrl,
        price,
        currency: market.currencyCode,
        imageUrl,
      });
    }
  }

  return products;
}

function extractNavItems(html: string, extraItems?: string[]): string[] {
  const navItems: string[] = [];
  const navRegex = /<nav[^>]*>([\s\S]*?)<\/nav>/gi;
  let navMatch;
  while ((navMatch = navRegex.exec(html)) !== null) {
    const linkRegex = /<a[^>]*>([^<]{2,30})<\/a>/gi;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(navMatch[1])) !== null) {
      const text = decodeHtmlEntities(linkMatch[1].trim());
      if (text.length >= 2 && text.length <= 25 && !navItems.includes(text)) navItems.push(text);
    }
  }
  if (extraItems && extraItems.length > 0) {
    for (const item of extraItems) {
      const trimmed = item.trim();
      if (trimmed.length >= 2 && trimmed.length <= 25 && !navItems.includes(trimmed)) navItems.push(trimmed);
    }
  }
  return navItems;
}

/**
 * 按目标市场校验电话号码格式（导出供其他模块复用）。
 * 去除所有非数字后，对照各国合法位数范围进行硬校验。
 * 不合格的号码一律拒绝，宁可不返回也不填错号码。
 */
export function isValidPhoneForCountry(raw: string, countryCode: string): boolean {
  const digits = raw.replace(/\D/g, "");
  switch (countryCode) {
    // 北美：10 位本地 或 11 位（1 + 10位）
    case "US":
    case "CA":
      return digits.length === 10 || (digits.length === 11 && digits[0] === "1");
    // 英国：9–11 位
    case "GB":
      return digits.length >= 9 && digits.length <= 11;
    // 澳大利亚：8–10 位
    case "AU":
      return digits.length >= 8 && digits.length <= 10;
    // 日本：9–11 位
    case "JP":
      return digits.length >= 9 && digits.length <= 11;
    // 巴西：10–11 位
    case "BR":
      return digits.length >= 10 && digits.length <= 11;
    // 欧洲主要国家：7–12 位
    case "DE":
    case "FR":
    case "IT":
    case "ES":
    case "NL":
    case "SE":
    case "NO":
    case "DK":
      return digits.length >= 7 && digits.length <= 12;
    default:
      return digits.length >= 7 && digits.length <= 13;
  }
}

function extractPhoneCandidates(html: string, country: string): { country_code: string; phone_number: string }[] {
  const telRegex = /href=["']tel:([^"']+)["']/gi;
  const candidates: string[] = [];

  const COUNTRY_PHONE_CODE: Record<string, string> = {
    US: "US", CA: "CA", GB: "GB", UK: "GB", AU: "AU",
    DE: "DE", FR: "FR", JP: "JP", BR: "BR", IT: "IT",
    ES: "ES", NL: "NL", SE: "SE", NO: "NO", DK: "DK",
  };
  const countryCode = COUNTRY_PHONE_CODE[country.toUpperCase()] || "US";

  // 优先从 tel: href 提取（最可靠，是商家主动标记的可拨打号码）
  let telMatch;
  while ((telMatch = telRegex.exec(html)) !== null) {
    const phone = decodeURIComponent(telMatch[1]).replace(/\s+/g, "").trim();
    if (isValidPhoneForCountry(phone, countryCode) && !candidates.includes(phone)) {
      candidates.push(phone);
    }
  }

  // 若 tel: href 无结果，再从正文文本提取并严格校验
  if (candidates.length === 0) {
    const phoneRegex = /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;
    const textOnly = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const phoneMatches = textOnly.match(phoneRegex) || [];
    for (const p of phoneMatches) {
      const clean = p.replace(/\s+/g, "").trim();
      if (isValidPhoneForCountry(clean, countryCode) && !candidates.includes(clean)) {
        candidates.push(clean);
      }
    }
  }

  return candidates.slice(0, 3).map((phone) => ({ country_code: countryCode, phone_number: phone }));
}

/**
 * 用 while-loop 字符串搜索安全移除指定 HTML 块标签（含内容）。
 * 不使用正则，避免非贪婪模式被 JS 中的 <\/script> 等字符串截断的问题。
 */
function removeTagBlocks(html: string, tagName: string): string {
  const open = `<${tagName.toLowerCase()}`;
  const close = `</${tagName.toLowerCase()}>`;
  let result = html;
  while (true) {
    const startIdx = result.toLowerCase().indexOf(open);
    if (startIdx < 0) break;
    const endIdx = result.toLowerCase().indexOf(close, startIdx);
    if (endIdx < 0) {
      // 没找到闭合标签，截断到此
      result = result.slice(0, startIdx);
      break;
    }
    result = result.slice(0, startIdx) + " " + result.slice(endIdx + close.length);
  }
  return result;
}

function htmlToText(html: string): string {
  let text = html;
  // 先用字符串搜索移除整段 <head>（含 title/meta/所有 head-script）
  text = removeTagBlocks(text, "head");
  // 再移除 body 内的 <script> / <noscript> / <style> / <svg>
  text = removeTagBlocks(text, "script");
  text = removeTagBlocks(text, "noscript");
  text = removeTagBlocks(text, "style");
  text = removeTagBlocks(text, "svg");
  // 移除所有剩余 HTML 标签
  text = text.replace(/<[^>]+>/g, " ");
  // 解码常见 HTML 实体，折叠空白
  text = text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;|&[a-z]{2,8};/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

// ─── 站内链接发现 ───

const BAD_LINK_TEXTS = ["click here", "read more", "learn more", "see more", "view more", "here", "link", "click"];

/**
 * 国家代码到标准 locale URL 段的映射（xx-yy 格式）。
 * 当爬取结果中的 locale 与目标国家不匹配时，用此表替换。
 */
const COUNTRY_TO_LOCALE: Record<string, string> = {
  US: "en-us", GB: "en-gb", AU: "en-au", CA: "en-ca",
  IE: "en-ie", NZ: "en-nz", SG: "en-sg", IN: "en-in",
  DE: "de-de", AT: "de-at", CH: "de-ch",
  FR: "fr-fr", IT: "it-it", ES: "es-es",
  NL: "nl-nl", BE: "nl-be", SE: "sv-se",
  NO: "nb-no", DK: "da-dk", FI: "fi-fi",
  JP: "ja-jp", KR: "ko-kr", CN: "zh-cn", TW: "zh-tw",
  BR: "pt-br", PT: "pt-pt", MX: "es-mx",
};

/**
 * 检测 URL 路径开头的 locale/country 段，替换为目标国家对应的正确前缀。
 *
 * 支持两种格式：
 *   - 全 locale 格式：/en-sg/ /fr-fr/ /de-de/  → 替换为目标 locale（如 /en-us/）
 *   - 2 字母国家码格式：/sg/ /us/ /de/          → 替换为目标国家码（如 /us/）
 */
function normalizeLocaleInUrl(url: string, targetCountry: string): string {
  try {
    const u = new URL(url);
    const target = targetCountry.toUpperCase();

    // Case 1：完整 locale 前缀（en-sg, fr-fr 等）
    const m1 = u.pathname.match(/^\/([a-z]{2}[-_][a-z]{2})\//i);
    if (m1) {
      const existingCountry = m1[1].toLowerCase().replace("_", "-").split("-")[1]?.toUpperCase();
      if (existingCountry === target) return url; // 已正确
      const targetLocale = COUNTRY_TO_LOCALE[target];
      u.pathname = targetLocale
        ? "/" + targetLocale + u.pathname.slice(m1[0].length - 1)
        : "/" + u.pathname.slice(m1[0].length); // 未知 locale 则剥离前缀
      return u.toString();
    }

    // Case 2：纯 2 字母国家码前缀（/sg/ /us/ /de/ 等）
    const m2 = u.pathname.match(/^\/([a-z]{2})\//i);
    if (m2) {
      // 排除常见非国家码的 2 字母路径段（页面路径可能恰好 2 字母，如 /en/ 是语言不是国家）
      const KNOWN_COUNTRY_CODES = new Set([
        "us", "gb", "au", "ca", "ie", "nz", "sg", "in", "hk",
        "de", "at", "ch", "fr", "it", "es", "nl", "be", "se",
        "no", "dk", "fi", "jp", "kr", "cn", "tw", "br", "pt", "mx",
      ]);
      const existing2 = m2[1].toLowerCase();
      if (!KNOWN_COUNTRY_CODES.has(existing2)) return url; // 非国家码，不处理
      if (existing2 === target.toLowerCase()) return url; // 已正确
      u.pathname = "/" + target.toLowerCase() + u.pathname.slice(m2[0].length - 1);
      return u.toString();
    }

    return url;
  } catch { return url; }
}

async function discoverSitelinkCandidates(
  merchantUrl: string,
  pageLinks: { url: string; text: string }[],
  country?: string,
  puppeteerNavLinks?: { url: string; text: string }[],
  puppeteerProxyUrlOverride?: string | null,
): Promise<{ url: string; title: string; description: string }[]> {
  let merchantDomain = "";
  try { merchantDomain = new URL(merchantUrl).hostname.replace(/^www\./, ""); } catch {}
  const proxyUrl = country ? (await getProxyUrlForCountry(country) ?? undefined) : undefined;
  // Puppeteer 专用 HTTP 代理（Chrome 不支持 SOCKS5 认证，必须用 HTTP proxy）
  const puppeteerProxyUrl = puppeteerProxyUrlOverride !== undefined
    ? (puppeteerProxyUrlOverride ?? undefined)
    : country ? (await getHttpProxyUrlForCountry(country).catch(() => null) ?? undefined) : undefined;
  // C-015 §4：用 console.warn 以便 Next.js 16 prod 下也能落进 PM2 error.log 用于诊断
  if (proxyUrl) console.warn(`[Sitelinks] 使用 ${country} 代理探查候选链接，pageLinks=${pageLinks.length} navLinks=${puppeteerNavLinks?.length ?? 0} puppeteerProxy=${puppeteerProxyUrl ? "yes" : "no"}`);
  else if (country) console.warn(`[Sitelinks] 无 ${country} 代理，直连探查（locale 按目标国家规范化），pageLinks=${pageLinks.length}`);

  const candidates: { url: string; title: string; description: string }[] = [];
  const usedFinalUrls = new Set<string>();

  // C-014 §2.2：记录第一轮 HTTP 代理失败的 URL，用于 Puppeteer 批量兜底
  const httpFailedLinks: { url: string; text: string }[] = [];

  // 拒因计数（最终一次性汇总到 console.warn，避免刷屏）
  const rejectStats = { notOk: 0, rootPath: 0, duplicate: 0, titleShort: 0, botBlockFallback: 0 };

  // C-017 bot-block 决策：只有当**同批多条**子页都被重定向到首页时，才视为 WAF 整站保护、
  // 信任原 link.url；单条合法 301（老 URL 下线/季节过期）不触发回退，该 URL 按 rootPath 规则拒掉，
  // 避免生成"点进去回首页"的虚假 sitelink 被 Google Ads 判为 misleading。
  const BOT_BLOCK_THRESHOLD = 2;
  let botBlockSignals = 0;

  /** 单条 meta 是否呈现"子页被 302/301 到根路径"的 bot-block 信号 */
  const isHomeRedirect = (
    link: { url: string; text: string },
    meta: { ok: boolean; finalUrl: string; isSoft404: boolean },
  ): boolean => {
    if (!meta.ok || meta.isSoft404) return false;
    const rawUrl = meta.finalUrl || link.url;
    let rawPath = ""; try { rawPath = new URL(rawUrl).pathname; } catch {}
    let linkPath = ""; try { linkPath = new URL(link.url).pathname; } catch {}
    return (rawPath === "/" || rawPath === "") && linkPath !== "/" && linkPath !== "";
  };

  /** 把单条 meta 结果 + link 转为 candidate（共用给 HTTP / Puppeteer 两个来源），命中则 push */
  const tryPushCandidate = (
    link: { url: string; text: string },
    meta: { title: string; description: string; ok: boolean; finalUrl: string; isSoft404: boolean },
    botBlockMode: boolean = false,
  ): boolean => {
    if (candidates.length >= 6) return false;
    if (meta.isSoft404 || !meta.ok) {
      rejectStats.notOk++;
      return false;
    }
    const rawUrl = meta.finalUrl || link.url;
    // bot-block 回退仅在 botBlockMode=true 时激活（调用方已统计信号数达到阈值）。
    // botBlockMode=false 时，finalUrl.pathname==="/" 的子页会进入下面的 rootPath 分支被拒，
    // 避免把合法的 301→首页 URL 当作 sitelink 生成。
    let rawPath = "";
    try { rawPath = new URL(rawUrl).pathname; } catch {}
    let linkPath = "";
    try { linkPath = new URL(link.url).pathname; } catch {}
    const isBotBlockRedirect = botBlockMode && (rawPath === "/" || rawPath === "") && linkPath !== "/" && linkPath !== "";
    const usedRawUrl = isBotBlockRedirect ? link.url : rawUrl;
    const useMetaText = !isBotBlockRedirect;
    if (isBotBlockRedirect) rejectStats.botBlockFallback++;

    const realUrl = country ? normalizeLocaleInUrl(usedRawUrl, country) : usedRawUrl;
    try {
      const p = new URL(realUrl).pathname;
      if (p === "/" || p === "") {
        rejectStats.rootPath++;
        return false;
      }
    } catch {}
    const normalizedUrl = realUrl.replace(/\/$/, "").replace(/^http:/, "https:");
    if (usedFinalUrls.has(normalizedUrl)) {
      rejectStats.duplicate++;
      return false;
    }
    usedFinalUrls.add(normalizedUrl);

    let title = "";
    if (useMetaText && meta.title && !isBlockedTitle(meta.title)) {
      title = sanitizeAdText(smartTruncate(decodeHtmlEntities(meta.title).replace(/\s*[\|–—]\s*[^|–—]{0,40}$/, "").replace(/\s*-\s*[A-Z][a-zA-Z\s]{0,30}$/, "").trim(), 25));
    }
    if (!title || title.length < 2) {
      const cleanLinkText = sanitizeAdText(decodeHtmlEntities(link.text.trim()));
      if (cleanLinkText.length >= 2 && !BAD_LINK_TEXTS.includes(cleanLinkText.toLowerCase())) title = smartTruncate(cleanLinkText, 25);
    }
    if (!title || title.length < 2) title = titleFromUrlPath(realUrl);
    if (title.length < 2) {
      rejectStats.titleShort++;
      return false;
    }

    let desc = "";
    if (useMetaText && meta.description) desc = sanitizeAdText(smartTruncate(decodeHtmlEntities(meta.description), 35), { allowExclamation: true });

    // C-032 QA-1 A：第一层过滤——URL 路径 + 标题黑名单
    if (isLowValueSitelink(realUrl, title)) {
      console.warn(`[SitelinkFilter] L1 过滤低价值链接: url=${realUrl.slice(0, 80)} title="${title}"`);
      return false;
    }

    candidates.push({ url: realUrl, title, description: desc });
    return true;
  };

  // C-017：pageLinks 分支改为两阶段（收集 meta → 决策 botBlockMode → 统一 push），
  // 避免"边爬边 push"时因阈值未到就拒掉 home-redirect，或因阈值已到但此前已误拒的不一致。
  type MetaEntry = { link: { url: string; text: string }; meta: { title: string; description: string; ok: boolean; finalUrl: string; isSoft404: boolean } };
  const pageLinkDeferred: MetaEntry[] = [];

  if (pageLinks.length > 0) {
    const prioritized = [...pageLinks].sort((a, b) => {
      try {
        const pa = new URL(a.url).pathname.split("/").filter(Boolean).length;
        const pb = new URL(b.url).pathname.split("/").filter(Boolean).length;
        return pa - pb;
      } catch { return 0; }
    });
    // 对提取到的链接先做 locale 规范化：若无代理，直连从新加坡 IP 爬取的页面会包含
    // /en-sg/ 之类的路径段，需替换为目标国家 locale（如 /en-us/）再探查
    const linksToTry = prioritized
      .filter(l => { try { return !new URL(l.url).search; } catch { return true; } })
      .slice(0, 20)
      .map(l => country ? { ...l, url: normalizeLocaleInUrl(l.url, country) } : l);

    // C-027 FIX-C：HTTP L0 快速短路
    //   对 CF 整站保护型站点（如 aerosus.be），HTTP L0 长期 ok=0/20。
    //   改为先探 4 条（probe 波），若 ok=0 立即跳过剩余 16 条直接走 Puppeteer 兜底。
    //   收益：aerosus.be 类站 HTTP L0 从 ~16s → ~5s（§26.11.3 实测节约 11s/次）。
    const PROBE_SIZE = 4;
    const PROBE_TIMEOUT_MS = 5000;
    const probeLinks = linksToTry.slice(0, PROBE_SIZE);
    const remainingLinks = linksToTry.slice(PROBE_SIZE);

    const fetchWithLinkTimeout = async (link: { url: string; text: string }, timeoutMs?: number) => {
      try {
        const p = fetchUrlMeta(link.url, proxyUrl, country);
        const meta = timeoutMs
          ? await Promise.race([
              p,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("probe-timeout")), timeoutMs),
              ),
            ])
          : await p;
        return { link, meta };
      } catch {
        return { link, meta: { title: "", description: "", ok: false, finalUrl: link.url, isSoft404: false } };
      }
    };

    const probeResults = await Promise.all(
      probeLinks.map((link) => fetchWithLinkTimeout(link, PROBE_TIMEOUT_MS)),
    );

    const probeOkCount = probeResults.filter((r) => r.meta.ok).length;
    const probeShortCircuit = probeLinks.length >= PROBE_SIZE && probeOkCount === 0;

    const metaResults: MetaEntry[] = [...probeResults];
    if (probeShortCircuit) {
      console.warn(`[Sitelinks] HTTP L0 probe ${probeLinks.length}/${probeLinks.length} 全灭，短路跳过剩余 ${remainingLinks.length} 条，直接进 Puppeteer 兜底（CF 保护站快速路径）`);
      for (const link of remainingLinks) {
        metaResults.push({ link, meta: { title: "", description: "", ok: false, finalUrl: link.url, isSoft404: false } });
      }
    } else if (remainingLinks.length > 0) {
      const restResults = await Promise.all(
        remainingLinks.map((link) => fetchWithLinkTimeout(link)),
      );
      metaResults.push(...restResults);
    }

    let httpOkCount = 0;
    for (const { link, meta } of metaResults) {
      if (!meta.ok) { httpFailedLinks.push(link); continue; }
      httpOkCount++;
      if (isHomeRedirect(link, meta)) botBlockSignals++;
      pageLinkDeferred.push({ link, meta });
    }
    console.warn(`[Sitelinks] HTTP L0 完成: 尝试=${metaResults.length} ok=${httpOkCount} 失败=${httpFailedLinks.length} signals=${botBlockSignals}${probeShortCircuit ? " (probe短路)" : ""}`);
  }

  // ══════════════════════════════════════════════════════
  // C-014 §2.2：HTTP 代理识别导致 ok=false 的 URL，用共享 browser 的 Puppeteer 批量真实访问兜底
  // 这是 L0 的一部分（真实访问，不是降级），只是换用更重的浏览器栈绕过指纹识别。
  // ══════════════════════════════════════════════════════
  if (pageLinkDeferred.length < 6 && httpFailedLinks.length > 0) {
    const needed = Math.min(httpFailedLinks.length, 8);
    const retryUrls = httpFailedLinks.slice(0, needed).map(l => l.url);
    console.warn(`[Sitelinks] HTTP L0 失败 ${httpFailedLinks.length} 条，Puppeteer 共享 browser 兜底验证前 ${needed} 条`);
    try {
      const puppeteerMetas = await batchFetchMetaViaPuppeteer(retryUrls, puppeteerProxyUrl, {
        concurrency: 2,
        perPageTimeoutMs: 25000,
      });
      const linkByUrl = new Map(httpFailedLinks.map(l => [l.url, l]));
      let puppeteerOk = 0;
      for (const [url, meta] of puppeteerMetas.entries()) {
        const link = linkByUrl.get(url);
        if (!link) continue;
        if (!meta.ok) continue;
        puppeteerOk++;
        if (isHomeRedirect(link, meta)) botBlockSignals++;
        pageLinkDeferred.push({ link, meta });
      }
      console.warn(`[Sitelinks] Puppeteer 兜底完成: 尝试=${puppeteerMetas.size} ok=${puppeteerOk} signals=${botBlockSignals}`);
    } catch (e) {
      console.warn(`[Sitelinks] Puppeteer 批量兜底异常:`, e instanceof Error ? e.message : e);
    }
  }

  // C-017 阶段 3：决策 botBlockMode + 统一 push（按收集顺序，维持原优先级）
  let botBlockMode = botBlockSignals >= BOT_BLOCK_THRESHOLD;
  if (botBlockMode) {
    console.warn(`[Sitelinks] bot-block 模式已触发 (signals=${botBlockSignals} ≥ ${BOT_BLOCK_THRESHOLD})，回退使用原 link.url`);
  }
  for (const { link, meta } of pageLinkDeferred) {
    if (candidates.length >= 6) break;
    tryPushCandidate(link, meta, botBlockMode);
  }

  if (candidates.length < 6 && merchantUrl) {
    const existingNormalized = new Set(candidates.map((c) => c.url.replace(/\/$/, "").replace(/^http:/, "https:")));

    // 优先使用 Puppeteer 从真实 DOM 提取的 nav links（动态站点的实际导航）
    if (puppeteerNavLinks && puppeteerNavLinks.length > 0) {
      console.log(`[Sitelinks] 使用 Puppeteer nav links 探查（${puppeteerNavLinks.length} 条）`);
      const navLinksFiltered = puppeteerNavLinks
        .filter(l => {
          try {
            const u = new URL(l.url);
            return u.hostname.includes(merchantDomain) && !new URL(l.url).search && l.text.length >= 2;
          } catch { return false; }
        })
        .map(l => country ? { ...l, url: normalizeLocaleInUrl(l.url, country) } : l)
        .slice(0, 20);

      const navMetaResults = await Promise.all(
        navLinksFiltered.map(async (link) => {
          try {
            // C-014 §2.1：同第一段，传 country 启用 IP 轮换
            const meta = await fetchUrlMeta(link.url, proxyUrl, country);
            return { link, meta };
          } catch {
            return { link, meta: { title: "", description: "", ok: false, finalUrl: link.url, isSoft404: false } };
          }
        }),
      );

      // C-017：navLinks 分支同样改为两阶段（收集 → 决策 → 统一 push），
      // botBlockSignals 与 pageLinks 分支共享（同一商家同一批探查视为一批）。
      const navDeferred: MetaEntry[] = [];
      const navHttpFailed: { url: string; text: string }[] = [];
      for (const { link, meta } of navMetaResults) {
        if (!meta.ok) { navHttpFailed.push(link); continue; }
        if (meta.isSoft404) continue;
        if (isHomeRedirect(link, meta)) botBlockSignals++;
        navDeferred.push({ link, meta });
      }

      // navLinks 分支也走 Puppeteer 兜底
      if (navDeferred.length < 6 && navHttpFailed.length > 0) {
        const needed = Math.min(navHttpFailed.length, 6);
        const retryUrls = navHttpFailed.slice(0, needed).map(l => l.url);
        console.log(`[Sitelinks] navLinks HTTP L0 失败 ${navHttpFailed.length} 条，Puppeteer 兜底前 ${needed} 条`);
        try {
          const puppeteerMetas = await batchFetchMetaViaPuppeteer(retryUrls, puppeteerProxyUrl, { concurrency: 2, perPageTimeoutMs: 25000 });
          const linkByUrl = new Map(navHttpFailed.map(l => [l.url, l]));
          for (const [url, meta] of puppeteerMetas.entries()) {
            const link = linkByUrl.get(url);
            if (!link) continue;
            if (!meta.ok || meta.isSoft404) continue;
            if (isHomeRedirect(link, meta)) botBlockSignals++;
            navDeferred.push({ link, meta });
          }
          console.warn(`[Sitelinks] navLinks Puppeteer 兜底完成，deferred=${navDeferred.length} signals=${botBlockSignals}`);
        } catch (e) {
          console.warn(`[Sitelinks] navLinks Puppeteer 批量兜底异常:`, e instanceof Error ? e.message : e);
        }
      }

      // 决策可能因为 navLinks 新增了信号而升级（如 pageLinks 信号不足但 nav 补上阈值）
      const botBlockModeNav = botBlockSignals >= BOT_BLOCK_THRESHOLD;
      if (botBlockModeNav && !botBlockMode) {
        botBlockMode = true;
        console.warn(`[Sitelinks] bot-block 模式在 navLinks 阶段升级触发 (signals=${botBlockSignals})`);
      }
      for (const { link, meta } of navDeferred) {
        if (candidates.length >= 6) break;
        // navLinks 分支的 push 仍保留原独立实现（existingNormalized 与 pageLinks 的 usedFinalUrls 去重维度不同），
        // 但 bot-block 回退语义与 tryPushCandidate 保持一致。
        const rawUrl = meta.finalUrl || link.url;
        let rawPath = ""; try { rawPath = new URL(rawUrl).pathname; } catch {}
        let linkPath = ""; try { linkPath = new URL(link.url).pathname; } catch {}
        const isBotBlockRedirect = botBlockMode && (rawPath === "/" || rawPath === "") && linkPath !== "/" && linkPath !== "";
        const usedRawUrl = isBotBlockRedirect ? link.url : rawUrl;
        const useMetaText = !isBotBlockRedirect;
        const realUrl = country ? normalizeLocaleInUrl(usedRawUrl, country) : usedRawUrl;
        try { const p = new URL(realUrl).pathname; if (p === "/" || p === "") continue; } catch {}
        const norm = realUrl.replace(/\/$/, "").replace(/^http:/, "https:");
        if (existingNormalized.has(norm)) continue;
        existingNormalized.add(norm);
        let title = "";
        if (useMetaText && meta.title && !isBlockedTitle(meta.title)) {
          title = sanitizeAdText(smartTruncate(decodeHtmlEntities(meta.title).replace(/\s*[\|–—]\s*[^|–—]{0,40}$/, "").replace(/\s*-\s*[A-Z][a-zA-Z\s]{0,30}$/, "").trim(), 25));
        }
        if (!title || title.length < 2) {
          const cleanLinkText = sanitizeAdText(decodeHtmlEntities(link.text.trim()));
          if (cleanLinkText.length >= 2 && !BAD_LINK_TEXTS.includes(cleanLinkText.toLowerCase())) title = smartTruncate(cleanLinkText, 25);
        }
        if (!title || title.length < 2) title = titleFromUrlPath(realUrl);
        let desc = "";
        if (useMetaText && meta.description) desc = sanitizeAdText(smartTruncate(decodeHtmlEntities(meta.description), 35), { allowExclamation: true });
        if (title.length >= 2) {
          // C-032 QA-1 A：第一层过滤（navLinks 分支）
          if (isLowValueSitelink(realUrl, title)) {
            console.warn(`[SitelinkFilter] L1-nav 过滤低价值链接: url=${realUrl.slice(0, 80)} title="${title}"`);
          } else {
            candidates.push({ url: realUrl, title, description: desc });
          }
        }
      }
    }
  }

  // C-032 QA-2 C：候选过滤后不足 3 条 → 深度+1 爬取 navLinks 二级页扩充候选池
  if (candidates.length < 3 && puppeteerNavLinks && puppeteerNavLinks.length > 0) {
    console.warn(`[SitelinkFilter] 候选不足 3 条（当前 ${candidates.length}），触发深度+1 爬取`);
    const depth1Targets = puppeteerNavLinks
      .filter((l) => {
        try {
          const u = new URL(l.url);
          return u.hostname.includes(merchantDomain) && !u.search;
        } catch { return false; }
      })
      .slice(0, 3);

    for (const target of depth1Targets) {
      if (candidates.length >= 6) break;
      try {
        const res = await fetch(target.url, {
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) continue;
        const html = await res.text();

        // 从二级页面提取内部 <a href> 链接
        const depth1Links: { url: string; text: string }[] = [];
        const anchorRe = /<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let m: RegExpExecArray | null;
        while ((m = anchorRe.exec(html)) !== null) {
          const href = m[1].trim();
          const text = m[2].replace(/<[^>]+>/g, "").trim();
          if (!href || !text || text.length < 2) continue;
          try {
            const abs = new URL(href, target.url).toString();
            const u = new URL(abs);
            if (!u.hostname.includes(merchantDomain) || u.search) continue;
            if (u.pathname === "/" || u.pathname === "") continue;
            depth1Links.push({ url: abs, text });
          } catch { continue; }
        }
        console.warn(`[SitelinkFilter] 深度+1 ${target.url} → 提取 ${depth1Links.length} 条子链接`);

        const depth1ToTry = depth1Links.slice(0, 12);
        const depth1Metas = await Promise.all(
          depth1ToTry.map(async (link) => {
            try {
              const meta = await fetchUrlMeta(link.url, proxyUrl, country);
              return { link, meta };
            } catch {
              return { link, meta: { title: "", description: "", ok: false, finalUrl: link.url, isSoft404: false } };
            }
          }),
        );
        for (const { link, meta } of depth1Metas) {
          if (candidates.length >= 6) break;
          tryPushCandidate(link, meta, botBlockMode);
        }
      } catch (e) {
        console.warn(`[SitelinkFilter] 深度+1 ${target.url} 异常:`, e instanceof Error ? e.message : e);
      }
    }
    console.warn(`[SitelinkFilter] 深度+1 完成，候选数: ${candidates.length}`);
  }

  // C-015 §4：最终汇总行 + 拒因统计（console.warn 必落盘，方便事后诊断）
  console.warn(
    `[Sitelinks] 最终候选 ${candidates.length} 条 / merchantDomain=${merchantDomain} country=${country ?? "-"} ` +
    `| 拒因: notOk=${rejectStats.notOk} rootPath=${rejectStats.rootPath} dup=${rejectStats.duplicate} titleShort=${rejectStats.titleShort} botBlockFallback=${rejectStats.botBlockFallback}`,
  );
  return candidates.slice(0, 6);
}

// ─── 图片收集 ───

// 目标：缓存层至少积累 60 张原始图片候选，保证前端过滤后仍有 20+ 张可用
const IMG_COLLECT_TARGET = 60;

async function collectImages(
  crawlImages: string[],
  links: { url: string; text: string }[],
  merchantUrl: string,
  merchantName: string,
  puppeteerImages?: string[],
  proxyUrl?: string,
  puppeteerProxyUrl?: string,
  prioritySubpageUrls?: string[], // F-12: 已验证可达的高优先级子页面 URL（如 sitelinkCandidates）
): Promise<string[]> {
  // 提取商家域名，用于同域图片放行
  let merchantDomain: string | undefined;
  try { merchantDomain = new URL(merchantUrl).hostname; } catch { /* ignore */ }

  // 关键防御：所有进入 allImgs 的图片必须通过 isQualityImageUrl 过滤
  // （fetchPageImages 内部不做质量过滤，依赖此处统一把关）
  const allImgs: string[] = [];
  const seen = new Set<string>();
  const addImg = (img: string) => {
    if (seen.has(img)) return;
    if (!isQualityImageUrl(img, merchantDomain)) return;
    seen.add(img);
    allImgs.push(img);
  };
  // 初始爬取的图片也要过滤
  for (const img of crawlImages) addImg(img);

  // ① 从站内链接子页面 HTTP 抓图：优先产品/分类页，足量为止
  // 如果 links=0（SPA 站点常见），尝试常见电商路径作为子页面候选
  let effectiveLinks = links;
  if (links.length === 0 && merchantUrl && allImgs.length < IMG_COLLECT_TARGET) {
    try {
      const baseUrl = new URL(merchantUrl.startsWith("http") ? merchantUrl : `https://${merchantUrl}`);
      // 行业无关的通用产品/分类路径候选。历史版本里混了大量服装向词（/women /men /new-arrivals），
      // 对非服装类商家（汽车/家具/3C/美妆）只是无效请求 → 已剔除。
      const COMMON_PATHS = [
        "/collections", "/shop", "/products", "/catalog", "/category", "/store",
      ];
      effectiveLinks = COMMON_PATHS.map(p => ({
        url: `${baseUrl.origin}${p}`,
        text: p.replace("/", ""),
      }));
      console.log(`[CollectImages] links=0，生成 ${effectiveLinks.length} 个常见产品路径候选`);
    } catch {}
  }

  if (allImgs.length < IMG_COLLECT_TARGET && effectiveLinks.length > 0) {
    const productLinks = effectiveLinks.filter(l => /\/(collection|category|shop|women|men|kids|sale|new|all|products?|tour|experience|activit|menu|service)\b/i.test(l.url));
    const otherLinks = effectiveLinks.filter(l => !/\/(collection|category|shop|women|men|kids|sale|new|all|products?|tour|experience|activit|menu|service)\b/i.test(l.url));
    const subPages = [...productLinks, ...otherLinks].slice(0, 15).map((l) => l.url);
    for (let i = 0; i < subPages.length && allImgs.length < IMG_COLLECT_TARGET; i += 3) {
      const batch = subPages.slice(i, i + 3);
      const batchResults = await Promise.all(batch.map((u) => fetchPageImages(u).catch(() => [] as string[])));
      for (const imgs of batchResults) for (const img of imgs) {
        if (allImgs.length >= 100) break;
        addImg(img);
      }
    }
  }

  // ② Puppeteer 主页面图片：数量不足时补充，用同域放行规则
  if (allImgs.length < 30 && puppeteerImages && puppeteerImages.length > 0) {
    for (const img of puppeteerImages) {
      if (allImgs.length >= 100) break;
      if (isQualityImageUrl(img, merchantDomain)) addImg(img);
    }
    console.log(`[CollectImages] Puppeteer 补图后，图片数量: ${allImgs.length}`);
  }

  // ③ F-12 修复：Puppeteer 共享 browser 多页面采集
  //   原方案每页新建 browser（5-10s 启动 × N 页），单页 25s 超时，CF 站根本来不及。
  //   新方案：单 browser 多 tab 串行，单页 40s（CF 挑战 + scroll lazy-load 充足），最多采 6 个页面。
  //   优先级：prioritySubpageUrls（已验证可达，如 sitelinkCandidates）→ 产品/分类/体验链接 → 其他链接。
  if (allImgs.length < 30) {
    try {
      const PRODUCT_LINK_RE = /\/(collection|category|shop|women|men|kids|sale|new|all|products?|tour|experience|activit|menu|service|item|detail)\b/i;
      const productLinks = effectiveLinks.filter((l) => PRODUCT_LINK_RE.test(l.url)).map((l) => l.url);
      const otherLinks = effectiveLinks.filter((l) => !PRODUCT_LINK_RE.test(l.url)).map((l) => l.url);
      const merged: string[] = [];
      const seenSubUrl = new Set<string>();
      for (const u of [...(prioritySubpageUrls || []), ...productLinks, ...otherLinks]) {
        if (!u || seenSubUrl.has(u)) continue;
        seenSubUrl.add(u);
        merged.push(u);
        if (merged.length >= 6) break;
      }
      if (merged.length > 0) {
        console.log(`[CollectImages] Puppeteer 共享浏览器子页面采集 ${merged.length} 个: ${merged.map((u) => u.replace(/^https?:\/\/[^/]+/, "")).join(", ")}`);
        const harvest = await harvestImagesFromPagesWithPuppeteer(merged, puppeteerProxyUrl ?? proxyUrl, {
          perPageTimeoutMs: 40000,
          maxImagesPerPage: 50,
        });
        let totalAdded = 0;
        for (const [subUrl, subImgs] of harvest.entries()) {
          let added = 0;
          for (const img of subImgs) {
            if (allImgs.length >= 100) break;
            const before = allImgs.length;
            addImg(img);
            if (allImgs.length > before) added++;
          }
          totalAdded += added;
          if (added > 0) console.log(`[CollectImages] 子页面 ${subUrl} 补图 ${added} 张，累计: ${allImgs.length}`);
        }
        console.log(`[CollectImages] Puppeteer 子页面汇总补图 ${totalAdded} 张`);
      }
    } catch (e) {
      console.warn(`[CollectImages] Puppeteer 子页面采集异常: ${e instanceof Error ? e.message : e}`);
    }
  }

  // ④ 搜索兜底：图片仍严重不足时搜索补充
  if (allImgs.length < 20 && merchantUrl) {
    try {
      const searchImgs = await searchMerchantImages(merchantUrl, merchantName);
      for (const img of searchImgs) { if (allImgs.length >= 100) break; addImg(img); }
      if (searchImgs.length > 0) console.log(`[CollectImages] 搜索补图后，图片数量: ${allImgs.length}`);
    } catch {}
  }

  console.log(`[CollectImages] 最终原始图片候选数: ${allImgs.length}`);
  return allImgs;
}

// ─── 主函数：构建爬取缓存 ───

export async function buildCrawlCache(
  merchantUrl: string,
  merchantName: string,
  country: string,
  semrushData?: { titles: string[]; descriptions: string[] },
  options?: { forcePuppeteer?: boolean },
): Promise<CrawlCache> {
  await acquireCrawlSlot();
  try {
  // ══════════════════════════════════════════════════════
  // 策略瀑布流（Crawl Quality Gate）
  // locale URL 永远优先于 root URL，HTTP 优先于 Puppeteer
  // 达到质量阈值（score >= 40）即停止，否则取得分最高的结果
  // ══════════════════════════════════════════════════════
  const QUALITY_THRESHOLD = 40;

  // C-016: ccTLD 切换（aerosus.nl → aerosus.be 等）已移至 country-url-resolver 在 route 层完成。
  // 进入本函数的 merchantUrl 已经是 route 层解析后的最终域名，这里只做路径级 locale 推断（Sephora 型 /en-sg/）。

  // 计算 locale URL — 同时生成完整 locale（/en-us/）和纯国家码（/us/）两种格式
  // 不同电商建站平台偏好不同：Shopify 国际化常用 /en-us/，部分品牌自建站用 /us/
  let localeUrl: string | null = null;       // 完整 locale：/en-us/
  let localeUrlShort: string | null = null;  // 纯国家码：/us/
  if (merchantUrl && country) {
    const LOCALE_PREFIX_RE = /^\/([a-z]{2}[-_][a-z]{2}|[a-z]{2})\//i;
    try {
      const u = new URL(merchantUrl);
      if (!LOCALE_PREFIX_RE.test(u.pathname)) {
        const loc = COUNTRY_TO_LOCALE[country.toUpperCase()]; // en-us
        if (loc) {
          const u1 = new URL(merchantUrl);
          u1.pathname = "/" + loc + "/";
          localeUrl = u1.toString();
        }
        const u2 = new URL(merchantUrl);
        u2.pathname = "/" + country.toLowerCase() + "/";      // us
        localeUrlShort = u2.toString();
      }
    } catch {}
  }

  type CrawlResultType = { html: string; links: { url: string; text: string }[]; images: string[]; method: string; error?: string };

  // SOCKS5 代理（供 Node.js HTTP 请求使用，如 fetchViaProxy）
  const proxyUrl = country ? (await getProxyUrlForCountry(country).catch(() => null)) : null;
  // HTTP 代理（专供 Puppeteer/Chrome 使用，Chrome 不支持 SOCKS5 认证）
  const puppeteerProxyUrl = country ? (await getHttpProxyUrlForCountry(country).catch(() => null)) : null;
  if (puppeteerProxyUrl) console.log(`[CrawlPipeline] Puppeteer 将使用 HTTP 代理: ${puppeteerProxyUrl.replace(/:[^@]+@/, ':***@')}`);

  // Puppeteer 爬取辅助：带 HTTP 代理（内部代理失败时自动降级直连）
  // 单次超时从 35s 缩短至 20s，减少策略瀑布总耗时
  const runPuppeteer = async (url: string): Promise<CrawlResultType> => {
    const puppeteerHtml = await crawlPageWithPuppeteer(url, 20000, puppeteerProxyUrl ?? undefined);
    if (!puppeteerHtml) throw new Error("Puppeteer 返回空 HTML");
    const { links, images } = extractLinksAndImages(puppeteerHtml, url);
    return { html: puppeteerHtml.slice(0, 150000), links, images, method: "puppeteer" };
  };
  // Puppeteer 直连（不走代理，作为最终兜底）
  const runPuppeteerDirect = async (url: string): Promise<CrawlResultType> => {
    const puppeteerHtml = await crawlPageWithPuppeteer(url, 20000);
    if (!puppeteerHtml) throw new Error("Puppeteer 直连返回空 HTML");
    const { links, images } = extractLinksAndImages(puppeteerHtml, url);
    return { html: puppeteerHtml.slice(0, 150000), links, images, method: "puppeteer" };
  };

  // ══════════════════════════════════════════════════════
  // 策略优先级：
  //   有代理  → Puppeteer+代理 最优（JS渲染 + 正确 IP 出口）→ HTTP+代理 兜底
  //   无代理  → HTTP locale 先（省资源）→ Puppeteer locale 补充
  // ══════════════════════════════════════════════════════
  type Strategy = { name: string; run: () => Promise<CrawlResultType> };
  const strategies: Strategy[] = [];
  if (merchantUrl) {
    if (options?.forcePuppeteer || proxyUrl) {
      // 有代理 或 forcePuppeteer：优先 Puppeteer（带代理），确保 JS 渲染 + IP 出口正确
      if (localeUrlShort) strategies.push({ name: "puppeteer_locale_short+proxy", run: () => runPuppeteer(localeUrlShort!) });
      if (localeUrl) strategies.push({ name: "puppeteer_locale+proxy", run: () => runPuppeteer(localeUrl!) });
      strategies.push({ name: "puppeteer_root+proxy", run: () => runPuppeteer(merchantUrl) });
      // HTTP 作为兜底（Puppeteer 失败时）
      if (!options?.forcePuppeteer) {
        if (localeUrlShort) strategies.push({ name: "http_locale_short", run: () => crawlPage(localeUrlShort!, country) });
        if (localeUrl) strategies.push({ name: "http_locale", run: () => crawlPage(localeUrl!, country) });
        strategies.push({ name: "http_root", run: () => crawlPage(merchantUrl, country) });
      }
      // 最终兜底：Puppeteer 直连（不带代理），保证 JS 渲染结果
      strategies.push({ name: "puppeteer_direct_fallback", run: () => runPuppeteerDirect(merchantUrl) });
    } else {
      // 无代理：HTTP 先（快），Puppeteer 兜底
      if (localeUrlShort) strategies.push({ name: "http_locale_short", run: () => crawlPage(localeUrlShort!, country) });
      if (localeUrl) strategies.push({ name: "http_locale", run: () => crawlPage(localeUrl!, country) });
      strategies.push({ name: "http_root", run: () => crawlPage(merchantUrl, country) });
      if (localeUrlShort) strategies.push({ name: "puppeteer_locale_short", run: () => runPuppeteer(localeUrlShort!) });
      if (localeUrl) strategies.push({ name: "puppeteer_locale", run: () => runPuppeteer(localeUrl!) });
      strategies.push({ name: "puppeteer_root", run: () => runPuppeteer(merchantUrl) });
    }
  }

  let crawlResult: CrawlResultType = { html: "", links: [], images: [], method: "failed", error: "未配置商家 URL" };
  let crawlQuality = { score: 0, tier: "failed" as const, issues: ["no_url"] };

  // 整体爬取时间预算：有代理时给 Puppeteer 足够时间（DataDome 站点需 35s+），无代理快速退出
  const STRATEGY_BUDGET_MS = puppeteerProxyUrl ? 110_000 : 50_000;
  const strategyStartedAt = Date.now();

  for (const strategy of strategies) {
    const elapsed = Date.now() - strategyStartedAt;
    if (elapsed > STRATEGY_BUDGET_MS) {
      console.warn(`[CrawlPipeline] 总时间已达 ${elapsed}ms > ${STRATEGY_BUDGET_MS}ms，跳过剩余策略（已完成质量 score=${crawlQuality.score}）`);
      break;
    }
    try {
      // 单策略超时：Puppeteer 策略给 38s（DataDome/WAF 站点需要更长时间），HTTP 策略 22s
      const isPuppeteerStrategy = strategy.name.includes("puppeteer");
      const SINGLE_STRATEGY_TIMEOUT_MS = isPuppeteerStrategy ? 38_000 : 22_000;
      const result = await Promise.race([
        strategy.run(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`strategy-timeout-${strategy.name}`)), SINGLE_STRATEGY_TIMEOUT_MS),
        ),
      ]);
      const quality = assessCrawlQuality(result as Parameters<typeof assessCrawlQuality>[0]);
      console.log(`[CrawlPipeline] 策略 ${strategy.name}: score=${quality.score} tier=${quality.tier} issues=[${quality.issues}] elapsed=${Date.now() - strategyStartedAt}ms`);
      if (quality.score > crawlQuality.score) {
        crawlResult = result;
        crawlQuality = quality;
      }
      // 达标即止：但 no_links + no_images 组合分数恰好 = 40，属于边界退化结果，
      // 继续尝试其他策略以获得更多图片和链接
      const hasMinLinks = result.links.length >= 3;
      const hasMinImages = result.images.length >= 5;
      if (quality.score >= QUALITY_THRESHOLD && (hasMinLinks || hasMinImages)) break;
    } catch (e) {
      console.warn(`[CrawlPipeline] 策略 ${strategy.name} 失败:`, e instanceof Error ? e.message : e);
    }
  }

  crawlResult.links = crawlResult.links.filter((l) => !isBadSitelinkUrl(l.url));
  const crawlFailed = crawlResult.method === "failed";
  let html = crawlResult.html;

  // ─── Sitemap 兜底：links=0 时（SPA 无法抽取导航链接 或 主爬取全失败），尝试从 sitemap 补充链接和图片 ───
  // SPA/Vite/React 站点常见：Puppeteer 渲染成功但导航链接无法提取，此时 sitemap 是获取产品 URL 的可靠途径。
  // 主爬取彻底失败（crawlFailed=true）时同样尝试，因 sitemap 仅需一次 HTTP GET，不依赖 Puppeteer。
  if (merchantUrl && crawlResult.links.length === 0) {
    try {
      console.log(`[CrawlPipeline] links=0，尝试 Sitemap 补充链接和图片: ${merchantUrl}`);
      const sitemapRes = await crawlViaSitemap(merchantUrl);
      if (sitemapRes) {
        const newLinks = (sitemapRes.links || []).filter((l) => !isBadSitelinkUrl(l.url));
        if (newLinks.length > 0) {
          crawlResult.links = newLinks;
          console.log(`[CrawlPipeline] Sitemap 补充 ${newLinks.length} 个链接`);
        }
        const sitemapImgs: string[] = sitemapRes.images || [];
        const existingImgSet = new Set<string>(crawlResult.images);
        for (const img of sitemapImgs) {
          if (!existingImgSet.has(img)) { existingImgSet.add(img); crawlResult.images.push(img); }
        }
        if (sitemapImgs.length > 0) {
          console.log(`[CrawlPipeline] Sitemap 补充 ${sitemapImgs.length} 张图片，共 ${crawlResult.images.length} 张`);
        }
      }
    } catch (e) {
      console.warn("[CrawlPipeline] Sitemap 兜底失败:", e instanceof Error ? e.message : e);
    }
  }

  // sitemap / backend API 路径爬取成功但 html 为空，补发一次 HTTP fetch 用于数据提取
  if (!crawlFailed && !html && merchantUrl) {
    try {
      const fetchTarget = localeUrl ?? merchantUrl;
      const fallbackResp = await fetch(fetchTarget, {
        signal: AbortSignal.timeout(10000),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": getAcceptLanguage(country),
          "Cache-Control": "no-cache",
        },
      });
      if (fallbackResp.ok) {
        const text = await fallbackResp.text();
        html = text.slice(0, 150000);
        console.log(`[CrawlPipeline] 补救 fetch 成功，html 长度: ${html.length}`);
      }
    } catch {
      // 补救失败忽略
    }
  }

  // ─── Puppeteer 补充：质量分 < 阈值时（非 puppeteer 路径），用 Puppeteer 全量抓取补充图片/链接/HTML ───
  let puppeteerCache: import("@/lib/crawler").PuppeteerPageData | null = null;
  if (crawlQuality.score < QUALITY_THRESHOLD && crawlResult.method !== "puppeteer" && merchantUrl) {
    console.log(`[CrawlPipeline] 质量不足（score=${crawlQuality.score}），启动 Puppeteer 补充抓取`);
    try {
      // F-13 fix: 质量补充必须爬根 URL（merchantUrl），根页面懒加载更多产品图（100张）。
      // 用 localeUrl（如 /en-us/）会得到少得多的页面内容（31张），因为该子页面渲染不完整。
      const puppeteerTarget = merchantUrl;
      puppeteerCache = await crawlWithPuppeteerFull(puppeteerTarget, 40000, puppeteerProxyUrl ?? undefined);
      if (puppeteerCache) {
        const httpHtmlLen = html?.length ?? 0;
        if (!html || puppeteerCache.html.length > httpHtmlLen + 5000) {
          html = puppeteerCache.html.slice(0, 150000);
          console.log(`[CrawlPipeline] 采用 Puppeteer HTML（更丰富），puppeteer=${puppeteerCache.html.length} vs http=${httpHtmlLen}`);
        }
        const newImgs = puppeteerCache.images.filter(i => !crawlResult.images.includes(i));
        crawlResult.images = [...crawlResult.images, ...newImgs];
        if (crawlResult.links.length === 0 && puppeteerCache.navLinks.length > 0) {
          crawlResult.links = puppeteerCache.navLinks.filter(l => !isBadSitelinkUrl(l.url));
        }
        // 重新评估质量
        crawlQuality = assessCrawlQuality(crawlResult as Parameters<typeof assessCrawlQuality>[0]);
        console.log(`[CrawlPipeline] Puppeteer 补充完成，重新评分: score=${crawlQuality.score}, navLinks=${puppeteerCache.navLinks.length}, images=${puppeteerCache.images.length}`);
      }
    } catch (e) {
      console.warn("[CrawlPipeline] Puppeteer 补充失败:", e instanceof Error ? e.message : e);
    }
  } else if (crawlResult.method !== "puppeteer" && merchantUrl && (crawlResult.images.length < 3 || crawlResult.links.length < 8)) {
    // 即使质量已达标，图片或链接仍不足时，用 Puppeteer 补充数据（不替换 HTML）
    console.log(`[CrawlPipeline] 数据尚不充足（images=${crawlResult.images.length}, links=${crawlResult.links.length}），Puppeteer 补充图片/链接`);
    try {
      const puppeteerTarget = merchantUrl; // 同 F-13 fix：用根 URL 获得更完整的懒加载内容
      puppeteerCache = await crawlWithPuppeteerFull(puppeteerTarget, 40000, puppeteerProxyUrl ?? undefined);
      if (puppeteerCache) {
        const httpHtmlLen = html?.length ?? 0;
        if (!html || puppeteerCache.html.length > httpHtmlLen + 5000) {
          html = puppeteerCache.html.slice(0, 150000);
          console.log(`[CrawlPipeline] 采用 Puppeteer HTML（更丰富），puppeteer=${puppeteerCache.html.length} vs http=${httpHtmlLen}`);
        }
        const newImgs = puppeteerCache.images.filter(i => !crawlResult.images.includes(i));
        crawlResult.images = [...crawlResult.images, ...newImgs];
        if (crawlResult.links.length === 0 && puppeteerCache.navLinks.length > 0) {
          crawlResult.links = puppeteerCache.navLinks.filter(l => !isBadSitelinkUrl(l.url));
        }
        console.log(`[CrawlPipeline] Puppeteer 补充图片/链接完成，navLinks=${puppeteerCache.navLinks.length}, images=${puppeteerCache.images.length}`);
      }
    } catch (e) {
      console.warn("[CrawlPipeline] Puppeteer 补充失败:", e instanceof Error ? e.message : e);
    }
  }

  // ─── 促销子页面专项爬取：从已发现链接中找促销/活动相关 URL 爬取以补充 meta 描述 ───
  const extractPromoWithSubPage = async (): Promise<Record<string, unknown> | null> => {
    // 先从主页 HTML 提取（可能被 150K 截断，作为快速路径）
    const mainPromo = html ? extractPromotionInfo(html, merchantUrl, country) : null;
    if (mainPromo?.discount_type) return mainPromo; // 主页已有真实折扣，无需继续

    // 截断可能导致遗漏了页面后半段（footer/newsletter 区域）的促销信息
    // 补：对主页做一次专项 HTTP fetch，不截断，专门用于促销提取
    const promoFetchUrl = localeUrl ?? merchantUrl;
    if (promoFetchUrl) {
      try {
        const fullResp = await fetch(promoFetchUrl, {
          signal: AbortSignal.timeout(15000),
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language": getAcceptLanguage(country),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
        if (fullResp.ok) {
          const rawHtml = await fullResp.text();
          // 策略1：先对前 300K 的可见 HTML 尝试结构化提取
          const sliceHtml = rawHtml.slice(0, 300000);
          const slicePromo = extractPromotionInfo(sliceHtml, promoFetchUrl, country);
          if (slicePromo?.discount_type) return slicePromo;

          // 策略2：全量 HTML 直接正则搜索 <a>/<h*>/<p>/<div>/<span> 标签中的促销文字
          // 绕过 htmlToText 管道，专门应对超大 HTML（如 Next.js App Router 的 1.8MB 响应）
          const TAG_PROMO_RE = /<(?:a|h[1-6]|p|div|span|li)[^>]*>([^<]{5,200})<\/(?:a|h[1-6]|p|div|span|li)>/gi;
          const PCT_RE = /(\d{1,2})\s*%\s*(?:off|discount|sale)/i;
          const FIRST_ORDER_RE = /first[\s-]?order|new[\s-]?customer|new[\s-]?subscriber|sign[\s-]?up/i;
          const NEWSLETTER_RE = /newsletter|subscri(?:be|ption)|email/i;
          let tagMatch: RegExpExecArray | null;
          // eslint-disable-next-line no-cond-assign
          while ((tagMatch = TAG_PROMO_RE.exec(rawHtml)) !== null) {
            const text = tagMatch[1].trim();
            const pctMatch = PCT_RE.exec(text);
            if (!pctMatch) continue;
            const pct = parseInt(pctMatch[1], 10);
            if (pct < 5 || pct > 90) continue;
            const target = FIRST_ORDER_RE.test(text) ? "First Order"
              : NEWSLETTER_RE.test(text) ? "Newsletter"
              : null;
            if (!target) continue;
            const market = getAdMarketConfig(country);
            console.error(`[PromoFetch] direct-match pct=${pct} target=${target} text="${text.slice(0, 80)}"`);
            return {
              discount_type: "PERCENT",
              discount_percent: pct,
              promotion_target: target,
              language_code: market.promotionLanguageCode,
              final_url: promoFetchUrl,
            };
          }
          console.error(`[PromoFetch] rawLen=${rawHtml.length} slicePromo=${JSON.stringify(slicePromo)} no-direct-match`);
        }
      } catch (e) {
        console.error(`[PromoFetch] failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    // 在已发现链接中找促销/活动子页面（sale / promo / event / offer / deal / discount / clearance）
    const PROMO_PATTERNS = /\/(sale|promo|event|offer|deal|discount|clearance|friends|family|specials?|holiday|seasonal|black[-_]?friday|cyber[-_]?monday)\b/i;
    const promoLinks = crawlResult.links
      .filter((l) => PROMO_PATTERNS.test(l.url) && l.url.startsWith("http"))
      .slice(0, 2); // 最多试 2 个子页

    for (const link of promoLinks) {
      try {
        const resp = await fetch(link.url, {
          signal: AbortSignal.timeout(8000),
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36" },
        });
        if (!resp.ok) continue;
        const subHtml = (await resp.text()).slice(0, 80000);
        const subPromo = extractPromotionInfo(subHtml, link.url, country);
        if (subPromo?.discount_type) {
          // 使用商家主页 URL 作为落地页（不用子页面 URL）
          subPromo.final_url = merchantUrl;
          console.warn(`[PromoExtract] 从子页面提取成功: ${link.url}`);
          return subPromo;
        }
      } catch {
        // 子页面爬取失败静默继续
      }
    }
    return mainPromo; // 返回主页结果（可能 null 或仅有通用促销）
  };

  // ─── 价格子页面专项爬取：主页通常是类目/JS 渲染页，价格在产品详情页 ───
  // 策略：HTTP 快速尝试 → 若无结果则 Puppeteer 渲染（能拿到 JS 动态价格数据）
  const extractPriceWithProductPages = async (): Promise<ReturnType<typeof extractPriceInfo>> => {
    // 先从主页 HTML 提取
    const mainPrices = html ? extractPriceInfo(html, country, merchantUrl) : [];
    if (mainPrices.length >= 3) return mainPrices; // 主页已够用

    // 从已发现链接中找产品详情页（路径层级深 ≥3，优先含产品关键词）
    const PRODUCT_URL_RE = /\/(product|item|shoes?|boot|loafer|sneaker|sandal|bag|accessor)/i;
    const deepLinks = crawlResult.links.filter(l => {
      try {
        return new URL(l.url).pathname.split("/").filter(Boolean).length >= 3;
      } catch { return false; }
    });
    const productLinks = (deepLinks.filter(l => PRODUCT_URL_RE.test(l.url)).length > 0
      ? deepLinks.filter(l => PRODUCT_URL_RE.test(l.url))
      : deepLinks
    ).slice(0, 3);

    if (productLinks.length === 0) return mainPrices;

    // 阶段1：HTTP 快速尝试（省时，适合有 JSON-LD 的标准站点）
    const combined = [...mainPrices];
    for (const link of productLinks) {
      if (combined.length >= 8) break;
      try {
        const resp = await fetch(link.url, {
          signal: AbortSignal.timeout(8000),
          headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", Accept: "text/html" },
        });
        if (!resp.ok) continue;
        const subHtml = (await resp.text()).slice(0, 100000);
        const subPrices = extractPriceInfo(subHtml, country, link.url);
        for (const p of subPrices) {
          if (combined.length < 8 && !combined.some(r => r.header === p.header)) combined.push(p);
        }
      } catch {}
    }
    if (combined.length >= 1) return combined; // HTTP 拿到了就直接用

    // 阶段2：Puppeteer 渲染（JS 动态加载价格的站点，如 React/Next.js 商城）
    console.log(`[PriceExtract] HTTP 未获取到价格，尝试 Puppeteer 渲染: ${productLinks[0].url}`);
    try {
      const puppeteerHtml = await crawlPageWithPuppeteer(productLinks[0].url, 25000);
      if (puppeteerHtml) {
        const puppeteerPrices = extractPriceInfo(puppeteerHtml, country, productLinks[0].url);
        if (puppeteerPrices.length > 0) {
          console.log(`[PriceExtract] Puppeteer 获取到 ${puppeteerPrices.length} 条价格`);
          return puppeteerPrices;
        }
      }
    } catch (e) {
      console.warn("[PriceExtract] Puppeteer 价格提取失败:", e instanceof Error ? e.message : String(e));
    }
    return combined;
  };

  // F-12 修复：sitelinkCandidates 必须先于 collectImages 完成
  //   原方案 collectImages 与 sitelinks 并行 → collectImages 拿不到 sitelinks 已验证的真实子页面 URL，
  //   只能从主页 a 标签随便选，对 byfood.com 这类 SPA + CF 强保护站，主页几乎没有产品图链接 → 子页爬空。
  //   新方案：先 await sitelinkCandidates，把 url 列表作为 prioritySubpageUrls 传给 collectImages。
  //   其余轻量任务继续并行。
  const sitelinkCandidates = await discoverSitelinkCandidates(merchantUrl, crawlResult.links, country, puppeteerCache?.navLinks, puppeteerProxyUrl).catch(() => [] as Awaited<ReturnType<typeof discoverSitelinkCandidates>>);
  const sitelinkUrls = (sitelinkCandidates || []).map((c) => c.url).filter(Boolean);

  const [images, features, navItems, phoneCandidates, promoRegex, priceRegex, crawledProducts] = await Promise.all([
    collectImages(crawlResult.images, crawlResult.links, merchantUrl, merchantName, puppeteerCache?.images, proxyUrl ?? undefined, puppeteerProxyUrl ?? undefined, sitelinkUrls).catch(() => [] as string[]),
    Promise.resolve(html ? extractMerchantFeatures(html, [...(puppeteerCache?.heroTexts ?? []), ...(puppeteerCache?.uspTexts ?? [])]) : []),
    Promise.resolve(html ? extractNavItems(html, puppeteerCache?.categoryNames) : []),
    Promise.resolve(html ? extractPhoneCandidates(html, country) : []),
    extractPromoWithSubPage().catch(() => null),
    extractPriceWithProductPages().catch(() => [] as ReturnType<typeof extractPriceInfo>),
    Promise.resolve(html ? extractProducts(html, merchantUrl, country) : []),
  ]);

  const pageText = html ? htmlToText(html).slice(0, 10000) : "";

  // 检测站点是否使用 locale/country 前缀（/en-sg/ 或 /sg/ 两种格式），
  // 若是则为当前目标国家计算本地化落地页 URL
  let localizedMerchantUrl: string | undefined;
  if (merchantUrl && country) {
    // 同时检测完整 locale（/en-sg/）和纯国家码（/sg/）
    const localeSegRe = /^\/([a-z]{2}[-_][a-z]{2}|[a-z]{2})\//i;
    const KNOWN_COUNTRY_CODES_SET = new Set([
      "us", "gb", "au", "ca", "ie", "nz", "sg", "in", "hk",
      "de", "at", "ch", "fr", "it", "es", "nl", "be", "se",
      "no", "dk", "fi", "jp", "kr", "cn", "tw", "br", "pt", "mx",
    ]);
    // 优先从 crawlResult.links 检测，其次从 Puppeteer navLinks 补充
    const allLinksForLocaleCheck = [
      ...crawlResult.links.slice(0, 30),
      ...(puppeteerCache?.navLinks ?? []).slice(0, 20),
    ];
    const siteUsesLocale = allLinksForLocaleCheck.some(l => {
      try {
        const pathname = new URL(l.url).pathname;
        const m = pathname.match(/^\/([a-z]{2}[-_][a-z]{2}|[a-z]{2})\//i);
        if (!m) return false;
        const seg = m[1].toLowerCase();
        // 区分完整 locale（en-sg）和纯国家码（sg）
        if (seg.length === 5 || seg.length === 6) return true; // en-sg / en_sg
        return KNOWN_COUNTRY_CODES_SET.has(seg); // 纯国家码
      } catch { return false; }
    });
    // 检测站点用的是哪种格式（完整 locale 还是纯国家码）
    const usesShortCountryCode = !allLinksForLocaleCheck.some(l => {
      try { return /^\/[a-z]{2}[-_][a-z]{2}\//i.test(new URL(l.url).pathname); } catch { return false; }
    }) && allLinksForLocaleCheck.some(l => {
      try {
        const m = new URL(l.url).pathname.match(/^\/([a-z]{2})\//i);
        return m ? KNOWN_COUNTRY_CODES_SET.has(m[1].toLowerCase()) : false;
      } catch { return false; }
    });
    if (siteUsesLocale) {
      const targetLocale = COUNTRY_TO_LOCALE[country.toUpperCase()]; // en-us
      const targetShort = country.toLowerCase(); // us
      if (targetLocale || targetShort) {
        try {
          const u = new URL(merchantUrl);
          // 检测 merchantUrl 自身是否已有前缀
          const existingLongMatch = u.pathname.match(/^\/([a-z]{2}[-_][a-z]{2})(\/|$)/i);
          const existingShortMatch = u.pathname.match(/^\/([a-z]{2})(\/|$)/i);
          const existingShort = existingShortMatch && KNOWN_COUNTRY_CODES_SET.has(existingShortMatch[1].toLowerCase()) ? existingShortMatch : null;
          if (existingLongMatch) {
            // 替换已有的完整 locale 前缀
            u.pathname = "/" + (usesShortCountryCode ? targetShort : targetLocale!) + u.pathname.slice(existingLongMatch[0].length - 1);
          } else if (existingShort) {
            // 替换已有的纯国家码前缀
            u.pathname = "/" + (usesShortCountryCode ? targetShort : targetLocale!) + u.pathname.slice(existingShort[0].length - 1);
          } else {
            // 插入前缀（保留原有路径）
            const prefix = usesShortCountryCode ? targetShort : (targetLocale || targetShort);
            u.pathname = "/" + prefix + (u.pathname === "/" ? "/" : u.pathname);
          }
          localizedMerchantUrl = u.toString();
          if (localizedMerchantUrl !== merchantUrl) {
            console.log(`[CrawlPipeline] 检测到 locale 站点，落地页本地化: ${merchantUrl} → ${localizedMerchantUrl}`);
          }
        } catch {}
      }
    }
  }

  // ─── 从完整 HTML 提取原文片段（RawMentions），供 AI 润色时 grounding 使用 ───
  // 优先使用 Puppeteer 抓取的完整 HTML（未截断）；退而使用 crawlResult.html；再用 http truncated html
  const rawHtmlForMentions =
    (puppeteerCache && puppeteerCache.html.length > 5000 ? puppeteerCache.html : null) ??
    crawlResult.html ??
    html ??
    "";
  const rawMentions: RawMentions = extractRawMentions(rawHtmlForMentions);
  console.log(
    `[CrawlPipeline] rawMentions 采集完毕 promo=${rawMentions.promo.length} shipping=${rawMentions.shipping.length} features=${rawMentions.features.length}`
  );

  // ─── 检测爬取到的实际语言（优先于国家默认配置） ───
  // 适用场景：比利时（BE）→ 荷兰语/法语由网站实际内容决定，而非国家默认
  const detectedLanguageCode = detectPageLanguage(html, localizedMerchantUrl ?? crawlResult.method !== "failed" ? (localeUrl ?? merchantUrl) : undefined);
  if (detectedLanguageCode) {
    console.log(`[CrawlPipeline] 检测到页面实际语言: ${detectedLanguageCode}（来源: HTML lang 属性或 URL 路径）`);
  }

  return {
    links: crawlResult.links,
    images,
    pageText,
    features,
    navItems,
    phoneCandidates,
    sitelinkCandidates,
    semrushTitles: semrushData?.titles || [],
    semrushDescriptions: semrushData?.descriptions || [],
    promoRegex,
    priceRegex,
    crawledProducts,
    crawledAt: new Date().toISOString(),
    crawlMethod: crawlResult.method,
    crawlFailed,
    localizedMerchantUrl,
    crawlQualityScore: crawlQuality.score,
    crawlQualityIssues: crawlQuality.issues,
    rawMentions,
    detectedLanguageCode: detectedLanguageCode ?? undefined,
    navLinks: puppeteerCache?.navLinks?.slice(0, 50),
  };
  } finally {
    releaseCrawlSlot();
  }
}

/**
 * 从爬取的 HTML 和 URL 路径中检测网页实际语言。
 * 优先级：
 *   1. URL 路径语言前缀（最可靠：服务器按访客 IP 已做重定向）
 *   2. <html lang="..."> 属性
 *   3. <meta http-equiv="content-language" content="...">
 *
 * 返回 Google Ads 语言 code（如 "nl", "fr", "de"），检测不到返回 null。
 */
export function detectPageLanguage(html: string | null | undefined, pageUrl?: string): string | null {
  // HTML BCP-47 tag → Google Ads lang code 映射表
  const BCP47_TO_GADS: Record<string, string> = {
    en: "en", "en-us": "en", "en-gb": "en", "en-au": "en", "en-ca": "en",
    "en-ie": "en", "en-nz": "en", "en-sg": "en", "en-in": "en", "en-hk": "en",
    nl: "nl", "nl-nl": "nl", "nl-be": "nl",
    fr: "fr", "fr-fr": "fr", "fr-be": "fr", "fr-ch": "fr",
    de: "de", "de-de": "de", "de-at": "de", "de-ch": "de",
    es: "es", "es-es": "es", "es-mx": "es", "es-ar": "es",
    it: "it", "it-it": "it",
    pt: "pt", "pt-pt": "pt", "pt-br": "pt",
    ja: "ja", "ja-jp": "ja",
    ko: "ko", "ko-kr": "ko",
    zh: "zh_CN", "zh-cn": "zh_CN", "zh-hans": "zh_CN",
    "zh-tw": "zh_TW", "zh-hant": "zh_TW", "zh-hk": "zh_TW",
    sv: "sv", "sv-se": "sv",
    da: "da", "da-dk": "da",
    no: "no", nb: "no", "nb-no": "no",
    fi: "fi", "fi-fi": "fi",
    pl: "pl", "pl-pl": "pl",
    cs: "cs", "cs-cz": "cs",
    ru: "ru", "ru-ru": "ru",
    tr: "tr", "tr-tr": "tr",
    th: "th", "th-th": "th",
    vi: "vi", "vi-vn": "vi",
    id: "id", "id-id": "id",
    ms: "ms", "ms-my": "ms",
    ar: "ar", "ar-sa": "ar", "ar-ae": "ar",
    he: "iw", "he-il": "iw", iw: "iw",
    el: "el", "el-gr": "el",
    ro: "ro", "ro-ro": "ro",
    hu: "hu", "hu-hu": "hu",
    bg: "bg", "bg-bg": "bg",
    hi: "hi", "hi-in": "hi",
    uk: "uk", "uk-ua": "uk",
  };

  // 优先检测：URL 路径语言/locale 前缀
  // /nl/ /nl-be/ /fr/ /fr-be/ /en-us/ /de/ 等
  if (pageUrl) {
    try {
      const pathname = new URL(pageUrl).pathname.toLowerCase();
      // 匹配 /xx/ 或 /xx-yy/ 开头
      const m = pathname.match(/^\/([a-z]{2}(?:-[a-z]{2})?)\//);
      if (m) {
        const seg = m[1];
        const mapped = BCP47_TO_GADS[seg];
        if (mapped) return mapped;
      }
    } catch {}
  }

  if (!html) return null;

  // 检测 <html lang="...">
  const htmlTagMatch = html.match(/<html[^>]+\blang=["']([^"']+)["']/i);
  if (htmlTagMatch) {
    const raw = htmlTagMatch[1].toLowerCase().trim();
    const mapped = BCP47_TO_GADS[raw] ?? BCP47_TO_GADS[raw.split("-")[0]];
    if (mapped) return mapped;
  }

  // 检测 <meta http-equiv="content-language" content="...">
  const metaLangMatch = html.match(/<meta[^>]+http-equiv=["']content-language["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+http-equiv=["']content-language["']/i);
  if (metaLangMatch) {
    const raw = metaLangMatch[1].toLowerCase().trim().split(",")[0].trim();
    const mapped = BCP47_TO_GADS[raw] ?? BCP47_TO_GADS[raw.split("-")[0]];
    if (mapped) return mapped;
  }

  return null;
}
