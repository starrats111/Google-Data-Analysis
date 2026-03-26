import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import prisma from "@/lib/prisma";
import { callAiWithFallback } from "@/lib/ai-service";
import { getAdMarketConfig } from "@/lib/ad-market";
import { crawlPage, fetchUrlMeta, fetchPageImages, searchMerchantImages } from "@/lib/crawler";
import { buildAiRulePrompt } from "@/lib/ai-rule-profile";

function formatAiRuleBlock(profile: unknown | null | undefined, section: "sitelinks" | "ad_copy" | "compliance"): string {
  if (!profile) return "";
  const text = buildAiRulePrompt(profile, section);
  return text ? `\n\nUser hard rules (MUST follow; do not violate Google Ads policy):\n${text}\n` : "";
}

/**
 * JS 重定向 / 挑战 URL 过滤模式
 */
const BAD_SITELINK_PATTERNS = [
  /\/httpservice\//i,
  /\/enablejs/i,
  /\/cdn-cgi\//i,
  /\/captcha/i,
  /\/turnstile\//i,
  /\/bot-check/i,
  /\/challenge[\/\?]/i,
  /[\?&]__cf_chl/i,
  /\/human-verification/i,
  /\/verify\?/i,
  /\/consent\//i,
  /\/cookie-consent/i,
  /\/(login|signup|register|cart|checkout|account|wishlist|password|privacy|terms|imprint|impressum|datenschutz|agb|cookie-policy|unsubscribe)\b/i,
];

function isBadSitelinkUrl(url: string): boolean {
  if (BAD_SITELINK_PATTERNS.some((p) => p.test(url))) return true;
  const lower = url.toLowerCase();
  if (lower.includes("/search?q=cache:") || lower.includes("webcache.googleusercontent.com")) return true;
  if (/google\.\w+\/search/i.test(url) || /bing\.com\/search/i.test(url)) return true;
  return false;
}

/** 解码 HTML 实体（&amp; &ndash; &#39; 等） */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&nbsp;/gi, " ")
    .replace(/&laquo;/gi, "«")
    .replace(/&raquo;/gi, "»")
    .replace(/&copy;/gi, "©")
    .replace(/&reg;/gi, "®")
    .replace(/&trade;/gi, "™")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 智能截断：在字符限制内保持语义完整，优先在单词边界截断 */
function smartTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.5) {
    return truncated.slice(0, lastSpace).replace(/[,.\-–—:;]+$/, "").trim();
  }
  return truncated.replace(/[,.\-–—:;\s]+$/, "").trim();
}

const BLOCKED_PAGE_TITLES = [
  "just a moment", "attention required", "access denied",
  "you have been blocked", "security check", "checking your browser",
  "please wait", "one moment", "verify you are human",
  "un instant", "einen moment", "bot verification",
  "ddos protection", "pardon our interruption",
];

function isBlockedTitle(title: string): boolean {
  const t = title.toLowerCase().replace(/[.…]+$/, "").trim();
  return BLOCKED_PAGE_TITLES.some((b) => t.includes(b) || t === b);
}

function titleFromUrlPath(url: string): string {
  try {
    const segments = new URL(url).pathname
      .replace(/\.(html?|php|aspx?)$/i, "")
      .split("/").filter(Boolean)
      .filter((s) => s.length > 1);
    if (segments.length === 0) return "";
    return segments
      .map((s) => decodeURIComponent(s).replace(/[-_+]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()))
      .join(" ")
      .slice(0, 25);
  } catch { return ""; }
}

/**
 * POST /api/user/ad-creation/generate-extensions
 * 根据商家网站自动生成广告扩展：sitelinks / images / callouts
 * 健壮爬虫机制：Puppeteer → HTTP → 失败返回 crawl_failed
 * 所有链接和图片必须来自真实爬取，不做 AI 推测
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { campaign_id, types = [] } = await req.json();
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
      select: { final_url: true },
    })
    : null;

  const merchantUrl = merchant.merchant_url || adCreative?.final_url || "";
  const merchantName = merchant.merchant_name || "";
  const country = campaign.target_country || "US";

  const adSettings = await prisma.ad_default_settings.findFirst({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
    select: { ai_rule_profile: true },
  });
  const aiRuleProfile = (adSettings as { ai_rule_profile?: unknown } | null)?.ai_rule_profile;

  let crawlResult: { html: string; links: { url: string; text: string }[]; images: string[]; method: string; error?: string } = { html: "", links: [], images: [], method: "failed", error: "" };

  if (merchantUrl) {
    crawlResult = await crawlPage(merchantUrl);
  }

  // 过滤掉 JS 重定向等无效 URL
  crawlResult.links = crawlResult.links.filter((l) => !isBadSitelinkUrl(l.url));

  const crawlFailed = crawlResult.method === "failed";
  const result: Record<string, unknown> = {
    crawl_failed: crawlFailed,
    crawl_method: crawlResult.method,
  };
  if (crawlResult.error) result.crawl_error = crawlResult.error;

  const tasks: Promise<void>[] = [];

  // 促销/价格信息：爬首页 + 子页面，用 AI 提取
  if (types.includes("promotion")) {
    result.promotion = await extractPromotionWithAI(crawlResult.html, merchantUrl, merchantName, country, crawlResult.links, aiRuleProfile);
  }
  if (types.includes("price")) {
    result.price_items = await extractPriceWithAI(crawlResult.html, merchantUrl, merchantName, country, crawlResult.links, aiRuleProfile);
  }

  if (types.includes("sitelinks")) {
    tasks.push(
      generateSitelinks(merchantName, merchantUrl, country, crawlResult.links, aiRuleProfile)
        .then((data) => { result.sitelinks = data; })
        .catch((err) => {
          console.error("[Extensions] Sitelinks 生成失败:", err instanceof Error ? err.message : err);
          result.sitelinks = [];
        }),
    );
  }

  if (types.includes("images")) {
    tasks.push(
      (async () => {
        const allImgs = [...crawlResult.images];

        // 图片不足时，尝试从子页面获取更多
        if (allImgs.length < 25 && crawlResult.links.length > 0) {
          console.log(`[Images] 图片不足 (${allImgs.length})，从子页面补充...`);
          const subPages = crawlResult.links.slice(0, 12).map((l) => l.url);
          for (let i = 0; i < subPages.length && allImgs.length < 40; i += 3) {
            const batch = subPages.slice(i, i + 3);
            const batchResults = await Promise.all(batch.map((u) => fetchPageImages(u).catch(() => [] as string[])));
            for (const imgs of batchResults) {
              for (const img of imgs) {
                if (allImgs.length >= 40) break;
                if (!allImgs.includes(img)) allImgs.push(img);
              }
            }
          }
          if (allImgs.length > 0) console.log(`[Images] 子页面补充后共 ${allImgs.length} 张图片`);
        }

        // 仍然无图片 → Wayback Machine CDX API 回退
        if (allImgs.length === 0 && merchantUrl) {
          console.log("[Images] 子页面也无图片，尝试 Wayback Machine...");
          try {
            const domain = new URL(merchantUrl).hostname;
            const cdxUrl = `https://web.archive.org/cdx/search/cdx?url=${domain}/*&matchType=prefix&filter=mimetype:image/jpeg&filter=statuscode:200&fl=timestamp,original&limit=30&output=json`;
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 15000);
            const cdxRes = await fetch(cdxUrl, { signal: ctrl.signal });
            clearTimeout(t);
            if (cdxRes.ok) {
              const rows = await cdxRes.json() as string[][];
              const seen = new Set<string>();
              for (const row of rows.slice(1)) {
                if (allImgs.length >= 20) break;
                const [ts, origUrl] = row;
                if (!origUrl || seen.has(origUrl)) continue;
                const lower = origUrl.toLowerCase();
                if (/icon|logo|favicon|badge|pixel|spacer|1x1|svg|gif/i.test(lower)) continue;
                if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(lower)) continue;
                seen.add(origUrl);
                const waybackUrl = `https://web.archive.org/web/${ts}im_/${origUrl}`;
                allImgs.push(waybackUrl);
              }
              if (allImgs.length > 0) console.log(`[Images] Wayback Machine 获取到 ${allImgs.length} 张图片`);
            }
          } catch (e) {
            console.log("[Images] Wayback Machine 获取失败:", e instanceof Error ? e.message : e);
          }
        }

        // 图片不足 → 搜索引擎图片搜索补充
        if (allImgs.length < 20 && merchantUrl) {
          console.log(`[Images] 图片不足 (${allImgs.length})，启用搜索引擎图片搜索补充...`);
          try {
            const searchImgs = await searchMerchantImages(merchantUrl, merchantName);
            for (const img of searchImgs) {
              if (allImgs.length >= 40) break;
              if (!allImgs.includes(img)) allImgs.push(img);
            }
            if (allImgs.length > 0) console.log(`[Images] 搜索引擎补充后共 ${allImgs.length} 张图片`);
          } catch (e) {
            console.log("[Images] 搜索引擎图片搜索失败:", e instanceof Error ? e.message : e);
          }
        }

        if (allImgs.length > 0) {
          result.images = await selectBestImages(merchantName, merchantUrl, allImgs).catch(() => allImgs.slice(0, 20));
        } else {
          result.images = [];
        }
      })(),
    );
  }

  if (types.includes("callouts")) {
    tasks.push(
      generateCallouts(merchantName, merchantUrl, country, crawlResult.html, aiRuleProfile)
        .then((data) => { result.callouts = data; })
        .catch(() => {
          result.callouts = getDefaultCallouts(merchantName, country, []);
        }),
    );
  }

  // 致电扩展：从商家网站提取联系电话
  if (types.includes("call")) {
    tasks.push(
      extractPhoneNumber(merchantUrl, merchantName, country, crawlResult.html, crawlResult.links)
        .then((data) => { if (data) result.call = data; })
        .catch((err) => {
          console.warn("[Extensions] 致电提取失败:", err instanceof Error ? err.message : err);
        }),
    );
  }

  // 结构化摘要：从商家网站提取产品/服务属性
  if (types.includes("snippet")) {
    tasks.push(
      extractStructuredSnippet(merchantName, merchantUrl, country, crawlResult.html, crawlResult.links)
        .then((data) => { if (data) result.structured_snippet = data; })
        .catch((err) => {
          console.warn("[Extensions] 结构化摘要提取失败:", err instanceof Error ? err.message : err);
        }),
    );
  }

  await Promise.all(tasks);

  return apiSuccess(serializeData(result));
}

/**
 * 常见电商/网站页面路径候选，用于探测补充
 */
