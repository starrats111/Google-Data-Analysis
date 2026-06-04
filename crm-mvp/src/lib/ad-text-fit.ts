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

/**
 * 同步兜底：保证 ≤maxLen 且按词边界（不半截词）。无 AI、确定性、永不阻断。
 */
export function fitAdTextSync(text: string, maxLen: number): string {
  const t = (text ?? "").trim();
  if (t.length <= maxLen) return t;
  const cut = smartTruncate(t, maxLen);
  // 极端兜底：smartTruncate 理论上恒 ≤maxLen，这里再保险一次
  return cut.length <= maxLen ? cut : cut.slice(0, maxLen).trimEnd();
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
  const overlong = result
    .map((t, idx) => ({ idx, t }))
    .filter((o) => o.t.length > maxLen);
  if (overlong.length === 0) return result;

  try {
    const prompt = `Rewrite each Google Ads text into a semantically COMPLETE phrase within ${maxLen} characters (count every character including spaces and punctuation). Keep the same language (${languageName}). Preserve brand names, numbers and key selling points. NEVER truncate mid-word or mid-idea — rephrase to fit.

${overlong.map((o, i) => `${i + 1}. "${o.t}" (${o.t.length} chars → MUST be ≤${maxLen})`).join("\n")}

Return ONLY a JSON array of ${overlong.length} strings in the SAME order. Every string MUST be ≤${maxLen} characters.`;
    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 1024);
    const parsed = JSON.parse(extractJsonFromAi(raw));
    if (Array.isArray(parsed)) {
      for (let i = 0; i < overlong.length; i++) {
        const c = String(parsed[i] ?? "").trim().replace(/^["']|["']$/g, "");
        result[overlong[i].idx] =
          c.length >= 2 && c.length <= maxLen ? c : fitAdTextSync(overlong[i].t, maxLen);
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
