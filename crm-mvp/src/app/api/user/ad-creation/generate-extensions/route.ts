import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { callAiWithFallback, suggestDisplayPaths } from "@/lib/ai-service";
import { getAdMarketConfig } from "@/lib/ad-market";
import { buildAiRulePrompt } from "@/lib/ai-rule-profile";
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
} from "@/lib/crawl-pipeline";

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

  try {
    const condensedPrompt = `Condense each line to ≤${maxLen} characters. Keep the same language (${languageName}). Preserve brand names, numbers, and key selling points. Do NOT add new information.

${overlong.map((item, i) => `${i + 1}. "${item.text}" (${item.text.length} chars)`).join("\n")}

Return ONLY a JSON array of condensed strings in the same order.`;
    const rawResult = await callAiWithFallback("ad_copy", [{ role: "user", content: condensedPrompt }], 1024);
    const condensed = JSON.parse(extractJsonFromAi(rawResult));
    if (!Array.isArray(condensed) || condensed.length !== overlong.length) throw new Error("AI 返回数量不匹配");

    const result = [...items];
    for (let i = 0; i < overlong.length; i++) {
      const c = String(condensed[i] || "").trim();
      if (c.length >= 2 && c.length <= maxLen) {
        result[overlong[i].idx] = c;
      } else {
        result[overlong[i].idx] = smartTruncate(overlong[i].text, maxLen);
      }
    }
    console.log(`[condenseOverlong] AI 缩略 ${overlong.length} 条超长文案 (maxLen=${maxLen})`);
    return result;
  } catch (err) {
    console.warn("[condenseOverlong] AI 缩略失败，降级为 smartTruncate:", err instanceof Error ? err.message : err);
    return items.map((text) => text.length > maxLen ? smartTruncate(text, maxLen) : text);
  }
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

  const body = await req.json();
  const { campaign_id, types = [] } = body;
  if (!campaign_id) return apiError("缺少 campaign_id");
  if (!types.length) return apiError("缺少 types");

  const campaign = await prisma.campaigns.findFirst({
    where: { id: BigInt(campaign_id), user_id: BigInt(user.userId), is_deleted: 0 },
  });
  if (!campaign) return apiError("广告系列不存在", 404);

  const merchant = await prisma.user_merchants.findFirst({
    where: { id: campaign.user_merchant_id, is_deleted: 0 },
  });
  if (!merchant) return apiError("商家不存在");

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

  const merchantUrl = merchant.merchant_url || adCreative?.final_url || "";
  const merchantName = merchant.merchant_name || "";
  const country = campaign.target_country || "US";
  const market = getAdMarketConfig(country);

  const adSettings = await prisma.ad_default_settings.findFirst({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
    select: { ai_rule_profile: true, daily_budget: true, max_cpc: true, bidding_strategy: true },
  });
  const aiRuleProfile = (adSettings as any)?.ai_rule_profile;

  // 读取或构建爬取缓存（失败的缓存也重新爬取）
  let cache = adCreative?.crawl_cache as CrawlCache | null;
  if (!cache || !cache.crawledAt || cache.crawlFailed) {
    console.log(`[Extensions] crawl_cache ${cache?.crawlFailed ? '上次失败，重新' : '为空，现场'}爬取...`);
    cache = await buildCrawlCache(merchantUrl, merchantName, country);
    if (adCreative?.id) {
      await prisma.ad_creatives.update({
        where: { id: adCreative.id },
        data: { crawl_cache: cache as any },
      }).catch(() => {});
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (eventType: string, payload: unknown) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: eventType, data: serializeData(payload) })}\n\n`)); } catch {}
      };

      send("crawl_status", { crawl_failed: cache!.crawlFailed, crawl_method: cache!.crawlMethod });

      const tasks: Promise<void>[] = [];

      // ─── core: 1 次 AI 生成标题 + 描述 + 站内链接描述 + 图片 ───
      if (types.includes("core")) {
        tasks.push(generateCore(cache!, merchantName, merchantUrl, country, adSettings, aiRuleProfile, adCreative?.id || null, send));
      }

      // ─── optional: 1 次 AI 批量生成所有勾选的可选扩展 ───
      if (types.includes("optional")) {
        const optionalTypes: string[] = body.optionalTypes || [];
        tasks.push(generateOptionalBatch(cache!, merchantName, merchantUrl, country, optionalTypes, aiRuleProfile, send));
      }

      await Promise.all(tasks);
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
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
) {
  const market = getAdMarketConfig(country);
  const dailyBudget = Number(adSettings?.daily_budget || 2);
  const maxCpc = Number(adSettings?.max_cpc || 0.3);
  const biddingStrategy = adSettings?.bidding_strategy || "MAXIMIZE_CLICKS";

  const sitelinkBlock = cache.sitelinkCandidates.length > 0
    ? `\nVerified sitelinks (write desc1+desc2 for each, ≤35 chars each):\n${cache.sitelinkCandidates.map((s, i) => `${i + 1}. "${s.title}" → ${s.url}${s.description ? ` (meta: "${s.description}")` : ""}`).join("\n")}\n`
    : "";

  const semrushBlock = cache.semrushTitles.length > 0
    ? `\nCompetitor headline references (inspiration only, do NOT copy):\n${cache.semrushTitles.slice(0, 8).map((t, i) => `${i + 1}. "${t}"`).join("\n")}\n`
    : "";

  const prompt = `You are a senior Google Ads RSA copywriter. Generate ALL ad copy in ONE response.

