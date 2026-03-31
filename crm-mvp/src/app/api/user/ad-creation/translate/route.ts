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
    ? `将以下 Google Ads 广告文案翻译为简体中文，仅供参考查看，无字符限制。

商家: ${merchant_name || "Unknown"}

标题:
${(headlines || []).map((h: string, i: number) => `${i + 1}. "${h}"`).join("\n")}

描述:
${(descriptions || []).map((d: string, i: number) => `${i + 1}. "${d}"`).join("\n")}${calloutsSection}${sitelinksSection}

要求:
- 自然翻译，不要逐字翻译
- 品牌名、产品名保持原样
- 保持营销语气
- 无字符限制

仅返回 JSON:
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
