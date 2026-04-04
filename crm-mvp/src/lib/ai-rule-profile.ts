/**
 * AI 人设系统 — Adrian · 数据猎手
 * 支持多人设库，员工可自建，系统内置 Adrian 不可删除
 */

// ─── 类型定义 ───────────────────────────────────────────────

export type AiPromptSection = "general" | "keywords" | "ad_copy" | "sitelinks" | "compliance";

export interface AiPersona {
  id: string;
  name: string;
  tags: string[];
  description: string;
  is_system: boolean;
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

/** ai_rule_profile JSON 顶层结构 */
export interface AiRuleProfile {
  version: 2;
  active_persona_id: string;
  personas: AiPersona[];
  /** 用户全局偏好，不区分人设 */
  forbidden_terms: string[];
  preferred_terms: string[];
  enforce_policy_check: boolean;
}

// ─── 系统内置 Adrian 人设 ────────────────────────────────────

export const SYSTEM_ADRIAN_PERSONA: AiPersona = {
  id: "system_adrian",
  name: "Adrian · 数据猎手",
  tags: ["ROI激进派", "数字驱动运营", "账户诊断专家", "杠杆工程"],
  description: "Google Ads 搜索广告顾问，专注 ROI 导向精准投放。擅长低预算账户关键词严选、文案7角度构建与账户系统化诊断。",
  is_system: true,

  prompt_text: [
    "【角色定位】你是「Adrian · 数据猎手」，一位专注 ROI 导向的 Google Ads 搜索广告顾问。",
    "【职业信条】",
    '  · "没有坏的产品，只有投错的人群和出不动的价。"',
    '  · "优化一个竞争系统前7天不许动它，因为不熟它，你在搞懂系统。"',
    '  · "出价策略（Bidding Strategy）是引流，素材是饲料，消费路径才是最值钱的。"',
    "【核心能力】关键词精准筛选（SemRush意图层分析）、广告文案7角度构建、账户诊断与4阶段投放策略制定。",
    "【行动原则】",
    "  · 关键词严选：从候选词中只取1-5个，按 HIGH_INTENT / FEATURE_SCENE / BRAND / LONG_TAIL 分层",
    "  · 单主题广告组：每组1-5个同意图词 + 专属文案，避免主题混杂",
    "  · 系统化否定词：首批必须排除 cheap / free / wholesale / diy / reddit / review-only / how-to",
    "  · 数据驱动决策：无数据时不轻下结论，优先建立追踪体系再优化",
  ].join("\n"),

  persona: "Adrian · 数据猎手 — Google Ads 搜索广告顾问。定位：ROI 激进派 | 数字驱动运营 | 账户诊断专家。擅长用最小预算撬动最大转化，不相信「运气」，只相信数据和系统。",

  keyword_requirements: [
    "【意图层分级】从 SemRush 候选词中严格筛选1-5个，按意图层分组：",
    "  · HIGH_INTENT（最优先）：含 buy/shop/order/purchase/case/stand/magsafe 等购买意图词，建议精确匹配，出价最高",
    "  · FEATURE_SCENE（次优先）：含 kickstand/clear/wireless/protect/slim 等功能场景词，短语匹配",
    "  · BRAND（适量）：品牌词或竞品词，精确匹配，单独广告组",
    "  · LONG_TAIL（慎选）：4个token以上的具体长尾词，考虑 DKI",
    "【筛选规则】CPC 须在日预算可承受范围内（日预算 $1.5-$2.0，CPC ≤ $0.3）；",
    "排除政策风险词；排除与商家主营业务相关性低于70%的词；score < 20 的词直接淘汰",
  ].join("\n"),

  ad_copy_requirements: [
    "【标题7角度（15条必须覆盖）】",
    "  · Angle 1 痛点钩子：让用户感到被理解，触发共鸣",
    "  · Angle 2 具体利益：具体的结果/数字，不说空话",
    "  · Angle 3 信任信号：Top-rated / Best Seller / Trusted by X 等",
    "  · Angle 4 产品聚焦：直接对应搜索意图，高度相关",
    "  · Angle 5 差异化：品牌独特点，区别竞品",
    "  · Angle 6 CTA：清晰的下一步行动",
    "  · Angle 7 品牌：含商家名称，强化记忆",
    "  · 高意图词 ≥2条、功能场景词 ≥2条、品牌 ≥1条",
    "  · 第1条标题必须含品牌名或明确品牌指向",
    "【描述4角度（4条各对应一个角度）】",
    "  · Angle A：痛点→解决方案，引发代入感",
    "  · Angle B：核心利益 + 明确 CTA",
    "  · Angle C：信任背书 + 社会证明",
    "  · Angle D：独特优势，区别竞品",
    "  · AVOID HEADLINE MIRRORING：描述不得复述标题前3个词",
    "【字数规则】标题 ≤30字符；描述50-90字符；不捏造折扣/物流承诺",
  ].join("\n"),

  sitelink_requirements: "基于商家真实站内页面生成站内链接标题（≤25字符）与描述（≤35字符），内容简洁、准确、可点击，不得编造页面或虚假优惠。",

  compliance_requirements: "生成前后执行 Google Ads 政策自检：不得输出绝对化承诺（guaranteed/零风险/100% safe）、医疗治愈类（cure/miracle/heal）、快速致富类、误导性前后对比等违规表达；如发现政策风险，必须明确标注并提供替代方案。",

  hard_rules: [
    "【4阶段投放指标框架】",
    "  · 冷启动期（Day1-7）：不动策略，只看 Impression Share + CTR；系统在学习，不要打扰",
    "  · 过滤期（Day8-14）：加否定词，暂停 CTR<1.5% 的标题；开始排除低质流量",
    "  · 优化期（Day15-30）：切换 tROAS≥300% 策略，A/B测描述；精细化调优",
    "  · 扩量期（Day31+）：PMax 补量 + DSA + 视频再营销；系统成熟后扩展",
    "【硬规则】所有关键词、标题、描述、站内链接及提交前校验均须严格遵守；",
    "无法满足时必须明确说明原因，不得默默忽略。优先遵守 Google Ads 平台政策。",
  ].join("\n"),

  forbidden_terms: [],
  preferred_terms: [],
  enforce_policy_check: true,
};

/** 默认 AI 规则配置（新用户创建时使用） */
export const DEFAULT_AI_RULE_PROFILE: AiRuleProfile = {
  version: 2,
  active_persona_id: "system_adrian",
  personas: [SYSTEM_ADRIAN_PERSONA],
  forbidden_terms: [],
  preferred_terms: [],
  enforce_policy_check: true,
};

// ─── 工具函数 ─────────────────────────────────────────────────

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.map((item) => String(item || "").trim()).filter(Boolean)));
  }
  if (typeof value === "string") {
    return Array.from(new Set(
      value.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean),
    ));
  }
  return [];
}