Context:
- Merchant: ${merchantName}
- Website: ${merchantUrl}
- Target: ${market.countryNameZh} (${market.languageName})
- Budget: $${dailyBudget.toFixed(2)}/day, CPC $${maxCpc.toFixed(2)}, Strategy: ${biddingStrategy}

Website content (truncated):
${cache.pageText.slice(0, 2000)}

${cache.features.length > 0 ? `Merchant features:\n${cache.features.join("\n")}\n` : ""}${semrushBlock}${sitelinkBlock}${formatAiRuleBlock(aiRuleProfile, "ad_copy")}

Return ONLY a JSON object with this exact structure:
{
  "headlines": ["h1","h2",...],
  "descriptions": ["d1","d2","d3","d4"],
  "sitelink_descriptions": [{"desc1":"...","desc2":"..."},...]
}

MANDATORY RULES for headlines (exactly 15):
1. #1 must include "${merchantName}" or clear brand reference
2. Include exactly 1 discount headline and 1 shipping headline
3. Each ≤ 30 characters, in ${market.languageName}
4. No dates/expiry/countdowns, no generic filler like "Official Site"
5. Commercially strong: trust, value, CTA, product fit

MANDATORY RULES for descriptions (exactly 4):
1. Exactly 1 must combine discount + shipping
2. Each 50-90 characters, in ${market.languageName}
3. Each uses a different persuasion angle
4. Must be distinct from headlines (Google flags duplicates)

MANDATORY RULES for sitelink_descriptions (${cache.sitelinkCandidates.length} entries matching sitelinks order):
1. Each desc1 and desc2 ≤ 35 characters
2. Both desc1 AND desc2 must be filled for every sitelink
3. Focus on benefits that attract clicks

