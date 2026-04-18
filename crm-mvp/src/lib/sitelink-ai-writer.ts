/**
 * C-016 sitelink AI writer
 *
 * 职责：对 N 条已验证的 sitelink URL 候选，一次调 AI 生成 title + desc1 + desc2。
 *
 * 调用时机：主爬虫 discover + autoExpandSitelinks 扩源完成后（候选 URL 已固化），
 *            独立于 headlines/descriptions 主 AI 流（不阻塞首屏）。
 *
 * 合规：
 *   - 标题 ≤ 25 字符，非全大写，Title/Sentence Case；
 *   - desc1 / desc2 ≤ 35 字符，禁用绝对化 / 无证据承诺 / 禁用符号；
 *   - 输出语言 = 广告目标语言（resolveLanguageName）。
 *
 * 兜底：AI 失败 / 返回残缺 → 用页面 meta + 品牌名自动填充，保证每条都有完整 3 字段。
 */

import { callAiWithFallback } from "@/lib/ai-service";
import { resolveLanguageName } from "@/lib/ad-market";
import { sanitizeAdText, smartTruncate, titleFromUrlPath, decodeHtmlEntities, extractJsonFromAi } from "@/lib/crawl-pipeline";

export interface SitelinkInput {
  url: string;
  /** 页面 <title> */
  pageTitle?: string;
  /** 页面 meta description */
  pageDescription?: string;
  /** <a> 文本（discover 阶段 pageLinks.text） */
  linkText?: string;
}

export interface SitelinkOutput {
  url: string;
  title: string; // ≤ 25
  desc1: string; // ≤ 35
  desc2: string; // ≤ 35
}

