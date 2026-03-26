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
    "第一步，你作为一名拥有三十年经验的谷歌广告投放专家，特别擅长关键词的筛选，对谷歌搜索广告各种指标及作用了如指掌。现在我作为一名新手想投放谷歌广告，根据semrush可以用的关键词，请帮我筛选，要给我一个＄1.5预算，CPC0.3的完美答案。",
    "第二步我的要求很重要，请你帮我根据刚刚选择的关键词生成15条吸引顾客的广告标题和4条广告描述，广告标题中折扣和物流信息各一条并优先展示,折扣力度优选最大的，第一条一定要和品牌相关联，次要折扣从第四条输出，广告描述中有且仅有一条包含折扣和物流信息，生成后核实字数是否符合标准，尽量避免过多的大写字符，标题和描述用英语输出并逐行翻译为中文,生成后核查字数是否合格，标题和描述要单独列行但仍要醒目,语言描述需要具有品牌特色，回答完全符合google ads的平台规范，不得欺骗、误导消费者，规避敏感词，请保证信息真实！",
    "第三步请根据站内链接生成小标题，并分别添加2条相应描述，都不得超过28字符，要求信息真实无误，不可以涉及欺骗消费者",
  ].join("\n"),
  persona: "一名拥有三十年经验的谷歌广告投放专家，擅长低预算搜索广告的关键词筛选与文案优化。",
  keyword_requirements: "以低预算账户为前提，结合日预算、最高 CPC、出价策略与商家相关性，从 SemRush 候选词中筛选最适合投放的关键词，并说明选择原因。",
  ad_copy_requirements: "输出 15 条标题和 4 条描述；标题第 1 条必须强关联品牌，第 2 条优先折扣，第 3 条优先物流，次要折扣从第 4 条开始；描述中有且仅有 1 条同时包含折扣和物流；整体必须符合 Google Ads 字数限制与政策要求。",
  sitelink_requirements: "基于真实站内链接生成站内链接标题与描述，标题与描述需简洁、准确、可点击，不得编造事实。",
  compliance_requirements: "生成前后都要做一次 Google Ads 政策与合规核查，不得输出欺骗、误导、敏感、夸张承诺或无法证实的内容。",
  hard_rules: "用户在 AI 设定中填写的规则均视为硬规则，关键词、文案、站内链接和提交前校验都必须遵守；如果无法满足，必须明确返回原因而不是默认忽略。",
  forbidden_terms: [],
  preferred_terms: [],
  enforce_policy_check: true,
};

const BASIC_POLICY_RISK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "保证结果/零风险承诺", pattern: /guaranteed?\s+results?|zero\s+risk|risk[\s-]?free|100%\s+safe|instant\s+approval/i },
  { label: "医疗治愈类承诺", pattern: /cure|miracle|heals?|治疗|治愈|神药/i },
  { label: "快速致富类承诺", pattern: /make\s+money\s+fast|get\s+rich\s+quick|快速赚钱|暴富/i },
  { label: "误导性前后对比承诺", pattern: /before\s+and\s+after|before\/after|前后对比/i },
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
