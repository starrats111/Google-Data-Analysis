import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { callAiWithFallback, suggestDisplayPaths } from "@/lib/ai-service";
import { getAdMarketConfig, resolveLanguageName } from "@/lib/ad-market";
import { buildAiRulePrompt, checkItemViolations } from "@/lib/ai-rule-profile";
import {
  type CrawlCache,
  buildCrawlCache,
  extractMerchantFeatures,
  extractPromotionInfo,
  extractPriceInfo,
  extractJsonFromAi,
  smartTruncate,
  titleFromUrlPath,
  decodeHtmlEntities,
  sanitizeAdText,
} from "@/lib/crawl-pipeline";
import { humanizeAdCopyBatch, AD_COPY_ANTI_AI_BLOCK } from "@/lib/humanizer";

function formatAiRuleBlock(profile: unknown | null | undefined, section: "sitelinks" | "ad_copy" | "compliance"): string {
  if (!profile) return "";
  const text = buildAiRulePrompt(profile, section);
  return text ? `\nUser hard rules (MUST follow):\n${text}\n` : "";
}

/**
 * AI 语义缩略：将超过 maxLen 的文案用 AI 缩写，保留核心含义和商业意图
 * 一次调用批量处理所有超长项，失败时降级为 smartTruncate
 */
async function condenseOverlong(items: string[], maxLen: number, languageName: string): Promise<string[]> {
  const overlong = items
    .map((text, idx) => ({ idx, text }))
    .filter((item) => item.text.length > maxLen);
  if (overlong.length === 0) return items;

  // 单条 AI 精简（用于批量失败后的逐条重试）
  const condenseSingle = async (text: string): Promise<string> => {
    try {
      const raw = await callAiWithFallback(
        "ad_copy",
        [{
          role: "user",
          content: `Rewrite this Google Ads text to fit within ${maxLen} characters. Keep the core meaning, brand names, and key selling points. Remove filler words. Write in ${languageName}.\n\nOriginal (${text.length} chars): "${text}"\n\nOutput ONLY the rewritten text, nothing else. It MUST be ≤${maxLen} characters.`,
        }],
        120,
      );
      const result = raw.trim().replace(/^["']|["']$/g, "");
      if (result.length >= 2 && result.length <= maxLen) return result;
    } catch {}
    return text; // AI 失败返回原文，不硬截断
  };

  try {
    const condensedPrompt = `Condense each line to ≤${maxLen} characters. Keep the same language (${languageName}). Preserve brand names, numbers, and key selling points. Do NOT add new information.

${overlong.map((item, i) => `${i + 1}. "${item.text}" (${item.text.length} chars → must be ≤${maxLen})`).join("\n")}

Return ONLY a JSON array of condensed strings in the same order. Every string MUST be ≤${maxLen} characters.`;
    const rawResult = await callAiWithFallback("ad_copy", [{ role: "user", content: condensedPrompt }], 1024);
    const condensed = JSON.parse(extractJsonFromAi(rawResult));
    if (!Array.isArray(condensed) || condensed.length !== overlong.length) throw new Error("AI 返回数量不匹配");

    const result = [...items];
    for (let i = 0; i < overlong.length; i++) {
      const c = String(condensed[i] || "").trim();
      if (c.length >= 2 && c.length <= maxLen) {
        result[overlong[i].idx] = c;
      } else {
        // 批量精简后仍超长，逐条再精简一次
        result[overlong[i].idx] = await condenseSingle(overlong[i].text);
      }
    }
    console.log(`[condenseOverlong] AI 缩略 ${overlong.length} 条超长文案 (maxLen=${maxLen})`);
    return result;
  } catch (err) {
    console.warn("[condenseOverlong] 批量 AI 缩略失败，逐条重试:", err instanceof Error ? err.message : err);
    const result = [...items];
    for (const item of overlong) {
      result[item.idx] = await condenseSingle(item.text);
    }
    return result;
  }
}

const MAX_COMPLIANCE_RETRIES = 3;

async function complianceAutoFix(
  items: string[],
  type: "headline" | "description",
  merchantName: string,
  languageName: string,
  aiRuleProfile: unknown,
  maxLen: number,
  minLen: number,
): Promise<{ items: string[]; fixed: string[]; remaining: string[] }> {
  let current = [...items];
  const allFixed: string[] = [];

  for (let attempt = 0; attempt < MAX_COMPLIANCE_RETRIES; attempt++) {
    const violations = checkItemViolations(current, aiRuleProfile);
    if (violations.length === 0) return { items: current, fixed: allFixed, remaining: [] };

    const label = type === "headline" ? "标题" : "描述";
    console.log(`[complianceAutoFix] ${label}第${attempt + 1}次修复: ${violations.length} 条违规`);

    const avoidReasons = [...new Set(violations.flatMap((v) => v.reasons))];
    const violatingTexts = violations.map((v) => v.text.toLowerCase());

    const prompt = `Generate ${violations.length} replacement Google Ads RSA ${type === "headline" ? "headlines" : "descriptions"}.
Merchant: ${merchantName}, Language: ${languageName}

The following were REJECTED for policy violations and need replacements:
${violations.map((v, i) => `${i + 1}. "${v.text}" — reason: ${v.reasons.join(", ")}`).join("\n")}

CRITICAL AVOIDANCE RULES — your output will be auto-checked, violations cause rejection:
${avoidReasons.map((r) => `- MUST NOT trigger: ${r}`).join("\n")}
- Never use these exact words: guaranteed, risk-free, zero risk, 100% safe, cure, cures, miracle, heal, heals, instant approval, before and after
- Use factual, benefit-driven language instead of absolute promises or medical claims
- Each ${type === "headline" ? "headline" : "description"}: ${minLen}-${maxLen} characters
- IMPORTANT: Write COMPLETELY DIFFERENT content from the rejected items, do not just rephrase them
Return ONLY a JSON array of ${violations.length} strings.`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 1024);
      const parsed = JSON.parse(extractJsonFromAi(raw));
      if (Array.isArray(parsed)) {
        for (let i = 0; i < violations.length && i < parsed.length; i++) {
          const replacement = String(parsed[i] || "").trim();
          if (replacement.length >= minLen && replacement.length <= maxLen) {
            allFixed.push(`「${violations[i].text}」→「${replacement}」`);
            current[violations[i].index] = replacement;
          }
        }
      }
    } catch (err) {
      console.warn(`[complianceAutoFix] ${label}第${attempt + 1}次重生成失败:`, err instanceof Error ? err.message : err);
      break;
    }
  }

  // 最终检查：仍然违规的直接删除，不保留
  const finalViolations = checkItemViolations(current, aiRuleProfile);
  const remaining: string[] = [];
  if (finalViolations.length > 0) {
    const label = type === "headline" ? "标题" : "描述";
    const removeIndices = new Set(finalViolations.map((v) => v.index));
    for (const v of finalViolations) {
      remaining.push(`${label}「${v.text}」已删除（${v.reasons.join("、")}）`);
    }
    current = current.filter((_, idx) => !removeIndices.has(idx));
    console.log(`[complianceAutoFix] ${label}最终删除 ${finalViolations.length} 条无法修复的违规项`);
  }

  return { items: current, fixed: allFixed, remaining };
}