function getCommonProbePaths(merchantUrl: string): string[] {
  let origin = "";
  try { origin = new URL(merchantUrl).origin; } catch { return []; }
  return [
    `${origin}/collections`, `${origin}/collections/all`,
    `${origin}/products`, `${origin}/shop`,
    `${origin}/sale`, `${origin}/new`, `${origin}/new-arrivals`,
    `${origin}/best-sellers`, `${origin}/about`, `${origin}/contact`,
    `${origin}/pages/about`, `${origin}/pages/contact`,
    `${origin}/categories`, `${origin}/catalog`,
    `${origin}/promo`, `${origin}/promotions`,
    `${origin}/soldes`, `${origin}/nouveautes`,
    `${origin}/homme`, `${origin}/femme`, `${origin}/enfants`,
    `${origin}/men`, `${origin}/women`, `${origin}/kids`,
    `${origin}/accessories`, `${origin}/shoes`,
    `${origin}/outlet`, `${origin}/clearance`,
    `${origin}/c/promo`, `${origin}/c/sale`,
    `${origin}/c/new`, `${origin}/c/men`, `${origin}/c/women`,
  ];
}

/**
 * 探测一个候选 URL：GET 请求，跟踪重定向获取真实 URL，
 * 读取页面内容检测软 404，提取标题和描述
 */
const PROBE_UAS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
];