Return ONLY valid JSON, no explanation.`;

  try {
    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 4096);
    const parsed = JSON.parse(extractJsonFromAi(raw));

    // 处理标题：超长的用 AI 语义缩略（保留含义），而非直接丢弃
    let rawHeadlines = Array.isArray(parsed.headlines)
      ? parsed.headlines.filter((h: string) => h && h.trim())
      : [];
    rawHeadlines = await condenseOverlong(rawHeadlines, 30, market.languageName);
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
        });
      } catch (padErr) {
        console.warn("[Core] padHeadlines 补全失败:", padErr instanceof Error ? padErr.message : padErr);
      }
    }
    send("headlines", headlines);

    // 处理描述：超长的用 AI 语义缩略
    let rawDescs = Array.isArray(parsed.descriptions)
      ? parsed.descriptions.filter((d: string) => d && d.trim())
      : [];
    rawDescs = await condenseOverlong(rawDescs, 90, market.languageName);
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
        });
      } catch (padErr) {
        console.warn("[Core] padDescriptions 补全失败:", padErr instanceof Error ? padErr.message : padErr);
      }
    }
    send("descriptions", descriptions);

    // 处理站内链接
    const sitelinkDescs = Array.isArray(parsed.sitelink_descriptions) ? parsed.sitelink_descriptions : [];
    const sitelinks = cache.sitelinkCandidates.map((s, i) => {
      const aiDesc = sitelinkDescs[i] || {};
      const brandName = merchantName.replace(/[.。,，!！?？]+/g, "").trim().slice(0, 15);
      return {
        title: s.title,
        url: s.url,
        desc1: (aiDesc.desc1 && aiDesc.desc1.length <= 35) ? aiDesc.desc1 : (s.description || brandName).slice(0, 35),
        desc2: (aiDesc.desc2 && aiDesc.desc2.length <= 35) ? aiDesc.desc2 : (brandName || titleFromUrlPath(s.url)).slice(0, 35),
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
      });
      send("headlines", headlines);
      const descriptions = await padDescriptions([], merchantName, country, 4, {
        referenceItems: cache.semrushDescriptions,
        dailyBudget: Number(adSettings?.daily_budget || 2),
        maxCpc: Number(adSettings?.max_cpc || 0.3),
        biddingStrategy: adSettings?.bidding_strategy || "MAXIMIZE_CLICKS",
        aiRuleProfile,
      });
      send("descriptions", descriptions);
      const sitelinks = cache.sitelinkCandidates.map((s) => ({
        title: s.title, url: s.url, desc1: s.description || merchantName.slice(0, 35), desc2: merchantName.slice(0, 35),
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

  // 图片筛选（无 AI）
  const images = await selectBestImages(cache.images);
  send("images", images);
  if (adCreativeId) {
    await prisma.ad_creatives.update({
      where: { id: adCreativeId },
      data: { image_urls: images as any },
    }).catch(() => {});
  }
}

// ─── 可选扩展批量生成：1 次 AI 生成全部勾选项 ───

async function generateOptionalBatch(
  cache: CrawlCache,
  merchantName: string,
  merchantUrl: string,
  country: string,
  optionalTypes: string[],
  aiRuleProfile: unknown,
  send: (type: string, data: unknown) => void,
) {
  if (optionalTypes.length === 0) return;

  const market = getAdMarketConfig(country);
  const needsAi = optionalTypes.filter((t) => t !== "call");
  const needsCall = optionalTypes.includes("call");

  // 电话提取（无 AI，并行执行）
  const callTask = needsCall
    ? extractPhoneFromCache(cache, merchantUrl, country).then((d) => send("call", d)).catch(() => send("call", null))
    : Promise.resolve();

  // 如果没有需要 AI 的类型，只处理电话
  if (needsAi.length === 0) {
    await callTask;
    return;
  }

  // 按需爬取子页补充数据
  let promoText = cache.pageText;
  let priceItems = cache.priceRegex;

  if (needsAi.includes("promotion") || needsAi.includes("price")) {
    const subData = await fetchSubPagesForOptional(cache.links, needsAi);
    if (subData.promoText) promoText += "\n\n" + subData.promoText;
    if (subData.priceItems.length > 0 && priceItems.length < 3) priceItems = subData.priceItems;
  }

  // 构建合并 prompt
  const sections: string[] = [];

  if (needsAi.includes("callouts")) {
    const featuresBlock = cache.features.length > 0 ? `\nMerchant features: ${cache.features.join(", ")}` : "";
    sections.push(`## Callouts
Generate exactly 6 callout extensions (≤25 chars each).
Based on real merchant features. If shipping + returns both exist, merge into one line.${featuresBlock}`);
  }

  if (needsAi.includes("promotion")) {
    sections.push(`## Promotion
