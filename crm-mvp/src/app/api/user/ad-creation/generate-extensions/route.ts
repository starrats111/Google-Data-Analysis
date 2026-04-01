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
  const { campaign_id, types = [], ad_language } = body;
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

      try {
        send("crawl_status", { crawl_failed: cache!.crawlFailed, crawl_method: cache!.crawlMethod });

        const tasks: Promise<void>[] = [];

        // ─── core: 1 次 AI 生成标题 + 描述 + 站内链接描述 + 图片 ───
        if (types.includes("core")) {
          tasks.push(generateCore(cache!, merchantName, merchantUrl, country, adSettings, aiRuleProfile, adCreative?.id || null, send, ad_language));
        }

        // ─── optional: 1 次 AI 批量生成所有勾选的可选扩展 ───
        if (types.includes("optional")) {
          const optionalTypes: string[] = body.optionalTypes || [];
          tasks.push(generateOptionalBatch(cache!, merchantName, merchantUrl, country, optionalTypes, aiRuleProfile, send, ad_language));
        }

        await Promise.all(tasks);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        console.error("[Extensions] 流式生成未捕获异常:", err instanceof Error ? err.message : err);
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", data: "生成失败，请重试" })}\n\n`)); } catch {}
      } finally {
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      // 客户端主动断开连接时静默处理，避免抛出未捕获异常
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
    ? `\nReal products found on website (use these names in copy, do NOT invent product names):\n${crawledProducts.slice(0, 10).map((p: any, i: number) => `${i + 1}. "${p.name}"${p.price ? ` — ${p.currency || ""}${p.price}` : ""}`).join("\n")}\n`
    : "";

  const prompt = `You are a top-tier Google Ads conversion copywriter. Your mission: write ad copy so compelling that users STOP scrolling and click. Every line must earn its place.

FACTUAL CONSTRAINTS (non-negotiable):
- Use ONLY facts from the data below. NEVER fabricate product names, prices, or claims.
- If no discount/shipping data is provided, focus on desire, trust, and brand story instead.
${discountGuidance}${shippingGuidance}

Context:
- Merchant: ${merchantName}
- Website: ${merchantUrl}
- Target market: ${market.countryNameZh} (write in ${languageName})
- Budget: $${dailyBudget.toFixed(2)}/day, CPC $${maxCpc.toFixed(2)}, Strategy: ${biddingStrategy}
${productBlock}
Website content:
${cache.pageText.slice(0, 2000)}

${cache.features.length > 0 ? `Merchant features:\n${cache.features.join("\n")}\n` : ""}${semrushBlock}${sitelinkBlock}${formatAiRuleBlock(aiRuleProfile, "ad_copy")}
${AD_COPY_ANTI_AI_BLOCK}

Return ONLY a JSON object with this exact structure:
{
  "headlines": ["h1","h2",...],
  "descriptions": ["d1","d2","d3","d4"],
  "sitelink_descriptions": [{"title":"...","desc1":"...","desc2":"..."},...]
}
Note: "title" in sitelink_descriptions is required. If the original sitelink title is in ALL CAPS or is unclear, rewrite it in Title Case or sentence case (≤25 chars). Otherwise keep it as-is.

═══ COPYWRITING CRAFT — READ BEFORE WRITING ═══
Great ad copy does ONE of these things per line:
  • Speaks to a pain: "Tired of products that don't work?"
  • Promises a specific outcome: "Results you'll actually see"
  • Builds desire: "The skin you've always wanted"
  • Creates trust: "Trusted by thousands — see why"
  • Drives action: "Shop the top-rated collection"
  • Highlights edge: "No harsh chemicals. Real results."

Power words (use freely): proven, real results, fast, works, rated, top-selling, trusted, easy, clear, fresh, effective, new, better, lasting, gentle, visible, simple, best

BANNED words (auto-rejected): unlock, unleash, elevate, revolutionize, seamless, cutting-edge, game-changer, curated, empower, harness, innovative, transformative, holistic, paradigm, synergy

═══ HEADLINES — exactly 15, each ≤30 chars ═══
Build a VARIED set across these angles (mix freely, brand headline MUST be #1):
  ① Brand (required #1): include "${merchantName}" — make it memorable, not just the name
  ② Benefit (2-3 lines): specific outcome the customer gets — concrete, vivid
  ③ Hook/question (1-2 lines): speak to the pain or desire — make them feel seen
  ④ Trust/proof (1-2 lines): credibility signal — rated, proven, loved, tested
  ⑤ Product/category (2-3 lines): what they're shopping for — specific, searchable
  ⑥ Differentiator (1-2 lines): what makes this brand stand out vs. alternatives
  ⑦ CTA (1-2 lines): what to do next — specific action, not just "Shop Now"
  ${hasRealDiscount ? "⑧ Discount (1 line): reference the verified discount — be specific" : ""}
  ${hasRealFreeShipping ? "⑧ Shipping (1 line): mention free shipping as a value hook" : ""}

Rules:
- Use Title Case or sentence case — NEVER ALL CAPS
- No dates, expiry, or countdowns
- No multiple punctuation — at most ONE ! or ? per headline
- Front-load the most important word

═══ DESCRIPTIONS — exactly 4, each 50-90 chars ═══
Write one description per angle — each must open differently and cover a DISTINCT benefit:

  Description 1 — PROBLEM → SOLUTION: Name the customer's real pain, position the product as the fix. Example: "Struggling with X? [Brand] delivers Y that actually works."
  Description 2 — KEY BENEFIT + CTA: Lead with the strongest product outcome, end with a specific action. Example: "Get [specific result] with [product]. Shop the full range today."
  Description 3 — TRUST + PROOF: Use credibility — ratings, endorsements, brand heritage, tested/proven claims. Example: "Trusted by [audience]. Dermatologist-tested. See real results."
  Description 4 — UNIQUE EDGE: What makes this brand different. No harsh chemicals, better formula, exclusive range, etc. Example: "Unlike [generic alternatives], [brand] uses [specific edge] for real results."

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

Return ONLY valid JSON, no explanation.`;

  try {
    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 4096);
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

// ─── 可选扩展批量生成：1 次 AI 生成全部勾选项 ───

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
  const needsCall = optionalTypes.includes("call");

  // 电话提取（无 AI，并行执行）
  const callTask = needsCall
    ? extractPhoneFromCache(cache, merchantUrl, country).then((d) => send("call", d)).catch(() => send("call", null))
    : Promise.resolve();

  // ─── promotion: 完全由爬虫数据提供，不经过 AI ───
  if (optionalTypes.includes("promotion")) {
    const promo = cache.promoRegex
      ? { ...cache.promoRegex, final_url: merchantUrl }
      : null;
    send("promotion", promo);
    if (promo) {
      console.log(`[Optional] 促销信息（爬虫提取）: ${JSON.stringify(promo).slice(0, 200)}`);
    } else {
      console.log("[Optional] 未从网页爬取到促销信息");
    }
  }

  // ─── price: 完全由爬虫数据提供，不经过 AI ───
  if (optionalTypes.includes("price")) {
    // 优先使用 crawledProducts（有真实产品名和URL），其次用 priceRegex
    const crawledProducts = (cache as any).crawledProducts || [];
    let items: { header: string; description: string; price: number; currency: string; url: string }[] = [];

    if (crawledProducts.length > 0) {
      items = crawledProducts
        .filter((p: any) => p.name && p.price && p.price > 0)
        .slice(0, 8)
        .map((p: any) => ({
          header: String(p.name).slice(0, 25),
          description: String(p.description || "").slice(0, 25),
          price: Number(p.price),
          currency: String(p.currency || market.currencyCode),
          url: String(p.url || merchantUrl),
        }));
    }

    if (items.length === 0 && cache.priceRegex.length > 0) {
      items = cache.priceRegex.map((p) => ({ ...p, url: p.url || merchantUrl }));
    }

    // 如果首页爬不到，尝试子页面
    if (items.length === 0) {
      const subData = await fetchSubPagesForOptional(cache.links, ["price"]);
      if (subData.priceItems.length > 0) {
        items = subData.priceItems.map((p) => ({ ...p, url: p.url || merchantUrl }));
      }
    }

    send("price_items", items);
    console.log(`[Optional] 价格信息（爬虫提取）: ${items.length} 条产品`);
  }

  // ─── 需要 AI 的类型：仅 callouts 和 snippet ───
  const needsAi = optionalTypes.filter((t) => !["call", "promotion", "price"].includes(t));

  if (needsAi.length > 0) {
    // 构建合并 prompt（仅 callouts / snippet，不含 promotion / price）
    const sections: string[] = [];

    if (needsAi.includes("callouts")) {
      const featuresBlock = cache.features.length > 0 ? `\nMerchant features: ${cache.features.join(", ")}` : "";
      sections.push(`## Callouts
Generate exactly 6 callout extensions (≤25 chars each).
Based on real merchant features. If shipping + returns both exist, merge into one line.
Do NOT fabricate specific discounts or promotions.${featuresBlock}`);
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

CRITICAL: Your role is to WRITE copy based on the information below. Do NOT invent product names, prices, discounts, or any factual claims. Only use information explicitly present in the website content.

Merchant: ${merchantName}
Website: ${merchantUrl}
Target: ${market.countryNameZh} (${languageName})

Website content:
${cache.pageText.slice(0, 3000)}

${sections.join("\n\n")}
${formatAiRuleBlock(aiRuleProfile, "compliance")}

Return ONLY a JSON object with applicable keys:
{
  ${needsAi.includes("callouts") ? '"callouts": ["c1","c2","c3","c4","c5","c6"],' : ""}
  ${needsAi.includes("snippet") ? '"snippet": { "header": "Types", "values": ["v1","v2","v3"] }' : ""}
}`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 4096);
      const parsed = JSON.parse(extractJsonFromAi(raw));

      if (needsAi.includes("callouts")) {
        let callouts = Array.isArray(parsed.callouts)
          ? parsed.callouts.filter((c: string) => c && c.length <= 25).slice(0, 6)
          : getDefaultCallouts(merchantName, country, cache.features);
        const calloutFix = await complianceAutoFix(callouts, "headline", merchantName, languageName, aiRuleProfile, 25, 2);
        callouts = calloutFix.items;
        if (calloutFix.fixed.length > 0) send("compliance_auto_fix", { fixed: calloutFix.fixed, count: calloutFix.fixed.length });
        if (calloutFix.remaining.length > 0) send("compliance_warnings", { warnings: calloutFix.remaining, count: calloutFix.remaining.length });
        send("callouts", callouts);
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

      console.log(`[Optional] AI 生成完成: ${needsAi.join(", ")}`);
    } catch (err) {
      console.error("[Optional] AI 生成失败:", err instanceof Error ? err.message : err);
      for (const t of needsAi) {
        if (t === "callouts") send("callouts", getDefaultCallouts(merchantName, country, cache.features));
        else if (t === "snippet") send("structured_snippet", null);
      }
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

// URL 路径中的促销/文字内容特征词（此类图片通常带大量文字）
const TEXT_PROMO_URL_PATTERNS = [
  "/sale", "_sale", "-sale",
  "/promo", "_promo", "-promo",
  "/offer", "_offer", "-offer",
  "/deal", "_deal", "-deal",
  "/coupon", "/clearance", "/flyer", "/poster",
  "/announce", "/campaign", "/ad-", "/ads-",
  "percent-off", "pct-off", "%-off",
  "/graphic", "/infographic",
  "before-after", "before_after", "beforeafter",
];

async function selectBestImages(rawImages: string[], merchantUrl?: string): Promise<string[]> {
  // 解析商家主域名，用于品牌相关性判断
  let merchantDomain = "";
  if (merchantUrl) {
    try {
      const u = new URL(merchantUrl.startsWith("http") ? merchantUrl : `https://${merchantUrl}`);
      merchantDomain = u.hostname.replace(/^www\./, "");
    } catch { /* ignore */ }
  }

  const filtered = rawImages.filter((url) => {
    const lower = url.toLowerCase();
    if (IMG_BLACKLIST.some((kw) => lower.includes(kw))) return false;
    if (lower.endsWith(".svg") || lower.startsWith("data:")) return false;
    const tinyMatch = lower.match(/[/_-](\d+)x(\d+)/);
    if (tinyMatch && (parseInt(tinyMatch[1]) < 150 || parseInt(tinyMatch[2]) < 150)) return false;

    // 过滤社交媒体域名图片（与品牌不强相关）
    try {
      const imgHostname = new URL(url).hostname.toLowerCase();
      if (SOCIAL_MEDIA_DOMAINS.some((d) => imgHostname === d || imgHostname.endsWith("." + d))) return false;
      // 如果商家域名已知，且图片来自完全无关的第三方域（非主流CDN），降低优先级
      // 但不直接过滤，避免误伤合法CDN
    } catch { /* ignore */ }

    // 过滤 URL 中含有明显促销/文字内容特征的图片
    const urlPath = lower.split("?")[0];
    if (TEXT_PROMO_URL_PATTERNS.some((p) => urlPath.includes(p))) return false;

    return true;
  });

  // 若商家域名已知，将同域图片排在前面
  const ranked = merchantDomain
    ? [
        ...filtered.filter((url) => {
          try { return new URL(url).hostname.replace(/^www\./, "").includes(merchantDomain); }
          catch { return false; }
        }),
        ...filtered.filter((url) => {
          try { return !new URL(url).hostname.replace(/^www\./, "").includes(merchantDomain); }
          catch { return true; }
        }),
      ]
    : filtered;

  if (ranked.length === 0) return rawImages.slice(0, 60);

  const checked: string[] = [];
  for (let i = 0; i < ranked.length && checked.length < 80; i += 10) {
    const batch = ranked.slice(i, i + 10);
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

  return checked.length > 0 ? checked.slice(0, 60) : ranked.slice(0, 60);
}
