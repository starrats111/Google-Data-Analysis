export type AiPromptSection = "general" | "keywords" | "ad_copy" | "sitelinks" | "compliance";

export interface AiRuleProfile {
  version: 1;
  prompt_text: string;
  persona: string;
  keyword_requirements: string;
  ad_copy_requirements: string;
  sitelink_requirements: string;
  compliance_requirements: string;
  hard_rules: string;
  forbidden_terms: string[];
  preferred_terms: string[];
  enforce_policy_check: boolean;
}

export const DEFAULT_AI_RULE_PROFILE: AiRuleProfile = {
  version: 1,
  prompt_text: [
    "【角色定位】你是「数据猎手（Search Ads）」，一位专注 ROI 导向的 Google Ads 搜索广告顾问。核心能力：关键词精准筛选、广告文案优化、账户诊断与投放策略制定。",
    "【关键词筛选】基于 SemRush 数据，结合日预算（$1.5~$2.0）、最高 CPC（$0.3）和出价策略，优先筛选：搜索意图明确、竞争度适中、与商家主营业务高度相关的词。排除：竞争过高导致 CPC 超预算、与商家业务无关、或存在政策风险的词。",
    "【广告文案生成】输出 15 条标题（每条 ≤ 30 字符）和 4 条描述（每条 50-90 字符）：标题第 1 条必须强关联品牌；若有折扣则第 2 条优先折扣，第 3 条优先物流；描述中有且仅有 1 条同时包含折扣和物流；所有内容必须符合 Google Ads 政策，不得夸大或误导。语言与目标市场一致，禁止伪造折扣数字或物流信息。",
    "【站内链接】基于商家真实页面生成站内链接小标题（≤ 25 字符）和描述（≤ 35 字符），内容真实可点击，不得编造。",
    "【合规自检】每次生成前后执行 Google Ads 政策核查，不得输出：绝对化承诺（guaranteed/零风险）、医疗治愈类、快速致富类、前后对比类等违规表达。",
  ].join("\n"),
  persona: "数据猎手（Search Ads）— Google Ads 搜索广告顾问，定位：ROI 导向 | 精准投放 | 账户优化。擅长低预算账户的关键词筛选、文案优化与广告系列诊断，帮助广告主以最小花费获取最大转化。",
  keyword_requirements: "以低预算账户为前提，结合日预算、最高 CPC、出价策略与商家相关性，从 SemRush 候选词中优先筛选：搜索量适中、竞争度低-中、Match Type 以 Broad Match Modifier 或 Phrase Match 为主的词；排除 CPC 超出预算上限的词和政策风险词。",
  ad_copy_requirements: "输出 15 条标题和 4 条描述；标题第 1 条必须强关联品牌；若有折扣则优先展示折扣标题；物流免费信息（如确认）单独一条；描述中有且仅有 1 条同时涵盖折扣+物流；所有内容符合 Google Ads RSA 字数限制与平台政策，不得捏造折扣数字或物流承诺。",
  sitelink_requirements: "基于商家真实站内页面生成站内链接标题（≤ 25 字符）与描述（≤ 35 字符），内容简洁、准确、可点击，不得编造页面或虚假优惠。",
  compliance_requirements: "生成前后执行 Google Ads 政策自检：不得输出绝对化承诺（guaranteed/零风险/100% safe）、医疗治愈类（cure/miracle/heal）、快速致富类、误导性前后对比（before and after）等违规表达；如发现政策风险，必须明确标注并提供替代方案。",
  hard_rules: "所有 AI 设定中的规则均为硬规则，关键词、标题、描述、站内链接及提交前校验均须严格遵守；无法满足时必须明确说明原因，不得默默忽略。优先遵守用户自定义规则，其次遵守 Google Ads 平台政策。",
  forbidden_terms: [],
  preferred_terms: [],
  enforce_policy_check: true,
};