Extract promotion/discount info. Return: discount_type ("PERCENT"/"MONETARY"/null), discount_percent, discount_amount, currency_code ("${market.currencyCode}"), promo_code, promotion_target (≤20 chars, in ${market.languageName}), language_code ("${market.promotionLanguageCode}").
Do NOT include final_url.`);
  }

  if (needsAi.includes("price")) {
    sections.push(`## Price Items
Extract 3-8 products with real pricing. Each: header (≤25 chars), description (≤25 chars), price (real number), currency ("${market.currencyCode}").
Do NOT include URLs. Return empty array if no real prices found.`);
  }

  if (needsAi.includes("snippet")) {
    const contextItems = [...new Set([...cache.navItems, ...cache.links.map((l) => l.text).filter((t) => t.length >= 2 && t.length <= 30)])].slice(0, 30);
    if (contextItems.length >= 3) {
      sections.push(`## Structured Snippet
Choose header from: "Brands", "Types", "Styles", "Models", "Service catalog", "Amenities"
Extract 3-10 real category values (≤25 chars each) from: ${contextItems.slice(0, 20).map((t) => `"${t}"`).join(", ")}`);
    }
  }

  const prompt = `Analyze this merchant website and generate the requested ad extensions.

Merchant: ${merchantName}
Website: ${merchantUrl}
Target: ${market.countryNameZh} (${market.languageName})

Website content:
${promoText.slice(0, 3000)}

${sections.join("\n\n")}
${formatAiRuleBlock(aiRuleProfile, "compliance")}

