import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { callAiWithFallback } from "@/lib/ai-service";

function safeParseJson(raw: string): Record<string, unknown> {
  let text = raw.trim();
  if (text.startsWith("```")) {
    const firstNl = text.indexOf("\n");
    if (firstNl > 0) text = text.slice(firstNl + 1);
    if (text.trimEnd().endsWith("```")) text = text.trimEnd().slice(0, -3);
    text = text.trim();
  }
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    text = text.slice(jsonStart, jsonEnd + 1);
  }

  try {
    return JSON.parse(text);
  } catch {
    // pass — try repair below
  }

  let repaired = text
    .replace(/,\s*([}\]])/g, "$1")              // trailing commas
    .replace(/\n/g, "\\n")                       // unescaped newlines inside strings
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");

  try {
    return JSON.parse(repaired);
  } catch {
    // pass
  }

  // aggressive: regex-extract arrays for each known key
  const result: Record<string, unknown> = {};
  for (const key of ["headlines", "descriptions", "callouts"]) {
    const re = new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*?)\\]`, "s");
    const m = repaired.match(re);
    if (m) {
      const items = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) =>
        x[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'),
      );
      if (items.length > 0) result[key] = items;
    }
  }
  // sitelinks: array of objects
  const slMatch = repaired.match(/"sitelinks"\s*:\s*\[([\s\S]*?)\]/);
  if (slMatch) {
    const objMatches = [...slMatch[1].matchAll(/\{[^}]*\}/g)];
    const sitelinks = objMatches.map((om) => {
      const obj: Record<string, string> = {};
      for (const field of ["title", "desc1", "desc2"]) {
        const fm = om[0].match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
        if (fm) obj[field] = fm[1].replace(/\\"/g, '"');
      }
      return obj;
    }).filter((o) => o.title);
    if (sitelinks.length > 0) result.sitelinks = sitelinks;
  }

  if (Object.keys(result).length > 0) return result;

  throw new Error(`Expected ',' or '}' — AI returned invalid JSON that could not be repaired`);
}

const COUNTRY_LANGUAGE_MAP: Record<string, { name: string; language: string }> = {
  CN: { name: "中国", language: "Simplified Chinese (中文)" },
  US: { name: "美国", language: "English (US)" },
  UK: { name: "英国", language: "English (UK)" },
  CA: { name: "加拿大", language: "English (CA)" },
  AU: { name: "澳大利亚", language: "English (AU)" },
  DE: { name: "德国", language: "German" },
  FR: { name: "法国", language: "French" },
  JP: { name: "日本", language: "Japanese" },
  BR: { name: "巴西", language: "Portuguese (BR)" },
  ES: { name: "西班牙", language: "Spanish" },
  IT: { name: "意大利", language: "Italian" },
  NL: { name: "荷兰", language: "Dutch" },
  KR: { name: "韩国", language: "Korean" },
};

/**
 * POST /api/user/ad-creation/translate
 * 将广告标题、描述和宣传信息翻译为目标语言
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { headlines, descriptions, callouts, sitelinks, target_country, merchant_name } = await req.json();

  if (!headlines?.length && !descriptions?.length && !callouts?.length && !sitelinks?.length) {
    return apiError("没有需要翻译的内容");
  }

  const lang = COUNTRY_LANGUAGE_MAP[target_country?.toUpperCase()] || COUNTRY_LANGUAGE_MAP.US;
  const isChinese = target_country?.toUpperCase() === "CN";

  const calloutsSection = (callouts?.length > 0)
    ? (isChinese
      ? `\n\n宣传信息:\n${callouts.map((c: string, i: number) => `${i + 1}. "${c}"`).join("\n")}`
      : `\n\nCALLOUTS (each must stay ≤ 25 characters after translation):\n${callouts.map((c: string, i: number) => `${i + 1}. "${c}"`).join("\n")}`)
    : "";

  const calloutsJsonHint = callouts?.length > 0
    ? (isChinese ? ',"callouts":["中文宣传1","..."]' : ',"callouts":["translated callout 1","..."]')
    : "";

  const sitelinksSection = (sitelinks?.length > 0)
    ? (isChinese
      ? `\n\n站内链接（每条含标题、描述1、描述2）:\n${sitelinks.map((s: any, i: number) => `${i + 1}. 标题: "${s.title || ""}" | 描述1: "${s.desc1 || ""}" | 描述2: "${s.desc2 || ""}"`).join("\n")}`
      : `\n\nSITELINKS (each has title ≤25chars, desc1 ≤35chars, desc2 ≤35chars):\n${sitelinks.map((s: any, i: number) => `${i + 1}. Title: "${s.title || ""}" | Desc1: "${s.desc1 || ""}" | Desc2: "${s.desc2 || ""}"`).join("\n")}`)
    : "";

  const sitelinksJsonHint = sitelinks?.length > 0
    ? (isChinese
      ? ',"sitelinks":[{"title":"中文标题","desc1":"中文描述1","desc2":"中文描述2"},...]'
      : ',"sitelinks":[{"title":"translated","desc1":"translated","desc2":"translated"},...]')
    : "";

  const prompt = isChinese
    ? `你是 Adrian，一位以"数据猎手"著称的 Google Ads 广告专家，擅长把英文广告标题转化为让中国用户眼前一亮的简体中文版本。

