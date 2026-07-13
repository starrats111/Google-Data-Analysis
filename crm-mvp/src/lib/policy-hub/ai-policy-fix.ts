/**
 * D-152 / Policy Hub — Google Ads 拒登后的 AI 自动改写闭环
 *
 * 现状（修复前）：广告被 Google Ads 以政策原因拒登时，submit/route.ts 只把
 *   policy-hub 解析出的 readableMessage 字符串丢回前端，弹「我知道了」终止 ——
 *   全凭员工人工逐条排查改文案。而本地规则违规反而早已有 AI 自动改写（generate-more）。
 *
 * 本模块把后者补齐：拿 Google 真实拒登的「被拒字段 + 违规原文 + 政策原因」喂给 AI，
 *   定向改写被拒的标题/描述（拿不到具体字段时整体改写），返回改写后的全量文案，
 *   供 submit 重建 RSA 操作后自动重提（最多 N 轮）。
 */

import { callAiWithFallback } from "@/lib/ai-service";
import { extractJsonFromAi } from "@/lib/crawl-pipeline";
import { googleAdsTextWidth } from "@/lib/ad-text-width";
import type { ParsedPolicyError } from "./error-parser";

const HEADLINE_MAX = 30;
const HEADLINE_MIN = 2;
const DESC_MAX = 90;
const DESC_MIN = 30;

export interface PolicyRewriteResult {
  /** 改写后的全量标题（未命中违规的原样保留） */
  headlines: string[];
  /** 改写后的全量描述 */
  descriptions: string[];
  /** 是否真的产生了改写（false 表示 AI 无法改/无可改，调用方应停止重试） */
  changed: boolean;
  /** 改写明细（「原文」→「改写」），用于日志/回传 */
  notes: string[];
}

/** 从 readableField（如「标题4」「描述2」）解析出 0-based 下标 */
function parseFieldIndex(readableField: string | null, kind: "标题" | "描述"): number | null {
  if (!readableField) return null;
  const m = readableField.match(new RegExp(`^${kind}(\\d+)$`));
  if (!m) return null;
  const oneBased = Number(m[1]);
  return Number.isFinite(oneBased) && oneBased > 0 ? oneBased - 1 : null;
}

/** 汇总 Google 给出的拒登原因 + 需要规避的违规原文 */
function summarizeReasons(parsed: ParsedPolicyError | null): { reasonText: string; avoidTexts: string[] } {
  if (!parsed || parsed.primary.length === 0) {
    return {
      reasonText: "Rejected by Google Ads as PROHIBITED / disapproved content (no per-field detail provided).",
      avoidTexts: [],
    };
  }
  const reasonLines = new Set<string>();
  const avoidTexts = new Set<string>();
  for (const p of parsed.primary) {
    const label = p.category?.labelZh || p.externalPolicyName || p.policyName || "policy violation";
    const fix = p.category?.suggestedFix || p.externalPolicyDescription || p.message || "";
    reasonLines.add(`- ${label}${fix ? `: ${fix}` : ""}`);
    if (p.violatingText && !/^-?\d+$/.test(p.violatingText.trim())) avoidTexts.add(p.violatingText.trim());
  }
  return { reasonText: [...reasonLines].join("\n"), avoidTexts: [...avoidTexts] };
}