/**
 * POST /api/user/ad-creation/generate-extensions
 *
 * types 支持:
 *   "core"    → 1 次 AI 生成标题(15) + 描述(4) + 站内链接描述 + 图片筛选
 *   "optional" + optionalTypes: ["callouts","promotion","price","call","snippet"]
 *              → 1 次 AI 批量生成所有勾选的可选扩展
 *
 * 数据来自 ad_creatives.crawl_cache（认领时已缓存），缺失时现场爬取
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  let body: any;
  try {
    body = await req.json();
  } catch (e) {
    console.error("[Extensions] 请求体 JSON 解析失败:", e instanceof Error ? e.message : e);
    return apiError("请求体格式错误");
  }
  const { campaign_id, types = [], ad_language, keywords: requestKeywords = [] } = body;
  if (!campaign_id) {
    console.warn("[Extensions] 400: 缺少 campaign_id, body:", JSON.stringify(body).slice(0, 200));
    return apiError("缺少 campaign_id");
  }
  if (!types.length) {
    console.warn("[Extensions] 400: 缺少 types, campaign_id:", campaign_id);
    return apiError("缺少 types");
  }

  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaign_id), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!campaign) {
    console.warn(`[Extensions] 404: 广告系列不存在, campaign_id=${campaign_id}, user_id=${user.userId}`);
    return apiError("广告系列不存在", 404);
  }

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
  });
  if (!merchant) {
    console.warn(`[Extensions] 400: 商家不存在, user_merchant_id=${campaign.user_merchant_id}, campaign_id=${campaign_id}`);
    return apiError("商家不存在");
  }

  const adGroup = await prisma.ad_groups.findFirst({
    where: { campaign_id: campaign.id, is_deleted: 0 },
    select: { id: true },
  });
  const adCreative = adGroup
    ? await prisma.ad_creatives.findFirst({
      where: { ad_group_id: adGroup.id, is_deleted: 0 },
      select: { id: true, final_url: true, crawl_cache: true },
    })
    : null;

  // 优先使用用户明确设定的落地页 URL（用户可能已改成本地化路径如 /en-us/）
  // merchant_url 是商家层面的默认 URL，可能带旧地区前缀（如 /en-sg/）
  let merchantUrl = adCreative?.final_url || merchant.merchant_url || "";
  const merchantName = merchant.merchant_name || "";
  const country = campaign.target_country || "US";
  const market = getAdMarketConfig(country);

  const adSettings = await prisma.ad_default_settings.findFirst({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
    select: { ai_rule_profile: true, daily_budget: true, max_cpc: true, bidding_strategy: true },
  });
  const aiRuleProfile = (adSettings as any)?.ai_rule_profile;

  // 读取或构建爬取缓存（失败/为空/旧数据不足时重新爬取）
  let cache = adCreative?.crawl_cache as CrawlCache | null;

  // 判断是否需要重爬：
  // 1. 无缓存 / 爬取失败
  // 2. optional 扩展请求了 promotion/price，且缓存在 2026-04-07 之前生成（旧 10KB 截断版本，可能漏掉折扣数据）
  const needsOptional = (types as string[]).includes("optional");
  const optionalNeedsPromo = needsOptional && ((body.optionalTypes as string[]) || []).some((t: string) => ["promotion", "price"].includes(t));

  // 促销数据无有效折扣时（discount_percent <= 0 且 discount_amount <= 0）强制重爬
  // 因为旧缓存可能用 10KB HTML 截断，漏掉了 banner 里的折扣信息
  const cachedPromo = cache?.promoRegex as Record<string, unknown> | null | undefined;
  const cachedPromoHasDiscount =
    (cachedPromo?.discount_percent ? Number(cachedPromo.discount_percent) : 0) > 0 ||
    (cachedPromo?.discount_amount ? Number(cachedPromo.discount_amount) : 0) > 0;
  const cacheNeedsRefreshForPromo = optionalNeedsPromo && !cachedPromoHasDiscount;

  // 质量分驱动的缓存失效：score < 40 说明上次爬取质量低下（splash 页、被封、内容稀薄等）
  const cacheLowQuality = typeof cache?.crawlQualityScore === "number" && cache.crawlQualityScore < 40;
  // 旧缓存（无质量分字段）+ 明显质量问题（links=0 或 crawlFailed），也视为低质量
  const cacheHasEmptyLinks = !cacheLowQuality && cache && (
    (Array.isArray(cache.links) && cache.links.length === 0) ||
    (cache.crawlQualityScore === undefined && Array.isArray(cache.links) && cache.links.length < 3)
  );

  if (!cache || !cache.crawledAt || cache.crawlFailed || cacheNeedsRefreshForPromo || cacheLowQuality || cacheHasEmptyLinks) {
    const reason = !cache || !cache.crawledAt ? '为空'
      : cache.crawlFailed ? '上次失败'
      : cacheLowQuality ? `质量低（score=${cache.crawlQualityScore}, issues=[${cache.crawlQualityIssues?.join(",")}]）`
      : cacheHasEmptyLinks ? 'links 为空（旧缓存命中 splash 页）'
      : '缓存促销无有效折扣，重爬';
    console.log(`[Extensions] crawl_cache ${reason}，重新爬取... forcePuppeteer=${cacheNeedsRefreshForPromo}`);
    // 促销数据通常由 JS 渲染（如公告栏），forcePuppeteer 保证获取到完整 DOM
    const newCache = await buildCrawlCache(merchantUrl, merchantName, country, undefined, {
      forcePuppeteer: cacheNeedsRefreshForPromo,
    });
    // 竞态保护：若新 cache 无折扣但旧 cache 已有折扣，不覆盖（防止 core/optional 并发写互相覆盖）
    const newPromo = newCache.promoRegex as Record<string, unknown> | null;
    const newHasDiscount = (newPromo?.discount_percent ? Number(newPromo.discount_percent) : 0) > 0 ||
      (newPromo?.discount_amount ? Number(newPromo.discount_amount) : 0) > 0;
    const shouldSave = newHasDiscount || !cachedPromoHasDiscount;
    cache = newCache;
    if (adCreative?.id && shouldSave) {
      // 再次读 DB，确认在本次重爬期间没有其他请求已保存了更好的数据
      const freshRecord = await prisma.ad_creatives.findFirst({ where: { id: adCreative.id }, select: { crawl_cache: true } }).catch(() => null);
      const freshPromo = (freshRecord?.crawl_cache as any)?.promoRegex as Record<string, unknown> | null;
      const freshHasDiscount = (freshPromo?.discount_percent ? Number(freshPromo.discount_percent) : 0) > 0 ||
        (freshPromo?.discount_amount ? Number(freshPromo.discount_amount) : 0) > 0;
      if (!freshHasDiscount || newHasDiscount) {
        await prisma.ad_creatives.update({
          where: { id: adCreative.id },
          data: { crawl_cache: cache as any },
        }).catch(() => {});
        console.log(`[Extensions] cache 已保存，newHasDiscount=${newHasDiscount}`);
      } else {
        // DB 已有更好数据，读取并使用 DB 的 cache
        cache = freshRecord!.crawl_cache as any;
        console.log(`[Extensions] 保留 DB 中更好的 cache（已有折扣）`);
      }
    }
  }

  // 若爬取时检测到站点使用 locale 前缀，用本地化 URL 更新 merchantUrl 和 DB 的 final_url
  // 优先使用缓存中已存储的 localizedMerchantUrl；若旧缓存没有该字段，则从 cache.links 实时推断
  let localizedUrl = (cache as CrawlCache | null)?.localizedMerchantUrl;
  if (!localizedUrl && cache?.links && cache.links.length > 0 && country) {
    const localeSegRe = /^\/([a-z]{2}[-_][a-z]{2})\//i;
    const siteUsesLocale = (cache.links as { url: string; text: string }[]).slice(0, 30).some(l => {
      try { return localeSegRe.test(new URL(l.url).pathname); } catch { return false; }
    });
    if (siteUsesLocale) {
      const LOCALE_MAP: Record<string, string> = {
        US: "en-us", GB: "en-gb", AU: "en-au", CA: "en-ca", IE: "en-ie",
        DE: "de-de", AT: "de-at", CH: "de-ch", FR: "fr-fr", BE: "fr-be",
        ES: "es-es", MX: "es-mx", IT: "it-it", NL: "nl-nl", PT: "pt-pt",
        BR: "pt-br", JP: "ja-jp", KR: "ko-kr", CN: "zh-cn", TW: "zh-tw",
        SG: "en-sg", HK: "en-hk", IN: "en-in", NZ: "en-nz",
        SE: "sv-se", NO: "nb-no", DK: "da-dk", FI: "fi-fi", PL: "pl-pl",
      };
      const targetLocale = LOCALE_MAP[country.toUpperCase()];
      if (targetLocale) {
        try {
          const u = new URL(merchantUrl);
          const existingLocaleMatch = u.pathname.match(/^\/([a-z]{2}[-_][a-z]{2})(\/|$)/i);
          if (existingLocaleMatch) {
            u.pathname = "/" + targetLocale + u.pathname.slice(existingLocaleMatch[0].length - 1);
          } else {
            u.pathname = "/" + targetLocale + (u.pathname === "/" ? "/" : u.pathname);
          }
          localizedUrl = u.toString();
          console.log(`[Extensions] 从 cache.links 推断 locale URL: ${merchantUrl} → ${localizedUrl}`);
        } catch {}
      }
    }
  }
  if (localizedUrl && localizedUrl !== merchantUrl && adCreative?.id) {
    merchantUrl = localizedUrl;
    await prisma.ad_creatives.update({
      where: { id: adCreative.id },
      data: { final_url: localizedUrl },
    }).catch(() => {});
    console.log(`[Extensions] final_url 本地化: ${adCreative?.final_url || merchant.merchant_url} → ${localizedUrl}`);
  }

  const encoder = new TextEncoder();
  // 用 isClosed flag 跟踪 controller 状态，避免客户端断开后继续写入导致的 "Controller is already closed" 异常
  let isClosed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (eventType: string, payload: unknown) => {
        if (isClosed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: eventType, data: serializeData(payload) })}\n\n`)); } catch { isClosed = true; }
      };

      try {
        send("crawl_status", { crawl_failed: cache!.crawlFailed, crawl_method: cache!.crawlMethod });

        const tasks: Promise<void>[] = [];

        // ─── core: 1 次 AI 生成标题 + 描述 + 站内链接描述 + 图片 ───
        if (types.includes("core")) {
          const confirmedKeywords = Array.isArray(requestKeywords) ? (requestKeywords as string[]).filter(Boolean).slice(0, 10) : [];
          tasks.push(generateCore(cache!, merchantName, merchantUrl, country, adSettings, aiRuleProfile, adCreative?.id || null, send, ad_language, confirmedKeywords));
        }

        // ─── optional: 1 次 AI 批量生成所有勾选的可选扩展 ───
        if (types.includes("optional")) {
          const optionalTypes: string[] = body.optionalTypes || [];
          tasks.push(generateOptionalBatch(cache!, merchantName, merchantUrl, country, optionalTypes, aiRuleProfile, send, ad_language));
        }

        await Promise.all(tasks);
        if (!isClosed) {
          try { controller.enqueue(encoder.encode("data: [DONE]\n\n")); } catch { isClosed = true; }
        }
      } catch (err) {
        if (!isClosed) {
          console.error("[Extensions] 流式生成未捕获异常:", err instanceof Error ? err.message : err);
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", data: "生成失败，请重试" })}\n\n`)); } catch { isClosed = true; }
        }
      } finally {
        if (!isClosed) {
          isClosed = true;
          try { controller.close(); } catch {}
        }
      }
    },
    cancel() {
      // 客户端主动断开连接时设置 isClosed，避免后续 enqueue 操作抛出异常
      isClosed = true;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      // 禁止 Cloudflare 对此接口使用 QUIC/HTTP3，避免 ERR_QUIC_PROTOCOL_ERROR
      "Alt-Svc": "clear",
    },
  });
}

// ─── Core 生成：标题 + 描述 + 站内链接描述 + 图片（1 次 AI） ───

async function generateCore(
  cache: CrawlCache,
  merchantName: string,
  merchantUrl: string,
  country: string,
  adSettings: any,
  aiRuleProfile: unknown,
  adCreativeId: bigint | null,
  send: (type: string, data: unknown) => void,
  adLanguageCode?: string,
  confirmedKeywords: string[] = [],
) {
  const market = getAdMarketConfig(country);
  const languageName = resolveLanguageName(country, adLanguageCode);
  const dailyBudget = Number(adSettings?.daily_budget || 2);
  const maxCpc = Number(adSettings?.max_cpc || 0.3);
  const biddingStrategy = adSettings?.bidding_strategy || "MAXIMIZE_CLICKS";

  const sitelinkBlock = cache.sitelinkCandidates.length > 0
    ? `\nVerified sitelinks (for each: if title is in ALL CAPS or unclear, rewrite it; write desc1+desc2):\n${cache.sitelinkCandidates.map((s, i) => {
        const isAllCaps = /^[A-Z0-9\s#&!?',.-]+$/.test(s.title.trim()) && s.title.trim().length > 3;
        const titleNote = isAllCaps ? ` ← ALL CAPS, MUST rewrite to Title Case` : "";
        return `${i + 1}. title: "${s.title}"${titleNote} → ${s.url}${s.description ? ` (meta: "${s.description}")` : ""}`;
      }).join("\n")}\n`
    : "";

  const semrushBlock = cache.semrushTitles.length > 0
    ? `\nCompetitor headline references (inspiration only, do NOT copy):\n${cache.semrushTitles.slice(0, 8).map((t, i) => `${i + 1}. "${t}"`).join("\n")}\n`
    : "";

  // 根据爬取数据判断是否有真实折扣/物流信息
  const hasRealDiscount = cache.promoRegex && (cache.promoRegex.discount_type === "PERCENT" || cache.promoRegex.discount_type === "MONETARY");
  const hasRealFreeShipping = cache.features.some((f) => /free\s*ship|free\s*deliver/i.test(f));
  const hasGenericPromo = cache.promoRegex && !hasRealDiscount;

  let discountGuidance = "";
  if (hasRealDiscount && cache.promoRegex) {
    const promoData = cache.promoRegex;
    if (promoData.discount_type === "PERCENT") {
      discountGuidance = `\nThe website has a VERIFIED ${promoData.discount_percent}% discount — you may reference this exact number.`;
    } else if (promoData.discount_type === "MONETARY") {
      discountGuidance = `\nThe website has a VERIFIED ${promoData.currency_code || ""}${promoData.discount_amount} discount — you may reference this exact amount.`;
    }
  } else if (hasGenericPromo) {
    discountGuidance = "\nThe website appears to have general promotions/deals. You may mention 'deals available' or 'special offers' but do NOT fabricate specific discount numbers.";
  } else {
    discountGuidance = "\nNo verified discount was found on the website. Do NOT mention any specific discounts, percentages, or savings amounts. Focus on product quality, brand trust, and value instead.";
  }

  const shippingGuidance = hasRealFreeShipping
    ? "\nFree shipping was detected on the website — you may mention it."
    : "\nNo free shipping was confirmed on the website. Do NOT claim free shipping unless it is explicitly stated in the website content above.";

  // 爬虫提取的真实产品数据，传给 AI 作为写文案的素材
  const crawledProducts = (cache as any).crawledProducts || [];
  const productBlock = crawledProducts.length > 0
    ? `\nReal products found on website (use these names and prices as copy anchors):\n${crawledProducts.slice(0, 15).map((p: any, i: number) => `${i + 1}. "${p.name}"${p.price ? ` — ${p.currency || market.currencyCode}${p.price}` : ""}`).join("\n")}\n`
    : "";

  // 价格区间分析（给 AI 真实的价格锚点）
  const prices = crawledProducts.map((p: any) => Number(p.price)).filter((n: number) => n > 0).sort((a: number, b: number) => a - b);
  const priceRangeBlock = prices.length >= 2
    ? `\nPrice range on site: ${market.currencyCode}${prices[0]} – ${market.currencyCode}${prices[prices.length - 1]} (median ~${market.currencyCode}${prices[Math.floor(prices.length / 2)]}). Use these real prices as anchors ("From ${market.currencyCode}${prices[0]}", etc.).\n`
    : prices.length === 1
    ? `\nEntry price on site: ${market.currencyCode}${prices[0]}. You may reference this.\n`
    : "";

  // 确认关键词块（员工已确认的高意图词）
  const keywordsBlock = confirmedKeywords.length > 0
    ? `\n⚡ CONFIRMED HIGH-INTENT KEYWORDS (employee-selected, build multiple headlines around these):\n${confirmedKeywords.map((k, i) => `${i + 1}. ${k}`).join("\n")}\nAt least 3 headlines MUST directly mirror or include these keywords.\n`
    : "";

  const isNonEnglish = market.languageCode !== "en";
  const langEnforcement = isNonEnglish
    ? `\n⚠️ CRITICAL LANGUAGE RULE: ALL output (headlines, descriptions, sitelink titles, sitelink descriptions) MUST be written ENTIRELY in ${languageName}. Do NOT use English. Do NOT mix languages. Even if the source website content or examples below are in English, you MUST translate and localize everything into ${languageName}. The target audience speaks ${languageName} — all copy must feel native to them.\n`
    : "";

  // 动态读取激活人设
  const { normalizeAiRuleProfile, getActivePersona } = await import("@/lib/ai-rule-profile");
  const normalizedProfile = normalizeAiRuleProfile(aiRuleProfile);
  const activePersona = getActivePersona(normalizedProfile);

  // ─── system message：人设身份 + 写作信条 + 禁忌（AI 角色定义，最高优先级）
  const systemPrompt = `You are ${activePersona.name} — ${activePersona.persona}

${formatAiRuleBlock(aiRuleProfile, "ad_copy")}

${AD_COPY_ANTI_AI_BLOCK}

IRON IDENTITY RULE: You are NOT a generic copywriting tool. You are ${activePersona.name}. Every word you output must reflect your persona's philosophy and craft standards. If a line you write could belong to any other brand or any other copywriter — delete it and rewrite it. Only output lines that could ONLY come from you, for THIS specific merchant.`;

  // ─── user message：商家数据 + 任务规格（每次请求变化的内容）
  const prompt = `Your single mission: write ad copy that converts cold searchers into buyers for THIS specific merchant.
${langEnforcement}
═══ NON-NEGOTIABLE RULES ═══
1. POLICY COMPLIANCE FIRST: Assess whether the merchant's product could trigger Google Ads restricted content policies. If ambiguous, ONLY use language that clearly describes the LEGAL use case.
2. SPECIFICITY OVER GENERICS: Every headline must contain at least ONE specific fact (price, year, material, collection name, feature). Headlines like "Best Quality" or "Shop Now" are REJECTED.
3. KEYWORD-FIRST: Mirror confirmed keywords in headlines. If a keyword could trigger a policy violation, reframe it safely.
4. DATA INTEGRITY: Use ONLY the facts provided below. Never invent discounts, prices, or product names.
5. ZERO AI CLICHÉS: Banned words: premium, top-quality, perfect, amazing, cutting-edge, seamless, elevate, unlock. Use real product/brand language instead.
6. HEADLINES ONLY — ABSOLUTE PROHIBITIONS (no exceptions, no persona overrides):
   · NO return/refund/money-back language in headlines. Put it in descriptions if needed.
     ✗ "Free Returns on All Orders" / "30-Day Money-Back Guarantee" → REJECTED from headlines
   · NO discount codes or promo codes in headlines. Ever.
     ✗ "Use Code SAVE20" / "Enter Promo Code for 20% Off" → REJECTED from headlines
     ✓ Verified percentage off ("20% Off Sitewide") is allowed in headlines if confirmed on the website.
${discountGuidance}${shippingGuidance}

═══ MERCHANT INTELLIGENCE — READ ALL BEFORE WRITING ═══
- Merchant: ${merchantName}
- Website: ${merchantUrl}
- Target market: ${market.countryNameZh} (write in ${languageName})
- Budget: $${dailyBudget.toFixed(2)}/day, CPC $${maxCpc.toFixed(2)}, Strategy: ${biddingStrategy}
${keywordsBlock}${priceRangeBlock}${productBlock}
Website content (extract specific collection names, materials, features, brand voice):
${cache.pageText.slice(0, 5000)}

${cache.features.length > 0 ? `Merchant features (REAL — use them as copy hooks):\n${cache.features.slice(0, 20).join("\n")}\n` : ""}${semrushBlock}${sitelinkBlock}
Return ONLY a JSON object with this exact structure:
{
  "headlines": ["h1","h2",...],
  "descriptions": ["d1","d2","d3","d4"],
  "sitelink_descriptions": [{"title":"...","desc1":"...","desc2":"..."},...]
}
Note: "title" in sitelink_descriptions is required. If the original sitelink title is in ALL CAPS or is unclear, rewrite it in Title Case or sentence case (≤25 chars).${isNonEnglish ? ` IMPORTANT: If the original sitelink title is in English, you MUST translate it to ${languageName}. All sitelink titles and descriptions must be in ${languageName}.` : " Otherwise keep it as-is."}

═══ COPYWRITING CRAFT ═══

Your job is NOT to describe the product. Your job is to make someone who wasn't sure if they wanted it suddenly NEED it.

Before writing EACH headline or description, ask:
  1. Would I stop scrolling if I saw this? (ATTENTION)
  2. Does this give a SPECIFIC reason to buy? (VALUE)
  3. Does this sound like a human, or a robot filling space? (SOUL)
  4. Could this headline work for ANY other brand? If yes → REWRITE. Every line must be ownable by this specific merchant.

DESIRE-BUILDING TOOLKIT:
  • PAINT THE AFTER: "Wake up to clear skin" > "Effective skincare solution"
  • NAME THE VILLAIN: "No more breakouts" > "Skincare products"
  • USE SENSORY WORDS: "buttery soft", "razor sharp", "whisper quiet", "featherlight"
  • SOCIAL PROOF WITH TEXTURE: "Loved by 12K+ customers who tried everything else first"
  • CONTRAST CREATES CLARITY: "No chemicals — just results" / "Not mass-produced. Handmade."
  • SPECIFICITY IS DESIRE: "3 patented ingredients" / "Handcrafted from Italian leather"

Power words (use freely): proven, real, fast, works, rated, top-selling, trusted, easy, clear, fresh, effective, lasting, gentle, visible, simple, loved, tested, natural, pure, handmade

BANNED words (auto-rejected): unlock, unleash, elevate, revolutionize, seamless, cutting-edge, game-changer, curated, empower, harness, innovative, transformative, holistic, paradigm, synergy

═══ HEADLINES — exactly 15, each ≤30 chars ═══

⚠️ CRITICAL DISTRIBUTION RULE: Only headline #1 may include "${merchantName}" as a prefix. Headlines #2–15 must NOT start with "${merchantName}". Vary the angle for every single headline — if two headlines feel similar, replace one.

Angle distribution (follow this):
  ① Brand anchor (headline #1 ONLY): "${merchantName}" + one specific hook. E.g. "${merchantName} — Built Since 1987" or "${merchantName} Denim, LA-Made"
  ② Keyword mirrors (#2–4, 3 headlines): Echo the confirmed search keywords — specific, searchable. Add ONE benefit hook to each, NOT just the keyword alone.
     ✗ "AG Jeans Denim & Clothing" (keyword + generic category = zero value)
     ✓ "AG Denim — Holds Shape All Day" (keyword + specific benefit)
  ③ Pain/desire hook (#5–6, 2 headlines): The exact emotional itch — name the problem users hate.
     ✓ "Stop Settling For Baggy Knees" / "Sick of Jeans That Lose Shape?"
  ④ Outcome visualization (#7–8, 2 headlines): Paint the after — what life looks like with this product.
     ✓ "From Office to Dinner — One Pair" / "Denim That Moves With You"
  ⑤ Trust/proof (#9–10, 2 headlines): Credibility that feels real, not claimed.
     ✓ "4.8★ by 12K+ Customers" / "Made in L.A. Since 1987"
  ⑥ Only-we-do-this (#11–12, 2 headlines): The thing competitors CAN'T say.
     ✓ "The Only Denim With Su-Per® Stretch" / "No-Sag Guarantee or Full Refund"
  ⑦ CTA with reason (#13–15, 3 headlines): Action + specific incentive — not just "Shop Now".
     ✗ "Shop Spring Collection Now" (no reason to act NOW)
     ✗ "Use The Women's Fit Guide" (no desire, no hook)
     ✓ "Find Your Perfect Fit — Free Returns" / "Try Risk-Free for 30 Days"
  ${hasRealDiscount ? "  ⑧ Discount: reference the verified discount in one of the CTA headlines — be specific" : ""}
  ${hasRealFreeShipping ? "  ⑧ Free Shipping: weave into one CTA headline as a value hook" : ""}

Rules:
- Use Title Case or sentence case — NEVER ALL CAPS
- No dates, expiry, or countdowns
- No multiple punctuation — at most ONE ! or ? per headline
- Front-load the most important word — readers scan left-to-right

═══ DESCRIPTIONS — exactly 4, each 50-90 chars ═══
Each description is a micro-sales-pitch. The reader is on the fence — your 90 characters push them over.
Each of the 4 descriptions must tackle a DIFFERENT psychological angle. They are NOT variations of the same message.

  Desc 1 — EMPATHY CLOSE: Start with their frustration, pivot to your solution in one breath.
     ✓ "Sick of jeans that sag? Try AG denim made in L.A. Shop the fit."
     ✗ "We offer a range of denim solutions for various needs." (about YOU, not THEM)

  Desc 2 — IRRESISTIBLE OFFER: Stack value until saying no feels like losing something.
     ✓ "Free shipping + free returns. Shop best-selling fits now."
     ✗ "Visit our website to browse our products." (zero value)

  Desc 3 — TRUST BUILDER: Remove every reason NOT to buy.
     ✓ "Rated 4.8★ by 50K+ customers. 30-day money-back guarantee."
     ✗ "We pride ourselves on customer satisfaction." (empty claim)

  Desc 4 — COMPETITIVE WEDGE: One sentence that makes alternatives feel inferior.
     ✓ "The only denim with Su-Per® stretch tech. No knockoffs. No compromise."
     ✗ "Our products are of the highest quality." (says nothing specific)

Rules:
- Each description MUST open with a different word/phrase — no two can start the same
- ${hasRealDiscount && hasRealFreeShipping ? "Description 1 or 2 may combine verified discount + free shipping" : "Only use verified information from the website content"}
- No multiple punctuation — at most one ! per description
- NEVER write in ALL CAPS
- Must be clearly distinct from headlines (Google penalizes repetition)

═══ SITELINK DESCRIPTIONS — ${cache.sitelinkCandidates.length} entries ═══
1. "title" REQUIRED — ≤25 chars, Title Case/sentence case, NEVER ALL CAPS
2. If title is marked "← ALL CAPS, MUST rewrite" — provide a natural, clear replacement
3. desc1 and desc2 each ≤35 chars — both required
4. Make desc1 the main benefit hook, desc2 a supporting detail or CTA
5. No exclamation marks in titles — desc1/desc2 may use at most one

${isNonEnglish ? `\n⚠️ FINAL REMINDER: ALL headlines, descriptions, sitelink titles, and sitelink descriptions MUST be in ${languageName}. The examples above are English templates for structure reference only — you MUST write the actual output in ${languageName}. Do NOT output any English text.\n` : ""}Return ONLY valid JSON, no explanation.`;

  try {
    const raw = await callAiWithFallback("ad_copy", [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ], 4096);
    const parsed = JSON.parse(extractJsonFromAi(raw));

    // 处理标题：去 AI 味 → 超长缩略 → 过滤
    let rawHeadlines = Array.isArray(parsed.headlines)
      ? parsed.headlines.filter((h: string) => h && h.trim())
      : [];
    rawHeadlines = humanizeAdCopyBatch(rawHeadlines, 2, 30);
    rawHeadlines = await condenseOverlong(rawHeadlines, 30, languageName);
    let headlines = rawHeadlines.filter((h: string) => h.length >= 2 && h.length <= 30).slice(0, 15);

    // 标题不足15条时，用 padHeadlines 补全
    if (headlines.length < 15) {
      try {
        const { padHeadlines } = await import("@/lib/ai-service");
        headlines = await padHeadlines(headlines, merchantName, country, 15, {
          referenceItems: cache.semrushTitles,
          dailyBudget: Number(adSettings?.daily_budget || 2),
          maxCpc: Number(adSettings?.max_cpc || 0.3),
          biddingStrategy: adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
          aiRuleProfile,
          adLanguageCode,
        });
      } catch (padErr) {
        console.warn("[Core] padHeadlines 补全失败:", padErr instanceof Error ? padErr.message : padErr);
      }
    }
    // 合规自动修复：标题
    const headlineFix = await complianceAutoFix(headlines, "headline", merchantName, languageName, aiRuleProfile, 30, 2);
    headlines = headlineFix.items;

    // 违规项被删除后，不足 15 条时补全一次（不再做二次合规，避免循环）
    if (headlines.length < 15) {
      try {
        const { padHeadlines } = await import("@/lib/ai-service");
        const padded = await padHeadlines(headlines, merchantName, country, 15, {
          referenceItems: cache.semrushTitles,
          dailyBudget: Number(adSettings?.daily_budget || 2),
          maxCpc: Number(adSettings?.max_cpc || 0.3),
          biddingStrategy: adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
          aiRuleProfile,
          adLanguageCode,
        });
        const newOnly = padded.filter((h: string) => !headlines.includes(h));
        const cleanNew = newOnly.filter((h: string) => checkItemViolations([h], aiRuleProfile).length === 0);
        headlines = [...headlines, ...cleanNew].slice(0, 15);
        console.log(`[Core] 合规删除后补全标题: +${cleanNew.length} 条 (总${headlines.length})`);
      } catch (e) { console.warn("[Core] 合规后补全标题失败:", e instanceof Error ? e.message : e); }
    }
    send("headlines", headlines);

    // 处理描述：去 AI 味 → 超长缩略 → 过滤
    let rawDescs = Array.isArray(parsed.descriptions)
      ? parsed.descriptions.filter((d: string) => d && d.trim())
      : [];
    rawDescs = humanizeAdCopyBatch(rawDescs, 40, 90);
    rawDescs = await condenseOverlong(rawDescs, 90, languageName);
    let descriptions = rawDescs.filter((d: string) => d.length >= 40 && d.length <= 90).slice(0, 4);

    // 描述不足4条时，用 padDescriptions 补全
    if (descriptions.length < 4) {
      try {
        const { padDescriptions } = await import("@/lib/ai-service");
        descriptions = await padDescriptions(descriptions, merchantName, country, 4, {
          referenceItems: cache.semrushDescriptions,
          dailyBudget: Number(adSettings?.daily_budget || 2),
          maxCpc: Number(adSettings?.max_cpc || 0.3),
          biddingStrategy: adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
          aiRuleProfile,
          adLanguageCode,
        });
      } catch (padErr) {
        console.warn("[Core] padDescriptions 补全失败:", padErr instanceof Error ? padErr.message : padErr);
      }
    }

    // 合规自动修复：描述
    const descFix = await complianceAutoFix(descriptions, "description", merchantName, languageName, aiRuleProfile, 90, 40);
    descriptions = descFix.items;

    // 违规项被删除后，不足 4 条时补全一次
    if (descriptions.length < 4) {
      try {
        const { padDescriptions } = await import("@/lib/ai-service");
        const padded = await padDescriptions(descriptions, merchantName, country, 4, {
          referenceItems: cache.semrushDescriptions,
          dailyBudget: Number(adSettings?.daily_budget || 2),
          maxCpc: Number(adSettings?.max_cpc || 0.3),
          biddingStrategy: adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
          aiRuleProfile,
          adLanguageCode,
        });
        const newOnly = padded.filter((d: string) => !descriptions.includes(d));
        const cleanNew = newOnly.filter((d: string) => checkItemViolations([d], aiRuleProfile).length === 0);
        descriptions = [...descriptions, ...cleanNew].slice(0, 4);
        console.log(`[Core] 合规删除后补全描述: +${cleanNew.length} 条 (总${descriptions.length})`);
      } catch (e) { console.warn("[Core] 合规后补全描述失败:", e instanceof Error ? e.message : e); }
    }
    send("descriptions", descriptions);

    // 汇总合规修复结果
    const allAutoFixed = [...headlineFix.fixed, ...descFix.fixed];
    const allRemaining = [...headlineFix.remaining, ...descFix.remaining];
    if (allAutoFixed.length > 0) {
      send("compliance_auto_fix", { fixed: allAutoFixed, count: allAutoFixed.length });
      console.log(`[Core] 合规自动修复: ${allAutoFixed.length} 条已替换`);
    }
    if (allRemaining.length > 0) {
      send("compliance_warnings", { warnings: allRemaining, count: allRemaining.length });
      console.log(`[Core] 合规警告: ${allRemaining.length} 条仍有风险（已达最大重试次数）`);
    }

    // 处理站内链接（标题/描述需符合 Google Ads 规范：不能全大写、不能有多余标点）
    const sitelinkDescs = Array.isArray(parsed.sitelink_descriptions) ? parsed.sitelink_descriptions : [];
    const sitelinks = cache.sitelinkCandidates.map((s, i) => {
      const aiDesc = sitelinkDescs[i] || {};
      const brandName = merchantName.replace(/[.。,，!！?？]+/g, "").trim().slice(0, 15);

      // 优先使用 AI 建议的 title（需通过验证：非全大写、长度合法）
      const rawCrawlTitle = sanitizeAdText(s.title);
      let finalTitle = rawCrawlTitle;
      if (aiDesc.title && typeof aiDesc.title === "string") {
        const aiTitle = sanitizeAdText(aiDesc.title.trim());
        const isAllCaps = /^[A-Z0-9\s#&!?',.-]+$/.test(aiTitle) && /[A-Z]{2,}/.test(aiTitle);
        if (!isAllCaps && aiTitle.length >= 2 && aiTitle.length <= 25) {
          finalTitle = aiTitle;
        }
      }

      return {
        title: finalTitle.slice(0, 25),
        url: s.url,
        desc1: sanitizeAdText(
          (aiDesc.desc1 && aiDesc.desc1.length <= 35) ? aiDesc.desc1 : (s.description || brandName).slice(0, 35),
          { allowExclamation: true },
        ),
        desc2: sanitizeAdText(
          (aiDesc.desc2 && aiDesc.desc2.length <= 35) ? aiDesc.desc2 : (brandName || titleFromUrlPath(s.url)).slice(0, 35),
          { allowExclamation: true },
        ),
      };
    });
    send("sitelinks", sitelinks);

    // 保存到 DB
    if (adCreativeId) {
      const pathSuggest = suggestDisplayPaths(merchantName, [], country);
      await prisma.ad_creatives.update({
        where: { id: adCreativeId },
        data: {
          headlines: headlines as any,
          descriptions: descriptions as any,
          sitelinks: sitelinks as any,
          display_path1: pathSuggest.path1,
          display_path2: pathSuggest.path2,
        },
      });
    }

    console.log(`[Core] AI 生成完成: ${headlines.length} 标题, ${descriptions.length} 描述, ${sitelinks.length} 站内链接`);
  } catch (err) {
    console.error("[Core] AI 生成失败:", err instanceof Error ? err.message : err);
    // fallback: 使用 padHeadlines/padDescriptions
    try {
      const { padHeadlines, padDescriptions } = await import("@/lib/ai-service");
      const headlines = await padHeadlines([], merchantName, country, 15, {
        referenceItems: cache.semrushTitles,
        dailyBudget: Number(adSettings?.daily_budget || 2),
        maxCpc: Number(adSettings?.max_cpc || 0.3),
        biddingStrategy: adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
        aiRuleProfile,
        adLanguageCode,
      });
      send("headlines", headlines);
      const descriptions = await padDescriptions([], merchantName, country, 4, {
        referenceItems: cache.semrushDescriptions,
        dailyBudget: Number(adSettings?.daily_budget || 2),
        maxCpc: Number(adSettings?.max_cpc || 0.3),
        biddingStrategy: adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
        aiRuleProfile,
        adLanguageCode,
      });
      send("descriptions", descriptions);
      const sitelinks = cache.sitelinkCandidates.map((s) => ({
        title: sanitizeAdText(s.title).slice(0, 25), url: s.url,
        desc1: sanitizeAdText(s.description || merchantName.slice(0, 35), { allowExclamation: true }),
        desc2: sanitizeAdText(merchantName.slice(0, 35), { allowExclamation: true }),
      }));
      send("sitelinks", sitelinks);
      if (adCreativeId) {
        const pathSuggest2 = suggestDisplayPaths(merchantName, [], country);
        await prisma.ad_creatives.update({
          where: { id: adCreativeId },
          data: { headlines: headlines as any, descriptions: descriptions as any, sitelinks: sitelinks as any, display_path1: pathSuggest2.path1, display_path2: pathSuggest2.path2 },
        });
      }
    } catch (fallbackErr) {
      console.error("[Core] Fallback 也失败:", fallbackErr);
      send("headlines", []); send("descriptions", []); send("sitelinks", []);
    }
  }

  // 图片筛选：社交域名 + 促销URL过滤 + 商家同域优先
  const images = await selectBestImages(cache.images, merchantUrl);
  send("images", images);
  if (adCreativeId) {
    await prisma.ad_creatives.update({
      where: { id: adCreativeId },
      data: { image_urls: images as any },
    }).catch(() => {});
  }
}

// Google Ads 审批的 Promotion occasion 枚举
const GOOGLE_PROMOTION_OCCASIONS = [
  "BACK_TO_SCHOOL", "BLACK_FRIDAY", "CHRISTMAS", "CYBER_MONDAY",
  "EASTER", "FATHERS_DAY", "HALLOWEEN", "MOTHERS_DAY",
  "NEW_YEARS", "THANKSGIVING", "VALENTINES_DAY", "NONE",
] as const;
type PromotionOccasion = (typeof GOOGLE_PROMOTION_OCCASIONS)[number];

// Google Ads 审批的 Structured Snippet header 枚举（13个）
const GOOGLE_SNIPPET_HEADERS = [
  "Amenities", "Brands", "Courses", "Degree programs", "Destinations",
  "Featured hotels", "Insurance coverage", "Models", "Neighborhoods",
  "Service catalog", "Shows", "Styles", "Types",
] as const;
type SnippetHeader = (typeof GOOGLE_SNIPPET_HEADERS)[number];

function validatePromotionOccasion(val: string): PromotionOccasion {
  const upper = val.toUpperCase().replace(/ /g, "_") as PromotionOccasion;
  return GOOGLE_PROMOTION_OCCASIONS.includes(upper) ? upper : "NONE";
}

function validateSnippetHeader(val: string): SnippetHeader {
  const found = GOOGLE_SNIPPET_HEADERS.find(
    (h) => h.toLowerCase() === val.toLowerCase()
  );
  return found ?? "Types";
}

// ─── 可选扩展批量生成 ───

async function generateOptionalBatch(
  cache: CrawlCache,
  merchantName: string,
  merchantUrl: string,
  country: string,
  optionalTypes: string[],
  aiRuleProfile: unknown,
  send: (type: string, data: unknown) => void,
  adLanguageCode?: string,
) {
  if (optionalTypes.length === 0) return;

  const market = getAdMarketConfig(country);
  const languageName = resolveLanguageName(country, adLanguageCode);

  // ─── call: 只使用真实爬取的电话，找不到则 skipped ───
  if (optionalTypes.includes("call")) {
    try {
      const phone = await extractPhoneFromCache(cache, merchantUrl, country);
      if (phone) {
        send("call", { found: true, skipped: false, ...phone });
      } else {
        send("call", { skipped: true });
        console.log("[Optional] 致电扩展：未找到真实电话，跳过");
      }
    } catch {
      send("call", { skipped: true });
    }
  }

  // ─── promotion: 三层流水线 —— regex结构化数据 → rawMentions AI解析 → 数字一致性校验 ───
  if (optionalTypes.includes("promotion")) {
    const promo = cache.promoRegex as Record<string, unknown> | null;
    const discountPercent = promo?.discount_percent ? Number(promo.discount_percent) : 0;
    const discountAmount = promo?.discount_amount ? Number(promo.discount_amount) : 0;
    const hasRealDiscount = discountPercent > 0 || discountAmount > 0;

    // 辅助：去除 target 中的折扣数字文本
    const stripDiscountFromTarget = (text: string) =>
      text
        .replace(/,?\s*up\s+to\s+\d+\s*%\s*off/gi, "")
        .replace(/,?\s*\d+\s*%\s*off/gi, "")
        .replace(/,?\s*\$[\d,.]+\s*off/gi, "")
        .replace(/,?\s*save\s+\d+%/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();

    /**
     * verifyPromoResult: 校验 AI 生成的折扣数值是否确实出现在原文 rawMentions.promo 中。
     * 若校验失败，返回 false（需要跳过或重试）。
     */
    const verifyPromoResult = (
      aiPercent: number,
      aiAmount: number,
      sources: string[],
    ): boolean => {
      if (sources.length === 0) return true; // 无原文时不校验，放行
      const combined = sources.join(" ").toLowerCase();
      if (aiPercent > 0) {
        // 原文中必须有这个百分比数字
        return new RegExp(`\\b${aiPercent}\\s*%`).test(combined);
      }
      if (aiAmount > 0) {
        // 原文中必须有这个金额数字（含货币符号或数字）
        return new RegExp(`\\b${aiAmount}\\b`).test(combined);
      }
      return true;
    };

    // 层 1：regex 结构化结果已有真实折扣
    if (hasRealDiscount && promo) {
      const occasion = validatePromotionOccasion(String(promo.occasion || "NONE"));
      const rawTarget = String(promo.promotion_target || "").trim();
      const cleanedTarget = stripDiscountFromTarget(rawTarget);
      let promotionTarget = cleanedTarget.slice(0, 20);

      if (cleanedTarget.length > 20) {
        try {
          const aiRaw = await callAiWithFallback("extension", [
            {
              role: "user",
              content: `You are a Google Ads copywriter. Extract ONLY the promotion event name from the text below.\n\nRules:\n- Max 20 characters (including spaces)\n- Output ONLY the event name (e.g. "Friends & Family", "Spring Specials", "Summer Sale")\n- Do NOT include any discount numbers, percentages, or "off"\n- No punctuation at the end\n- English only\n\nText: "${cleanedTarget}"`,
            },
          ], 30);
          const optimized = aiRaw.trim().replace(/^["']|["']$/g, "").slice(0, 20);
          if (optimized.length >= 3) promotionTarget = optimized;
        } catch (e) {
          console.warn(`[Optional] 促销标题 AI 优化失败:`, e instanceof Error ? e.message : e);
        }
      }

      send("promotion", {
        skipped: false,
        found: true,
        promotion_target: promotionTarget,
        discount_type: String(promo.discount_type || "PERCENT"),
        discount_percent: discountPercent > 0 ? discountPercent : null,
        discount_amount: discountAmount > 0 ? discountAmount : null,
        currency_code: market.currencyCode,
        occasion,
        final_url: merchantUrl,
      });
      console.log(`[Optional] 促销扩展[层1-regex]：${discountPercent > 0 ? discountPercent + "%" : "$" + discountAmount}，target="${promotionTarget}"`);
    }
    // 层 2：regex 无结果，但 rawMentions.promo 有原文 → 交给 AI 解析
    else {
      const promoSnippets = cache.rawMentions?.promo;

      if (!promoSnippets || promoSnippets.length === 0) {
        send("promotion", { skipped: true });
        console.log(`[Optional] 促销扩展：regex无折扣且无 rawMentions，跳过`);
      } else {
        console.log(`[Optional] 促销扩展[层2-AI]：rawMentions.promo=${promoSnippets.length} 条，发送 AI 解析`);
        const snippetsText = promoSnippets.slice(0, 8).map((s, i) => `${i + 1}. "${s}"`).join("\n");

        const aiPrompt = `You are a Google Ads promotion data extractor. Read the following REAL snippets from the merchant's website and extract the promotion details.

Snippets from website:
${snippetsText}

Return ONLY a JSON object (no markdown, no explanation):
{
  "discount_type": "PERCENT" | "MONETARY" | "NONE",
  "discount_percent": <number or null>,
  "discount_amount": <number or null>,
  "promotion_target": "<max 20 chars, event name only, e.g. First Order, Newsletter, Summer Sale>",
  "found": <true if a real discount exists, false otherwise>
}

Rules:
- ONLY extract numbers that EXPLICITLY appear in the snippets above. NEVER invent numbers.
- discount_type "PERCENT" requires a "%" sign in the snippets.
- discount_type "MONETARY" requires a "$"/"€"/"£" amount in the snippets.
- promotion_target must be the event/occasion name without discount numbers (max 20 chars).
- If no real discount is found, set found: false.`;

        let aiPromo: { discount_type: string; discount_percent: number | null; discount_amount: number | null; promotion_target: string; found: boolean } | null = null;
        let retries = 2;
        while (retries-- > 0 && !aiPromo) {
          try {
            const aiRaw = await callAiWithFallback("extension", [{ role: "user", content: aiPrompt }], 256);
            const parsed = JSON.parse(extractJsonFromAi(aiRaw)) as Record<string, unknown>;
            if (parsed && (parsed.found === true || parsed.found === "true")) {
              const pct = parsed.discount_percent ? Number(parsed.discount_percent) : 0;
              const amt = parsed.discount_amount ? Number(parsed.discount_amount) : 0;
              if (pct > 0 || amt > 0) {
                // 层 3：数字一致性校验 —— AI 输出的数字必须在原文中真实存在
                const verified = verifyPromoResult(pct, amt, promoSnippets);
                if (verified) {
                  aiPromo = { ...parsed, discount_percent: pct || null, discount_amount: amt || null };
                  console.log(`[Optional] 促销扩展[层3-验证通过]：pct=${pct}, amt=${amt}, target="${parsed.promotion_target}"`);
                } else {
                  console.warn(`[Optional] 促销扩展[层3-验证失败]：AI 输出 pct=${pct}/amt=${amt} 在原文中未找到，重试(${retries})`);
                  aiPromo = null;
                }
              }
            }
          } catch (e) {
            console.warn(`[Optional] 促销 AI 解析失败:`, e instanceof Error ? e.message : e);
          }
        }

        if (aiPromo) {
          const occasion = validatePromotionOccasion("NONE");
          const promotionTarget = stripDiscountFromTarget(String(aiPromo.promotion_target || "")).slice(0, 20) || "Special Offer";
          send("promotion", {
            skipped: false,
            found: true,
            promotion_target: promotionTarget,
            discount_type: aiPromo.discount_type || "PERCENT",
            discount_percent: aiPromo.discount_percent,
            discount_amount: aiPromo.discount_amount,
            currency_code: market.currencyCode,
            occasion,
            final_url: merchantUrl,
          });
          console.log(`[Optional] 促销扩展[层2+3]：输出 target="${promotionTarget}"，pct=${aiPromo.discount_percent}`);
        } else {
          send("promotion", { skipped: true });
          console.log(`[Optional] 促销扩展：AI 解析后数字校验均未通过，跳过`);
        }
      }
    }
  }

  // ─── price: 只使用真实爬取的价格数据，无数据则 skipped ───
  if (optionalTypes.includes("price")) {
    const crawledProducts = (cache as any).crawledProducts || [];
    let items: { header: string; description: string; price: number; currency: string; url: string }[] = [];

    // 将相对路径 URL 转为绝对 URL
    const toAbsoluteUrl = (url: string) => {
      if (!url) return merchantUrl;
      if (url.startsWith("http://") || url.startsWith("https://")) return url;
      try {
        const base = merchantUrl.startsWith("http") ? merchantUrl : `https://${merchantUrl}`;
        return new URL(url, base).toString();
      } catch { return merchantUrl; }
    };

    if (crawledProducts.length > 0) {
      items = crawledProducts
        .filter((p: any) => p.name && p.price && p.price > 0)
        .slice(0, 8)
        .map((p: any) => ({
          header: String(p.name).trim(),
          description: String(p.description || "").trim(),
          price: Number(p.price),
          currency: String(p.currency || market.currencyCode),
          url: toAbsoluteUrl(String(p.url || "")),
        }));
    }

    if (items.length === 0 && cache.priceRegex.length > 0) {
      items = cache.priceRegex.map((p) => ({ ...p, url: toAbsoluteUrl(p.url || "") }));
    }

    // 尝试子页面补充（仅真实数据）
    if (items.length === 0) {
      const subData = await fetchSubPagesForOptional(cache.links, ["price"]);
      if (subData.priceItems.length > 0) {
        items = subData.priceItems.map((p) => ({ ...p, url: toAbsoluteUrl(p.url || "") }));
      }
    }

    if (items.length === 0) {
      send("price_items", { skipped: true });
      console.log("[Optional] 价格扩展：未爬取到真实价格数据，跳过");
    } else {
      // ── AI 批量重写价格项的 header + description，和广告文案同等品质 ──

      const MAX_PRICE_RETRIES = 2;

      try {
        const priceRewritePrompt = `You are Adrian — a Google Ads price extension copywriter. Rewrite each product's title and description to be compelling, human, and benefit-driven.

Merchant: ${merchantName}
Language: ${languageName}

RAW PRODUCTS (from website crawl — these are real products with real prices):
${items.map((item, i) => `${i + 1}. Name: "${item.header}"${item.description ? ` | Desc: "${item.description}"` : ""} | ${item.currency} ${item.price}`).join("\n")}

YOUR TASK — rewrite each product into a Google Ads Price Extension entry:

HEADER (≤25 chars):
- Clean, appealing product name — NOT the raw crawl text
- Fix awkward numbering, spacing, capitalization (e.g. "Diaper rash cream 1 2 3" → "123 Diaper Rash Cream")
- Use Title Case naturally — "Gentle Cleansing Gel" not "2 in 1 cleansing gel"
- Keep brand-specific product names if they're already good
- Do NOT include prices or currency symbols
- Must sound like a product you'd see in a store, not a database entry

DESCRIPTION (≤25 chars):
- A benefit hook or what-it-does phrase — NOT a restatement of the header
- MUST be COMPLETELY DIFFERENT from the header — Google Ads rejects identical header/description
- Think: what would make a parent/buyer click? "Soothes baby's skin fast" not "Diaper rash cream"
- Use sensory/emotional language: "gentle", "soothing", "nourishing", "refreshing"
- Examples of GOOD descriptions: "Gentle daily face wash", "Soothes irritated skin", "Hydrates & protects", "Fresh scent all day"
- Examples of BAD descriptions: same as header, generic "Shop now", just a category name

Return ONLY a JSON array of objects:
[{"header": "...", "description": "..."}, ...]

Every header MUST be ≤25 characters. Every description MUST be ≤25 characters.
Header and description MUST be different for each item. COUNT CAREFULLY.`;

        let rewritten: { header: string; description: string }[] | null = null;

        for (let attempt = 1; attempt <= MAX_PRICE_RETRIES; attempt++) {
          try {
            const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: priceRewritePrompt }], 2048);
            const parsed = JSON.parse(extractJsonFromAi(raw));
            if (Array.isArray(parsed) && parsed.length >= items.length) {
              rewritten = parsed.slice(0, items.length);
              break;
            }
            console.warn(`[Price] AI batch rewrite attempt ${attempt}: 返回数量不匹配 (${parsed?.length} vs ${items.length})`);
          } catch (e) {
            console.warn(`[Price] AI batch rewrite attempt ${attempt} 失败:`, e instanceof Error ? e.message : e);
          }
        }

        if (rewritten) {
          items = items.map((item, i) => {
            const ai = rewritten![i];
            let header = (ai?.header || "").trim().replace(/\s*[\$€£¥]\d[\d,.]*/g, "").trim();
            let desc = (ai?.description || "").trim();

            // 长度安全网：超过 25 字符则回退到原始数据清理版
            if (header.length < 2 || header.length > 25) {
              header = item.header.replace(/\s*[\$€£¥]\s*\d[\d,.]*\+?/g, "").trim().slice(0, 25);
            }
            if (desc.length < 2 || desc.length > 25) {
              desc = (item.description || "").trim().slice(0, 25);
            }

            // header == description 冲突解决
            if (desc.toLowerCase() === header.toLowerCase() || desc.length < 2) {
              desc = `Shop ${merchantName}`.length <= 25 ? `Shop ${merchantName}` : "View details";
              if (desc.toLowerCase() === header.toLowerCase()) desc = "View details";
            }

            return { ...item, header, description: desc };
          });
          console.log(`[Price] AI batch rewrite 成功: ${items.length} 条产品标题/描述已重写`);
        } else {
          // AI 全部失败时的降级处理：清理原始数据
          items = items.map((item) => {
            let header = item.header
              .replace(/\s*[\$€£¥]\s*\d[\d,.]*\+?/g, "")
              .replace(/\s+/g, " ").trim().slice(0, 25);
            let desc = (item.description || "").trim().slice(0, 25);
            if (desc.toLowerCase() === header.toLowerCase() || desc.length < 2) {
              desc = `Shop ${merchantName}`.length <= 25 ? `Shop ${merchantName}` : "View details";
              if (desc.toLowerCase() === header.toLowerCase()) desc = "View details";
            }
            return { ...item, header, description: desc };
          });
          console.warn(`[Price] AI batch rewrite 全部失败，使用清理后的原始数据`);
        }
      } catch (outerErr) {
        console.error("[Price] AI rewrite 异常:", outerErr instanceof Error ? outerErr.message : outerErr);
      }

      let priceType = "Products";
      try {
        if (merchantName.split(" ").length === 1 || /store|shop|brand/i.test(cache.pageText)) {
          priceType = "Brands";
        } else if (/service|consult|plan|subscription/i.test(cache.pageText)) {
          priceType = "Services";
        }
      } catch {}
      send("price_items", { skipped: false, items, type: priceType });
      console.log(`[Optional] 价格信息: ${items.length} 条（AI 重写标题/描述）`);
    }
  }

  // ─── AI 生成类型：callouts + snippet + negative_keywords ───
  const needsAi = optionalTypes.filter((t) => !["call", "promotion", "price"].includes(t));

  if (needsAi.length > 0) {
    const sections: string[] = [];

    if (needsAi.includes("callouts")) {
      const featuresText = cache.features.length > 0
        ? cache.features.join(", ")
        : cache.pageText.slice(0, 500);
      sections.push(`## Callouts (宣传信息)
Generate exactly 6 callout extensions based ONLY on real merchant features.
Each callout: 2-25 characters STRICTLY. No generic placeholder text.
Merchant features / page content: ${featuresText}

Rules:
- Must be specific to THIS merchant (not generic like "Best Quality", "Shop Now")
- If free shipping confirmed: include it. If returns confirmed: include it.
- Focus on concrete features: materials, certifications, guarantees, unique attributes
- Do NOT fabricate discounts, numbers, or unverified claims`);
    }

    if (needsAi.includes("snippet")) {
      const contextItems = [...new Set([
        ...cache.navItems,
        ...cache.links.map((l) => l.text).filter((t) => t.length >= 2 && t.length <= 30),
      ])].slice(0, 30);
      sections.push(`## Structured Snippet (结构化摘要)
IMPORTANT: Choose header ONLY from this exact list (case-sensitive):
${GOOGLE_SNIPPET_HEADERS.map((h) => `"${h}"`).join(", ")}

Extract 3-10 real category values (each ≤25 chars) from merchant content.
Available nav/link items: ${contextItems.slice(0, 20).map((t) => `"${t}"`).join(", ")}

Choose the most appropriate header for this merchant type.`);
    }

    if (needsAi.includes("negative_keywords")) {
      sections.push(`## Negative Keywords (否定关键词)
Generate 10-20 negative keywords using Adrian's strategy.
Merchant: ${merchantName}, Products/Context: ${cache.features.slice(0, 5).join(", ") || cache.pageText.slice(0, 300)}

MUST include (where relevant):
- Price-sensitivity negatives: cheap, cheapest, free, wholesale, budget, bargain
- DIY/research intent: diy, how to make, tutorial, homemade, recipe
- Non-purchase intent: reddit, review only, forum, wiki, definition, meaning
- Competitor confusion: [if merchant is a specific brand, include generic category terms that don't match]
- Low-quality seekers: knockoff, replica, fake, imitation, generic
- Policy-risk negatives: If the merchant's product category could be confused with restricted content (e.g., mushroom supplies → add "magic", "psychedelic", "trip", "high"; knife store → add "weapon", "combat", "tactical assault"), add negatives that prevent ads from showing on policy-violating searches

Return ONLY single words or short phrases. No match-type brackets.`);
    }

    if (sections.length === 0) { await Promise.resolve(); return; }

    const prompt = `${AD_COPY_ANTI_AI_BLOCK}

Analyze this merchant and generate the requested Google Ads extensions.

CRITICAL: Only use facts from the website content. Do NOT invent product names, prices, or claims.

Merchant: ${merchantName}
Website: ${merchantUrl}
Target: ${market.countryNameZh} (${languageName})

Website content:
${cache.pageText.slice(0, 3000)}

${sections.join("\n\n")}

Return ONLY a valid JSON object with the applicable keys:
{
  ${needsAi.includes("callouts") ? '"callouts": ["c1","c2","c3","c4","c5","c6"],' : ""}
  ${needsAi.includes("snippet") ? `"snippet": { "header": "Types", "values": ["v1","v2","v3"] }${needsAi.includes("negative_keywords") ? "," : ""}` : ""}
  ${needsAi.includes("negative_keywords") ? '"negative_keywords": ["kw1","kw2",...]' : ""}
}`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 4096);
      const parsed = JSON.parse(extractJsonFromAi(raw));

      if (needsAi.includes("callouts")) {
        let callouts: string[] = Array.isArray(parsed.callouts)
          ? parsed.callouts
              .map((c: string) => String(c || "").trim())
              .filter((c: string) => c.length >= 2 && c.length <= 25)
          : [];
        // 必须至少4条，不足则补充通用词
        if (callouts.length < 4) {
          const extras = cache.features
            .map((f) => f.slice(0, 25))
            .filter((f) => f.length >= 2 && !callouts.includes(f));
          callouts = [...callouts, ...extras].slice(0, 6);
        }
        const calloutFix = await complianceAutoFix(callouts, "headline", merchantName, languageName, aiRuleProfile, 25, 2);
        callouts = calloutFix.items;
        if (calloutFix.fixed.length > 0) send("compliance_auto_fix", { fixed: calloutFix.fixed, count: calloutFix.fixed.length });
        callouts = humanizeAdCopyBatch(callouts, 2, 25);
        send("callouts", callouts.slice(0, 6));
      }

      if (needsAi.includes("snippet")) {
        const snippet = parsed.snippet;
        if (snippet?.header && Array.isArray(snippet.values) && snippet.values.length >= 3) {
          const validHeader = validateSnippetHeader(String(snippet.header));
          let values = snippet.values
            .map((v: string) => String(v || "").trim())
            .filter((v: string) => v.length >= 2 && v.length <= 25)
            .slice(0, 10);
          values = humanizeAdCopyBatch(values, 2, 25);
          send("structured_snippet", values.length >= 3 ? { header: validHeader, values } : null);
        } else {
          send("structured_snippet", null);
        }
      }

      if (needsAi.includes("negative_keywords")) {
        const negKws: string[] = Array.isArray(parsed.negative_keywords)
          ? parsed.negative_keywords
              .map((k: string) => String(k || "").trim().toLowerCase())
              .filter((k: string) => k.length >= 2 && k.length <= 80)
              .slice(0, 20)
          : [];
        send("negative_keywords", negKws);
        console.log(`[Optional] 否定关键词: ${negKws.length} 条`);
      }

      console.log(`[Optional] AI 生成完成: ${needsAi.join(", ")}`);
    } catch (err) {
      console.error("[Optional] AI 生成失败:", err instanceof Error ? err.message : err);
      if (needsAi.includes("callouts")) send("callouts", []);
      if (needsAi.includes("snippet")) send("structured_snippet", null);
      if (needsAi.includes("negative_keywords")) send("negative_keywords", []);
    }
  }
}

