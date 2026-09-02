/**
 * Humanizer 发布门禁（C-186）
 *
 * 规则来源：humanizer skill（softaworks/agent-toolkit，基于 Wikipedia "Signs of AI writing"）。
 * 所有文章在发布到站点之前必须通过本检测；未通过且自动清洗后仍未通过的，禁止发布。
 *
 * 检测分两级：
 * - hard：几乎只有 AI 会写的指纹（em dash、reasoning 残留、chatbot 客套话、
 *   "stands as a testament" 类膨胀措辞、"in conclusion" 类收尾套话）。出现即不通过。
 * - soft：AI 高频词（seamless/vibrant/elevate…）。单个出现不算问题（真实写作也会用，
 *   如 seamless leggings 是正常产品词），累计超过阈值才不通过。
 *
 * 检测对象是剥掉 HTML 标签后的正文纯文本，避免 href/style 等属性误伤。
 *
 * D-310：每条规则自带 `fix`（替换写法），自动清洗直接由本表驱动 —— 拦什么就修什么，
 * 同一个正则、同一套词形，不会再出现「门禁认 Game-Changer / game changing，
 * 清洗只认小写 game-changer」这种修不掉又发不出去的死局。
 * 没有 `fix` 的规则（reasoning 残留、chatbot 客套话、知识截止声明、negative parallelism）
 * 表示换个词救不回来，只能重新生成。
 */

export interface GateViolation {
  id: string;
  label: string;
  severity: "hard" | "soft";
  count: number;
  samples: string[];
}

export interface GateResult {
  passed: boolean;
  hardViolations: GateViolation[];
  softCount: number;
  softViolations: GateViolation[];
}

/** soft 词累计出现次数超过该值则不通过 */
const SOFT_TOTAL_THRESHOLD = 6;

/** 自动清洗的替换写法：定值字符串，或按命中的原文决定词形的函数 */
type FixTo = string | ((matched: string) => string);

interface Rule {
  id: string;
  label: string;
  re: RegExp;
  severity: "hard" | "soft";
  /** 缺省 = 这条规则换词救不回来，必须重新生成 */
  fix?: { re: RegExp; to: FixTo };
}

// ─── 大小写与词形工具 ───