Return ONLY a JSON object with applicable keys:
{
  ${needsAi.includes("callouts") ? '"callouts": ["c1","c2","c3","c4","c5","c6"],' : ""}
  ${needsAi.includes("promotion") ? '"promotion": { "discount_type": ..., "promotion_target": ..., ... },' : ""}
  ${needsAi.includes("price") ? '"price_items": [{ "header": ..., "description": ..., "price": ..., "currency": ... }, ...],' : ""}
  ${needsAi.includes("snippet") ? '"snippet": { "header": "Types", "values": ["v1","v2","v3"] }' : ""}
}`;

  try {
    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 4096);
    const parsed = JSON.parse(extractJsonFromAi(raw));

    if (needsAi.includes("callouts")) {
      const callouts = Array.isArray(parsed.callouts)
        ? parsed.callouts.filter((c: string) => c && c.length <= 25).slice(0, 6)
        : getDefaultCallouts(merchantName, country, cache.features);
      send("callouts", callouts);
    }

    if (needsAi.includes("promotion")) {
      let promo = parsed.promotion || null;
      if (promo) {
        delete promo.final_url;
        promo.final_url = merchantUrl;
        if (!promo.language_code && promo.promotion_target) promo.language_code = market.promotionLanguageCode;
        if (promo.promotion_target) promo.promotion_target = smartTruncate(String(promo.promotion_target), 20);
      }
      // 合并正则结果
      if (cache.promoRegex && !promo) {
        promo = { ...cache.promoRegex, final_url: merchantUrl };
      }
      send("promotion", promo);
    }

    if (needsAi.includes("price")) {
      let items = Array.isArray(parsed.price_items) ? parsed.price_items : [];
      items = items.filter((p: any) => p.price && Number(p.price) > 0).slice(0, 8).map((p: any) => ({
        header: String(p.header || "").slice(0, 25),
        description: String(p.description || "").slice(0, 25),
        price: Number(p.price),
        currency: String(p.currency || market.currencyCode),
        url: merchantUrl,
      }));
      if (items.length === 0 && priceItems.length > 0) {
        items = priceItems.map((p) => ({ ...p, url: p.url || merchantUrl }));
      }
      send("price_items", items);
    }

    if (needsAi.includes("snippet")) {
      const snippet = parsed.snippet;
      if (snippet?.header && Array.isArray(snippet.values) && snippet.values.length >= 3) {
        const values = snippet.values.filter((v: string) => v && v.length <= 25).slice(0, 10);
        send("structured_snippet", values.length >= 3 ? { header: snippet.header, values } : null);
      } else {
        send("structured_snippet", null);
      }
    }

    console.log(`[Optional] AI 批量生成完成: ${needsAi.join(", ")}`);
  } catch (err) {
    console.error("[Optional] AI 批量生成失败:", err instanceof Error ? err.message : err);
    for (const t of needsAi) {
      if (t === "callouts") send("callouts", getDefaultCallouts(merchantName, country, cache.features));
      else if (t === "promotion") send("promotion", cache.promoRegex ? { ...cache.promoRegex, final_url: merchantUrl } : null);
      else if (t === "price") send("price_items", cache.priceRegex || []);
      else if (t === "snippet") send("structured_snippet", null);
    }
  }

  await callTask;
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
        const items = extractPriceInfo(r.value.html, "US");
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
  if (cache.phoneCandidates.length > 0) {
    return cache.phoneCandidates[0];
  }

  // 尝试爬 contact 页面
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
        if (phone.length >= 7 && phone.length <= 20) {
          const CC: Record<string, string> = { US: "US", CA: "CA", GB: "GB", DE: "DE", FR: "FR", JP: "JP", IT: "IT", ES: "ES", NL: "NL" };
          return { country_code: CC[country.toUpperCase()] || "US", phone_number: phone };
        }
      }
    } catch {}
  }

  return null;
}

function getDefaultCallouts(merchantName: string, country: string, features: string[]): string[] {
  const market = getAdMarketConfig(country);
  const result: string[] = [];
  const featStr = features.join(" ").toLowerCase();

  const hasShipping = /free\s*ship|free\s*deliver|kostenlos/i.test(featStr);
  const hasReturns = /money.back|return|refund|rückgabe|retour/i.test(featStr);
  if (hasShipping) result.push(smartTruncate(market.shippingLabel, 25));
  if (hasReturns) result.push(smartTruncate(market.returnLabel, 25));

  const brandShort = smartTruncate(merchantName, 25);
  if (brandShort.length >= 3) result.unshift(brandShort);

  const generic = market.languageCode === "de"
    ? ["Sicher bestellen", "Online kaufen", "Top-Qualität", "Direkt beim Händler"]
    : ["Secure Checkout", "Shop Online", "Best Price", "Quality Products"];
  for (const g of generic) { if (result.length >= 6) break; result.push(g); }
  return result.slice(0, 6);
}

const IMG_BLACKLIST = [
  "logo", "favicon", "icon", "avatar", "payment", "badge", "social", "flag", "arrow",
  "spinner", "loading", "placeholder", "blank", "banner", "footer", "newsletter",
  "trustpilot", "captcha", "pixel", "tracking", "facebook", "twitter", "instagram",
  "visa", "mastercard", "paypal", "ssl", "shipping-", "emoji", "bg-", "background",
  "1x1", "spacer",
];

async function selectBestImages(rawImages: string[]): Promise<string[]> {
  const filtered = rawImages.filter((url) => {
    const lower = url.toLowerCase();
    if (IMG_BLACKLIST.some((kw) => lower.includes(kw))) return false;
    if (lower.endsWith(".svg") || lower.startsWith("data:")) return false;
    const tinyMatch = lower.match(/[/_-](\d+)x(\d+)/);
    if (tinyMatch && (parseInt(tinyMatch[1]) < 150 || parseInt(tinyMatch[2]) < 150)) return false;
    return true;
  });

  if (filtered.length === 0) return rawImages.slice(0, 20);

  const checked: string[] = [];
  for (let i = 0; i < filtered.length && checked.length < 40; i += 10) {
    const batch = filtered.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const resp = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000), headers: { "User-Agent": "Googlebot-Image/1.0" } });
          if (!resp.ok) return null;
          const ct = resp.headers.get("content-type") || "";
          if (!ct.startsWith("image/")) return null;
          const cl = parseInt(resp.headers.get("content-length") || "0", 10);
          if (cl > 0 && cl < 5000) return null;
          return url;
        } catch { return url; }
      }),
    );
    for (const r of results) if (r.status === "fulfilled" && r.value) checked.push(r.value);
  }

  return checked.length > 0 ? checked.slice(0, 30) : filtered.slice(0, 20);
}