// ─── 辅助函数 ───

async function fetchSubPagesForOptional(
  links: { url: string; text: string }[],
  needsAi: string[],
): Promise<{ promoText: string; priceItems: { header: string; description: string; price: number; currency: string; url: string }[] }> {
  let promoText = "";
  let priceItems: { header: string; description: string; price: number; currency: string; url: string }[] = [];

  const promoKeywords = ["sale", "deal", "offer", "promo", "discount", "coupon", "special", "clearance", "pricing"];
  const priceKeywords = ["pricing", "price", "plan", "shop", "product", "store", "buy", "collection"];

  const subLinks = links.filter((l) => {
    const lower = l.url.toLowerCase() + " " + l.text.toLowerCase();
    if (needsAi.includes("promotion") && promoKeywords.some((kw) => lower.includes(kw))) return true;
    if (needsAi.includes("price") && priceKeywords.some((kw) => lower.includes(kw))) return true;
    return false;
  }).slice(0, 4);

  const results = await Promise.allSettled(subLinks.map(async (link) => {
    const resp = await fetch(link.url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
    return { text, html, url: link.url };
  }));

  for (const r of results) {
    if (r.status === "fulfilled" && r.value) {
      promoText += `\n--- ${r.value.url} ---\n${r.value.text}`;
      if (needsAi.includes("price")) {
        const items = extractPriceInfo(r.value.html, "US", r.value.url);
        if (items.length > priceItems.length) priceItems = items;
      }
    }
  }

  return { promoText, priceItems };
}

async function extractPhoneFromCache(
  cache: CrawlCache,
  merchantUrl: string,
  country: string,
): Promise<{ country_code: string; phone_number: string } | null> {
  const CC: Record<string, string> = {
    US: "US", CA: "CA", GB: "GB", UK: "GB", AU: "AU",
    DE: "DE", FR: "FR", JP: "JP", IT: "IT", ES: "ES", NL: "NL",
    SE: "SE", NO: "NO", DK: "DK", BR: "BR",
  };
  const countryCode = CC[country.toUpperCase()] || "US";

  // 从缓存中选出第一个通过格式校验的号码
  // 不能盲目取 candidates[0]，历史缓存可能包含格式不正确的号码
  const { isValidPhoneForCountry: validate } = await import("@/lib/crawl-pipeline");
  for (const candidate of cache.phoneCandidates) {
    if (validate(candidate.phone_number, countryCode)) {
      return { country_code: countryCode, phone_number: candidate.phone_number };
    }
  }

  // 缓存无有效号码，尝试爬 contact 页面的 tel: href（最可靠来源）
  const contactLinks = cache.links.filter((l) =>
    /contact|about|impressum|kontakt|nous-contacter/i.test(l.url) || /contact|about/i.test(l.text),
  ).slice(0, 2);

  for (const link of contactLinks) {
    try {
      const resp = await fetch(link.url, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      });
      if (!resp.ok) continue;
      const html = await resp.text();
      const telRegex = /href=["']tel:([^"']+)["']/gi;
      let m;
      while ((m = telRegex.exec(html)) !== null) {
        const phone = decodeURIComponent(m[1]).replace(/\s+/g, "").trim();
        if (validate(phone, countryCode)) {
          return { country_code: countryCode, phone_number: phone };
        }
      }
    } catch {}
  }

  // 找不到合格号码 → 返回 null，skip call extension
  console.log(`[Call] 未找到符合 ${countryCode} 格式的电话号码，跳过致电扩展`);
  return null;
}