async function probeUrlReal(
  probeUrl: string,
  merchantDomain: string,
): Promise<{ url: string; title: string; desc: string; valid: boolean } | null> {
  let lastFinalUrl = probeUrl;
  let wasBlocked = false;

  for (const ua of PROBE_UAS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(probeUrl, {
        method: "GET", redirect: "follow", signal: ctrl.signal,
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml,*/*",
          "Accept-Language": "en-US,en;q=0.9,fr;q=0.8,de;q=0.7",
        },
      });
      clearTimeout(t);

      const finalUrl = res.url || probeUrl;
      lastFinalUrl = finalUrl;

      // 检查最终域名是否还在商家域名下
      try {
        const finalDomain = new URL(finalUrl).hostname.replace(/^www\./, "");
        if (!finalDomain.includes(merchantDomain) && !merchantDomain.includes(finalDomain)) {
          return null;
        }
      } catch { return null; }

      // 排除落在首页的（说明被重定向到首页，不是真实页面）
      try {
        const finalPath = new URL(finalUrl).pathname;
        if (finalPath === "/" || finalPath === "") return null;
      } catch {}

      if (res.status >= 400 && res.status !== 403) continue;

      const html = await res.text();
      if (!html || html.length < 500) continue;

      // 软 404 检测
      const lower = html.toLowerCase();
      const soft404 = [
        "page not found", "page introuvable", "seite nicht gefunden",
        "404", "not found", "does not exist", "n'existe pas",
      ];
      const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
      const pageTitle = (titleMatch?.[1] || "").trim();
      const titleLower = pageTitle.toLowerCase();

      if (soft404.some((s) => titleLower.includes(s))) return null;
      if (html.length < 5000 && soft404.some((s) => lower.includes(s))) return null;

      // Cloudflare / 拦截页标题检测
      if (isBlockedTitle(pageTitle)) {
        wasBlocked = true;
        continue;
      }

      // 提取标题和描述（解码 HTML 实体 + 智能截断）
      const cleanTitle = smartTruncate(
        decodeHtmlEntities(pageTitle)
          .replace(/\s*[\|–—]\s*[^|–—]{0,40}$/, "")
          .replace(/\s*-\s*[A-Z][a-zA-Z\s]{0,30}$/, "")
          .trim(),
        25,
      );

      const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)
        || html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']description["']/i);
      const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)/i)
        || html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+property=["']og:description["']/i);
      const desc = smartTruncate(decodeHtmlEntities((descMatch?.[1] || ogDescMatch?.[1] || "").trim()), 35);

      if (!cleanTitle || cleanTitle.length < 2) {
        const pathTitle = titleFromUrlPath(finalUrl);
        if (pathTitle.length >= 2) {
          return { url: finalUrl, title: pathTitle, desc, valid: true };
        }
        continue;
      }

      return { url: finalUrl, title: cleanTitle, desc, valid: true };
    } catch {}
  }

  // 所有 UA 被拦截但 URL 有效
  if (wasBlocked) {
    const pathTitle = titleFromUrlPath(lastFinalUrl);
    if (pathTitle.length >= 2) {
      return { url: lastFinalUrl, title: pathTitle, desc: "", valid: true };
    }
  }
  return null;
}

/**
 * 完全由爬虫获取站内链接，标题和描述来自真实页面
 * 不使用 AI 生成，确保标题和链接内容一致
 * 不足 6 个时探测常见路径：GET 请求跟踪重定向获取真实 URL
 */
async function generateSitelinks(
  _merchantName: string,
  merchantUrl: string,
  _country: string,
  pageLinks: { url: string; text: string }[],
  aiRuleProfile?: unknown,
): Promise<{ title: string; desc1: string; desc2: string; url: string }[]> {

  let merchantDomain = "";
  try { merchantDomain = new URL(merchantUrl).hostname.replace(/^www\./, ""); } catch {}

  // 第一步：对爬虫获取的链接，逐个获取真实页面标题和描述
  const candidates: { title: string; desc1: string; desc2: string; url: string }[] = [];
  const usedFinalUrls = new Set<string>();

  if (pageLinks.length > 0) {
    console.log(`[Sitelinks] 处理爬虫获取的 ${pageLinks.length} 个链接...`);
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

      // 使用真实的最终 URL
      const realUrl = meta.finalUrl || link.url;

      // 跳过软 404
      if (meta.isSoft404) {
        console.log(`[Sitelinks] 跳过软404: ${link.url} → ${realUrl}`);
        continue;
      }

      // 跳过首页
      try {
        const p = new URL(realUrl).pathname;
        if (p === "/" || p === "") continue;
      } catch {}

      // 去重
      const normalizedUrl = realUrl.replace(/\/$/, "").replace(/^http:/, "https:");
      if (usedFinalUrls.has(normalizedUrl)) continue;
      usedFinalUrls.add(normalizedUrl);

      let title = "";
      let desc1 = "";

      if (meta.ok && meta.title && !isBlockedTitle(meta.title)) {
        title = decodeHtmlEntities(meta.title)
          .replace(/\s*[\|–—]\s*[^|–—]{0,40}$/, "")
          .replace(/\s*-\s*[A-Z][a-zA-Z\s]{0,30}$/, "")
          .trim();
        title = smartTruncate(title, 25);
      }

      // 跳过无意义的 link.text（如 "click here" 等）
      const BAD_LINK_TEXTS = ["click here", "read more", "learn more", "see more", "view more", "here", "link", "click"];
      if (!title || title.length < 2) {
        const cleanLinkText = decodeHtmlEntities(link.text.trim());
        if (cleanLinkText.length >= 2 && !BAD_LINK_TEXTS.includes(cleanLinkText.toLowerCase())) {
          title = smartTruncate(cleanLinkText, 25);
        }
      }

      // 最后从 URL 路径生成标题
      if (!title || title.length < 2) {
        title = titleFromUrlPath(realUrl);
      }

      if (meta.ok && meta.description) {
        desc1 = smartTruncate(decodeHtmlEntities(meta.description), 35);
      }

      if (title.length >= 2) {
        candidates.push({ title, desc1, desc2: "", url: realUrl });
      }
    }
    console.log(`[Sitelinks] 爬虫链接处理后有 ${candidates.length} 个有效链接`);
  }

  // 第二步：如果不足 6 个，探测常见路径补充
  if (candidates.length < 6 && merchantUrl) {
    console.log(`[Sitelinks] 有效链接不足 6 个 (${candidates.length})，探测常见路径补充...`);
    const probePaths = getCommonProbePaths(merchantUrl);
    const existingNormalized = new Set(candidates.map((c) => c.url.replace(/\/$/, "").replace(/^http:/, "https:")));

    for (let i = 0; i < probePaths.length && candidates.length < 6; i += 5) {
      const batch = probePaths.slice(i, i + 5);
      const results = await Promise.all(
        batch.map((p) => probeUrlReal(p, merchantDomain)),
      );

      for (const r of results) {
        if (!r || candidates.length >= 6) continue;
        const normalized = r.url.replace(/\/$/, "").replace(/^http:/, "https:");
        if (existingNormalized.has(normalized)) continue;
        existingNormalized.add(normalized);
        candidates.push({ title: r.title, desc1: r.desc, desc2: "", url: r.url });
        console.log(`[Sitelinks] 探测成功: ${r.url} → "${r.title}"`);
      }
    }
  }

  // 第三步：AI 生成有吸引力的描述（desc1 + desc2）
  if (candidates.length > 0) {
    try {
      const linksInfo = candidates.map((c) => `- "${c.title}" → ${c.url}${c.desc1 ? ` (现有描述: "${c.desc1}")` : ""}`).join("\n");
      const prompt = `You are a Google Ads sitelink description writer for "${_merchantName}" (${merchantUrl}), target market: ${_country}.

For each sitelink below, write TWO short, compelling description lines that attract clicks.
Each description line MUST be ≤ 35 characters. Use the target market's language.
Focus on benefits, urgency, or value propositions. No emoji.

Sitelinks:
${linksInfo}
${formatAiRuleBlock(aiRuleProfile, "sitelinks")}

Return ONLY a JSON array matching the sitelinks order:
[{"desc1":"compelling line 1","desc2":"compelling line 2"},...]`;

      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 2048);
      const parsed = JSON.parse(extractJsonFromAi(raw)) as { desc1: string; desc2: string }[];

      for (let i = 0; i < candidates.length && i < parsed.length; i++) {
        const d = parsed[i];
        if (d.desc1 && d.desc1.length <= 35) candidates[i].desc1 = d.desc1;
        if (d.desc2 && d.desc2.length <= 35) candidates[i].desc2 = d.desc2;
      }
      console.log(`[Sitelinks] AI 描述生成成功`);
    } catch (err) {
      console.error(`[Sitelinks] AI 描述生成失败:`, err instanceof Error ? err.message : err);
    }

    // 第四步：补足缺失的描述（desc1 或 desc2 为空的逐条补齐）
    const incomplete = candidates
      .map((c, i) => ({ idx: i, c }))
      .filter(({ c }) => !c.desc1 || c.desc1.length < 2 || !c.desc2 || c.desc2.length < 2);

    if (incomplete.length > 0) {
      console.log(`[Sitelinks] ${incomplete.length} 条链接描述不完整，补足中...`);
      try {
        const fillInfo = incomplete.map(({ c }) => {
          const missing = [];
          if (!c.desc1 || c.desc1.length < 2) missing.push("desc1");
          if (!c.desc2 || c.desc2.length < 2) missing.push("desc2");
          return `- "${c.title}" (${c.url}) — need: ${missing.join(", ")}${c.desc1 ? ` [existing desc1: "${c.desc1}"]` : ""}${c.desc2 ? ` [existing desc2: "${c.desc2}"]` : ""}`;
        }).join("\n");

        const fillPrompt = `You are a Google Ads sitelink description writer for "${_merchantName}" (${merchantUrl}), target market: ${_country}.

Fill in the MISSING description lines for these sitelinks. Each line MUST be ≤ 35 characters.
Use the target market's language. Be compelling - focus on benefits, urgency, or value. No emoji.
If a sitelink already has desc1 or desc2, write the OTHER one to complement it.

Sitelinks needing descriptions:
${fillInfo}
${formatAiRuleBlock(aiRuleProfile, "sitelinks")}

Return ONLY a JSON array (same order):
[{"desc1":"line or empty if exists","desc2":"line or empty if exists"},...]`;

        const fillRaw = await callAiWithFallback("ad_copy", [{ role: "user", content: fillPrompt }], 1024);
        const fillParsed = JSON.parse(extractJsonFromAi(fillRaw)) as { desc1: string; desc2: string }[];

        for (let j = 0; j < incomplete.length && j < fillParsed.length; j++) {
          const { idx, c } = incomplete[j];
          const fill = fillParsed[j];
          if ((!c.desc1 || c.desc1.length < 2) && fill.desc1 && fill.desc1.length <= 35) {
            candidates[idx].desc1 = fill.desc1;
          }
          if ((!c.desc2 || c.desc2.length < 2) && fill.desc2 && fill.desc2.length <= 35) {
            candidates[idx].desc2 = fill.desc2;
          }
        }
        console.log(`[Sitelinks] 描述补足完成`);
      } catch (fillErr) {
        console.error(`[Sitelinks] 描述补足失败:`, fillErr instanceof Error ? fillErr.message : fillErr);
      }
    }

    // 最终兜底：仍缺描述的用品牌名+路径填充
    const brandName = _merchantName.replace(/[.。,，!！?？]+/g, "").trim().slice(0, 15);
    for (const c of candidates) {
      if (!c.desc1 || c.desc1.length < 2) {
        const pathTitle = titleFromUrlPath(c.url);
        c.desc1 = (pathTitle && brandName) ? `${brandName} - ${pathTitle}`.slice(0, 35) : (brandName || "").slice(0, 35);
      }
      if (!c.desc2 || c.desc2.length < 2) {
        c.desc2 = c.desc1 !== brandName ? brandName.slice(0, 35) : titleFromUrlPath(c.url).slice(0, 35);
      }
    }
  }

  // ─── 第五步：验证所有链接有效性，踢掉无效的，不够 6 条就补 ───
  const verified = await verifySitelinkCandidates(candidates, merchantUrl, merchantDomain, usedFinalUrls);
  console.log(`[Sitelinks] 最终生成 ${verified.length} 条已验证站内链接`);
  return verified;
}

/**
 * 验证候选站内链接，移除无效的（404/410/超时），
 * 不足 6 条时探测更多常见路径补充，最多重试 2 轮
 */
async function verifySitelinkCandidates(
  candidates: { title: string; desc1: string; desc2: string; url: string }[],
  merchantUrl: string,
  merchantDomain: string,
  usedUrls: Set<string>,
): Promise<{ title: string; desc1: string; desc2: string; url: string }[]> {
  const TARGET = 6;
  let pool = [...candidates];

  for (let round = 0; round < 3; round++) {
    if (pool.length === 0) break;

    const validSet = await verifyLinks(pool.map((c) => c.url));
    const good: typeof pool = [];
    const bad: string[] = [];
    for (const c of pool) {
      if (validSet.has(c.url)) {
        good.push(c);
      } else {
        bad.push(c.url);
        console.log(`[Sitelinks] 链接无效已移除: ${c.url}`);
      }
    }

    pool = good;
    if (pool.length >= TARGET || bad.length === 0) break;

    console.log(`[Sitelinks] 验证后仅 ${pool.length} 条有效，第 ${round + 1} 轮补充探测...`);
    const existingNorm = new Set(pool.map((c) => c.url.replace(/\/$/, "").replace(/^http:/, "https:")));
    for (const b of bad) existingNorm.add(b.replace(/\/$/, "").replace(/^http:/, "https:"));
    for (const u of usedUrls) existingNorm.add(u);

    const extraPaths = getExtraProbePaths(merchantUrl, round);
    const newCandidates: typeof pool = [];

    for (let i = 0; i < extraPaths.length && pool.length + newCandidates.length < TARGET; i += 5) {
      const batch = extraPaths.slice(i, i + 5);
      const results = await Promise.all(
        batch.map((p) => probeUrlReal(p, merchantDomain)),
      );
      for (const r of results) {
        if (!r || pool.length + newCandidates.length >= TARGET) continue;
        const norm = r.url.replace(/\/$/, "").replace(/^http:/, "https:");
        if (existingNorm.has(norm)) continue;
        existingNorm.add(norm);
        newCandidates.push({ title: r.title, desc1: r.desc || "", desc2: "", url: r.url });
        console.log(`[Sitelinks] 补充探测成功: ${r.url} → "${r.title}"`);
      }
    }

    pool = [...pool, ...newCandidates];
  }

  return pool.slice(0, TARGET);
}

function getExtraProbePaths(merchantUrl: string, round: number): string[] {
  let origin = "";
  try { origin = new URL(merchantUrl).origin; } catch { return []; }

  const sets: string[][] = [
    [
      `${origin}/faq`, `${origin}/faqs`, `${origin}/help`,
      `${origin}/pages/faq`, `${origin}/pages/shipping`,
      `${origin}/pages/returns`, `${origin}/pages/warranty`,
      `${origin}/shipping`, `${origin}/returns`, `${origin}/warranty`,
      `${origin}/reviews`, `${origin}/testimonials`,
      `${origin}/blog`, `${origin}/news`,
      `${origin}/gift-cards`, `${origin}/gift-card`,
    ],
    [
      `${origin}/our-story`, `${origin}/pages/our-story`,
      `${origin}/sustainability`, `${origin}/pages/sustainability`,
      `${origin}/wholesale`, `${origin}/pages/wholesale`,
      `${origin}/store-locator`, `${origin}/stores`,
      `${origin}/new-in`, `${origin}/featured`,
      `${origin}/bundles`, `${origin}/sets`,
      `${origin}/deals`, `${origin}/offers`,
      `${origin}/rewards`, `${origin}/loyalty`,
    ],
    [
      `${origin}/collections/sale`, `${origin}/collections/new`,
      `${origin}/collections/best-sellers`, `${origin}/collections/featured`,
      `${origin}/catalog/sale`, `${origin}/catalog/new`,
      `${origin}/c/accessories`, `${origin}/c/shoes`,
      `${origin}/c/home`, `${origin}/c/electronics`,
      `${origin}/how-it-works`, `${origin}/pages/how-it-works`,
    ],
  ];

  return sets[Math.min(round, sets.length - 1)] || [];
}

const VERIFY_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
];

async function verifyLinks(urls: string[]): Promise<Set<string>> {
  const valid = new Set<string>();
  const unique = [...new Set(urls)].slice(0, 30);

  const checkOne = async (url: string): Promise<boolean> => {
    for (const ua of VERIFY_UAS) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, {
          method: "HEAD", redirect: "follow", signal: controller.signal,
          headers: { "User-Agent": ua, "Accept": "text/html,*/*" },
        });
        clearTimeout(t);
        if (res.status === 404 || res.status === 410 || res.status >= 500) return false;
        if (res.status < 400) return true;
        if (res.status === 403 || res.status === 405) {
          const c2 = new AbortController();
          const t2 = setTimeout(() => c2.abort(), 8000);
          const res2 = await fetch(url, {
            method: "GET", redirect: "follow", signal: c2.signal,
            headers: { "User-Agent": ua, Accept: "text/html" },
          });
          clearTimeout(t2);
          if (res2.status < 400 || res2.status === 403) return true;
        }
      } catch {}
    }
    return false;
  };

  for (let i = 0; i < unique.length; i += 5) {
    const batch = unique.slice(i, i + 5);
    const results = await Promise.all(batch.map(async (url) => ({ url, ok: await checkOne(url) })));
    for (const r of results) {
      if (r.ok) valid.add(r.url);
    }
  }
  return valid;
}