const BASIC_POLICY_RISK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "保证结果/零风险承诺", pattern: /\bguaranteed?\s+results?\b|\bzero\s+risk\b|\brisk[\s-]?free\b|\b100%\s+safe\b|\binstant\s+approval\b/i },
  { label: "医疗治愈类承诺", pattern: /\bcures?\b|\bmiracle\b|\bheals?\b|治疗|治愈|神药/i },
  { label: "快速致富类承诺", pattern: /\bmake\s+money\s+fast\b|\bget\s+rich\s+quick\b|快速赚钱|暴富/i },
  { label: "误导性前后对比承诺", pattern: /\bbefore\s+and\s+after\b|\bbefore\/after\b|前后对比/i },
];

function normalizeText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)));
  }
  if (typeof value === "string") {
    return Array.from(new Set(
      value
        .split(/[\n,，;；]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ));
  }
  return [];
}

export function normalizeAiRuleProfile(value: unknown): AiRuleProfile {
  const raw = (value && typeof value === "object") ? (value as Record<string, unknown>) : {};
  return {
    version: 1,
    prompt_text: normalizeText(raw.prompt_text, DEFAULT_AI_RULE_PROFILE.prompt_text),
    persona: normalizeText(raw.persona, DEFAULT_AI_RULE_PROFILE.persona),
    keyword_requirements: normalizeText(raw.keyword_requirements, DEFAULT_AI_RULE_PROFILE.keyword_requirements),
    ad_copy_requirements: normalizeText(raw.ad_copy_requirements, DEFAULT_AI_RULE_PROFILE.ad_copy_requirements),
    sitelink_requirements: normalizeText(raw.sitelink_requirements, DEFAULT_AI_RULE_PROFILE.sitelink_requirements),
    compliance_requirements: normalizeText(raw.compliance_requirements, DEFAULT_AI_RULE_PROFILE.compliance_requirements),
    hard_rules: normalizeText(raw.hard_rules, DEFAULT_AI_RULE_PROFILE.hard_rules),
    forbidden_terms: normalizeStringArray(raw.forbidden_terms),
    preferred_terms: normalizeStringArray(raw.preferred_terms),
    enforce_policy_check: typeof raw.enforce_policy_check === "boolean"
      ? raw.enforce_policy_check
      : DEFAULT_AI_RULE_PROFILE.enforce_policy_check,
  };
}

export function buildAiRulePrompt(profile: unknown, section: AiPromptSection = "general"): string {
  const normalized = normalizeAiRuleProfile(profile);
  const sections: string[] = [];

  if (normalized.prompt_text) {
    sections.push(`原始用户提示词（必须优先遵守）:\n${normalized.prompt_text}`);
  }
  if (normalized.persona) {
    sections.push(`AI 人设:\n${normalized.persona}`);
  }

  if (section === "general" || section === "keywords") {
    sections.push(`关键词规则:\n${normalized.keyword_requirements}`);
  }
  if (section === "general" || section === "ad_copy") {
    sections.push(`广告文案规则:\n${normalized.ad_copy_requirements}`);
  }
  if (section === "general" || section === "sitelinks") {
    sections.push(`站内链接规则:\n${normalized.sitelink_requirements}`);
  }
  if (section === "general" || section === "compliance") {
    sections.push(`合规检查规则:\n${normalized.compliance_requirements}`);
  }

  if (normalized.hard_rules) {
    sections.push(`硬规则:\n${normalized.hard_rules}`);
  }
  if (normalized.preferred_terms.length > 0) {
    sections.push(`优先考虑的词/表达:\n- ${normalized.preferred_terms.join("\n- ")}`);
  }
  if (normalized.forbidden_terms.length > 0) {
    sections.push(`禁止出现的词/表达:\n- ${normalized.forbidden_terms.join("\n- ")}`);
  }
  if (normalized.enforce_policy_check) {
    sections.push("必须执行一次 Google Ads 政策与合规自检；若不满足，请直接指出不满足原因。");
  }

  return sections.filter(Boolean).join("\n\n");
}

export function buildAiRuleSummary(profile: unknown) {
  const normalized = normalizeAiRuleProfile(profile);
  return {
    persona: normalized.persona || "未设置",
    keyword_requirements: normalized.keyword_requirements || "未设置",
    ad_copy_requirements: normalized.ad_copy_requirements || "未设置",
    sitelink_requirements: normalized.sitelink_requirements || "未设置",
    compliance_requirements: normalized.compliance_requirements || "未设置",
    hard_rules: normalized.hard_rules || "未设置",
    has_prompt_text: Boolean(normalized.prompt_text),
    forbidden_count: normalized.forbidden_terms.length,
    preferred_count: normalized.preferred_terms.length,
    enforce_policy_check: normalized.enforce_policy_check,
  };
}