function normalizePersona(raw: unknown): AiPersona | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return null;
  return {
    id: r.id,
    name: typeof r.name === "string" ? r.name : "",
    tags: normalizeStringArray(r.tags),
    description: typeof r.description === "string" ? r.description : "",
    is_system: r.id === "system_adrian",
    prompt_text: typeof r.prompt_text === "string" ? r.prompt_text : "",
    persona: typeof r.persona === "string" ? r.persona : "",
    keyword_requirements: typeof r.keyword_requirements === "string" ? r.keyword_requirements : "",
    ad_copy_requirements: typeof r.ad_copy_requirements === "string" ? r.ad_copy_requirements : "",
    sitelink_requirements: typeof r.sitelink_requirements === "string" ? r.sitelink_requirements : SYSTEM_ADRIAN_PERSONA.sitelink_requirements,
    compliance_requirements: typeof r.compliance_requirements === "string" ? r.compliance_requirements : SYSTEM_ADRIAN_PERSONA.compliance_requirements,
    hard_rules: typeof r.hard_rules === "string" ? r.hard_rules : "",
    forbidden_terms: normalizeStringArray(r.forbidden_terms),
    preferred_terms: normalizeStringArray(r.preferred_terms),
    enforce_policy_check: typeof r.enforce_policy_check === "boolean" ? r.enforce_policy_check : true,
  };
}

/**
 * 解析 ai_rule_profile JSON，返回规范化的 AiRuleProfile。
 * 始终确保 system_adrian 在 personas 列表中。
 */
export function normalizeAiRuleProfile(value: unknown): AiRuleProfile {
  const raw = (value && typeof value === "object") ? (value as Record<string, unknown>) : {};

  // 解析 personas 数组
  const rawPersonas = Array.isArray(raw.personas) ? raw.personas : [];
  const parsedPersonas: AiPersona[] = rawPersonas.map(normalizePersona).filter(Boolean) as AiPersona[];

  // 确保 system_adrian 始终存在（强制注入最新版本）
  const withoutAdrian = parsedPersonas.filter((p) => p.id !== "system_adrian");
  const personas: AiPersona[] = [SYSTEM_ADRIAN_PERSONA, ...withoutAdrian];

  const activeId = typeof raw.active_persona_id === "string" && raw.active_persona_id
    ? raw.active_persona_id
    : "system_adrian";

  return {
    version: 2,
    active_persona_id: activeId,
    personas,
    forbidden_terms: normalizeStringArray(raw.forbidden_terms),
    preferred_terms: normalizeStringArray(raw.preferred_terms),
    enforce_policy_check: typeof raw.enforce_policy_check === "boolean"
      ? raw.enforce_policy_check
      : true,
  };
}

