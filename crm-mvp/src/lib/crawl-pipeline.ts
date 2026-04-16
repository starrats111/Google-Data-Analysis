/**
 * 统一爬取管线 — 一次爬取，缓存复用
 * 被 merchants/route.ts（认领时缓存）和 generate-extensions/route.ts（AI 生成时读取）共用
 */
import { crawlPage, fetchUrlMeta, fetchPageImages, searchMerchantImages } from "@/lib/crawler";
import { getAdMarketConfig } from "@/lib/ad-market";
import { getProxyUrlForCountry, fetchViaProxy } from "@/lib/crawl-proxy";

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
  if (text[0] === "{" || text[0] === "[") return text;
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

const PROBE_UAS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
];

async function probeUrlReal(probeUrl: string, merchantDomain: string, proxyUrl?: string): Promise<{ url: string; title: string; desc: string } | null> {
  let lastFinalUrl = probeUrl;
  let wasBlocked = false;

  for (const ua of PROBE_UAS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const probeHeaders = { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,*/*", "Accept-Language": "en-US,en;q=0.9" };
      // 若有目标国家代理，通过代理探查，确保重定向后落在正确 locale（如 /en-us/）
      const res = proxyUrl
        ? await fetchViaProxy(probeUrl, { headers: probeHeaders, signal: ctrl.signal }, proxyUrl)
        : await fetch(probeUrl, { method: "GET", redirect: "follow", signal: ctrl.signal, headers: probeHeaders });
      clearTimeout(t);
      const finalUrl = (res as { url: string }).url || probeUrl;
      lastFinalUrl = finalUrl;

      try {
        const finalDomain = new URL(finalUrl).hostname.replace(/^www\./, "");
        if (!finalDomain.includes(merchantDomain) && !merchantDomain.includes(finalDomain)) return null;
      } catch { return null; }

      try { const p = new URL(finalUrl).pathname; if (p === "/" || p === "") return null; } catch {}
      // 403 可能是反爬但页面仍可读取，继续尝试下一个 UA；其余 4xx 直接排除
      if (res.status >= 400 && res.status !== 403) return null;

      const html = await res.text();
      if (!html || html.length < 500) continue;

      // 检测 Cloudflare/反爬拦截页面（Google Ads 审核时也会被拦截）
      if (/cf-browser-verification|cf-challenge|challenge-platform|turnstile/i.test(html)) return null;

      const lower = html.toLowerCase();
      const soft404 = ["page not found", "page introuvable", "seite nicht gefunden", "404", "not found", "does not exist"];
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const pageTitle = (titleMatch?.[1] || "").trim();
      if (soft404.some((s) => pageTitle.toLowerCase().includes(s))) return null;
      if (html.length < 5000 && soft404.some((s) => lower.includes(s))) return null;
      if (isBlockedTitle(pageTitle)) { wasBlocked = true; continue; }

      const cleanTitle = sanitizeAdText(smartTruncate(
        decodeHtmlEntities(pageTitle).replace(/\s*[\|–—]\s*[^|–—]{0,40}$/, "").replace(/\s*-\s*[A-Z][a-zA-Z\s]{0,30}$/, "").trim(), 25));

      const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)
        || html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']description["']/i);
      const desc = sanitizeAdText(smartTruncate(decodeHtmlEntities((descMatch?.[1] || "").trim()), 35), { allowExclamation: true });

      if (!cleanTitle || cleanTitle.length < 2) {
        const pathTitle = titleFromUrlPath(finalUrl);
        if (pathTitle.length >= 2) return { url: finalUrl, title: pathTitle, desc };
        continue;
      }
      return { url: finalUrl, title: cleanTitle, desc };
    } catch {}
  }

  if (wasBlocked) {
    const pathTitle = titleFromUrlPath(lastFinalUrl);
    if (pathTitle.length >= 2) return { url: lastFinalUrl, title: pathTitle, desc: "" };
  }
  return null;
}

/**
 * 生成候选 probe 路径。
 * - targetLocale: 若站点使用 /xx-yy/ locale 前缀（如 en-us），优先生成带 locale 的路径，
 *   避免直连从服务器 IP 访问时被重定向到首页（pathname="/"）而被过滤掉。
 * - 同时兜底生成不带 locale 的路径（适用于无 locale 前缀的站点）。
 */
function getCommonProbePaths(merchantUrl: string, targetLocale?: string): string[] {
  let origin = "";
  try { origin = new URL(merchantUrl).origin; } catch { return []; }

  const AD_PATHS = [
    // 主要品类
    "men", "women", "kids", "children",
    // 促销/活动
    "sale", "outlet", "new-arrivals", "new",
    "best-sellers", "featured", "collections",
    // 内容/品牌页面（时尚品牌常见）
    "discover", "studio", "editorial", "lookbook", "stories",
    // 鞋类
    "shoes", "boots", "sneakers", "loafers", "sandals",
    // 配件/服装
    "accessories", "bags", "clothing",
    // 通用
    "shop", "products", "promo",
  ];

  const paths: string[] = [];

  // 优先带 locale 前缀的路径（确保重定向后落在正确 locale，不会退回首页）
  if (targetLocale) {
    const locBase = `${origin}/${targetLocale}`;
    for (const p of AD_PATHS) paths.push(`${locBase}/${p}`);
  }

  // 不带 locale 的路径作为兜底（适用于无 locale 前缀的站点）
  for (const p of AD_PATHS) {
    const plain = `${origin}/${p}`;
    if (!paths.includes(plain)) paths.push(plain);
  }

  return paths;
}

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
 * 检测 URL 路径开头的 locale 段（如 /en-sg/ /fr-fr/）。
 * 若与 targetCountry 不匹配，尝试替换为目标 locale；不认识的 locale 则剥离。
 */
function normalizeLocaleInUrl(url: string, targetCountry: string): string {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/([a-z]{2}[-_][a-z]{2})\//i);
    if (!m) return url;
    const existingLocale = m[1].toLowerCase().replace("_", "-");
    const existingCountry = existingLocale.split("-")[1]?.toUpperCase();
    if (existingCountry === targetCountry.toUpperCase()) return url;
    const targetLocale = COUNTRY_TO_LOCALE[targetCountry.toUpperCase()];
    if (targetLocale) {
      u.pathname = "/" + targetLocale + u.pathname.slice(m[0].length - 1);
    } else {
      u.pathname = "/" + u.pathname.slice(m[0].length);
    }
    return u.toString();
  } catch { return url; }
}

async function discoverSitelinkCandidates(
  merchantUrl: string,
  pageLinks: { url: string; text: string }[],
  country?: string,
  puppeteerNavLinks?: { url: string; text: string }[],
): Promise<{ url: string; title: string; description: string }[]> {
  let merchantDomain = "";
  try { merchantDomain = new URL(merchantUrl).hostname.replace(/^www\./, ""); } catch {}
  const proxyUrl = country ? (await getProxyUrlForCountry(country) ?? undefined) : undefined;
  if (proxyUrl) console.log(`[Sitelinks] 使用 ${country} 代理探查候选链接`);
  else if (country) console.log(`[Sitelinks] 无 ${country} 代理，直连探查（locale 将按目标国家规范化）`);

  const candidates: { url: string; title: string; description: string }[] = [];
  const usedFinalUrls = new Set<string>();

  if (pageLinks.length > 0) {
    // 优先取路径层级浅（≤3段）、无查询参数的链接，最多尝试 15 条（之前 5 条太少）
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

    const metaResults = await Promise.all(
      linksToTry.map(async (link) => {
        try {
          const meta = await fetchUrlMeta(link.url, proxyUrl);
          return { link, meta };
        } catch {
          return { link, meta: { title: "", description: "", ok: false, finalUrl: link.url, isSoft404: false } };
        }
      }),
    );

    for (const { link, meta } of metaResults) {
      if (candidates.length >= 6) break;
      // 对 finalUrl 也做 locale 规范化：即使站点因 IP 地理位置重定向回了错误 locale，
      // 也将其纠正为目标国家 locale，确保提交给 Google Ads 的链接与目标市场一致
      const rawUrl = meta.finalUrl || link.url;
      const realUrl = country ? normalizeLocaleInUrl(rawUrl, country) : rawUrl;
      if (meta.isSoft404) continue;
      // 非 200 的 URL Google Ads 审核会拒登
      if (!meta.ok) continue;
      try { const p = new URL(realUrl).pathname; if (p === "/" || p === "") continue; } catch {}
      const normalizedUrl = realUrl.replace(/\/$/, "").replace(/^http:/, "https:");
      if (usedFinalUrls.has(normalizedUrl)) continue;
      usedFinalUrls.add(normalizedUrl);

      let title = "";
      if (meta.title && !isBlockedTitle(meta.title)) {
        title = sanitizeAdText(smartTruncate(decodeHtmlEntities(meta.title).replace(/\s*[\|–—]\s*[^|–—]{0,40}$/, "").replace(/\s*-\s*[A-Z][a-zA-Z\s]{0,30}$/, "").trim(), 25));
      }
      if (!title || title.length < 2) {
        const cleanLinkText = sanitizeAdText(decodeHtmlEntities(link.text.trim()));
        if (cleanLinkText.length >= 2 && !BAD_LINK_TEXTS.includes(cleanLinkText.toLowerCase())) title = smartTruncate(cleanLinkText, 25);
      }
      if (!title || title.length < 2) title = titleFromUrlPath(realUrl);

      let desc = "";
      if (meta.description) desc = sanitizeAdText(smartTruncate(decodeHtmlEntities(meta.description), 35), { allowExclamation: true });

      if (title.length >= 2) candidates.push({ url: realUrl, title, description: desc });
    }
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
            const meta = await fetchUrlMeta(link.url, proxyUrl);
            return { link, meta };
          } catch {
            return { link, meta: { title: "", description: "", ok: false, finalUrl: link.url, isSoft404: false } };
          }
        }),
      );

      for (const { link, meta } of navMetaResults) {
        if (candidates.length >= 6) break;
        const rawUrl = meta.finalUrl || link.url;
        const realUrl = country ? normalizeLocaleInUrl(rawUrl, country) : rawUrl;
        if (meta.isSoft404 || !meta.ok) continue;
        try { const p = new URL(realUrl).pathname; if (p === "/" || p === "") continue; } catch {}
        const norm = realUrl.replace(/\/$/, "").replace(/^http:/, "https:");
        if (existingNormalized.has(norm)) continue;
        existingNormalized.add(norm);
        let title = "";
        if (meta.title && !isBlockedTitle(meta.title)) {
          title = sanitizeAdText(smartTruncate(decodeHtmlEntities(meta.title).replace(/\s*[\|–—]\s*[^|–—]{0,40}$/, "").replace(/\s*-\s*[A-Z][a-zA-Z\s]{0,30}$/, "").trim(), 25));
        }
        if (!title || title.length < 2) {
          const cleanLinkText = sanitizeAdText(decodeHtmlEntities(link.text.trim()));
          if (cleanLinkText.length >= 2 && !BAD_LINK_TEXTS.includes(cleanLinkText.toLowerCase())) title = smartTruncate(cleanLinkText, 25);
        }
        if (!title || title.length < 2) title = titleFromUrlPath(realUrl);
        let desc = "";
        if (meta.description) desc = sanitizeAdText(smartTruncate(decodeHtmlEntities(meta.description), 35), { allowExclamation: true });
        if (title.length >= 2) candidates.push({ url: realUrl, title, description: desc });
      }
    }

    // 仍不足 6 条时，回退到 getCommonProbePaths（通用探查路径）
    if (candidates.length < 6) {
      // 检测站点是否使用 /xx-yy/ locale 前缀（从 pageLinks 或 merchantUrl 推断）
      let detectedLocaleInSite = false;
      const localeSegRe = /^\/([a-z]{2}[-_][a-z]{2})\//i;
      if (localeSegRe.test((() => { try { return new URL(merchantUrl).pathname; } catch { return ""; } })())) {
        detectedLocaleInSite = true;
      } else {
        detectedLocaleInSite = pageLinks.slice(0, 20).some(l => {
          try { return localeSegRe.test(new URL(l.url).pathname); } catch { return false; }
        });
      }
      // 只有确认站点使用 locale 前缀时才传 targetLocale，避免对无 locale 的站点生成错误路径
      const targetLocale = detectedLocaleInSite && country
        ? (COUNTRY_TO_LOCALE[country.toUpperCase()] ?? undefined)
        : undefined;
      if (targetLocale) console.log(`[Sitelinks] 检测到 locale 前缀站点，使用 /${targetLocale}/ 生成探查路径`);

      const probePaths = getCommonProbePaths(merchantUrl, targetLocale);
      for (let i = 0; i < probePaths.length && candidates.length < 6; i += 5) {
        const results = await Promise.all(probePaths.slice(i, i + 5).map((p) => probeUrlReal(p, merchantDomain, proxyUrl)));
        for (const r of results) {
          if (!r || candidates.length >= 6) continue;
          const rUrl = country ? normalizeLocaleInUrl(r.url, country) : r.url;
          const norm = rUrl.replace(/\/$/, "").replace(/^http:/, "https:");
          if (existingNormalized.has(norm)) continue;
          existingNormalized.add(norm);
          candidates.push({ url: rUrl, title: r.title, description: r.desc });
        }
      }
    }
  }

  return candidates.slice(0, 6);
}

