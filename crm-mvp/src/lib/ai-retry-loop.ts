/**
 * C-016 ai-retry-loop
 *
 * 职责：对 generateCore 产出的标题/描述，基于"政策违规 + 事实索赔"索引做**单条 mini-retry**。
 * 约束：
 *   - 只重写违规条目，不碰合规条目
 *   - 最多 3 轮，仍失败 → safe-ad-template 兜底
 *   - 复用 callAiWithFallback（与 generateCore 同一 AI 客户端）
 *
 * 调用时机（generate-extensions/route.ts 内）：
 *   generateCore → send("headlines") + send("descriptions")
 *     ↓
 *   collectGooglePolicyViolations + validateClaims（新增）
 *     ↓
 *   有违规 → rewriteViolationsOnly → 原位更新 headlines/descriptions
 *     ↓
 *   再 send("headlines"/"descriptions")  // 前端 CSS transition 平滑替换
 */

import { callAiWithFallback } from "@/lib/ai-service";
import { humanizeAdCopyBatch } from "@/lib/humanizer";
import { fillSafeHeadline, fillSafeDescription } from "@/lib/safe-ad-template";

export interface ViolationHint {
  /** 原文 */
  originalText: string;
  /** 0-based 索引（headlines/descriptions 的位置） */
  index: number;
  /** 注入 prompt 的人话提示 */
  hint: string;
}

export interface RewriteOptions {
  field: "headline" | "description";
  brandRoot: string;
  country: string;
  languageCode?: string;
  languageName?: string;
  /** headlines=30 / descriptions=90 */
  maxLen: number;
  /** headlines=2 / descriptions=40 */
  minLen: number;
  /** 最大 retry 轮数，默认 3 */
  maxRounds?: number;
  /** 持久证据/黑名单提示（用于防止"越改越违规"） */
  persistentRuleText?: string;
}

const MAX_ROUNDS_DEFAULT = 3;

function extractJsonArray(raw: string): string | null {
  // 尝试 ```json ... ```
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  // 裸数组
  const bracket = raw.match(/\[[\s\S]*\]/);
  if (bracket) return bracket[0];
  return null;
}