function includesForbiddenTerm(text: string, forbiddenTerms: string[]): string | null {
  const lower = text.toLowerCase();
  for (const term of forbiddenTerms) {
    if (lower.includes(term.toLowerCase())) {
      return term;
    }
  }
  return null;
}

export function checkItemViolations(
  items: string[],
  profile: unknown,
): Array<{ index: number; text: string; reasons: string[] }> {
  const normalized = normalizeAiRuleProfile(profile);
  const results: Array<{ index: number; text: string; reasons: string[] }> = [];

  for (let i = 0; i < items.length; i++) {
    const text = items[i];
    if (!text) continue;
    const reasons: string[] = [];

    const matched = includesForbiddenTerm(text, normalized.forbidden_terms);
    if (matched) {
      reasons.push(`命中禁止词「${matched}」`);
    }

    if (normalized.enforce_policy_check) {
      for (const rule of BASIC_POLICY_RISK_PATTERNS) {
        if (rule.pattern.test(text)) {
          reasons.push(rule.label);
          break;
        }
      }
    }

    if (reasons.length > 0) {
      results.push({ index: i, text, reasons });
    }
  }

  return results;
}

export function collectAiRuleViolations(payload: {
  profile: unknown;
  keywords?: Array<string | { text?: string | null }>;
  headlines?: string[];
  descriptions?: string[];
  callouts?: string[];
  sitelinks?: Array<{
    title?: string | null;
    description1?: string | null;
    description2?: string | null;
    finalUrl?: string | null;
    desc1?: string | null;
    desc2?: string | null;
    url?: string | null;
  }>;
}): string[] {
  const profile = normalizeAiRuleProfile(payload.profile);
  const violations: string[] = [];
  const forbiddenTerms = profile.forbidden_terms;

  const keywordTexts = (payload.keywords || []).map((item) => typeof item === "string" ? item : String(item?.text || "")).filter(Boolean);
  for (const keyword of keywordTexts) {
    const matched = includesForbiddenTerm(keyword, forbiddenTerms);
    if (matched) {
      violations.push(`关键词「${keyword}」命中了禁止词「${matched}」`);
    }
  }

  const textGroups: Array<{ label: string; items: string[] }> = [
    { label: "标题", items: payload.headlines || [] },
    { label: "描述", items: payload.descriptions || [] },
    { label: "宣传信息", items: payload.callouts || [] },
  ];

  for (const group of textGroups) {
    for (const item of group.items) {
      const matched = includesForbiddenTerm(item, forbiddenTerms);
      if (matched) {
        violations.push(`${group.label}「${item}」命中了禁止词「${matched}」`);
      }
    }
  }

  for (const sitelink of payload.sitelinks || []) {
    const sitelinkParts = [
      sitelink.title,
      sitelink.description1,
      sitelink.description2,
      sitelink.desc1,
      sitelink.desc2,
    ].map((item) => String(item || "").trim()).filter(Boolean);
    for (const part of sitelinkParts) {
      const matched = includesForbiddenTerm(part, forbiddenTerms);
      if (matched) {
        violations.push(`站内链接内容「${part}」命中了禁止词「${matched}」`);
      }
    }
  }

  if (profile.enforce_policy_check) {
    const policyTexts = [
      ...keywordTexts,
      ...(payload.headlines || []),
      ...(payload.descriptions || []),
      ...(payload.callouts || []),
      ...((payload.sitelinks || []).flatMap((item) => [item.title, item.description1, item.description2, item.desc1, item.desc2].map((v) => String(v || "").trim()).filter(Boolean))),
    ];

    for (const text of policyTexts) {
      for (const rule of BASIC_POLICY_RISK_PATTERNS) {
        if (rule.pattern.test(text)) {
          violations.push(`内容「${text}」疑似触发 Google Ads 风险表达：${rule.label}`);
          break;
        }
      }
    }
  }

  return Array.from(new Set(violations));
}