// ─── 图片收集 ───

async function collectImages(
  crawlImages: string[],
  links: { url: string; text: string }[],
  merchantUrl: string,
  merchantName: string,
  puppeteerImages?: string[],
): Promise<string[]> {
  const allImgs = [...crawlImages];

  if (allImgs.length < 60 && links.length > 0) {
    const subPages = links.slice(0, 9).map((l) => l.url);
    for (let i = 0; i < subPages.length; i += 3) {
      const batch = subPages.slice(i, i + 3);
      const batchResults = await Promise.all(batch.map((u) => fetchPageImages(u).catch(() => [] as string[])));
      for (const imgs of batchResults) for (const img of imgs) {
        if (allImgs.length >= 80) break;
        if (!allImgs.includes(img)) allImgs.push(img);
      }
    }
  }

  if (allImgs.length === 0 && merchantUrl) {
    try {
      const searchImgs = await searchMerchantImages(merchantUrl, merchantName);
      for (const img of searchImgs) { if (allImgs.length >= 80) break; if (!allImgs.includes(img)) allImgs.push(img); }
    } catch {}
  }

  // Puppeteer DOM 提取的图片：图片仍不足时补充
  if (allImgs.length < 3 && puppeteerImages && puppeteerImages.length > 0) {
    const { isQualityImageUrl } = await import("@/lib/crawler");
    for (const img of puppeteerImages) {
      if (allImgs.length >= 80) break;
      if (!allImgs.includes(img) && isQualityImageUrl(img)) allImgs.push(img);
    }
    console.log(`[CollectImages] Puppeteer 补图后，图片数量: ${allImgs.length}`);
  }

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
  let crawlResult = { html: "", links: [] as { url: string; text: string }[], images: [] as string[], method: "failed", error: "" };

  if (merchantUrl) {
    if (options?.forcePuppeteer) {
      // 促销数据通常由 JS 渲染，直接用 Puppeteer 保证获取完整 DOM
      const { crawlPageWithPuppeteer } = await import("@/lib/crawler");
      const puppeteerHtml = await crawlPageWithPuppeteer(merchantUrl);
      if (puppeteerHtml) {
        const { extractLinksAndImages } = await import("@/lib/crawler");
        const { links, images } = extractLinksAndImages(puppeteerHtml, merchantUrl);
        crawlResult = { html: puppeteerHtml.slice(0, 150000), links, images, method: "puppeteer" };
        console.log(`[CrawlPipeline] Puppeteer 爬取成功（forcePuppeteer），html 长度: ${crawlResult.html.length}`);
      } else {
        // Puppeteer 失败则回退到普通爬取
      crawlResult = await crawlPage(merchantUrl, country);
      console.log(`[CrawlPipeline] Puppeteer 失败，回退 HTTP 爬取`);
    }
  } else {
      crawlResult = await crawlPage(merchantUrl, country);
    }
  }

  crawlResult.links = crawlResult.links.filter((l) => !isBadSitelinkUrl(l.url));
  const crawlFailed = crawlResult.method === "failed";
  let html = crawlResult.html;

  // sitemap / backend API 路径爬取成功但 html 为空，补发一次 HTTP fetch 用于数据提取
  if (!crawlFailed && !html && merchantUrl) {
    try {
      const { getAcceptLanguage } = await import("@/lib/crawler");
      const fallbackResp = await fetch(merchantUrl, {
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
      // 补救失败忽略，提取结果为空
    }
  }

  // ─── Splash 页面检测：links=0 时说明爬到的是引导/启动画面，直接尝试 locale 专属 URL ───
  if (crawlResult.links.length === 0 && merchantUrl && country) {
    const targetLocale = COUNTRY_TO_LOCALE[country.toUpperCase()];
    if (targetLocale) {
      try {
        const u = new URL(merchantUrl);
        // 仅在 merchantUrl 本身没有 locale 前缀时才追加
        if (!u.pathname.match(/^\/[a-z]{2}[-_][a-z]{2}\//i)) {
          u.pathname = "/" + targetLocale + "/";
          const localeUrl = u.toString();
          console.log(`[CrawlPipeline] links=0（可能是 splash 页），尝试 locale URL: ${localeUrl}`);
          const localeCrawlResult = await crawlPage(localeUrl, country);
          if (localeCrawlResult.links.length > 0) {
            crawlResult = localeCrawlResult;
            html = localeCrawlResult.html || html;
            console.log(`[CrawlPipeline] locale URL 爬取成功，links: ${crawlResult.links.length}, images: ${crawlResult.images.length}`);
          }
        }
      } catch (e) {
        console.warn("[CrawlPipeline] locale URL 尝试失败:", e instanceof Error ? e.message : e);
      }
    }
    // 重新过滤坏链接（locale 爬取的结果可能带新链接）
    crawlResult.links = crawlResult.links.filter((l) => !isBadSitelinkUrl(l.url));
  }

  // ─── 数据充足性检测：图片 < 3 或有效链接 < 8 时，启动 Puppeteer 全量抓取 ───
  let puppeteerCache: import("@/lib/crawler").PuppeteerPageData | null = null;
  if (crawlResult.method !== "puppeteer" && merchantUrl && (crawlResult.images.length < 3 || crawlResult.links.length < 8)) {
    console.log(`[CrawlPipeline] 数据不足（images: ${crawlResult.images.length}, links: ${crawlResult.links.length}），启动 Puppeteer 全量抓取`);
    try {
      const { crawlWithPuppeteerFull } = await import("@/lib/crawler");
      // 使用已检测的 locale URL（如果存在）进行 Puppeteer 全量抓取
      const crawlTarget = (() => {
        if (!country) return merchantUrl;
        const loc = COUNTRY_TO_LOCALE[country.toUpperCase()];
        if (!loc) return merchantUrl;
        try {
          const u = new URL(merchantUrl);
          if (!u.pathname.match(/^\/[a-z]{2}[-_][a-z]{2}\//i)) {
            u.pathname = "/" + loc + "/";
            return u.toString();
          }
        } catch {}
        return merchantUrl;
      })();
      puppeteerCache = await crawlWithPuppeteerFull(crawlTarget);
      if (puppeteerCache) {
        if (!html) html = puppeteerCache.html.slice(0, 150000);
        const newImgs = puppeteerCache.images.filter(i => !crawlResult.images.includes(i));
        crawlResult.images = [...crawlResult.images, ...newImgs];
        // 若 Puppeteer 从 locale URL 获取到了链接，也更新 crawlResult.links
        if (crawlResult.links.length === 0 && puppeteerCache.navLinks.length > 0) {
          crawlResult.links = puppeteerCache.navLinks.filter(l => !isBadSitelinkUrl(l.url));
        }
        console.log(`[CrawlPipeline] Puppeteer 全量抓取成功，navLinks: ${puppeteerCache.navLinks.length}, images: ${puppeteerCache.images.length}`);
      }
    } catch (e) {
      console.warn("[CrawlPipeline] crawlWithPuppeteerFull 失败:", e instanceof Error ? e.message : e);
    }
  }

  // ─── 促销子页面专项爬取：从已发现链接中找促销/活动相关 URL 爬取以补充 meta 描述 ───
  const extractPromoWithSubPage = async (): Promise<Record<string, unknown> | null> => {
    // 先从主页 HTML 提取
    const mainPromo = html ? extractPromotionInfo(html, merchantUrl, country) : null;
    if (mainPromo?.discount_type) return mainPromo; // 主页已有真实折扣，无需继续

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
          console.log(`[PromoExtract] 从子页面提取成功: ${link.url}`);
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
      const { crawlPageWithPuppeteer } = await import("@/lib/crawler");
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

  // 并行执行所有提取任务
  const [sitelinkCandidates, images, features, navItems, phoneCandidates, promoRegex, priceRegex, crawledProducts] = await Promise.all([
    discoverSitelinkCandidates(merchantUrl, crawlResult.links, country, puppeteerCache?.navLinks).catch(() => []),
    collectImages(crawlResult.images, crawlResult.links, merchantUrl, merchantName, puppeteerCache?.images).catch(() => [] as string[]),
    Promise.resolve(html ? extractMerchantFeatures(html, [...(puppeteerCache?.heroTexts ?? []), ...(puppeteerCache?.uspTexts ?? [])]) : []),
    Promise.resolve(html ? extractNavItems(html, puppeteerCache?.categoryNames) : []),
    Promise.resolve(html ? extractPhoneCandidates(html, country) : []),
    extractPromoWithSubPage().catch(() => null),
    extractPriceWithProductPages().catch(() => [] as ReturnType<typeof extractPriceInfo>),
    Promise.resolve(html ? extractProducts(html, merchantUrl, country) : []),
  ]);

  const pageText = html ? htmlToText(html).slice(0, 10000) : "";

  // 检测站点是否使用 /xx-yy/ locale 前缀，若是则为当前目标国家计算本地化落地页 URL
  let localizedMerchantUrl: string | undefined;
  if (merchantUrl && country) {
    const localeSegRe = /^\/([a-z]{2}[-_][a-z]{2})\//i;
    // 优先从 crawlResult.links 检测，其次从 Puppeteer navLinks 补充
    const allLinksForLocaleCheck = [
      ...crawlResult.links.slice(0, 30),
      ...(puppeteerCache?.navLinks ?? []).slice(0, 20),
    ];
    const siteUsesLocale = allLinksForLocaleCheck.some(l => {
      try { return localeSegRe.test(new URL(l.url).pathname); } catch { return false; }
    });
    if (siteUsesLocale) {
      const targetLocale = COUNTRY_TO_LOCALE[country.toUpperCase()];
      if (targetLocale) {
        try {
          const u = new URL(merchantUrl);
          const existingLocaleMatch = u.pathname.match(/^\/([a-z]{2}[-_][a-z]{2})(\/|$)/i);
          if (existingLocaleMatch) {
            // 替换已有的 locale 前缀
            u.pathname = "/" + targetLocale + u.pathname.slice(existingLocaleMatch[0].length - 1);
          } else {
            // 插入 locale 前缀（保留原有路径）
            u.pathname = "/" + targetLocale + (u.pathname === "/" ? "/" : u.pathname);
          }
          localizedMerchantUrl = u.toString();
          if (localizedMerchantUrl !== merchantUrl) {
            console.log(`[CrawlPipeline] 检测到 locale 站点，落地页本地化: ${merchantUrl} → ${localizedMerchantUrl}`);
          }
        } catch {}
      }
    }
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
  };
  } finally {
    releaseCrawlSlot();
  }
}