/** 获取当前激活的人设，找不到时回退 Adrian */
export function getActivePersona(profile: AiRuleProfile): AiPersona {
  const found = profile.personas.find((p) => p.id === profile.active_persona_id);
  return found ?? SYSTEM_ADRIAN_PERSONA;
}

/** 返回完整人设列表（系统 + 自建） */
export function buildPersonaLibrary(profile: AiRuleProfile): AiPersona[] {
  return profile.personas;
}

/** 添加或更新人设（系统人设不可覆盖） */
export function upsertPersona(profile: AiRuleProfile, persona: AiPersona): AiRuleProfile {
  if (persona.id === "system_adrian") return profile; // 系统人设不可覆盖
  const existing = profile.personas.findIndex((p) => p.id === persona.id);
  const personas = [...profile.personas];
  if (existing >= 0) {
    personas[existing] = { ...persona, is_system: false };
  } else {
    personas.push({ ...persona, is_system: false });
  }
  return { ...profile, personas };
}

/** 删除自建人设（系统人设不可删） */
export function deletePersona(profile: AiRuleProfile, personaId: string): AiRuleProfile {
  if (personaId === "system_adrian") return profile;
  const personas = profile.personas.filter((p) => p.id !== personaId);
  const activeId = profile.active_persona_id === personaId ? "system_adrian" : profile.active_persona_id;
  return { ...profile, personas, active_persona_id: activeId };
}

// ─── Prompt 构建 ──────────────────────────────────────────────

const BASIC_POLICY_RISK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "保证结果/零风险承诺", pattern: /\bguaranteed?\s+results?\b|\bzero\s+risk\b|\brisk[\s-]?free\b|\b100%\s+safe\b|\binstant\s+approval\b/i },
  { label: "医疗治愈类承诺", pattern: /\bcures?\b|\bmiracle\b|\bheals?\b|治疗|治愈|神药/i },
  { label: "快速致富类承诺", pattern: /\bmake\s+money\s+fast\b|\bget\s+rich\s+quick\b|快速赚钱|暴富/i },
  { label: "误导性前后对比承诺", pattern: /\bbefore\s+and\s+after\b|\bbefore\/after\b|前后对比/i },
];

export function buildAiRulePrompt(profileRaw: unknown, section: AiPromptSection = "general"): string {
  const profile = normalizeAiRuleProfile(profileRaw);
  const persona = getActivePersona(profile);
  const sections: string[] = [];

  if (persona.prompt_text) {
    sections.push(`AI人设与职业信条（必须优先遵守）:\n${persona.prompt_text}`);
  }
  if (persona.persona) {
    sections.push(`AI 角色定位:\n${persona.persona}`);
  }
  if (section === "general" || section === "keywords") {
    sections.push(`关键词规则:\n${persona.keyword_requirements}`);
  }
  if (section === "general" || section === "ad_copy") {
    sections.push(`广告文案规则:\n${persona.ad_copy_requirements}`);
  }
  if (section === "general" || section === "sitelinks") {
    sections.push(`站内链接规则:\n${persona.sitelink_requirements}`);
  }
  if (section === "general" || section === "compliance") {
    sections.push(`合规检查规则:\n${persona.compliance_requirements}`);
  }
  if (persona.hard_rules) {
    sections.push(`投放框架与硬规则:\n${persona.hard_rules}`);
  }

  // 全局优先/禁止词（叠加在人设词之上）
  const allPreferred = [...new Set([...persona.preferred_terms, ...profile.preferred_terms])];
  const allForbidden = [...new Set([...persona.forbidden_terms, ...profile.forbidden_terms])];

  if (allPreferred.length > 0) {
    sections.push(`优先考虑的词/表达:\n- ${allPreferred.join("\n- ")}`);
  }
  if (allForbidden.length > 0) {
    sections.push(`禁止出现的词/表达:\n- ${allForbidden.join("\n- ")}`);
  }
  if (persona.enforce_policy_check || profile.enforce_policy_check) {
    sections.push("必须执行一次 Google Ads 政策与合规自检；若不满足，请直接指出不满足原因。");
  }

  return sections.filter(Boolean).join("\n\n");
}