// getDefaultCallouts 已移除 — callouts 必须基于真实商家特征由 AI 生成

const IMG_BLACKLIST = [
  "logo", "favicon", "icon", "avatar", "payment", "badge", "social", "flag", "arrow",
  "spinner", "loading", "placeholder", "blank", "footer", "newsletter",
  "trustpilot", "captcha", "pixel", "tracking", "facebook", "twitter", "instagram",
  "visa", "mastercard", "paypal", "ssl", "emoji", "1x1", "spacer",
];

// 社交媒体域名 - 非品牌相关图片（规则：不能有文字、必须品牌强相关）
const SOCIAL_MEDIA_DOMAINS = [
  "instagram.com", "cdninstagram.com",
  "facebook.com", "fbcdn.net", "fbsbx.com",
  "twitter.com", "twimg.com",
  "tiktok.com", "tiktokcdn.com",
  "pinterest.com", "pinimg.com",
  "youtube.com", "ytimg.com",
  "snapchat.com", "snapchatcdn.com",
  "reddit.com", "redd.it",
  "tumblr.com",
];

// URL 路径中的促销/文字内容特征词（此类图片通常带大量文字覆盖，不是纯产品图）
// 注意：不过滤 /hero/ /banner/ /slide/ — 电商品牌常用这些路径存放产品主图
const TEXT_PROMO_URL_PATTERNS = [
  "/flyer", "/poster",
  "/announce", "/ad-creative", "/ads-creative",
  "percent-off", "pct-off", "%-off",
  "/graphic", "/infographic",
  "before-after", "before_after", "beforeafter",
  "/coupon",
];

