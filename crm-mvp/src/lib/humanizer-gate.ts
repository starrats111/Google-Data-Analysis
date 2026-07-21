/**
 * Humanizer 发布门禁（C-186）
 *
 * 规则来源：humanizer skill（softaworks/agent-toolkit，基于 Wikipedia "Signs of AI writing"）。
 * 所有文章在发布到站点之前必须通过本检测；未通过且自动清洗（humanize）后仍未通过的，禁止发布。
 *
 * 检测分两级：
 * - hard：几乎只有 AI 会写的指纹（em dash、reasoning 残留、chatbot 客套话、
 *   "stands as a testament" 类膨胀措辞、"in conclusion" 类收尾套话）。出现即不通过。
 * - soft：AI 高频词（seamless/vibrant/elevate…）。单个出现不算问题（真实写作也会用，
 *   如 seamless leggings 是正常产品词），累计超过阈值才不通过。
 *
 * 检测对象是剥掉 HTML 标签后的正文纯文本，避免 href/style 等属性误伤。
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

interface Rule {
  id: string;
  label: string;
  re: RegExp;
  severity: "hard" | "soft";
}

const HARD_RULES: Rule[] = [
  { id: "reasoning_tag", label: "AI reasoning 残留标签", re: /<(?:think|thinking|scratchpad|reasoning|reflection|analysis|plan)\b/gi, severity: "hard" },
  { id: "em_dash", label: "em dash（—）", re: /\u2014|\u2E3A|\u2E3B/g, severity: "hard" },
  { id: "cn_dash", label: "中文破折号（——）", re: /——/g, severity: "hard" },
  { id: "testament", label: "\"testament to\" 膨胀措辞", re: /\b(?:a|is a|stands? as a|serves? as a)\s+testament to\b/gi, severity: "hard" },
  { id: "paradigm", label: "\"paradigm\"", re: /\bparadigm(?:\s+shift)?s?\b/gi, severity: "hard" },
  { id: "synergy", label: "\"synergy\"", re: /\bsynerg(?:y|ies|istic)\b/gi, severity: "hard" },
  { id: "multifaceted", label: "\"multifaceted\"", re: /\bmultifaceted\b/gi, severity: "hard" },
  { id: "delve", label: "\"delve\"", re: /\bdelv(?:e|es|ed|ing)\b/gi, severity: "hard" },
  { id: "evolving_landscape", label: "\"(ever-)evolving landscape\"", re: /\b(?:ever-evolving|evolving landscape|ever-changing landscape)\b/gi, severity: "hard" },
  { id: "todays_world", label: "\"in today's world/era\" 开场套话", re: /\bin today'?s (?:fast-paced |digital |modern |busy )?(?:world|era|age|landscape|market)\b/gi, severity: "hard" },
  { id: "worth_noting", label: "\"it is worth noting\" 类填充", re: /\bit(?:'s| is) (?:worth noting|important to note|worth mentioning)\b/gi, severity: "hard" },
  { id: "conclusion_cliche", label: "\"in conclusion\" 类收尾套话", re: /\b(?:in conclusion|to sum up|all in all|in summary)\b/gi, severity: "hard" },
  { id: "needless", label: "\"needless to say\"", re: /\bneedless to say\b/gi, severity: "hard" },
  { id: "game_changer", label: "\"game-changer\"", re: /\bgame[- ]chang(?:er|ing)\b/gi, severity: "hard" },
  { id: "cutting_edge", label: "\"cutting-edge\"", re: /\bcutting[- ]edge\b/gi, severity: "hard" },
  { id: "revolutionize", label: "\"revolutionize\"", re: /\brevolutioniz\w*\b/gi, severity: "hard" },
  { id: "chatbot_artifact", label: "chatbot 客套话残留", re: /\b(?:I hope this helps|Let me know if|Would you like me to|As an AI\b|as a language model)/gi, severity: "hard" },
  { id: "knowledge_cutoff", label: "知识截止免责声明", re: /\bas of my (?:last|latest) (?:training|knowledge)|\bup to my last training\b/gi, severity: "hard" },
];

const SOFT_RULES: Rule[] = [
  { id: "soft_words", label: "AI 高频词", re: /\b(?:seamless(?:ly)?|vibrant|elevat(?:e|es|ed|ing)|empower(?:s|ed|ing)?|foster(?:s|ed|ing)?|harness(?:es|ed|ing)?|leverag(?:e|es|ed|ing)|robust|streamlin(?:e|es|ed|ing)|holistic|transformative|groundbreaking|innovative|comprehensive|showcas(?:e|es|ed|ing)|underscor(?:e|es|ed|ing)|boasts?|nestled|pivotal|beacon|tapestry|curated|moreover|furthermore|additionally|meticulous(?:ly)?|unparalleled|unmatched)\b/gi, severity: "soft" },
  { id: "negative_parallelism", label: "negative parallelism（it's not just…, it's…）", re: /\bit'?s not (?:just|merely|only)\b[^.;!?]{0,60}[,;][^.;!?]{0,10}it'?s\b|\bnot only\b[^.!?]{0,80}\bbut also\b/gi, severity: "soft" },
];

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

/** 把违规结果拼成给用户看的一句话（发布 API 的错误信息） */
export function describeGateViolations(result: GateResult): string {
  const parts: string[] = [];
  for (const v of result.hardViolations) {
    parts.push(`${v.label}×${v.count}`);
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
