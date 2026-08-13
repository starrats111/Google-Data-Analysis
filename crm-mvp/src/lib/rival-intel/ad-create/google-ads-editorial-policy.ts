/**
 * Google Ads 编辑规范 · 标点与符号政策（Editorial / Punctuation and symbols）
 *
 * 依据：https://support.google.com/adspolicy/answer/14847994
 *       https://support.google.com/adspolicy/answer/6021546
 *       https://support.google.com/adspolicy/answer/14848297
 *
 * 非穷举，覆盖常见自动化拒审模式；商标/品牌名中的非常规符号需人工申诉，此处不做豁免。
 */

export type EditorialViolationRule =
  | "repeated_punctuation"
  | "prohibited_symbol"
  | "emoji"
  | "bullet_or_list_marker"
  | "decorative_asterisk"
  | "letter_substitution"
  | "gimmick_dotted_letters"
  | "spaced_out_letters"
  | "gimmick_arrow"
  | "html_markup"
  | "unsupported_character";

export interface EditorialViolation {
  rule: EditorialViolationRule;
  severity: "error" | "warning";
  /** 面向运营的中文说明 */
  message: string;
  /** 触发片段（便于定位草稿条目） */
  trigger?: string;
}

/** 发布链路需替换为空格的非标准符号（SYMBOLS 类） */
const PROHIBITED_SYMBOL_CHARS = /[|┃│｜•●○◦▪▫※■□★☆♦♠♣♥→←↔⇒⇐«»]/g;

/** 装饰性星号包裹，如 *flowers*（5* hotel 等合规用法不在此匹配） */
const DECORATIVE_ASTERISK_WRAP = /^\*[^*]+\*$|^\*+|\*+$/g;

const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;

const RULE_LABELS: Record<EditorialViolationRule, string> = {
  repeated_punctuation: "连续重复标点",
  prohibited_symbol: "非标准符号",
  emoji: "表情符号",
  bullet_or_list_marker: "项目符号或编号列表",
  decorative_asterisk: "装饰性星号",
  letter_substitution: "用符号替代字母",
  gimmick_dotted_letters: "字母间加点 gimmick",
  spaced_out_letters: "字母间空格 gimmick",
  gimmick_arrow: "非标准箭头",
  html_markup: "HTML 标记",
  unsupported_character: "无效控制字符",
};

/**
 * 按 Google Ads 编辑规范清洗 RSA 标题/描述（可自动修复部分）。
 */
export function sanitizeGoogleAdsRsaText(text: string): string {
  if (!text) return "";

  let out = text
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n+/g, " ");

  out = out.replace(/[！]/g, "!").replace(/[？]/g, "?");

  if (EMOJI_PATTERN.test(out)) {
    out = out.replace(EMOJI_PATTERN, " ");
  }

  out = out
    .replace(PROHIBITED_SYMBOL_CHARS, " ")
    .replace(/->|=>|<-|<>/g, " ")
    .replace(DECORATIVE_ASTERISK_WRAP, (m) => m.replace(/\*/g, "").trim());

  out = out
    .replace(/!{2,}/g, "!")
    .replace(/\?{2,}/g, "?")
    .replace(/\.{4,}/g, "...")
    .replace(/[,;]{2,}/g, ",")
    .replace(/\s+/g, " ")
    .trim();

  return out;
}

function pushViolation(
  violations: EditorialViolation[],
  rule: EditorialViolationRule,
  severity: "error" | "warning",
  trigger: string,
  detail?: string,
): void {
  const label = RULE_LABELS[rule];
  violations.push({
    rule,
    severity,
    message: detail ?? `${label}（${trigger}）`,
    trigger,
  });
}

/**
 * 审计单条 RSA 文案是否仍违反 Google 编辑/标点政策（应在 sanitize 之后调用）。
 */