async function selectBestImages(
  _merchantName: string,
  _merchantUrl: string,
  rawImages: string[],
): Promise<string[]> {
  // ── 1. URL 关键词黑名单过滤（快速排除无关图片） ──
  const URL_BLACKLIST = [
    "logo", "favicon", "icon", "avatar", "payment", "badge", "social",
    "flag", "arrow", "spinner", "loading", "placeholder", "blank",
    "banner", "header-bg", "footer", "newsletter", "popup", "modal",
    "trustpilot", "review-star", "rating", "captcha", "recaptcha",
    "pixel", "tracking", "analytics", "ad-", "advert", "sponsor",
    "facebook", "twitter", "instagram", "youtube", "pinterest", "tiktok",
    "linkedin", "whatsapp", "telegram", "wechat", "share",
    "visa", "mastercard", "paypal", "amex", "stripe", "klarna", "afterpay",
    "ssl", "secure", "certificate", "norton", "mcafee",
    "shipping-", "delivery-icon", "return-icon", "warranty",
    "emoji", "smiley", "thumb", "check-mark", "close-btn",
    "bg-", "background", "pattern", "texture", "gradient",
    "1x1", "spacer", "clear.gif", "pixel.gif",
  ];

  const urlFiltered = rawImages.filter((url) => {
    const lower = url.toLowerCase();
    // 排除黑名单关键词
    if (URL_BLACKLIST.some((kw) => lower.includes(kw))) return false;
    // 排除 SVG（通常是图标）
    if (lower.endsWith(".svg")) return false;
    // 排除 base64 data URI（通常是小图标）
    if (lower.startsWith("data:")) return false;
    // 排除明显的小尺寸（URL 中带尺寸参数）
    const tinyMatch = lower.match(/[/_-](\d+)x(\d+)/);
    if (tinyMatch) {
      const w = parseInt(tinyMatch[1], 10);
      const h = parseInt(tinyMatch[2], 10);
      if (w < 150 || h < 150) return false;
    }
    return true;
  });

  if (urlFiltered.length === 0) return rawImages.slice(0, 20);

  // ── 2. HEAD 请求检测实际图片尺寸（排除太小的） ──
  const sizeChecked: string[] = [];
  const HEAD_CONCURRENCY = 10;
  const HEAD_TIMEOUT = 5000;

  for (let i = 0; i < urlFiltered.length && sizeChecked.length < 40; i += HEAD_CONCURRENCY) {
    const batch = urlFiltered.slice(i, i + HEAD_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const resp = await fetch(url, {
            method: "HEAD",
            signal: AbortSignal.timeout(HEAD_TIMEOUT),
            headers: { "User-Agent": "Googlebot-Image/1.0" },
          });
          if (!resp.ok) return null;
          const contentType = resp.headers.get("content-type") || "";
          if (!contentType.startsWith("image/")) return null;
          // 排除太小的图片（< 5KB 通常是图标/占位符）
          const contentLength = parseInt(resp.headers.get("content-length") || "0", 10);
          if (contentLength > 0 && contentLength < 5000) return null;
          return url;
        } catch {
          return url; // HEAD 失败的保留（有些服务器不支持 HEAD）
        }
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) sizeChecked.push(r.value);
    }
  }

  if (sizeChecked.length === 0) return urlFiltered.slice(0, 20);

  // ── 3. 批量 OCR 检测（排除有文字的图片） ──
  const OCR_CONCURRENCY = 5;
  const OCR_TIMEOUT = 10000;
  const clean: string[] = [];

  for (let i = 0; i < sizeChecked.length && clean.length < 30; i += OCR_CONCURRENCY) {
    const batch = sizeChecked.slice(i, i + OCR_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (url) => {
        try {
          const resp = await fetch(url, {
            signal: AbortSignal.timeout(OCR_TIMEOUT),
            headers: { "User-Agent": "Googlebot-Image/1.0" },
          });
          if (!resp.ok) return null;
          const buf = Buffer.from(await resp.arrayBuffer());
          // 太小的图片直接排除
          if (buf.length < 5000) return null;
          // 太大的图片跳过 OCR（保留，可能是高清产品图）
          if (buf.length > 2 * 1024 * 1024) return url;

          const Tesseract = (await import("tesseract.js")).default;
          const { data } = await Tesseract.recognize(buf, "eng", {
            logger: () => {},
          });
          // 过滤有意义的文字（长度>2，置信度>60）
          const meaningfulWords = (data.words || []).filter(
            (w) => w.text.replace(/[^a-zA-Z0-9]/g, "").length > 2 && w.confidence > 60,
          );
          // 超过 3 个有意义的词 → 判定为有文字的图片
          if (meaningfulWords.length > 3) return null;
          return url;
        } catch {
          return url; // OCR 失败的保留
        }
      }),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) clean.push(r.value);
    }
  }

  return clean.length > 0 ? clean : sizeChecked.slice(0, 30);
}