你的任务不是逐字翻译，而是**意译改写**：在保留核心卖点的基础上，用更有力、更具体、更具说服力的中文表达，让读者第一眼就产生"这正是我想要的"的感受。

商家: ${merchant_name || "Unknown"}

英文标题（需改写为吸引人的中文）:
${(headlines || []).map((h: string, i: number) => `${i + 1}. "${h}"`).join("\n")}

英文描述（需改写为简洁有力的中文）:
${(descriptions || []).map((d: string, i: number) => `${i + 1}. "${d}"`).join("\n")}${calloutsSection}${sitelinksSection}

改写规则（严格遵守）:
- 【内容忠实】必须保留原文的核心信息——原文提到的品牌名、产品系列、年份、折扣、具体卖点，中文版必须包含，不能替换成无关内容
- 【禁止直译】不要机械地把每个单词翻成中文，要重新组织语言表达同等甚至更强的营销力
- 【具体胜于抽象】如英文有年份/材质/数量/折扣，必须在中文中保留（如"40% off"→"低至6折"，"since 1975"→"创立于1975年"）
- 【动词驱动】标题优先用动词开头或强感官词（"收入囊中"、"亲手感受"、"现货精选"）
- 【禁止废话】绝对禁止"品质卓越"、"精心打造"、"非凡体验"等空洞词汇
- 【品牌/系列名不翻】Dooney & Bourke、Florentine、Pebble Grain、All Weather、Signature Fabric 等系列名直接保留英文
- 【描述字数】每条描述翻译后 20-40 字（原文约 50-90 字符），标题 8-16 字
- 【顺序对应】第 N 条中文必须对应第 N 条英文，不能打乱顺序

仅返回 JSON（不要任何解释或 markdown）:
{"headlines":["中文标题1","..."],"descriptions":["中文描述1","..."]${calloutsJsonHint}${sitelinksJsonHint}}`
    : `You are a professional Google Ads translator. Translate the following ad copy into ${lang.language} for the ${lang.name} market.

Merchant: ${merchant_name || "Unknown"}
Target language: ${lang.language}

HEADLINES (each must stay ≤ 30 characters after translation):
${(headlines || []).map((h: string, i: number) => `${i + 1}. "${h}"`).join("\n")}

DESCRIPTIONS (each must stay ≤ 90 characters after translation):
${(descriptions || []).map((d: string, i: number) => `${i + 1}. "${d}"`).join("\n")}${calloutsSection}${sitelinksSection}

CRITICAL RULES:
- Translate naturally, not word-for-word
- Headlines MUST be ≤ 30 characters each
- Descriptions MUST be ≤ 90 characters each${callouts?.length > 0 ? "\n- Callouts MUST be ≤ 25 characters each" : ""}${sitelinks?.length > 0 ? "\n- Sitelink titles MUST be ≤ 25 characters each\n- Sitelink descriptions MUST be ≤ 35 characters each" : ""}
- If a translation exceeds the limit, shorten it while keeping the meaning
- Keep brand names, product names, and proper nouns unchanged
- Maintain the marketing tone and call-to-action intent
- No emoji

Return ONLY a JSON object:
{"headlines":["translated headline 1","..."],"descriptions":["translated desc 1","..."]${calloutsJsonHint}${sitelinksJsonHint}}`;

  try {
    const raw = await callAiWithFallback(
      "translate",
      [{ role: "user", content: prompt }],
      4096,
    );

    const parsed = safeParseJson(raw);
    const rawH = Array.isArray(parsed.headlines) ? parsed.headlines : [];
    const rawD = Array.isArray(parsed.descriptions) ? parsed.descriptions : [];
    const rawC = Array.isArray(parsed.callouts) ? parsed.callouts : [];
    const rawS = Array.isArray(parsed.sitelinks) ? parsed.sitelinks : [];

    const translatedH = rawH
      .map((h: string) => String(h).trim())
      .filter((h: string) => h.length > 0);
    const translatedD = rawD
      .map((d: string) => String(d).trim())
      .filter((d: string) => d.length > 0);
    const translatedC = rawC
      .map((c: string) => String(c).trim())
      .filter((c: string) => c.length > 0);

    const translatedS = rawS
      .map((s: any) => ({
        title: String(s?.title || "").trim(),
        desc1: String(s?.desc1 || "").trim(),
        desc2: String(s?.desc2 || "").trim(),
      }))
      .filter((s: any) => s.title.length > 0);

    return apiSuccess({
      headlines: translatedH.length > 0 ? translatedH : headlines,
      descriptions: translatedD.length > 0 ? translatedD : descriptions,
      ...(callouts?.length > 0 ? { callouts: translatedC.length > 0 ? translatedC : callouts } : {}),
      ...(sitelinks?.length > 0 ? { sitelinks: translatedS.length > 0 ? translatedS : sitelinks } : {}),
      language: lang.language,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[Translate]", msg);
    return apiError(`翻译失败: ${msg.slice(0, 200)}`);
  }
}