export function auditGoogleAdsEditorialCopy(
  text: string,
  options?: { field?: "headline" | "description" },
): EditorialViolation[] {
  const violations: EditorialViolation[] = [];
  const trimmed = text.trim();
  if (!trimmed) return violations;

  const field = options?.field ?? "headline";

  if (EMOJI_PATTERN.test(trimmed)) {
    const m = trimmed.match(EMOJI_PATTERN);
    pushViolation(violations, "emoji", "error", m?.[0] ?? "emoji", "不得使用表情符号（Emoji）");
  }

  if (/[|┃│｜]/.test(trimmed)) {
    pushViolation(violations, "prohibited_symbol", "error", "|", "不得使用竖线等分隔符");
  }

  if (/[•●○◦▪▫※■□]/.test(trimmed) || /^\s*[-–—]\s+\S/.test(trimmed)) {
    pushViolation(
      violations,
      "bullet_or_list_marker",
      "error",
      "•",
      "不得使用项目符号或列表式排版（Google 不允许 RSA 使用 bullet/编号列表）",
    );
  }

  if (/^\s*\d+[\.\):]\s+\S/.test(trimmed)) {
    pushViolation(
      violations,
      "bullet_or_list_marker",
      "error",
      "1.",
      "不得以编号列表形式书写广告文案",
    );
  }

  if (/!{2,}/.test(trimmed) || /\?{2,}/.test(trimmed) || /[!?]{2,}/.test(trimmed)) {
    pushViolation(
      violations,
      "repeated_punctuation",
      "error",
      "!!",
      "不得连续重复感叹号或问号（如 !!、???）",
    );
  }

  if (/\.{4,}/.test(trimmed)) {
    pushViolation(violations, "repeated_punctuation", "error", "....", "不得滥用省略号/句点");
  }

  if (/->|=>|<-|<>/.test(trimmed)) {
    pushViolation(violations, "gimmick_arrow", "error", "->", "不得使用 ->、=> 等非标准箭头");
  }

  if (/^\*[^*]+\*$/.test(trimmed) || /(^|\s)\*[^*]+\*(\s|$)/.test(trimmed)) {
    pushViolation(
      violations,
      "decorative_asterisk",
      "error",
      "*",
      "不得以星号装饰文案（*word*）；星级评分等合规用法需人工申诉",
    );
  }

  if (/\w@\w/i.test(trimmed) || /\b\w*@\w+\b/.test(trimmed)) {
    pushViolation(
      violations,
      "letter_substitution",
      "error",
      "@",
      "不得用 @ 等符号替代字母（如 fl@wers）",
    );
  }

  if (/\b(?:[A-Za-z]\.){3,}[A-Za-z]\b/.test(trimmed)) {
    pushViolation(
      violations,
      "gimmick_dotted_letters",
      "error",
      "F.L.O.W.E.R.S",
      "不得使用字母间加点 gimmick（如 F.L.O.W.E.R.S.）",
    );
  }

  if (/\b(?:\w\s){4,}\w\b/.test(trimmed) && trimmed.length <= 40) {
    pushViolation(
      violations,
      "spaced_out_letters",
      "error",
      "C l e a r",
      "不得使用字母间空格 gimmick（如 C l e a r a n c e）",
    );
  }

  if (/[<>]/.test(trimmed)) {
    pushViolation(violations, "html_markup", "error", "<", "不得包含 HTML 标记");
  }

  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(trimmed)) {
    pushViolation(violations, "unsupported_character", "error", "\\x", "包含无效控制字符");
  }

  if (field === "headline" && /!/.test(trimmed)) {
    pushViolation(
      violations,
      "repeated_punctuation",
      "warning",
      "!",
      "标题中建议避免感叹号，以降低编辑规范拒审风险",
    );
  }

  return violations;
}

export function hasBlockingEditorialViolations(violations: EditorialViolation[]): boolean {
  return violations.some((v) => v.severity === "error");
}

/**
 * 清洗并审计；返回可用于 mutate 的文本与仍须人工处理的违规。
 */
export function prepareRsaTextForPublish(
  text: string,
  options?: { field?: "headline" | "description" },
): { text: string; violations: EditorialViolation[] } {
  const sanitized = sanitizeGoogleAdsRsaText(text);
  const violations = auditGoogleAdsEditorialCopy(sanitized, options);
  return { text: sanitized, violations };
}

/**
 * 批量审计草稿 RSA 资产，供 publish-guard 使用。
 */
export function auditRsaAssetsForPublish(input: {
  headlines: string[];
  descriptions: string[];
}): EditorialViolation[] {
  const all: EditorialViolation[] = [];
  for (const h of input.headlines) {
    const { violations } = prepareRsaTextForPublish(h, { field: "headline" });
    all.push(...violations.filter((v) => v.severity === "error"));
  }
  for (const d of input.descriptions) {
    const { violations } = prepareRsaTextForPublish(d, { field: "description" });
    all.push(...violations.filter((v) => v.severity === "error"));
  }
  return dedupeViolations(all);
}

function dedupeViolations(violations: EditorialViolation[]): EditorialViolation[] {
  const seen = new Set<string>();
  return violations.filter((v) => {
    const key = `${v.rule}:${v.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 发布阻断时的用户可见原因（中文）。
 */
export function formatEditorialViolationsForPublish(violations: EditorialViolation[]): string {
  const errors = dedupeViolations(violations).filter((v) => v.severity === "error");
  if (errors.length === 0) {
    return "广告文案不符合 Google Ads 编辑规范（标点与符号），无法发布。";
  }
  const lines = errors.slice(0, 5).map((v) => v.message);
  const more = errors.length > 5 ? `等共 ${errors.length} 项` : "";
  return (
    "广告文案不符合 Google Ads 编辑规范（标点与符号政策），无法发布：" +
    lines.join("；") +
    more +
    "。请修改草稿后重试。参考：support.google.com/adspolicy/answer/14847994"
  );
}

/** @deprecated 使用 auditRsaAssetsForPublish；保留兼容旧调用 */
export function containsGoogleAdsProhibitedSymbols(text: string): boolean {
  return auditGoogleAdsEditorialCopy(sanitizeGoogleAdsRsaText(text)).some(
    (v) => v.severity === "error",
  );
}