/**
 * 从 HTML 中提取促销信息（折扣、优惠码、促销活动）
 */
function hasPromotionSignal(data: Record<string, unknown> | null | undefined): data is Record<string, unknown> {
  if (!data) return false;
  return Boolean(
    (typeof data.promotion_target === "string" && data.promotion_target.trim())
    || data.discount_type === "PERCENT"
    || data.discount_type === "MONETARY"
    || (typeof data.promo_code === "string" && data.promo_code.trim())
    || (typeof data.final_url === "string" && data.final_url.trim()),
  );
}

function mergePromotionData(
  primary: Record<string, unknown> | null,
  fallback: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!hasPromotionSignal(primary) && !hasPromotionSignal(fallback)) return null;
  const merged: Record<string, unknown> = {};

  for (const source of [primary, fallback]) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value == null) continue;
      if (typeof value === "string" && !value.trim()) continue;
      if (!(key in merged)) merged[key] = value;
    }
  }

  return merged;
}

function extractPromotionInfo(html: string, sourceUrl: string, country: string): Record<string, unknown> | null {
  if (!html) return null;
  const lower = html.toLowerCase();
  const result: Record<string, unknown> = {};
  const market = getAdMarketConfig(country);

  // 提取折扣百分比（如 "20% off", "Save 30%", "Up to 50% off"）
  const percentMatch = html.match(/(?:up\s+to\s+)?(\d{1,2})\s*%\s*(?:off|discount|sale|rabatt|remise|sconto)/i)
    || html.match(/(?:save|get|enjoy)\s+(\d{1,2})\s*%/i);
  if (percentMatch) {
    result.discount_type = "PERCENT";
    result.discount_percent = parseInt(percentMatch[1], 10);
  }

  // 提取金额折扣（支持 $, €, £, CHF 等）
  const moneyMatch = html.match(/(?:save|get|rabatt|remise|sconto|descuento)\s*(?:[$€£]|chf\s*)?(\d{1,4})/i)
    || html.match(/(?:[$€£]|chf\s*)(\d{1,4})\s*(?:off|rabatt|remise|sconto|descuento)/i);
  if (moneyMatch && !result.discount_type) {
    result.discount_type = "MONETARY";
    result.discount_amount = parseInt(moneyMatch[1], 10);
    result.currency_code = market.currencyCode;
  }

  // 提取优惠码（如 "Use code: SAVE20", "Promo code: WELCOME10"）
  const codeMatch = html.match(/(?:code|coupon|promo|voucher|gutschein|codice)[:\s]+["']?([A-Z0-9]{3,20})["']?/i)
    || html.match(/(?:use|enter|apply)\s+(?:code\s+)?["']?([A-Z0-9]{4,20})["']?/i);
  if (codeMatch) {
    result.promo_code = codeMatch[1].toUpperCase();
  }

  // 提取促销标题（从 banner/announcement 区域）
  const bannerRegex = /<(?:div|span|p|a)[^>]*class=["'][^"']*(?:banner|announcement|promo|hero|notice|topbar|top-bar|sale-bar|offer)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|p|a)>/gi;
  let bannerMatch;
  const bannerTexts: string[] = [];
  while ((bannerMatch = bannerRegex.exec(html)) !== null) {
    const text = bannerMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (text.length > 5 && text.length < 150 && /\d/.test(text)) bannerTexts.push(text);
  }
  if (bannerTexts.length > 0) {
    result.promotion_target = bannerTexts[0].slice(0, 60);
  }

  // 提取免邮信息并按国家本地化
  if (/free\s*(?:standard\s*)?(?:shipping|delivery)|kostenlos(?:e|er)?\s+versand|livraison\s+offerte|env[ií]o\s+gratis|spedizione\s+gratuita/i.test(lower)) {
    if (!result.promotion_target) result.promotion_target = market.genericPromotionTarget;
    const thresholdMatch = html.match(/(?:free\s*(?:shipping|delivery)|kostenlos(?:e|er)?\s+versand|livraison\s+offerte|env[ií]o\s+gratis|spedizione\s+gratuita)[^.]*?(?:over|above|ab|d[eè]s|desde|from)?\s*(?:[$€£]|chf\s*)?(\d+)/i);
    if (thresholdMatch) {
      if (market.languageCode === "de") {
        result.promotion_target = `Kostenloser Versand ab ${thresholdMatch[1]} ${market.currencyCode}`;
      } else if (market.languageCode === "fr") {
        result.promotion_target = `Livraison offerte dès ${thresholdMatch[1]} ${market.currencyCode}`;
      } else if (market.languageCode === "es") {
        result.promotion_target = `Envío gratis desde ${thresholdMatch[1]} ${market.currencyCode}`;
      } else if (market.languageCode === "it") {
        result.promotion_target = `Spedizione gratis da ${thresholdMatch[1]} ${market.currencyCode}`;
      } else {
        result.promotion_target = `Free Shipping Over ${thresholdMatch[1]} ${market.currencyCode}`;
      }
    }
  }

  if (!result.promotion_target && !result.discount_type) {
    // 尝试从 meta/title 提取
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      const title = titleMatch[1].replace(/\s+/g, " ").trim();
      const saleInTitle = title.match(/(\d+%?\s*off|sale|discount|free shipping)/i);
      if (saleInTitle) result.promotion_target = title.slice(0, 60);
    }
  }

  result.final_url = sourceUrl;
  if (result.promotion_target) result.language_code = market.promotionLanguageCode;
  if (result.discount_type === "MONETARY" && !result.currency_code) result.currency_code = market.currencyCode;
  return Object.keys(result).length > 1 ? result : null;
}

/**
 * 从 HTML 中提取价格/产品信息
 */
function extractPriceInfo(html: string, country: string): Array<{ header: string; description: string; price: number; currency: string; url: string }> {
  if (!html) return [];
  const items: Array<{ header: string; description: string; price: number; currency: string; url: string }> = [];
  const market = getAdMarketConfig(country);

  // 提取 JSON-LD 结构化数据中的产品信息
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
                header: String(p.name).slice(0, 25),
                description: String(p.description || p.name).slice(0, 25),
                price,
                currency: o.priceCurrency || market.currencyCode,
                url: o.url || p.url || "",
              });
            }
          }
        }
      }
    } catch { /* ignore parse errors */ }
  }

  // 如果 JSON-LD 没找到，从 HTML 中提取价格
  if (items.length === 0) {
    const priceRegex = /<[^>]*class=["'][^"']*(?:price|product-price|sale-price)[^"']*["'][^>]*>\s*\$?\s*([\d,.]+)\s*<\/[^>]+>/gi;
    let priceMatch;
    while ((priceMatch = priceRegex.exec(html)) !== null && items.length < 8) {
      const price = parseFloat(priceMatch[1].replace(",", ""));
      if (price > 0 && price < 100000) {
        items.push({ header: `Product ${items.length + 1}`, description: "", price, currency: market.currencyCode, url: "" });
      }
    }
  }

  return items;
}

