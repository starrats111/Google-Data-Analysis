/**
 * C-148：广告文案"贴合限长"工具 —— 既不超长、也绝不从词中间硬切。
 *
 * 背景（设计方案 C-148）：旧逻辑在 submit/generate-extensions 多处用 `text.slice(0, maxLen)`
 * 把超长广告文案（标题/描述/站点链接/宣传信息/价格/促销/摘要）从单词中间硬切，
 * 导致上线广告出现半截词/半截语义（07：文案出现了截断，不可容忍）。
 *
 * 修复口径（07 拍板）：超长文案一律
 *   ① AI 语义压缩成完整 ≤maxLen 短语（保留品牌名/数字/卖点）；
 *   ② AI 失败/超时/仍超长 → smartTruncate 按"词边界"回退（永不半截词，且必 ≤maxLen）。
 * 保证：返回的每一条都 ≤maxLen，且不会出现从单词中间切断。
 */
import { callAiWithFallback } from "@/lib/ai-service";
import { smartTruncate, extractJsonFromAi } from "@/lib/crawl-pipeline";
import { googleAdsTextWidth, truncateByWidth } from "@/lib/ad-text-width";

/**
 * 同步兜底：保证 ≤maxLen 且按词边界（不半截词）。无 AI、确定性、永不阻断。
 * 2026-07-13（第六轮）：长度判定改 Google Ads 显示宽度（CJK 计 2），码点安全。
 */
export function fitAdTextSync(text: string, maxLen: number): string {
  const t = (text ?? "").trim();
  if (googleAdsTextWidth(t) <= maxLen) return t;
  const cut = smartTruncate(t, maxLen);
  // 极端兜底：smartTruncate 理论上恒 ≤maxLen，这里再保险一次
  return googleAdsTextWidth(cut) <= maxLen ? cut : truncateByWidth(cut, maxLen);
}

/**
 * 批量"贴合限长"：
 *   - 本就 ≤maxLen 的条目原样保留（不调用 AI，零额外开销）；
 *   - 超长条目先批量 AI 语义压缩成完整 ≤maxLen 短语；
 *   - AI 失败/返回不合格 → fitAdTextSync 按词边界回退。
 * 始终返回与输入同长度、每条 ≤maxLen 的数组。
 */
export async function fitAdTextBatch(
  items: string[],
  maxLen: number,
  languageName: string,
): Promise<string[]> {
  const result = items.map((i) => (i ?? "").trim());
  // 2026-07-13（第六轮）：超长判定改显示宽度（CJK 双宽），prompt 明确告知 CJK 计 2 单位
  const overlong = result
    .map((t, idx) => ({ idx, t }))
    .filter((o) => googleAdsTextWidth(o.t) > maxLen);
  if (overlong.length === 0) return result;

  try {
    const prompt = `Rewrite each Google Ads text into a semantically COMPLETE phrase within ${maxLen} display units. IMPORTANT: CJK / full-width characters (Chinese, Japanese, Korean) count as 2 units each; all other characters (including spaces and punctuation) count as 1. Keep the same language (${languageName}). Preserve brand names, numbers and key selling points. NEVER truncate mid-word or mid-idea — rephrase to fit.

${overlong.map((o, i) => `${i + 1}. "${o.t}" (${googleAdsTextWidth(o.t)} units → MUST be ≤${maxLen})`).join("\n")}

Return ONLY a JSON array of ${overlong.length} strings in the SAME order. Every string MUST be ≤${maxLen} display units.`;
    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 1024);
    // 2026-07-13：JSON.parse 改 parseAiJsonLoose 同源的 extractJsonFromAi + 宽松清洗
    const parsed = JSON.parse(extractJsonFromAi(raw));
    if (Array.isArray(parsed)) {
      for (let i = 0; i < overlong.length; i++) {
        const c = String(parsed[i] ?? "").trim().replace(/^["']|["']$/g, "");
        result[overlong[i].idx] =
          c.length >= 2 && googleAdsTextWidth(c) <= maxLen ? c : fitAdTextSync(overlong[i].t, maxLen);
      }
      return result;
    }
  } catch (e) {
    console.warn(`[fitAdTextBatch] AI 压缩失败，回退按词边界 smartTruncate:`, e instanceof Error ? e.message : e);
  }

  // AI 整体失败：逐条按词边界回退，保证 ≤maxLen 且不半截词
  for (const o of overlong) result[o.idx] = fitAdTextSync(o.t, maxLen);
  return result;
}