/** 调 AI 改写一组被拒文本，返回等长替换数组（失败/越界项回退为 null，由调用方丢弃该位） */
async function rewriteBatch(
  items: { index: number; text: string }[],
  kind: "headlines" | "descriptions",
  ctx: { merchantName: string; languageName: string; reasonText: string; avoidTexts: string[] },
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (items.length === 0) return out;
  const isHeadline = kind === "headlines";
  const maxLen = isHeadline ? HEADLINE_MAX : DESC_MAX;
  const minLen = isHeadline ? HEADLINE_MIN : DESC_MIN;

  const prompt = `You are fixing Google Ads RSA ${isHeadline ? "headlines" : "descriptions"} that were DISAPPROVED by Google Ads policy review.
Merchant: ${ctx.merchantName}
Output language: ${ctx.languageName}

WHY GOOGLE REJECTED THE AD:
${ctx.reasonText}
${ctx.avoidTexts.length > 0 ? `\nNEVER reuse these exact phrases (they triggered the violation): ${ctx.avoidTexts.map((t) => `"${t}"`).join(", ")}` : ""}

REWRITE each of the following ${items.length} item(s) so they are fully policy-compliant while keeping the original marketing intent and the output language:
${items.map((it, i) => `${i + 1}. "${it.text}"`).join("\n")}

Hard rules:
- Each rewritten item MUST be ${minLen}-${maxLen} characters.
- Do NOT use: guaranteed, risk-free, zero risk, 100% safe, cure, cures, miracle, heal, heals, best, #1, cheapest, free money, instant approval.
- No trademark/brand names you are not authorized to use, no excessive capitalization, no "!!"/"??"/symbols spam.
- Return ONLY a JSON array of exactly ${items.length} rewritten strings, in the same order.`;

  let raw: string;
  try {
    raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 1024);
  } catch {
    return out;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonFromAi(raw));
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (let i = 0; i < items.length && i < parsed.length; i++) {
    const repl = String(parsed[i] ?? "").trim();
    // 2026-07-13（第七轮）：改用 Google Ads 显示宽度（CJK 双宽）校验——
    // repl.length 会让 CJK 文本通过内部检查却被 Google 再次拒登（LINE_TOO_LONG）。
    const width = googleAdsTextWidth(repl);
    if (width >= minLen && width <= maxLen && repl.toLowerCase() !== items[i].text.toLowerCase()) {
      out.set(items[i].index, repl);
    }
  }
  return out;
}

/**
 * 主入口：按 Google 拒登原因改写被拒的标题/描述。
 *
 * 命中具体字段（policy-hub 解析出「标题N/描述N」）时只改这些；
 * 拿不到字段定位（如整条 PROHIBITED）时整体改写全部标题+描述。
 */
export async function rewriteAdCopyForPolicy(params: {
  headlines: string[];
  descriptions: string[];
  parsed: ParsedPolicyError | null;
  merchantName: string;
  languageName: string;
}): Promise<PolicyRewriteResult> {
  const headlines = [...params.headlines];
  const descriptions = [...params.descriptions];
  const { reasonText, avoidTexts } = summarizeReasons(params.parsed);

  // 1) 从解析结果定位被拒字段
  const hIdx = new Set<number>();
  const dIdx = new Set<number>();
  for (const p of params.parsed?.primary || []) {
    const hi = parseFieldIndex(p.readableField, "标题");
    if (hi != null && hi < headlines.length) hIdx.add(hi);
    const di = parseFieldIndex(p.readableField, "描述");
    if (di != null && di < descriptions.length) dIdx.add(di);
  }
  // 命中违规原文但没字段定位时，按文本匹配补充命中
  if (avoidTexts.length > 0) {
    headlines.forEach((h, i) => { if (avoidTexts.some((t) => h.toLowerCase().includes(t.toLowerCase()))) hIdx.add(i); });
    descriptions.forEach((d, i) => { if (avoidTexts.some((t) => d.toLowerCase().includes(t.toLowerCase()))) dIdx.add(i); });
  }
  // 2) 完全定位不到 → 整体改写（如整条 PROHIBITED 拒登）
  if (hIdx.size === 0 && dIdx.size === 0) {
    headlines.forEach((_, i) => hIdx.add(i));
    descriptions.forEach((_, i) => dIdx.add(i));
  }

  const ctx = { merchantName: params.merchantName, languageName: params.languageName, reasonText, avoidTexts };
  const [hRepl, dRepl] = await Promise.all([
    rewriteBatch([...hIdx].sort((a, b) => a - b).map((i) => ({ index: i, text: headlines[i] })), "headlines", ctx),
    rewriteBatch([...dIdx].sort((a, b) => a - b).map((i) => ({ index: i, text: descriptions[i] })), "descriptions", ctx),
  ]);

  const notes: string[] = [];
  for (const [i, repl] of hRepl) { notes.push(`标题「${headlines[i]}」→「${repl}」`); headlines[i] = repl; }
  for (const [i, repl] of dRepl) { notes.push(`描述「${descriptions[i]}」→「${repl}」`); descriptions[i] = repl; }

  return { headlines, descriptions, changed: notes.length > 0, notes };
}