/** 把替换词的大小写对齐原文（Game-Changer → Big Deal 的首字母，GAME-CHANGER → 全大写） */
function matchCase(sample: string, replacement: string): string {
  if (!sample || !replacement) return replacement;
  const letters = sample.replace(/[^A-Za-z]/g, "");
  if (letters.length > 1 && letters === letters.toUpperCase()) return replacement.toUpperCase();
  if (/^[A-Z]/.test(sample)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

/** 按原词的词尾选替换词的词形：look / looks / looked / looking */
function inflect(matched: string, base: string, third: string, past: string, gerund: string): string {
  const w = matched.toLowerCase();
  if (w.endsWith("ing")) return gerund;
  if (w.endsWith("ed")) return past;
  if (w.endsWith("es") || w.endsWith("s")) return third;
  return base;
}

/**
 * 破折号归一化：破折号（em dash）是 AI 写作最明显的指纹之一，确定性清除。
 * - 中文双破折号 "——" → 中文逗号
 * - 单 em dash 夹在文字之间：CJK 上下文用中文逗号，英文用英文逗号
 * - 其余残留 → 英文逗号
 * 只处理 em dash 家族（U+2014 / U+2E3A / U+2E3B），不动 en dash（U+2013，数字区间如 4–6 要用）。
 */
export function normalizeDashes(text: string): string {
  let r = text;
  r = r.replace(/\s*[—⸺⸻]{2,}\s*/g, "，");
  r = r.replace(/(\S)\s*[—⸺⸻]\s*(\S)/g, (_m, a: string, b: string) =>
    /[㐀-鿿]/.test(a) || /[㐀-鿿]/.test(b) ? `${a}，${b}` : `${a}, ${b}`,
  );
  r = r.replace(/[—⸺⸻]/g, ",");
  return r;
}

const HARD_RULES: Rule[] = [
  { id: "reasoning_tag", label: "AI reasoning 残留标签", re: /<(?:think|thinking|scratchpad|reasoning|reflection|analysis|plan)\b/gi, severity: "hard" },
  {
    id: "em_dash", label: "em dash（—）", re: /—|⸺|⸻/g, severity: "hard",
    // 连同破折号前后各一个字符一起吃进来，normalizeDashes 才判得出中英文语境
    fix: { re: /\S?\s*[—⸺⸻]+\s*\S?/g, to: (m) => normalizeDashes(m) },
  },
  {
    id: "cn_dash", label: "中文破折号（——）", re: /——/g, severity: "hard",
    fix: { re: /\s*——\s*/g, to: () => "，" },
  },
  {
    id: "testament", label: "\"testament to\" 膨胀措辞", re: /\b(?:a|is a|stands? as a|serves? as a)\s+testament to\b/gi, severity: "hard",
    fix: {
      re: /\b(?:a|is a|stands? as a|serves? as a)\s+testament to\b/gi,
      to: (m) => (/^a\s/i.test(m) ? matchCase(m, "proof of") : matchCase(m, "shows")),
    },
  },
  {
    id: "paradigm", label: "\"paradigm\"", re: /\bparadigm(?:\s+shift)?s?\b/gi, severity: "hard",
    fix: {
      re: /\bparadigm(?:\s+shift)?s?\b/gi,
      to: (m) => {
        const plural = /s$/i.test(m);
        if (/shift/i.test(m)) return matchCase(m, plural ? "changes" : "change");
        return matchCase(m, plural ? "approaches" : "approach");
      },
    },
  },
  {
    id: "synergy", label: "\"synergy\"", re: /\bsynerg(?:y|ies|istic)\b/gi, severity: "hard",
    fix: {
      re: /\bsynerg(?:y|ies|istic)\b/gi,
      to: (m) => {
        if (/istic$/i.test(m)) return matchCase(m, "combined");
        // 复数要换成复数，否则 "Their synergies were" 会变成 "Their teamwork were"
        return matchCase(m, /ies$/i.test(m) ? "joint efforts" : "teamwork");
      },
    },
  },
  {
    id: "multifaceted", label: "\"multifaceted\"", re: /\bmultifaceted\b/gi, severity: "hard",
    fix: { re: /\bmultifaceted\b/gi, to: "varied" },
  },
  {
    id: "delve", label: "\"delve\"", re: /\bdelv(?:e|es|ed|ing)\b/gi, severity: "hard",
    fix: { re: /\bdelv(?:e|es|ed|ing)\b/gi, to: (m) => matchCase(m, inflect(m, "look", "looks", "looked", "looking")) },
  },
  {
    id: "evolving_landscape", label: "\"(ever-)evolving landscape\"", re: /\b(?:ever-evolving|evolving landscape|ever-changing landscape)\b/gi, severity: "hard",
    fix: {
      re: /\b(?:ever-evolving|evolving landscape|ever-changing landscape)\b/gi,
      to: (m) => matchCase(m, /landscape/i.test(m) ? "changing market" : "changing"),
    },
  },
  {
    id: "todays_world", label: "\"in today's world/era\" 开场套话", re: /\bin today'?s (?:fast-paced |digital |modern |busy )?(?:world|era|age|landscape|market)\b/gi, severity: "hard",
    fix: { re: /\bin today'?s (?:fast-paced |digital |modern |busy )?(?:world|era|age|landscape|market)\b/gi, to: "these days" },
  },
  {
    id: "worth_noting", label: "\"it is worth noting\" 类填充", re: /\bit(?:'s| is) (?:worth noting|important to note|worth mentioning)\b/gi, severity: "hard",
    fix: { re: /\bit(?:'s| is) (?:worth noting|important to note|worth mentioning)\b/gi, to: "note" },
  },
  {
    id: "conclusion_cliche", label: "\"in conclusion\" 类收尾套话", re: /\b(?:in conclusion|to sum up|all in all|in summary)\b/gi, severity: "hard",
    fix: { re: /\b(?:in conclusion|to sum up|all in all|in summary)\b/gi, to: "so" },
  },
  {
    id: "needless", label: "\"needless to say\"", re: /\bneedless to say\b/gi, severity: "hard",
    fix: { re: /\bneedless to say\b/gi, to: "clearly" },
  },
  {
    id: "game_changer", label: "\"game-changer\"", re: /\bgame[- ]chang(?:er|ing)\b/gi, severity: "hard",
    fix: { re: /\bgame[- ]chang(?:er|ing)\b/gi, to: (m) => matchCase(m, /ing$/i.test(m) ? "huge" : "big deal") },
  },
  {
    id: "cutting_edge", label: "\"cutting-edge\"", re: /\bcutting[- ]edge\b/gi, severity: "hard",
    fix: { re: /\bcutting[- ]edge\b/gi, to: "modern" },
  },
  {
    id: "revolutionize", label: "\"revolutionize\"", re: /\brevolutioniz\w*\b/gi, severity: "hard",
    fix: { re: /\brevolutioniz\w*\b/gi, to: (m) => matchCase(m, inflect(m, "change", "changes", "changed", "changing")) },
  },
  { id: "chatbot_artifact", label: "chatbot 客套话残留", re: /\b(?:I hope this helps|Let me know if|Would you like me to|As an AI\b|as a language model)/gi, severity: "hard" },
  { id: "knowledge_cutoff", label: "知识截止免责声明", re: /\bas of my (?:last|latest) (?:training|knowledge)|\bup to my last training\b/gi, severity: "hard" },
];

const SOFT_WORDS_RE = /\b(?:seamless(?:ly)?|vibrant|elevat(?:e|es|ed|ing)|empower(?:s|ed|ing)?|foster(?:s|ed|ing)?|harness(?:es|ed|ing)?|leverag(?:e|es|ed|ing)|robust|streamlin(?:e|es|ed|ing)|holistic|transformative|groundbreaking|innovative|comprehensive|showcas(?:e|es|ed|ing)|underscor(?:e|es|ed|ing)|boasts?|nestled|pivotal|beacon|tapestry|curated|moreover|furthermore|additionally|meticulous(?:ly)?|unparalleled|unmatched)\b/gi;

/**
 * AI 高频词 → 大白话替换表（键一律小写）。
 * 门禁的自动清洗与 humanizer 的 removeAiWords 共用这一张表：
 * 有替换词的换词（不留空档），没有的才按原逻辑删掉。
 */
export const AI_WORD_REPLACEMENTS: Record<string, string> = {
  // soft 规则覆盖的词
  seamless: "smooth", seamlessly: "smoothly",
  vibrant: "lively",
  elevate: "improve", elevates: "improves", elevated: "improved", elevating: "improving",
  empower: "help", empowers: "helps", empowered: "helped", empowering: "helping",
  foster: "build", fosters: "builds", fostered: "built", fostering: "building",
  harness: "use", harnesses: "uses", harnessed: "used", harnessing: "using",
  leverage: "use", leverages: "uses", leveraged: "used", leveraging: "using",
  robust: "solid",
  streamline: "simplify", streamlines: "simplifies", streamlined: "simplified", streamlining: "simplifying",
  holistic: "complete",
  transformative: "powerful",
  groundbreaking: "new",
  innovative: "new",
  comprehensive: "complete",
  showcase: "show", showcases: "shows", showcased: "showed", showcasing: "showing",
  underscore: "highlight", underscores: "highlights", underscored: "highlighted", underscoring: "highlighting",
  boast: "have", boasts: "has",
  nestled: "set",
  pivotal: "key",
  beacon: "symbol",
  tapestry: "mix",
  curated: "selected",
  moreover: "also", furthermore: "also", additionally: "also",
  meticulous: "careful", meticulously: "carefully",
  unparalleled: "top", unmatched: "great",
  // hard 规则覆盖的词（humanizer 的 AI_WORDS 里也有，换词避免删出空档）
  revolutionize: "change", revolutionizing: "changing",
  "game-changer": "big deal",
  "cutting-edge": "modern",
  delve: "look", "delve into": "look at",
  paradigm: "approach", "paradigm shift": "change",
  synergy: "teamwork",
  multifaceted: "varied",
  testament: "proof",
  "needless to say": "clearly",
  "in conclusion": "so", "to sum up": "so", "all in all": "so",
  // AI_WORDS 里删掉会把句子挖穿的名词/动词
  ecosystem: "system",
  realm: "area",
  embark: "start",
  navigate: "handle", navigating: "handling",
  landscape: "market",
};

const SOFT_RULES: Rule[] = [
  {
    id: "soft_words", label: "AI 高频词", re: SOFT_WORDS_RE, severity: "soft",
    fix: {
      re: SOFT_WORDS_RE,
      to: (m) => {
        const hit = AI_WORD_REPLACEMENTS[m.toLowerCase()];
        return hit ? matchCase(m, hit) : m;
      },
    },
  },
  { id: "negative_parallelism", label: "negative parallelism（it's not just…, it's…）", re: /\bit'?s not (?:just|merely|only)\b[^.;!?]{0,60}[,;][^.;!?]{0,10}it'?s\b|\bnot only\b[^.!?]{0,80}\bbut also\b/gi, severity: "soft" },
];

/** 换词救不回来的规则：命中这些只能重新生成文章 */
const NON_FIXABLE_IDS = new Set(
  [...HARD_RULES, ...SOFT_RULES].filter((r) => !r.fix).map((r) => r.id),
);

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s{2,}/g, " ");
}

function runRule(text: string, rule: Rule): GateViolation | null {
  const matches = [...text.matchAll(rule.re)];
  if (matches.length === 0) return null;
  return {
    id: rule.id,
    label: rule.label,
    severity: rule.severity,
    count: matches.length,
    samples: matches.slice(0, 3).map((m) => m[0].slice(0, 60)),
  };
}

/** 对文章 HTML 内容运行 Humanizer 门禁检测 */
export function runHumanizerGate(html: string): GateResult {
  const content = html || "";
  // reasoning 标签要在剥 HTML 前检测（它本身就是标签形态）
  const rawViolations: GateViolation[] = [];
  const reasoningRule = HARD_RULES[0];
  const reasoningHit = runRule(content, reasoningRule);
  if (reasoningHit) rawViolations.push(reasoningHit);

  const text = stripHtml(content);

  const hardViolations: GateViolation[] = [...rawViolations];
  for (const rule of HARD_RULES.slice(1)) {
    const hit = runRule(text, rule);
    if (hit) hardViolations.push(hit);
  }

  const softViolations: GateViolation[] = [];
  let softCount = 0;
  for (const rule of SOFT_RULES) {
    const hit = runRule(text, rule);
    if (hit) {
      softViolations.push(hit);
      softCount += hit.count;
    }
  }

  return {
    passed: hardViolations.length === 0 && softCount <= SOFT_TOTAL_THRESHOLD,
    hardViolations,
    softCount,
    softViolations,
  };
}

/** 只改标签之间的正文，绝不碰 <...> 里的属性（href/src/class 等不能被替换词污染） */
function mapTextNodes(html: string, fn: (text: string) => string): string {
  return html.replace(/(<[^>]*>)|([^<]+)/g, (_m, tag: string | undefined, text: string | undefined) =>
    tag !== undefined ? tag : fn(text as string),
  );
}

/**
 * 按门禁自身的规则自动清洗正文：拦什么就修什么，忽略大小写、认词形变体，
 * 一律换成大白话而不是删掉（删词会留下 "It d how I buy tickets" 这种残句）。
 *
 * soft 词只在累计超标时才替换 —— 单个 seamless / vibrant 可能是正常产品词
 * （seamless leggings），没超标就别动人家的正文。
 */
export function autoFixGateHits(html: string): string {
  const source = html || "";
  const fixSoft = runHumanizerGate(source).softCount > SOFT_TOTAL_THRESHOLD;

  return mapTextNodes(source, (text) => {
    let out = text;
    for (const rule of [...HARD_RULES, ...SOFT_RULES]) {
      if (!rule.fix) continue;
      if (rule.severity === "soft" && !fixSoft) continue;
      const { re, to } = rule.fix;
      out = out.replace(re, (m) => (typeof to === "string" ? matchCase(m, to) : to(m)));
    }
    return out.replace(/[ \t]{2,}/g, " ");
  });
}

/** 把违规结果拼成给用户看的一句话（发布 API 的错误信息） */
export function describeGateViolations(result: GateResult): string {
  const parts: string[] = [];
  for (const v of result.hardViolations) {
    // D-310：带上正文里的原话。只报规则名的话，正文写的是 "game changer" /
    // "Game-Changer"，用户照着提示搜 "game-changer" 根本搜不到。
    const samples = [...new Set(v.samples)].map((s) => `“${s}”`).join("、");
    parts.push(samples ? `${v.label}×${v.count}（正文：${samples}）` : `${v.label}×${v.count}`);
  }
  if (result.softCount > SOFT_TOTAL_THRESHOLD) {
    const detail = result.softViolations
      .flatMap((v) => v.samples)
      .slice(0, 5)
      .join(", ");
    parts.push(`AI 高频词超标（${result.softCount} 处，上限 ${SOFT_TOTAL_THRESHOLD}：${detail}…）`);
  }
  return parts.join("；");
}

export interface GateEnforcement {
  /** 是否放行 */
  ok: boolean;
  /** 放行时可直接发布的正文（可能已被自动清洗过） */
  content: string;
  /** 正文是否被自动清洗改动过（调用方需要回写 DB） */
  cleaned: boolean;
  /** 首检结果，日志用 */
  before: GateResult;
  /** ok=false 时给用户看的整句话 */
  reason?: string;
}

/**
 * 发布前的门禁总闸：检测 → 不过就自动清洗一次 → 复检 → 仍不过才拒发。
 * publish-to-site 与 Hermes 委托发文共用这一份，避免两条链路规则漂移。
 */
export function enforceHumanizerGate(content: string, minLength = 200): GateEnforcement {
  const original = content || "";
  const before = runHumanizerGate(original);
  if (before.passed) return { ok: true, content: original, cleaned: false, before };

  const fixed = autoFixGateHits(original);
  const after = runHumanizerGate(fixed);

  if (after.passed) {
    if (fixed.trim().length >= minLength) {
      return { ok: true, content: fixed, cleaned: fixed !== original, before };
    }
    return {
      ok: false, content: original, cleaned: false, before,
      reason: `Humanizer 自动清洗后正文只剩 ${fixed.trim().length} 字（下限 ${minLength}），禁止发布。请到文章管理里对这篇点「重新生成」`,
    };
  }

  // 仍有痕迹：区分「换词救不回来」和「换词也没救过来」，两种出路都只有重新生成
  const needsRegen = after.hardViolations.some((v) => NON_FIXABLE_IDS.has(v.id));
  const tail = needsRegen
    ? "。这类痕迹是整段生成坏了，换词救不回来，请到文章管理里对这篇点「重新生成」"
    : "。自动清洗也没能清干净，请到文章管理里对这篇点「重新生成」";
  return {
    ok: false, content: original, cleaned: false, before,
    reason: `Humanizer 检测未通过，禁止发布：${describeGateViolations(after)}${tail}`,
  };
}