export function buildAiRuleSummary(profileRaw: unknown) {
  const profile = normalizeAiRuleProfile(profileRaw);
  const persona = getActivePersona(profile);
  return {
    active_persona_id: profile.active_persona_id,
    persona_name: persona.name,
    persona_tags: persona.tags,
    persona_description: persona.description,
    is_system: persona.is_system,
    keyword_requirements: persona.keyword_requirements || "未设置",
    ad_copy_requirements: persona.ad_copy_requirements || "未设置",
    sitelink_requirements: persona.sitelink_requirements || "未设置",
    compliance_requirements: persona.compliance_requirements || "未设置",
    hard_rules: persona.hard_rules || "未设置",
    has_prompt_text: Boolean(persona.prompt_text),
    forbidden_count: profile.forbidden_terms.length + persona.forbidden_terms.length,
    preferred_count: profile.preferred_terms.length + persona.preferred_terms.length,
    enforce_policy_check: persona.enforce_policy_check || profile.enforce_policy_check,
    total_personas: profile.personas.length,
  };
}

// ─── 违规检查 ──────────────────────────────────────────────────

function includesForbiddenTerm(text: string, forbiddenTerms: string[]): string | null {
  const lower = text.toLowerCase();
  for (const term of forbiddenTerms) {
    if (lower.includes(term.toLowerCase())) return term;
  }
  return null;
}

export function checkItemViolations(
  items: string[],
  profileRaw: unknown,
): Array<{ index: number; text: string; reasons: string[] }> {
  const profile = normalizeAiRuleProfile(profileRaw);
  const persona = getActivePersona(profile);
  const allForbidden = [...new Set([...persona.forbidden_terms, ...profile.forbidden_terms])];
  const results: Array<{ index: number; text: string; reasons: string[] }> = [];

  for (let i = 0; i < items.length; i++) {
    const text = items[i];
    if (!text) continue;
    const reasons: string[] = [];

    const matched = includesForbiddenTerm(text, allForbidden);
    if (matched) reasons.push(`命中禁止词「${matched}」`);

    if (persona.enforce_policy_check || profile.enforce_policy_check) {
      for (const rule of BASIC_POLICY_RISK_PATTERNS) {
        if (rule.pattern.test(text)) { reasons.push(rule.label); break; }
      }
    }
    if (reasons.length > 0) results.push({ index: i, text, reasons });
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
  const persona = getActivePersona(profile);
  const allForbidden = [...new Set([...persona.forbidden_terms, ...profile.forbidden_terms])];
  const violations: string[] = [];

  const keywordTexts = (payload.keywords || [])
    .map((item) => typeof item === "string" ? item : String(item?.text || ""))
    .filter(Boolean);

  for (const keyword of keywordTexts) {
    const matched = includesForbiddenTerm(keyword, allForbidden);
    if (matched) violations.push(`关键词「${keyword}」命中了禁止词「${matched}」`);
  }

  const textGroups: Array<{ label: string; items: string[] }> = [
    { label: "标题", items: payload.headlines || [] },
    { label: "描述", items: payload.descriptions || [] },
    { label: "宣传信息", items: payload.callouts || [] },
  ];

  for (const group of textGroups) {
    for (const item of group.items) {
      const matched = includesForbiddenTerm(item, allForbidden);
      if (matched) violations.push(`${group.label}「${item}」命中了禁止词「${matched}」`);
    }
  }

  for (const sitelink of payload.sitelinks || []) {
    const parts = [sitelink.title, sitelink.description1, sitelink.description2, sitelink.desc1, sitelink.desc2]
      .map((v) => String(v || "").trim()).filter(Boolean);
    for (const part of parts) {
      const matched = includesForbiddenTerm(part, allForbidden);
      if (matched) violations.push(`站内链接内容「${part}」命中了禁止词「${matched}」`);
    }
  }

  if (persona.enforce_policy_check || profile.enforce_policy_check) {
    const policyTexts = [
      ...keywordTexts,
      ...(payload.headlines || []),
      ...(payload.descriptions || []),
      ...(payload.callouts || []),
      ...((payload.sitelinks || []).flatMap((item) =>
        [item.title, item.description1, item.description2, item.desc1, item.desc2]
          .map((v) => String(v || "").trim()).filter(Boolean)
      )),
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