/**
 * 用 AI 从商家网站提取促销信息（爬首页 + 子页面）
 */
async function extractPromotionWithAI(
  html: string,
  merchantUrl: string,
  merchantName: string,
  country: string,
  links: { url: string; text: string }[],
  aiRuleProfile?: unknown,
): Promise<Record<string, unknown> | null> {
  const market = getAdMarketConfig(country);
  // 1. 先用正则快速提取（首页）
  const homepageResult = extractPromotionInfo(html, merchantUrl, country);
  let mergedResult: Record<string, unknown> | null = hasPromotionSignal(homepageResult)
    ? { ...homepageResult }
    : null;

  // 2. 爬取促销相关子页面
  const promoKeywords = ["sale", "deal", "offer", "promo", "discount", "coupon", "special", "clearance", "pricing"];
  const promoLinks = links.filter((l) =>
    promoKeywords.some((kw) => l.url.toLowerCase().includes(kw) || l.text.toLowerCase().includes(kw)),
  ).slice(0, 3);

  let combinedText = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);

  for (const link of promoLinks) {
    try {
      const resp = await fetch(link.url, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      });
      if (resp.ok) {
        const subHtml = await resp.text();
        const subResult = extractPromotionInfo(subHtml, link.url, country);
        mergedResult = mergePromotionData(mergedResult, subResult);
        const subText = subHtml.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
        combinedText += "\n\n--- Sub page: " + link.url + " ---\n" + subText;
      }
    } catch { /* skip */ }
  }

  // 3. 用 AI 提取
  try {
    const { callAiWithFallback } = await import("@/lib/ai-service");
    const aiResp = await callAiWithFallback("ad_copy", [{ role: "user", content: `Analyze this merchant website text and extract promotion/discount information.

Merchant: ${merchantName}
Target market: ${market.countryNameZh} / ${market.languageName}
Preferred language code: ${market.promotionLanguageCode}
Preferred currency code: ${market.currencyCode}
URL: ${merchantUrl}

Website text (truncated):
${combinedText.slice(0, 4000)}

Extract and return a JSON object with these fields (use null if not found):
- discount_type: "PERCENT" or "MONETARY" or null
- discount_percent: number or null (e.g. 20 for 20% off)
- discount_amount: number or null
- currency_code: string or null
- promo_code: string or null
- language_code: string or null
- promotion_target: string or null (localized for the target market, max 60 chars)
- final_url: the best URL for this promotion, or "${merchantUrl}" if none

Rules:
- promotion_target MUST be in ${market.languageName}
- Never default to English for non-English markets
- If discount_type is MONETARY, currency_code should be ${market.currencyCode} unless the website clearly shows another local currency
- Keep the phrasing truthful and concise
${formatAiRuleBlock(aiRuleProfile, "compliance")}

Return ONLY valid JSON, no explanation.` }], 2048);

    const parsed = JSON.parse(aiResp.replace(/```json?\s*/g, "").replace(/```/g, "").trim());
    if (parsed.discount_type || parsed.promotion_target || parsed.promo_code || parsed.final_url) {
      mergedResult = mergePromotionData(mergedResult, {
        ...parsed,
        currency_code: parsed.currency_code || market.currencyCode,
        language_code: parsed.language_code || market.promotionLanguageCode,
        final_url: parsed.final_url || merchantUrl,
      });
    }
  } catch (err) {
    console.warn("[ExtractPromotion] AI extraction failed:", err instanceof Error ? err.message : err);
  }

  if (mergedResult) {
    mergedResult.final_url = String(mergedResult.final_url || merchantUrl || "");
    if (!mergedResult.language_code && mergedResult.promotion_target) {
      mergedResult.language_code = market.promotionLanguageCode;
    }
    if (mergedResult.discount_type === "MONETARY" && !mergedResult.currency_code) {
      mergedResult.currency_code = market.currencyCode;
    }
  }

  return hasPromotionSignal(mergedResult) ? mergedResult : null;
}

/**
 * 用 AI 从商家网站提取价格/产品信息（爬首页 + 子页面）
 */