function parseRewrittenArray(raw: string, expectedCount: number): string[] {
  try {
    const jsonText = extractJsonArray(raw) || raw;
    const parsed = JSON.parse(jsonText);
    if (Array.isArray(parsed)) {
      return parsed.filter((x) => typeof x === "string" && x.trim().length > 0).slice(0, expectedCount);
    }
  } catch { /* fallthrough */ }
  // 退而求其次：按行拆
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/^[\s\d.\-·•"]+/, "").replace(/["',\s]+$/, "").trim()).filter(Boolean);
  return lines.slice(0, expectedCount);
}

/**
 * 单条 AI 重写核心调用。复用 callAiWithFallback("ad_copy")，与 generateCore 同一客户端。
 */
async function rewriteBatch(
  hints: ViolationHint[],
  opts: RewriteOptions,
): Promise<Record<number, string>> {
  if (hints.length === 0) return {};
  const { field, brandRoot, country, languageName, maxLen, minLen, persistentRuleText } = opts;
  const langHint = languageName ? `Write in ${languageName}.` : "Write in the original language of the item.";

  const list = hints
    .map((h, i) => `${i + 1}. ORIGINAL: "${h.originalText}"  VIOLATION: ${h.hint}`)
    .join("\n");

  const systemPrompt = `You are a senior Google Ads copywriter. Your job right now is to rewrite ONLY the flagged ${field}s so they pass Google Ads policies and only use verifiable facts. Keep each rewrite in the same language as the original. No numbers, no prices, no warranties, no absolute claims ("best", "#1", "guarantee", "100%"), no country tags. Keep the brand name "${brandRoot}" but do NOT add country abbreviations (NL, BE, DE…) after it.${persistentRuleText ? "\n\nExtra rules:\n" + persistentRuleText : ""}`;

  const userPrompt = `Brand: ${brandRoot}
Target country: ${country}
Field: ${field} (max ${maxLen} chars, min ${minLen} chars)
${langHint}

Rewrite EACH flagged item. Return ONLY a JSON array of ${hints.length} strings in the same order. No commentary.

Flagged items:
${list}

Constraints:
- Same meaning where possible, but remove the VIOLATION content.
- Do not invent facts (no percentages, prices, phone numbers, years, free shipping, warranty).
- Use non-numeric value props (e.g. "Official Store", "Shop Online", "Browse Catalog").
- Stay within ${minLen}-${maxLen} characters per item.
- Never use ALL CAPS.

Return JSON array only. Example: ["rewrite1","rewrite2",...]`;

  try {
    const raw = await callAiWithFallback("ad_copy", [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ], 1024);
    const arr = parseRewrittenArray(raw, hints.length);
    const humanized = humanizeAdCopyBatch(arr, minLen, maxLen);

    const result: Record<number, string> = {};
    for (let i = 0; i < hints.length; i++) {
      const candidate = humanized[i];
      if (!candidate) continue;
      if (candidate.length < minLen || candidate.length > maxLen) continue;
      result[hints[i].index] = candidate;
    }
    return result;
  } catch (err) {
    console.warn(`[AI Retry] 单条重写失败 (${field}):`, err instanceof Error ? err.message : err);
    return {};
  }
}

/**
 * 统一重写回调：对外暴露的语义是"把这些有问题的条目改掉，返回可用的新值"
 * 进出参数：
 *   items: 当前已渲染的 field 列表
 *   violations: 需要重写的 index + hint
 *   validateAfterFn: 重写后再次校验单条是否仍违规（true=通过）
 *
 * 流程：
 *   round 1..maxRounds：AI 重写 violations → validateAfterFn 逐条校验 → 通过的直接替换 → 未过的进入下一轮
 *   全轮结束仍未过的条目 → safe-ad-template 兜底
 */
export async function rewriteViolationsOnly(params: {
  items: string[];
  violations: Array<{ index: number; hint: string }>;
  opts: RewriteOptions;
  /** 对单条重写结果做"仍然违规？"判定。true = 通过。 */
  validateAfterFn?: (newText: string, field: "headline" | "description", index: number) => boolean;
  /** 调试回调，每轮告知进度 */
  onRound?: (round: number, remaining: number) => void;
}): Promise<{ items: string[]; degraded: number[]; rewritten: number[] }> {
  const { items, violations, opts, validateAfterFn, onRound } = params;
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS_DEFAULT;
  const result = [...items];
  const rewritten: number[] = [];
  const degraded: number[] = [];
  let pending = violations.slice();

  for (let round = 1; round <= maxRounds && pending.length > 0; round++) {
    onRound?.(round, pending.length);
    const hints: ViolationHint[] = pending.map((v) => ({
      originalText: result[v.index] || "",
      index: v.index,
      hint: v.hint,
    })).filter((h) => h.originalText);
    if (hints.length === 0) break;

    const newMap = await rewriteBatch(hints, opts);
    const nextPending: Array<{ index: number; hint: string }> = [];

    for (const v of pending) {
      const candidate = newMap[v.index];
      if (!candidate) {
        nextPending.push(v);
        continue;
      }
      // 若提供二次校验函数，要通过才算成功
      if (validateAfterFn && !validateAfterFn(candidate, opts.field, v.index)) {
        // 本轮重写仍违规 → 下轮继续
        nextPending.push({ index: v.index, hint: `${v.hint} (round ${round} attempt still violated)` });
        continue;
      }
      result[v.index] = candidate;
      rewritten.push(v.index);
    }
    pending = nextPending;
  }

  // 3 轮仍失败 → safe-template 兜底
  if (pending.length > 0) {
    for (const v of pending) {
      const safe = opts.field === "headline"
        ? fillSafeHeadline(opts.brandRoot, opts.country, opts.languageCode, v.index)
        : fillSafeDescription(opts.brandRoot, opts.country, opts.languageCode, v.index);
      result[v.index] = safe;
      degraded.push(v.index);
    }
  }

  return { items: result, degraded, rewritten };
}
