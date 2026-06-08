/**
 * LANG-01：广告文案「语言一致性」后置守卫
 *
 * 背景：管线已按 country/market 解析出目标广告语言并在 prompt 里强约束，但 AI 在
 *       源站全英文时偶发"语言漂移"，把部分/全部标题、描述写成英文（混语言）。生成后
 *       此前没有任何语言校验闸 → 直接落库上屏 → 「语言是繁體、文案却是英文」。
 *
 * 本模块职责：生成后逐条判定语言，对"目标为非拉丁语(zh/ja/ko/ru…) 却写成纯拉丁/英文"
 *       的条目，批量送 AI 按目标语言本地化重写；重写仍失败的，用 safe-ad-template 同
 *       语言兜底，**绝不留下与目标语言不符的条目**。
 *
 * 设计取舍：拉丁语系互相之间(en/de/fr/es…)纯启发式难以可靠区分，易误伤，故本守卫
 *       **只对非拉丁脚本目标语言生效**（CJK / 谚文 / 西里尔），正好覆盖 07 的繁體场景。
 */

import { callAiWithFallback } from "@/lib/ai-service";
import { extractJsonFromAi } from "@/lib/crawl-pipeline";
import { fillSafeHeadline, fillSafeDescription } from "@/lib/safe-ad-template";

type ScriptKind = "han" | "kana" | "hangul" | "cyrillic" | "latin";

/** 目标语言代码 → 期望脚本类型。拉丁语系统一归 "latin"（本守卫跳过，避免误伤）。 */
export function targetLanguageScript(langCode?: string): ScriptKind {
  if (!langCode) return "latin";
  const l = String(langCode).toLowerCase().replace(/_/g, "-");
  if (l.startsWith("zh")) return "han";
  if (l.startsWith("ja")) return "kana"; // 日文：汉字 + 假名
  if (l.startsWith("ko")) return "hangul";
  if (l.startsWith("ru") || l.startsWith("uk") || l.startsWith("be") || l.startsWith("bg") || l.startsWith("sr")) return "cyrillic";
  return "latin";
}

const SCRIPT_REGEX: Record<Exclude<ScriptKind, "latin">, RegExp> = {
  // CJK 统一表意文字（含扩展 A）+ 兼容表意文字
  han: /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g,
  // 日文：平/片假名 + 汉字
  kana: /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g,
  hangul: /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/g,
  cyrillic: /[\u0400-\u04ff\u0500-\u052f]/g,
};

/** 统计文本中"字母类"字符数（Unicode 字母），用于做脚本占比分母。 */
function letterCount(text: string): number {
  const m = text.match(/\p{L}/gu);
  return m ? m.length : 0;
}

function scriptCharCount(text: string, kind: Exclude<ScriptKind, "latin">): number {
  const m = text.match(SCRIPT_REGEX[kind]);
  return m ? m.length : 0;
}

/**
 * 判定单条文案是否与目标语言不符。
 * - 目标拉丁语系：恒返回 false（不在守卫范围）。
 * - 目标非拉丁：若该条几乎不含目标脚本字符（占字母比 < 阈值），判为漂移。
 *   纯数字/符号（无字母）不判（如电话、价格）。
 */
export function isLanguageMismatch(text: string, langCode?: string): boolean {
  const kind = targetLanguageScript(langCode);
  if (kind === "latin") return false;
  const letters = letterCount(text);
  if (letters === 0) return false; // 纯数字/符号，跳过
  const ratio = scriptCharCount(text, kind) / letters;
  return ratio < 0.2;
}

export interface LanguageGuardOptions {
  langCode?: string;          // 目标广告语言代码，如 "zh_TW"
  languageName: string;       // 目标语言英文名，如 "Traditional Chinese"
  fieldKind: "headline" | "description" | "short"; // short=callout/snippet 等短文案
  maxLen: number;
  minLen?: number;
  merchantName: string;
  country?: string;
  label?: string;             // 日志标识
}

/**
 * 批量 AI 本地化重写「语言不符」的条目。返回与输入同序、同长度的数组；
 * 无法对齐的位置返回空串，由调用方决定兜底。
 */