function isAllCapsLike(s: string): boolean {
  if (!s) return false;
  return /^[A-Z0-9\s#&!?',.\-]+$/.test(s.trim()) && /[A-Z]{3,}/.test(s.trim());
}

function cleanTitle(raw: string | undefined): string {
  if (!raw) return "";
  return sanitizeAdText(
    decodeHtmlEntities(raw)
      // 去除结尾的 "- BrandName" / "| BrandName" 之类
      .replace(/\s*[\|–—]\s*[^|–—]{0,40}$/, "")
      .replace(/\s*-\s*[A-Z][a-zA-Z\s]{0,30}$/, "")
      .trim(),
  );
}

function cleanDesc(raw: string | undefined): string {
  if (!raw) return "";
  return sanitizeAdText(decodeHtmlEntities(raw), { allowExclamation: true }).trim();
}

function pickFallbackTitle(c: SitelinkInput): string {
  // linkText 优先（discover 阶段抽到的 <a> 文本通常最贴合导航语义）
  if (c.linkText) {
    const t = cleanTitle(c.linkText);
    if (t.length >= 2 && !isAllCapsLike(t)) return smartTruncate(t, 25);
  }
  if (c.pageTitle) {
    const t = cleanTitle(c.pageTitle);
    if (t.length >= 2 && !isAllCapsLike(t)) return smartTruncate(t, 25);
  }
  return smartTruncate(titleFromUrlPath(c.url), 25);
}

/**
 * 一次 AI 调用为所有候选生成 title/desc1/desc2。
 */
export async function generateSitelinkTexts(
  candidates: SitelinkInput[],
  opts: {
    brandRoot: string;
    country: string;
    languageCode?: string;
  },
): Promise<SitelinkOutput[]> {
  if (!candidates || candidates.length === 0) return [];

  const languageName = resolveLanguageName(opts.country, opts.languageCode);
  const brand = opts.brandRoot.trim();

  const block = candidates
    .map((c, i) => {
      const lines: string[] = [`${i + 1}. url: ${c.url}`];
      if (c.pageTitle) lines.push(`   page_title: "${cleanTitle(c.pageTitle)}"`);
      if (c.pageDescription) lines.push(`   page_desc: "${cleanDesc(c.pageDescription).slice(0, 180)}"`);
      if (c.linkText) lines.push(`   link_text: "${cleanTitle(c.linkText)}"`);
      return lines.join("\n");
    })
    .join("\n\n");

  const prompt = `You are a Google Ads copywriter. Write sitelink copy for ${candidates.length} real pages of brand "${brand}" targeting ${opts.country}.

Language requirement:
- ALL output (titles + descriptions) MUST be in ${languageName}. Translate from page_title / page_desc if they are in another language.

For EACH entry produce one object with:
- "title": ≤ 25 characters. Title Case or sentence case. NEVER all-caps. Clearly conveys page purpose / category.
- "desc1": ≤ 35 characters. A concrete benefit, feature, or CTA derived from page_title / page_desc / link_text.
- "desc2": ≤ 35 characters. A DIFFERENT complementary benefit (must not duplicate desc1 semantically).

Strict rules:
- Factual only: do not invent prices, percentages, warranties, phone numbers, free-shipping claims if not clearly implied by the page content.
- No emojis. No forbidden symbols (★ ® ™ %off). No double punctuation (!!, ??).
- Do not use ALL CAPS words longer than 3 characters.
- Keep brand voice consistent (${brand}).

Return STRICT JSON, no markdown fences, no explanation. Keep the SAME ORDER as the numbered entries below (index 1..${candidates.length}). Do NOT output url field — only title/desc1/desc2:
{"sitelinks":[{"title":"...","desc1":"...","desc2":"..."}, ...]}

Entries:
${block}`;

  let raw: string;
  try {
    raw = await callAiWithFallback(
      "ad_copy_generation",
      [
        { role: "system", content: "You write concise, multilingual, policy-compliant Google Ads sitelink copy." },
        { role: "user", content: prompt },
      ],
      Math.min(1200, 120 * candidates.length + 300),
    );
  } catch (e) {
    console.warn("[SitelinkAI] 调用失败，使用页面 meta 兜底:", e instanceof Error ? e.message : e);
    return fallbackAll(candidates, brand);
  }

  // C-023 诊断开关：SITELINK_AI_DUMP=1 时 dump AI 原始响应全文（仅排查期打开，生产默认关闭）
  const dumpRaw = process.env.SITELINK_AI_DUMP === "1";
  if (dumpRaw) {
    console.warn(
      `[SitelinkAI-RAW] len=${raw.length} head=${JSON.stringify(raw.slice(0, 1200))}`,
    );
  }

  let parsed: unknown;
  try {
    // 先剥离 reasoning 模型的 <think>…</think> 块（DeepSeek R1 / o1 等会在 JSON 前输出思考链）
    let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    // 再剥离残留的未闭合 <think>... 前缀（模型意外截断）
    const thinkStart = cleaned.indexOf("<think>");
    if (thinkStart >= 0) {
      const afterOpen = cleaned.slice(thinkStart + "<think>".length);
      const firstJson = afterOpen.search(/[\{\[]/);
      if (firstJson >= 0) cleaned = afterOpen.slice(firstJson);
    }
    // 用统一的 JSON 提取器（去 markdown fence + 定位 {…} / […] 片段）
    parsed = JSON.parse(extractJsonFromAi(cleaned));
  } catch (e) {
    console.warn(
      "[SitelinkAI] JSON 解析失败，使用页面 meta 兜底:",
      e instanceof Error ? e.message : e,
      "raw_preview:", raw.slice(0, 200).replace(/\s+/g, " "),
    );
    return fallbackAll(candidates, brand);
  }

  const arr: Array<{ title?: string; desc1?: string; desc2?: string }> =
    Array.isArray((parsed as any)?.sitelinks) ? (parsed as any).sitelinks : [];

  if (dumpRaw) {
    console.warn(
      `[SitelinkAI-PARSED] arr_len=${arr.length} first=${JSON.stringify(arr[0] ?? null)}`,
    );
  }

  // 严格按索引配对：prompt 给 AI 的就是 1..N 编号，URL 不让 AI 回传（避免幻觉）。
  // 数组长度不等 / 单项字段缺失 → 该条进 fallback（不再做 URL 兜底匹配）。
  let matched = 0;
  const results = candidates.map((c, i) => {
    const ai = arr[i];
    if (ai && (ai.desc1 || ai.desc2 || ai.title)) matched++;
    return buildOne(c, ai, brand);
  });

  console.warn(
    `[SitelinkAI] AI 映射匹配 ${matched}/${candidates.length}（arr_len=${arr.length}）`,
  );
  return results;
}

function buildOne(
  c: SitelinkInput,
  ai: { title?: string; desc1?: string; desc2?: string } | undefined,
  brand: string,
): SitelinkOutput {
  const aiTitle = ai?.title && typeof ai.title === "string" ? cleanTitle(ai.title) : "";
  const title =
    aiTitle.length >= 2 && aiTitle.length <= 25 && !isAllCapsLike(aiTitle)
      ? smartTruncate(aiTitle, 25)
      : pickFallbackTitle(c);

  const aiDesc1 = ai?.desc1 && typeof ai.desc1 === "string" ? cleanDesc(ai.desc1) : "";
  const desc1 =
    aiDesc1.length >= 2 && aiDesc1.length <= 45
      ? smartTruncate(aiDesc1, 35)
      : smartTruncate(cleanDesc(c.pageDescription) || brand, 35);

  const aiDesc2 = ai?.desc2 && typeof ai.desc2 === "string" ? cleanDesc(ai.desc2) : "";
  const desc2Raw =
    aiDesc2.length >= 2 && aiDesc2.length <= 45 && aiDesc2.toLowerCase() !== aiDesc1.toLowerCase()
      ? smartTruncate(aiDesc2, 35)
      : smartTruncate(brand, 35);
  const desc2 = desc2Raw === desc1 ? smartTruncate(`${brand}`, 35) : desc2Raw;

  return { url: c.url, title, desc1, desc2 };
}

function fallbackAll(candidates: SitelinkInput[], brand: string): SitelinkOutput[] {
  return candidates.map((c) => ({
    url: c.url,
    title: pickFallbackTitle(c),
    desc1: smartTruncate(cleanDesc(c.pageDescription) || brand, 35),
    desc2: smartTruncate(brand, 35),
  }));
}