async function extractPriceWithAI(
  html: string,
  merchantUrl: string,
  merchantName: string,
  country: string,
  links: { url: string; text: string }[],
  aiRuleProfile?: unknown,
): Promise<Array<{ header: string; description: string; price: number; currency: string; url: string }>> {
  const market = getAdMarketConfig(country);
  // 1. 先用正则快速提取（首页 JSON-LD）
  const regexResult = extractPriceInfo(html, country);
  if (regexResult.length >= 3) return regexResult;

  // 2. 爬取价格相关子页面
  const priceKeywords = ["pricing", "price", "plan", "shop", "product", "store", "buy", "collection"];
  const priceLinks = links.filter((l) =>
    priceKeywords.some((kw) => l.url.toLowerCase().includes(kw) || l.text.toLowerCase().includes(kw)),
  ).slice(0, 3);

  let combinedText = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);

  for (const link of priceLinks) {
    try {
      const resp = await fetch(link.url, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" },
      });
      if (resp.ok) {
        const subHtml = await resp.text();
        const subResult = extractPriceInfo(subHtml, country);
        if (subResult.length >= 3) return subResult;
        const subText = subHtml.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
        combinedText += "\n\n--- Sub page: " + link.url + " ---\n" + subText;
      }
    } catch { /* skip */ }
  }

  // 3. 用 AI 提取
  try {
    const { callAiWithFallback } = await import("@/lib/ai-service");
    const aiResp = await callAiWithFallback("ad_copy", [{ role: "user", content: `Analyze this merchant website text and extract product/pricing information for Google Ads Price Extensions.

Merchant: ${merchantName}
Target market: ${market.countryNameZh} / ${market.languageName}
Preferred currency: ${market.currencyCode}
URL: ${merchantUrl}

Website text (truncated):
${combinedText.slice(0, 4000)}

Extract 3-8 products/services with pricing. Return a JSON array of objects:
[
  { "header": "Localized name (max 25 chars)", "description": "Localized short desc (max 25 chars)", "price": 29.99, "currency": "${market.currencyCode}", "url": "product URL or empty string" }
]

Rules:
- header and description MUST be ≤ 25 characters each
- Use the target market language where possible
- price must be a real number found on the website, NOT made up
- If no real prices are found, return an empty array []
- currency should match the website's currency or ${market.currencyCode} for this market
${formatAiRuleBlock(aiRuleProfile, "compliance")}

Return ONLY valid JSON array, no explanation.` }], 2048);

    const parsed = JSON.parse(aiResp.replace(/```json?\s*/g, "").replace(/```/g, "").trim());
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.filter((p: Record<string, unknown>) => p.price && Number(p.price) > 0).slice(0, 8).map((p: Record<string, unknown>) => ({
        header: String(p.header || "").slice(0, 25),
        description: String(p.description || "").slice(0, 25),
        price: Number(p.price),
        currency: String(p.currency || market.currencyCode),
        url: String(p.url || ""),
      }));
    }
  } catch (err) {
    console.warn("[ExtractPrice] AI extraction failed:", err instanceof Error ? err.message : err);
  }

  return regexResult;
}