async function aiLocalize(
  mismatched: { idx: number; text: string }[],
  opts: LanguageGuardOptions,
): Promise<Record<number, string>> {
  const out: Record<number, string> = {};
  const lenRule =
    opts.fieldKind === "description" && opts.minLen
      ? `${opts.minLen}-${opts.maxLen} characters`
      : `≤${opts.maxLen} characters`;
  const prompt = `You are localizing Google Ads copy for a ${opts.languageName} audience.
The lines below were written in the WRONG language (English or another language). Rewrite EACH line ENTIRELY in ${opts.languageName}.

Rules:
- Keep the same marketing meaning and selling point.
- Each line MUST be ${lenRule}.
- Write native, natural ${opts.languageName}. Do NOT leave English words except well-known proper brand names.
- Do NOT add new facts, numbers, prices, or promises that are not in the original.
- Output MUST be in ${opts.languageName} script.

Lines:
${mismatched.map((m, i) => `${i + 1}. "${m.text}"`).join("\n")}

Return ONLY a JSON array of ${mismatched.length} rewritten strings in the same order, all in ${opts.languageName}.`;

  try {
    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 1024);
    const parsed = JSON.parse(extractJsonFromAi(raw));
    if (Array.isArray(parsed)) {
      for (let i = 0; i < mismatched.length; i++) {
        const cand = String(parsed[i] ?? "").trim().replace(/^["']|["']$/g, "");
        const minOk = opts.minLen ? cand.length >= opts.minLen : cand.length >= 2;
        // 重写结果必须：长度合规 + 不再是语言漂移
        if (cand && minOk && cand.length <= opts.maxLen && !isLanguageMismatch(cand, opts.langCode)) {
          out[mismatched[i].idx] = cand;
        }
      }
    }
  } catch (err) {
    console.warn(`[LangGuard] ${opts.label || opts.fieldKind} AI 本地化重写失败:`, err instanceof Error ? err.message : err);
  }
  return out;
}

/**
 * 主入口：对一组文案做语言一致性守卫。
 * 流程：检测漂移 → AI 批量本地化重写 → 仍漂移/失败的用 safe-template 同语言兜底。
 * 返回 { items, rewrittenCount, fallbackCount, changed }。
 */
export async function enforceLanguageConsistency(
  items: string[],
  opts: LanguageGuardOptions,
): Promise<{ items: string[]; rewrittenCount: number; fallbackCount: number; changed: boolean }> {
  const kind = targetLanguageScript(opts.langCode);
  if (kind === "latin" || items.length === 0) {
    return { items, rewrittenCount: 0, fallbackCount: 0, changed: false };
  }

  const mismatched = items
    .map((text, idx) => ({ idx, text }))
    .filter((it) => typeof it.text === "string" && it.text.trim() && isLanguageMismatch(it.text, opts.langCode));

  if (mismatched.length === 0) {
    return { items, rewrittenCount: 0, fallbackCount: 0, changed: false };
  }

  console.warn(
    `[LangGuard] ${opts.label || opts.fieldKind}: 目标=${opts.languageName}(${opts.langCode}) 检出 ${mismatched.length}/${items.length} 条语言漂移，触发本地化重写`,
  );

  const result = [...items];
  let rewrittenCount = 0;
  let fallbackCount = 0;

  // 1) AI 批量本地化重写
  const rewritten = await aiLocalize(mismatched, opts);

  // 2) 逐条落位；AI 未能对齐的，用 safe-template 同语言兜底
  for (let i = 0; i < mismatched.length; i++) {
    const { idx } = mismatched[i];
    const aiText = rewritten[idx];
    if (aiText) {
      result[idx] = aiText;
      rewrittenCount++;
      continue;
    }
    // 兜底：同语言模板（保证语言一致；safe-template 已支持 zh/de/fr…，无对应包则退英文，
    // 但 kind 非拉丁时 PACK_ZH 等会命中）
    const safe =
      opts.fieldKind === "description"
        ? fillSafeDescription(opts.merchantName, opts.country, opts.langCode, idx)
        : fillSafeHeadline(opts.merchantName, opts.country, opts.langCode, idx);
    // 模板兜底仍需确保语言一致；若模板也漂移（理论上不会），则保留原值不动以免更糟
    if (safe && !isLanguageMismatch(safe, opts.langCode)) {
      result[idx] = safe;
      fallbackCount++;
    }
  }

  const changed = rewrittenCount > 0 || fallbackCount > 0;
  if (changed) {
    console.warn(
      `[LangGuard] ${opts.label || opts.fieldKind}: 重写 ${rewrittenCount} 条 + 模板兜底 ${fallbackCount} 条`,
    );
  }
  return { items: result, rewrittenCount, fallbackCount, changed };
}