// 前端最少接收图片数，无论如何必须达到
const MIN_IMAGES_TO_FRONTEND = 20;

async function selectBestImages(rawImages: string[], merchantUrl?: string): Promise<string[]> {
  // 解析商家主域名，用于品牌相关性判断
  let merchantDomain = "";
  if (merchantUrl) {
    try {
      const u = new URL(merchantUrl.startsWith("http") ? merchantUrl : `https://${merchantUrl}`);
      merchantDomain = u.hostname.replace(/^www\./, "");
    } catch { /* ignore */ }
  }

  // 核心过滤（绝对黑名单：SVG / data-URI / 明确小图 / 社交域名 / 明显文字图片）
  const hardFilter = (url: string): boolean => {
    const lower = url.toLowerCase();
    if (IMG_BLACKLIST.some((kw) => lower.includes(kw))) return false;
    if (lower.endsWith(".svg") || lower.startsWith("data:")) return false;
    const tinyMatch = lower.match(/[/_-](\d+)x(\d+)/);
    if (tinyMatch && (parseInt(tinyMatch[1]) < 150 || parseInt(tinyMatch[2]) < 150)) return false;
    try {
      const imgHostname = new URL(url).hostname.toLowerCase();
      if (SOCIAL_MEDIA_DOMAINS.some((d) => imgHostname === d || imgHostname.endsWith("." + d))) return false;
    } catch { /* ignore */ }
    const urlPath = lower.split("?")[0];
    if (TEXT_PROMO_URL_PATTERNS.some((p) => urlPath.includes(p))) return false;
    return true;
  };

  // 软过滤（URL 含按钮/徽标/精灵图特征）
  const TEXT_URL_PATTERNS = [/\/badge[s]?\//i, /\/label[s]?\//i, /\/text[s]?\//i, /\/overlay/i, /\/sprite[s]?\//i, /\/button[s]?\//i, /\bfavicon\b/i];
  const softFilter = (url: string): boolean => !TEXT_URL_PATTERNS.some((p) => p.test(url.toLowerCase()));

  const filtered = rawImages.filter(hardFilter);

  // 若商家域名已知，将同域图片排在前面
  const rank = (imgs: string[]) => merchantDomain
    ? [
        ...imgs.filter((url) => { try { return new URL(url).hostname.replace(/^www\./, "").includes(merchantDomain); } catch { return false; } }),
        ...imgs.filter((url) => { try { return !new URL(url).hostname.replace(/^www\./, "").includes(merchantDomain); } catch { return true; } }),
      ]
    : imgs;

  const ranked = rank(filtered);

  // 兜底：硬过滤后太少，直接用原始列表（不过滤）
  const pool = ranked.length >= MIN_IMAGES_TO_FRONTEND ? ranked : rank(rawImages.filter(u => !u.startsWith("data:") && !u.endsWith(".svg")));

  // Step 1：HEAD 检查——验证可访问 + 非过小文件（并发 10，最多检查 80 张）
  const checked: string[] = [];
  for (let i = 0; i < pool.length && checked.length < 80; i += 10) {
    const batch = pool.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const resp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(4000), headers: { "User-Agent": "Googlebot-Image/1.0" } });
          if (!resp.ok) return null;
          const ct = resp.headers.get("content-type") || "";
          if (!ct.startsWith("image/")) return null;
          const cl = parseInt(resp.headers.get("content-length") || "0", 10);
          if (cl > 0 && cl < 5000) return null;
          return url;
        } catch { return url; } // 超时/报错：不过滤，保留
      }),
    );
    for (const r of results) if (r.status === "fulfilled" && r.value) checked.push(r.value);
    // 已通过 HEAD 检查的够用就停（节省时间）
    if (checked.length >= 40) break;
  }

  const headPassed = checked.length >= MIN_IMAGES_TO_FRONTEND ? checked : (checked.length > 0 ? [...checked, ...pool.filter(u => !checked.includes(u))].slice(0, 80) : pool.slice(0, 80));

  // Step 2：软过滤
  const cleanImages = headPassed.filter(softFilter);

  // ─── 硬保障：至少返回 MIN_IMAGES_TO_FRONTEND 张 ───
  // 逐层放宽：软过滤结果 → HEAD通过结果 → 原始 pool → 原始 rawImages
  const result = cleanImages.length >= MIN_IMAGES_TO_FRONTEND ? cleanImages
    : headPassed.length >= MIN_IMAGES_TO_FRONTEND ? headPassed
    : pool.length >= MIN_IMAGES_TO_FRONTEND ? pool
    : [...pool, ...rawImages.filter(u => !pool.includes(u) && !u.startsWith("data:"))];

  console.log(`[SelectImages] raw=${rawImages.length} filtered=${filtered.length} headPassed=${headPassed.length} clean=${cleanImages.length} final=${Math.min(result.length, 40)}`);
  return result.slice(0, 40);
}