/** 从 HTML 中提取商家真实卖点信息（运费政策、退换货、品牌特色等） */
function extractMerchantFeatures(html: string): string[] {
  const features: string[] = [];
  const lower = html.toLowerCase();

  // 提取 title 和 meta description
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch?.[1]) features.push(`Page title: ${decodeHtmlEntities(titleMatch[1].trim())}`);
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i)
    || html.match(/<meta[^>]+content=["']([^"']*?)["'][^>]+name=["']description["']/i);
  if (descMatch?.[1]) features.push(`Meta description: ${decodeHtmlEntities(descMatch[1].trim())}`);

  // 匹配实际卖点关键词
  const featurePatterns: { pattern: RegExp; label: string }[] = [
    { pattern: /free\s*shipping|free\s*deliver|kostenlos(?:e|er)?\s+versand|livraison\s+offerte|env[ií]o\s+gratis|spedizione\s+gratuita/i, label: "Free Shipping" },
    { pattern: /free\s*deliver/i, label: "Free Delivery" },
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
    { pattern: /veteran[- ]?owned/i, label: "Veteran-Owned" },
    { pattern: /locally\s*(sourced|made)/i, label: "Locally Sourced" },
    { pattern: /limited\s*edition/i, label: "Limited Edition" },
    { pattern: /exclusive/i, label: "Exclusive Products" },
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

  // 提取 banner 文本中的卖点
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

function getMergedPolicyCallout(country: string): string {
  const market = getAdMarketConfig(country);
  switch (market.languageCode) {
    case "de":
      return "Versand & Rückgabe frei";
    case "fr":
      return "Livraison + retours";
    case "es":
      return "Envío y devoluciones";
    case "it":
      return "Spedizione + resi";
    case "pt":
      return "Envio + devoluções";
    case "nl":
      return "Verzending & retour";
    case "ja":
      return "送料無料・返品対応";
    default:
      return "Free Shipping & Returns";
  }
}

async function generateCallouts(
  merchantName: string,
  merchantUrl: string,
  country: string,
  pageHtml: string,
  aiRuleProfile?: unknown,
): Promise<string[]> {
  const merchantFeatures = pageHtml ? extractMerchantFeatures(pageHtml) : [];
  const pageContext = merchantFeatures.length > 0
    ? `\nReal information from merchant website:\n${merchantFeatures.join("\n")}\n`
    : "";

  const normalizeCallouts = (items: string[]): string[] => {
    const deduped: string[] = [];
    const seen = new Set<string>();
    const shippingPattern = /free\s*ship|free\s*deliver|kostenlos(?:e|er)?\s+versand|livraison\s+offerte|env[ií]o\s+gratis|spedizione\s+gratuita/i;
    const returnPattern = /return|refund|money.back|rückgabe|retour|retours|devoluci|resi/i;
    const hasShipping = items.some((item) => shippingPattern.test(item));
    const hasReturns = items.some((item) => returnPattern.test(item));
    const mergedPolicy = smartTruncate(getMergedPolicyCallout(country), 25);

    for (const raw of items) {
      const text = smartTruncate(String(raw || "").trim(), 25);
      if (!text) continue;
      if ((shippingPattern.test(text) || returnPattern.test(text)) && hasShipping && hasReturns) {
        continue;
      }
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(text);
    }

    if (hasShipping && hasReturns) {
      deduped.unshift(mergedPolicy);
    }

    return deduped.slice(0, 6);
  };

  try {
    const prompt = `You are a Google Ads callout extension expert.
Merchant: ${merchantName}
Website: ${merchantUrl}
Target country: ${country}
${pageContext}
Generate exactly 6 callout extensions for this merchant based on REAL information from their website.

Rules:
- Each callout MUST be ≤ 25 characters
- PRIORITY: Use actual merchant features found on their website (shipping policy, return policy, brand story, product type, certifications, etc.)
- If shipping and return policy both exist, MERGE them into one line when possible (example: "${getMergedPolicyCallout(country)}")
- If the website mentions specific policies, reflect those accurately
- Include the merchant's actual strengths, NOT generic/made-up claims
- Only include shipping if the website actually offers it
- Write in the language appropriate for ${country}
- Be concise and impactful, no emoji
${formatAiRuleBlock(aiRuleProfile, "ad_copy")}

Return ONLY a JSON array: ["callout1","callout2",...]`;

    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 1024);
    const parsed = JSON.parse(extractJsonFromAi(raw)) as string[];
    return normalizeCallouts(parsed.filter((c) => c.trim().length > 0));
  } catch {
    return normalizeCallouts(getDefaultCallouts(merchantName, country, merchantFeatures));
  }
}

function getDefaultCallouts(merchantName: string, country: string, features: string[]): string[] {
  const market = getAdMarketConfig(country);
  const result: string[] = [];
  const featStr = features.join(" ").toLowerCase();

  const hasShipping = /free\s*ship|free\s*deliver|kostenlos(?:e|er)?\s+versand|livraison\s+offerte|env[ií]o\s+gratis|spedizione\s+gratuita/i.test(featStr);
  const hasReturns = /money.back|return|refund|rückgabe|retour|retours|devoluci|resi/i.test(featStr);
  if (hasShipping && hasReturns) {
    result.push(smartTruncate(getMergedPolicyCallout(country), 25));
  } else {
    if (hasShipping) result.push(smartTruncate(market.shippingLabel, 25));
    if (hasReturns) result.push(smartTruncate(market.returnLabel, 25));
  }

  if (/24\s*\/?\s*7/i.test(featStr)) result.push(market.languageCode === "de" ? "24/7 Service" : "24/7 Support");
  if (/hand.?(made|crafted)/i.test(featStr)) result.push(market.languageCode === "de" ? "Handwerksqualität" : "Handcrafted Quality");
  if (/award.?winning/i.test(featStr)) result.push(market.languageCode === "de" ? "Ausgezeichnet" : "Award-Winning");
  if (/organic|natural/i.test(featStr)) result.push(market.languageCode === "de" ? "Natürlich" : "All Natural");
  if (/sustainab|eco/i.test(featStr)) result.push(market.languageCode === "de" ? "Nachhaltig" : "Eco-Friendly");
  if (/family.?owned/i.test(featStr)) result.push(market.languageCode === "de" ? "Familiengeführt" : "Family-Owned");
  if (/veteran.?owned/i.test(featStr)) result.push(market.languageCode === "de" ? "Veteranengeführt" : "Veteran-Owned");
  if (/made\s*in/i.test(featStr)) result.push(market.languageCode === "de" ? "Hergestellt vor Ort" : "Made in Origin");
  if (/best\s*seller/i.test(featStr)) result.push(market.languageCode === "de" ? "Bestseller" : "Best Sellers");
  if (/gift\s*card/i.test(featStr)) result.push(market.languageCode === "de" ? "Geschenkkarten" : "Gift Cards");

  const brandShort = smartTruncate(merchantName, 25);
  if (brandShort.length >= 3 && brandShort.length <= 25 && !result.includes(brandShort)) {
    result.unshift(brandShort);
  }

  const generic = market.languageCode === "de"
    ? ["Sicher bestellen", "Online kaufen", "Kollektion entdecken", "Neu eingetroffen", "Top-Qualität", "Direkt beim Händler"]
    : ["Secure Checkout", "Shop Online", "Browse Collection", "New Arrivals", "Best Price", "Quality Products"];
  for (const g of generic) {
    if (result.length >= 6) break;
    if (!result.includes(g)) result.push(g);
  }

  return result.slice(0, 6);
}

function extractJsonFromAi(raw: string): string {
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

/**
 * 从商家网站提取联系电话
 * 优先从 HTML 中正则提取，不足时尝试 contact/about 子页面
 */
async function extractPhoneNumber(
  merchantUrl: string,
  _merchantName: string,
  country: string,
  html: string,
  links: { url: string; text: string }[],
): Promise<{ country_code: string; phone_number: string } | null> {
  // 国际电话正则（匹配 +XX-XXX-XXX-XXXX 等格式）
  const phoneRegex = /(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;
  // tel: 链接
  const telRegex = /href=["']tel:([^"']+)["']/gi;

  const candidates: string[] = [];

  // 从 tel: 链接提取
  let telMatch;
  while ((telMatch = telRegex.exec(html)) !== null) {
    const phone = decodeURIComponent(telMatch[1]).replace(/\s+/g, "").trim();
    if (phone.length >= 7 && phone.length <= 20) candidates.push(phone);
  }

  // 从页面文本提取
  const textOnly = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const phoneMatches = textOnly.match(phoneRegex) || [];
  for (const p of phoneMatches) {
    const clean = p.replace(/\s+/g, "").trim();
    if (clean.length >= 7 && clean.length <= 20 && !candidates.includes(clean)) {
      candidates.push(clean);
    }
  }

  // 如果首页没找到，尝试 contact/about 页面
  if (candidates.length === 0) {
    const contactLinks = links.filter((l) =>
      /contact|about|impressum|kontakt|nous-contacter/i.test(l.url) || /contact|about/i.test(l.text),
    ).slice(0, 3);

    for (const link of contactLinks) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(link.url, {
          signal: ctrl.signal,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        });
        clearTimeout(t);
        if (!res.ok) continue;
        const subHtml = await res.text();

        let subTelMatch;
        const subTelRegex = /href=["']tel:([^"']+)["']/gi;
        while ((subTelMatch = subTelRegex.exec(subHtml)) !== null) {
          const phone = decodeURIComponent(subTelMatch[1]).replace(/\s+/g, "").trim();
          if (phone.length >= 7 && phone.length <= 20) candidates.push(phone);
        }

        const subText = subHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
        const subPhones = subText.match(phoneRegex) || [];
        for (const p of subPhones) {
          const clean = p.replace(/\s+/g, "").trim();
          if (clean.length >= 7 && clean.length <= 20 && !candidates.includes(clean)) {
            candidates.push(clean);
          }
        }
        if (candidates.length > 0) break;
      } catch {}
    }
  }

  if (candidates.length === 0) return null;

  // 优先选带国际区号的
  const withPlus = candidates.find((c) => c.startsWith("+"));
  const phone = withPlus || candidates[0];

  // 推断国家代码
  const COUNTRY_PHONE_CODE: Record<string, string> = {
    US: "US", CA: "CA", GB: "GB", UK: "GB", AU: "AU",
    DE: "DE", FR: "FR", JP: "JP", BR: "BR", IT: "IT",
    ES: "ES", NL: "NL", SE: "SE", NO: "NO", DK: "DK",
  };
  const countryCode = COUNTRY_PHONE_CODE[country.toUpperCase()] || "US";

  console.log(`[Extensions] 提取到电话: ${phone} (country: ${countryCode})`);
  return { country_code: countryCode, phone_number: phone };
}

/**
 * 从商家网站提取结构化摘要
 * 使用 AI 从页面内容中提取品牌/产品/服务类别
 */
async function extractStructuredSnippet(
  merchantName: string,
  merchantUrl: string,
  _country: string,
  html: string,
  links: { url: string; text: string }[],
): Promise<{ header: string; values: string[] } | null> {
  // 从链接文本和页面内容中提取分类信息
  const linkTexts = links
    .map((l) => l.text.trim())
    .filter((t) => t.length >= 2 && t.length <= 30)
    .slice(0, 30);

  // 提取导航菜单项（通常是分类）
  const navItems: string[] = [];
  const navRegex = /<nav[^>]*>([\s\S]*?)<\/nav>/gi;
  let navMatch;
  while ((navMatch = navRegex.exec(html)) !== null) {
    const navHtml = navMatch[1];
    const linkRegex = /<a[^>]*>([^<]{2,30})<\/a>/gi;
    let linkMatch;
    while ((linkMatch = linkRegex.exec(navHtml)) !== null) {
      const text = decodeHtmlEntities(linkMatch[1].trim());
      if (text.length >= 2 && text.length <= 25 && !navItems.includes(text)) {
        navItems.push(text);
      }
    }
  }

  const contextItems = [...new Set([...navItems, ...linkTexts])].slice(0, 40);

  if (contextItems.length < 3) return null;

  const prompt = `You are analyzing a merchant website to extract structured snippet data for Google Ads.

Merchant: ${merchantName}
Website: ${merchantUrl}

Navigation/category items found on the site:
${contextItems.map((t, i) => `${i + 1}. "${t}"`).join("\n")}

Based on these items, determine the best structured snippet header and extract 3-10 relevant values.

Available headers: "Brands", "Types", "Styles", "Models", "Service catalog", "Amenities", "Destinations", "Neighborhoods"

Rules:
1. Choose the most appropriate header based on the merchant's content
2. Values must be real categories/items found on the site, NOT made up
3. Each value must be ≤ 25 characters
4. Minimum 3 values, maximum 10
5. Values should be the most important/popular categories

Return ONLY JSON: {"header": "Types", "values": ["Value 1", "Value 2", "Value 3"]}`;

  try {
    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 1024);
    const parsed = JSON.parse(extractJsonFromAi(raw));
    if (parsed.header && Array.isArray(parsed.values) && parsed.values.length >= 3) {
      const values = parsed.values
        .map((v: string) => String(v).trim())
        .filter((v: string) => v.length >= 1 && v.length <= 25)
        .slice(0, 10);
      if (values.length >= 3) {
        console.log(`[Extensions] 结构化摘要: header=${parsed.header}, values=${values.length}条`);
        return { header: parsed.header, values };
      }
    }
  } catch (err) {
    console.warn("[Extensions] AI 结构化摘要提取失败:", err instanceof Error ? err.message : err);
  }

  return null;
}
