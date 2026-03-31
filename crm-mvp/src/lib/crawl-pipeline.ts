/**
 * 统一爬取管线 — 一次爬取，缓存复用
 * 被 merchants/route.ts（认领时缓存）和 generate-extensions/route.ts（AI 生成时读取）共用
 */
import { crawlPage, fetchUrlMeta, fetchPageImages, searchMerchantImages } from "@/lib/crawler";
import { getAdMarketConfig } from "@/lib/ad-market";

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

export function extractMerchantFeatures(html: string): string[] {
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

  return features;
}

export function extractPromotionInfo(html: string, sourceUrl: string, country: string): Record<string, unknown> | null {
  if (!html) return null;
  const lower = html.toLowerCase();
  const result: Record<string, unknown> = {};
  const market = getAdMarketConfig(country);

  // 只从促销相关区域（banner/topbar/promo）提取折扣信息，避免匹配到正文中的无关数字
  const promoZoneRegex = /<(?:div|span|p|a|header|section)[^>]*class=["'][^"']*(?:banner|announcement|promo|hero|notice|topbar|top-bar|sale-bar|offer|discount|coupon|deal)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p|a|header|section)>/gi;
  let promoZoneMatch;
  const promoZoneTexts: string[] = [];
  while ((promoZoneMatch = promoZoneRegex.exec(html)) !== null) {
    const text = promoZoneMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length > 3 && text.length < 200) promoZoneTexts.push(text);
  }
  const promoZoneText = promoZoneTexts.join(" ");

  // 优先从促销区域提取具体折扣数字，而非全页匹配
  const zoneToSearch = promoZoneText || "";
  const percentMatch = zoneToSearch.match(/(?:up\s+to\s+)?(\d{1,2})\s*%\s*(?:off|discount|sale|rabatt|remise|sconto)/i)
    || zoneToSearch.match(/(?:save|get|enjoy)\s+(\d{1,2})\s*%/i);
  if (percentMatch) {
    const pct = parseInt(percentMatch[1], 10);
    if (pct >= 5 && pct <= 90) {
      result.discount_type = "PERCENT";
      result.discount_percent = pct;
    }
  }

  const moneyMatch = zoneToSearch.match(/(?:save|get|rabatt|remise|sconto|descuento)\s*(?:[$€£]|chf\s*)?(\d{1,4})/i)
    || zoneToSearch.match(/(?:[$€£]|chf\s*)(\d{1,4})\s*(?:off|rabatt|remise|sconto|descuento)/i);
  if (moneyMatch && !result.discount_type) {
    const amt = parseInt(moneyMatch[1], 10);
    if (amt >= 1 && amt <= 5000) {
      result.discount_type = "MONETARY";
      result.discount_amount = amt;
      result.currency_code = market.currencyCode;
    }
  }

  const codeMatch = html.match(/(?:code|coupon|promo|voucher|gutschein|codice)[:\s]+["']?([A-Z0-9]{3,20})["']?/i)
    || html.match(/(?:use|enter|apply)\s+(?:code\s+)?["']?([A-Z0-9]{4,20})["']?/i);
  if (codeMatch) result.promo_code = codeMatch[1].toUpperCase();

  if (promoZoneTexts.length > 0 && /\d/.test(promoZoneTexts[0])) {
    result.promotion_target = smartTruncate(promoZoneTexts[0], 20);
  }

  const hasFreeShipping = /free\s*(?:standard\s*)?(?:shipping|delivery)|kostenlos(?:e|er)?\s+versand|livraison\s+offerte|env[ií]o\s+gratis|spedizione\s+gratuita/i.test(lower);
  if (hasFreeShipping && !result.promotion_target) {
    result.promotion_target = market.genericPromotionTarget;
  }

  // 仅当 title 中明确含有折扣关键词+数字时才从 title 提取
  if (!result.promotion_target && !result.discount_type) {
    const titleMatch2 = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch2) {
      const title = titleMatch2[1].replace(/\s+/g, " ").trim();
      if (/\d+%\s*off/i.test(title)) result.promotion_target = smartTruncate(title, 20);
    }
  }

  // 如果没有具体折扣数字但页面有一般性优惠/促销关键词，仅标记"有优惠"
  const hasGenericPromo = !result.discount_type && (
    /(?:sale|deals?|special\s+offer|limited\s+time|clearance)\b/i.test(promoZoneText) ||
    /(?:sale|deals?|special\s+offer)\b/i.test(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || "")
  );
  if (hasGenericPromo && !result.promotion_target) {
    result.promotion_target = market.genericPromotionTarget;
    result.has_generic_promo = true;
  }

  result.final_url = sourceUrl;
  if (result.promotion_target) {
    result.promotion_target = smartTruncate(String(result.promotion_target), 20);
    result.language_code = market.promotionLanguageCode;
  }
  if (result.discount_type === "MONETARY" && !result.currency_code) result.currency_code = market.currencyCode;
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
              items.push({
                header: String(p.name).slice(0, 25), description: String(p.description || p.name).slice(0, 25),
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
        productName = decodeHtmlEntities(nameMatch[1].trim()).slice(0, 25);
      }
      const linkMatch = block.match(/<a[^>]+href=["']([^"'#][^"']*?)["']/i);
      const productUrl = linkMatch?.[1] || sourceUrl || "";

      if (productName && productName.length >= 2) {
        items.push({ header: productName, description: "", price, currency: market.currencyCode, url: productUrl });
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

function extractNavItems(html: string): string[] {
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
  return navItems;
}

function extractPhoneCandidates(html: string, country: string): { country_code: string; phone_number: string }[] {
  const phoneRegex = /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;
  const telRegex = /href=["']tel:([^"']+)["']/gi;
  const candidates: string[] = [];

  let telMatch;
  while ((telMatch = telRegex.exec(html)) !== null) {
    const phone = decodeURIComponent(telMatch[1]).replace(/\s+/g, "").trim();
    if (phone.length >= 7 && phone.length <= 20) candidates.push(phone);
  }

  const textOnly = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const phoneMatches = textOnly.match(phoneRegex) || [];
  for (const p of phoneMatches) {
    const clean = p.replace(/\s+/g, "").trim();
    if (clean.length >= 7 && clean.length <= 20 && !candidates.includes(clean)) candidates.push(clean);
  }

  const COUNTRY_PHONE_CODE: Record<string, string> = {
    US: "US", CA: "CA", GB: "GB", UK: "GB", AU: "AU",
    DE: "DE", FR: "FR", JP: "JP", BR: "BR", IT: "IT",
    ES: "ES", NL: "NL", SE: "SE", NO: "NO", DK: "DK",
  };
  const countryCode = COUNTRY_PHONE_CODE[country.toUpperCase()] || "US";

  return candidates.slice(0, 3).map((phone) => ({ country_code: countryCode, phone_number: phone }));
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── 站内链接发现 ───

const PROBE_UAS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
];

async function probeUrlReal(probeUrl: string, merchantDomain: string): Promise<{ url: string; title: string; desc: string } | null> {
  let lastFinalUrl = probeUrl;
  let wasBlocked = false;

  for (const ua of PROBE_UAS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(probeUrl, {
        method: "GET", redirect: "follow", signal: ctrl.signal,
        headers: { "User-Agent": ua, Accept: "text/html,application/xhtml+xml,*/*", "Accept-Language": "en-US,en;q=0.9" },
      });
      clearTimeout(t);
      const finalUrl = res.url || probeUrl;
      lastFinalUrl = finalUrl;

      try {
        const finalDomain = new URL(finalUrl).hostname.replace(/^www\./, "");
        if (!finalDomain.includes(merchantDomain) && !merchantDomain.includes(finalDomain)) return null;
      } catch { return null; }

      try { const p = new URL(finalUrl).pathname; if (p === "/" || p === "") return null; } catch {}
      // 400+ 状态码说明 Google 爬虫也访问不了，直接排除
      if (res.status >= 400) return null;

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

function getCommonProbePaths(merchantUrl: string): string[] {
  let origin = "";
  try { origin = new URL(merchantUrl).origin; } catch { return []; }
  return [
    `${origin}/collections`, `${origin}/collections/all`, `${origin}/products`, `${origin}/shop`,
    `${origin}/sale`, `${origin}/new`, `${origin}/new-arrivals`, `${origin}/best-sellers`,
    `${origin}/about`, `${origin}/contact`, `${origin}/pages/about`, `${origin}/pages/contact`,
    `${origin}/categories`, `${origin}/catalog`, `${origin}/promo`, `${origin}/men`, `${origin}/women`,
  ];
}

const BAD_LINK_TEXTS = ["click here", "read more", "learn more", "see more", "view more", "here", "link", "click"];

async function discoverSitelinkCandidates(
  merchantUrl: string,
  pageLinks: { url: string; text: string }[],
): Promise<{ url: string; title: string; description: string }[]> {
  let merchantDomain = "";
  try { merchantDomain = new URL(merchantUrl).hostname.replace(/^www\./, ""); } catch {}

  const candidates: { url: string; title: string; description: string }[] = [];
  const usedFinalUrls = new Set<string>();

  if (pageLinks.length > 0) {
    const metaResults = await Promise.all(
      pageLinks.slice(0, 15).map(async (link) => {
        try {
          const meta = await fetchUrlMeta(link.url);
          return { link, meta };
        } catch {
          return { link, meta: { title: "", description: "", ok: false, finalUrl: link.url, isSoft404: false } };
        }
      }),
    );

    for (const { link, meta } of metaResults) {
      if (candidates.length >= 6) break;
      const realUrl = meta.finalUrl || link.url;
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
    const probePaths = getCommonProbePaths(merchantUrl);
    const existingNormalized = new Set(candidates.map((c) => c.url.replace(/\/$/, "").replace(/^http:/, "https:")));
    for (let i = 0; i < probePaths.length && candidates.length < 6; i += 5) {
      const results = await Promise.all(probePaths.slice(i, i + 5).map((p) => probeUrlReal(p, merchantDomain)));
      for (const r of results) {
        if (!r || candidates.length >= 6) continue;
        const norm = r.url.replace(/\/$/, "").replace(/^http:/, "https:");
        if (existingNormalized.has(norm)) continue;
        existingNormalized.add(norm);
        candidates.push({ url: r.url, title: r.title, description: r.desc });
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
): Promise<string[]> {
  const allImgs = [...crawlImages];

  if (allImgs.length < 25 && links.length > 0) {
    const subPages = links.slice(0, 9).map((l) => l.url);
    const batchResults = await Promise.all(subPages.map((u) => fetchPageImages(u).catch(() => [] as string[])));
    for (const imgs of batchResults) for (const img of imgs) {
      if (allImgs.length >= 40) break;
      if (!allImgs.includes(img)) allImgs.push(img);
    }
  }

  if (allImgs.length === 0 && merchantUrl) {
    try {
      const searchImgs = await searchMerchantImages(merchantUrl, merchantName);
      for (const img of searchImgs) { if (allImgs.length >= 40) break; if (!allImgs.includes(img)) allImgs.push(img); }
    } catch {}
  }

  return allImgs;
}

// ─── 主函数：构建爬取缓存 ───

export async function buildCrawlCache(
  merchantUrl: string,
  merchantName: string,
  country: string,
  semrushData?: { titles: string[]; descriptions: string[] },
): Promise<CrawlCache> {
  let crawlResult = { html: "", links: [] as { url: string; text: string }[], images: [] as string[], method: "failed", error: "" };

  if (merchantUrl) {
    crawlResult = await crawlPage(merchantUrl);
  }

  crawlResult.links = crawlResult.links.filter((l) => !isBadSitelinkUrl(l.url));
  const crawlFailed = crawlResult.method === "failed";
  const html = crawlResult.html;

  // 并行执行所有提取任务
  const [sitelinkCandidates, images, features, navItems, phoneCandidates, promoRegex, priceRegex, crawledProducts] = await Promise.all([
    discoverSitelinkCandidates(merchantUrl, crawlResult.links).catch(() => []),
    collectImages(crawlResult.images, crawlResult.links, merchantUrl, merchantName).catch(() => [] as string[]),
    Promise.resolve(html ? extractMerchantFeatures(html) : []),
    Promise.resolve(html ? extractNavItems(html) : []),
    Promise.resolve(html ? extractPhoneCandidates(html, country) : []),
    Promise.resolve(html ? extractPromotionInfo(html, merchantUrl, country) : null),
    Promise.resolve(html ? extractPriceInfo(html, country, merchantUrl) : []),
    Promise.resolve(html ? extractProducts(html, merchantUrl, country) : []),
  ]);

  const pageText = html ? htmlToText(html).slice(0, 4000) : "";

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
  };
}
