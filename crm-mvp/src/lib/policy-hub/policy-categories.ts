/**
 * D-041 / Policy Hub — Google Ads 政策分类映射表
 *
 * 知识基线：基于 Google Ads 官方政策中心 4 大类 30+ 子项，
 *   原文：https://support.google.com/adspolicy/answer/6008942
 *
 * 映射逻辑：把 Google Ads API 返回的 PolicyViolationDetails.key.policyName
 *   （如 "trademark_in_ad_text"）+ externalPolicyName（如 "Trademarks"）
 *   映射到我们的 4 大类 30+ 子项 + 中文化展示 + 修复建议 + 政策原文 URL。
 *
 * 严禁硬编码无依据的违规规则；本文件每条 policyName 必须能在 Google 政策中心找到对应官方页面。
 */

export type PolicyCategoryId =
  | "prohibited" // 禁止内容
  | "prohibited_practices" // 禁止做法
  | "restricted" // 限制内容
  | "editorial_technical" // 编辑/技术
  | "unknown"; // 未识别

export interface PolicyCategoryEntry {
  /** Google Ads API policyViolationDetails.key.policyName（小写下划线，权威标识） */
  policyName: string;
  /** 4 大类 */
  category: PolicyCategoryId;
  /** 子项 slug，对应 policy-kb/<category>/<subcategory>.md 知识库路径（D-042 落地） */
  subcategory: string;
  /** 中文显示名 */
  labelZh: string;
  /** 严重度：critical=广告必拒；warning=受限投放；minor=编辑提示 */
  severity: "critical" | "warning" | "minor";
  /** 政策原文官方 URL（员工可点击查看） */
  officialUrl: string;
  /** 给员工的修复建议（人话） */
  suggestedFix: string;
}

/**
 * 4 大类 30+ 政策子项映射表
 *
 * key = 我们内部的 normalized policy id（基于 Google policyName 小写化）
 * 数据全部来自 Google Ads Policy Center 官方文档（拉取于 2026-05-28）
 */
export const POLICY_CATEGORY_MAP: Record<string, PolicyCategoryEntry> = {
  // ============================================================
  // 1. Prohibited Content（禁止内容）— 触发即拒登 + 严重违规可能账号封停
  // ============================================================
  counterfeit: {
    policyName: "counterfeit",
    category: "prohibited",
    subcategory: "counterfeit-goods",
    labelZh: "假冒商品",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6020019",
    suggestedFix: "广告或落地页含商标/Logo 与他人完全相同或难以区分的仿冒品。请改用合法授权产品或避免使用商标 Logo。",
  },
  dangerous_products: {
    policyName: "dangerous_products",
    category: "prohibited",
    subcategory: "dangerous-products",
    labelZh: "危险产品/服务",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6014299",
    suggestedFix: "涉及武器/弹药/烟草/毒品/爆炸物等危险品，Google Ads 完全禁止。请下架该商家或仅推广配件类合规产品。",
  },
  enabling_dishonest_behavior: {
    policyName: "enabling_dishonest_behavior",
    category: "prohibited",
    subcategory: "dishonest-behavior",
    labelZh: "助长不诚实行为",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6020954",
    suggestedFix: "黑客工具/伪造证件/作弊服务/欺诈相关，Google Ads 完全禁止。请下架。",
  },
  inappropriate_content: {
    policyName: "inappropriate_content",
    category: "prohibited",
    subcategory: "inappropriate-content",
    labelZh: "不当内容",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6015406",
    suggestedFix: "广告或落地页含仇恨/歧视/暴力/虐待/惊悚/儿童危害类内容。请删除相关字词（spooky/demon/blood/hacked/scary 等），改用中性描述。",
  },

  // ============================================================
  // 2. Prohibited Practices（禁止做法）— Misrepresentation 是最常见的拒登类
  // ============================================================
  abusing_ad_network: {
    policyName: "abusing_ad_network",
    category: "prohibited_practices",
    subcategory: "abusing-ad-network",
    labelZh: "滥用广告网络",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6020954",
    suggestedFix: "Cloaking/Arbitrage/Bridge page 等绕过审核的行为，禁止。请检查落地页是否对 Google Bot 与真人显示不同内容。",
  },
  data_collection_use: {
    policyName: "data_collection_use",
    category: "prohibited_practices",
    subcategory: "data-collection",
    labelZh: "数据收集与使用",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6020954",
    suggestedFix: "用户敏感数据（信用卡/身份证/医疗/性取向）需在 HTTPS 安全表单提交，且需明确隐私政策声明。",
  },
  // Misrepresentation 10 子子项（Google 政策中心 answer/6020955）
  unacceptable_business_practices: {
    policyName: "unacceptable_business_practices",
    category: "prohibited_practices",
    subcategory: "misrepresentation/unacceptable-business",
    labelZh: "不可接受的商业行为",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/12175504",
    suggestedFix: "禁止冒充其他品牌/政府/官方组织。请删除暗示官方关联的字词（Official/Authorized/Government）除非确实持有授权。",
  },
  coordinated_deceptive_practices: {
    policyName: "coordinated_deceptive_practices",
    category: "prohibited_practices",
    subcategory: "misrepresentation/coordinated-deceptive",
    labelZh: "协同欺骗行为",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/9991401",
    suggestedFix: "政治/社会/公共议题相关广告必须真实标注主体身份和来源国，禁止隐瞒/虚构。",
  },
  misleading_representation: {
    policyName: "misleading_representation",
    category: "prohibited_practices",
    subcategory: "misrepresentation/misleading-representation",
    labelZh: "误导性陈述",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6020955",
    suggestedFix: "广告主身份、关联关系、资质必须真实。禁止虚构企业名/经营资质。",
  },
  dishonest_pricing_practices: {
    policyName: "dishonest_pricing_practices",
    category: "prohibited_practices",
    subcategory: "misrepresentation/dishonest-pricing",
    labelZh: "欺诈性定价",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/13691158",
    suggestedFix: "必须明示完整费用（含税/运费/订阅费）。禁止隐藏费用或使用误导性低价吸引点击。",
  },
  clickbait_ads: {
    policyName: "clickbait_ads",
    category: "prohibited_practices",
    subcategory: "misrepresentation/clickbait",
    labelZh: "标题党广告",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/13657030",
    suggestedFix: "禁止使用耸动语言（Doctors hate this/Sick of/Tired of/Shocking）+ 禁止用死亡/疾病/破产等负面情绪施压。请改用中性 CTA。",
  },
  misleading_ad_design: {
    policyName: "misleading_ad_design",
    category: "prohibited_practices",
    subcategory: "misrepresentation/misleading-ad-design",
    labelZh: "误导性广告设计",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6020955",
    suggestedFix: "禁止使用伪按钮/伪输入框/伪系统通知欺骗用户点击。请保持广告与落地页设计一致。",
  },
  manipulated_media: {
    policyName: "manipulated_media",
    category: "prohibited_practices",
    subcategory: "misrepresentation/manipulated-media",
    labelZh: "篡改媒体",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/13754621",
    suggestedFix: "禁止 PS/Deepfake 篡改图片视频以欺诈/误导。请使用商家原始未修改素材。",
  },
  unreliable_claims: {
    policyName: "unreliable_claims",
    category: "prohibited_practices",
    subcategory: "misrepresentation/unreliable-claims",
    labelZh: "不可靠声明",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6020955",
    suggestedFix: "禁止无证据的绝对化宣称（100% effective / Never fail / Award-winning / Trusted by millions）。改用可验证事实（Loved by 2,700+ buyers）。",
  },
  unclear_relevance: {
    policyName: "unclear_relevance",
    category: "prohibited_practices",
    subcategory: "misrepresentation/unclear-relevance",
    labelZh: "广告与落地页不相关",
    severity: "warning",
    officialUrl: "https://support.google.com/adspolicy/answer/6020955",
    suggestedFix: "广告承诺的内容必须能在落地页找到。请检查 final URL 是否包含广告所述的产品/服务/优惠。",
  },
  unavailable_offers: {
    policyName: "unavailable_offers",
    category: "prohibited_practices",
    subcategory: "misrepresentation/unavailable-offers",
    labelZh: "提供不可用的优惠",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6020955",
    suggestedFix: "广告中提到的促销/折扣/产品必须在落地页存在。请勿编造 50% off / Free shipping 等落地页找不到的优惠。",
  },

  // ============================================================
  // 3. Restricted Content（限制内容）— 多数需要认证或品牌授权
  // ============================================================
  trademark_in_ad_text: {
    policyName: "trademark_in_ad_text",
    category: "restricted",
    subcategory: "trademarks",
    labelZh: "广告文本含商标",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6118",
    suggestedFix: "广告标题/描述/扩展含品牌方商标。Affiliate/Reseller/Informational site 在落地页主要销售/介绍该商标产品时**允许**使用，但需先在 https://services.google.com/inquiry/aw_trademark 提交 3rd-Party Authorization；或改用类目词（Power Tools / Gear / Apparel）替代品牌名。",
  },
  trademark_violation: {
    policyName: "trademark_violation",
    category: "restricted",
    subcategory: "trademarks",
    labelZh: "商标侵权",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6118",
    suggestedFix: "等同 trademark_in_ad_text。请改用类目词或申请商标授权。",
  },
  adult_content: {
    policyName: "adult_content",
    category: "restricted",
    subcategory: "sexual-content",
    labelZh: "成人内容",
    severity: "warning",
    officialUrl: "https://support.google.com/adspolicy/answer/6023699",
    suggestedFix: "成人内容仅限在 Google 允许的国家投放，且不得对未成年人投放。请检查 country 设置和受众限制。",
  },
  alcohol_content: {
    policyName: "alcohol_content",
    category: "restricted",
    subcategory: "alcohol",
    labelZh: "酒精相关内容",
    severity: "warning",
    officialUrl: "https://support.google.com/adspolicy/answer/6023540",
    suggestedFix: "酒精广告需国家白名单 + 不得对未成年人投放。请检查 country 是否在 Google 允许列表内。",
  },
  copyright: {
    policyName: "copyright",
    category: "restricted",
    subcategory: "copyrights",
    labelZh: "版权",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6020954",
    suggestedFix: "禁止未授权使用他人受版权保护的内容。请使用商家原创素材或已获许可的素材。",
  },
  gambling_content: {
    policyName: "gambling_content",
    category: "restricted",
    subcategory: "gambling",
    labelZh: "赌博内容",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6018017",
    suggestedFix: "赌博广告需 Google Ads 认证 + 国家白名单 + 落地页含负责任赌博信息。请先申请 Google 赌博认证。",
  },
  healthcare_content: {
    policyName: "healthcare_content",
    category: "restricted",
    subcategory: "healthcare",
    labelZh: "医疗保健受限内容",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/176031",
    suggestedFix: "处方药/HIV 检测/成瘾治疗等需 Google 认证。请先申请医疗认证或避免承诺医疗效果。",
  },
  political_content: {
    policyName: "political_content",
    category: "restricted",
    subcategory: "political",
    labelZh: "政治内容",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6014595",
    suggestedFix: "政治广告需符合当地选举法 + 投放方身份认证 + 静默期遵守。",
  },
  financial_products: {
    policyName: "financial_products",
    category: "restricted",
    subcategory: "financial-products",
    labelZh: "金融产品/服务",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/2464998",
    suggestedFix: "贷款/信贷修复/外汇等需明示 APR/利率/费用。请在 description 中加入完整费用披露。",
  },
  cryptocurrency_content: {
    policyName: "cryptocurrency_content",
    category: "restricted",
    subcategory: "cryptocurrencies",
    labelZh: "加密货币",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/9214827",
    suggestedFix: "加密货币交易所/钱包等需 Google 加密货币认证。请先在 Google Ads 申请认证。",
  },
  legal_requirements: {
    policyName: "legal_requirements",
    category: "restricted",
    subcategory: "legal-requirements",
    labelZh: "当地法律要求",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6021546",
    suggestedFix: "请检查广告是否符合目标国家所有当地法律法规（GDPR/CCPA/广告法等）。",
  },

  // ============================================================
  // 4. Editorial & Technical（编辑与技术）— 最常见的 RSA 拒登类
  // ============================================================
  editorial: {
    policyName: "editorial",
    category: "editorial_technical",
    subcategory: "editorial",
    labelZh: "编辑规范",
    severity: "warning",
    officialUrl: "https://support.google.com/adspolicy/answer/6021546",
    suggestedFix: "广告文案不规范。请检查：①过度大写（FREE / f-r-e-e）；②非标准标点（!! / ?? / ★）；③模糊宣传（Buy products here）；④拼写错误。",
  },
  editorial_capitalization: {
    policyName: "editorial_capitalization",
    category: "editorial_technical",
    subcategory: "editorial/capitalization",
    labelZh: "大写过多",
    severity: "warning",
    officialUrl: "https://support.google.com/adspolicy/answer/6021546",
    suggestedFix: "headlines 单词全大写比例需 ≤30%，缩写白名单（USA/USD/VPN/MXN/EUR 等）除外。请改为 Title Case。",
  },
  editorial_non_standard_punctuation: {
    policyName: "editorial_non_standard_punctuation",
    category: "editorial_technical",
    subcategory: "editorial/punctuation",
    labelZh: "非标准标点",
    severity: "warning",
    officialUrl: "https://support.google.com/adspolicy/answer/6021546",
    suggestedFix: "禁止 !!/?? 重复标点 + 禁止 ★ ® ™ %off 等特殊符号。请清理标点。",
  },
  editorial_gimmicky_repetition: {
    policyName: "editorial_gimmicky_repetition",
    category: "editorial_technical",
    subcategory: "editorial/gimmicky-repetition",
    labelZh: "噱头重复",
    severity: "warning",
    officialUrl: "https://support.google.com/adspolicy/answer/6021546",
    suggestedFix: "禁止 f-r-e-e / w-i-n / c-l-i-c-k 之类拼接噱头字符。请使用正常拼写。",
  },
  destination_not_working: {
    policyName: "destination_not_working",
    category: "editorial_technical",
    subcategory: "destination/not-working",
    labelZh: "目标网址无效",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6022621",
    suggestedFix: "final URL 返回 4xx/5xx 错误或域名解析失败。请检查商家 URL 是否在线 + Cloudflare 设置是否阻止 Google Bot。",
  },
  destination_not_crawlable: {
    policyName: "destination_not_crawlable",
    category: "editorial_technical",
    subcategory: "destination/not-crawlable",
    labelZh: "目标页面无法抓取",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6022621",
    suggestedFix: "Google AdsBot 被阻止。请检查 robots.txt 是否允许 AdsBot-Google + 落地页 Cloudflare 是否禁用 Bot Fight Mode 或加白名单。",
  },
  destination_mismatch: {
    policyName: "destination_mismatch",
    category: "editorial_technical",
    subcategory: "destination/url-mismatch",
    labelZh: "Display URL 与 Final URL 不一致",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6022621",
    suggestedFix: "display URL 的 second-level domain 必须等于 final URL 的 second-level domain。请保持域名一致。",
  },
  unverified_phone_number: {
    policyName: "unverified_phone_number",
    category: "editorial_technical",
    subcategory: "destination/unverified-phone",
    labelZh: "未验证的电话号码",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6098343",
    suggestedFix: "Call extension 中的电话号码需先在 Google Ads 完成验证。请用商家可接听的电话且在后台完成验证。",
  },
  ad_format_requirements: {
    policyName: "ad_format_requirements",
    category: "editorial_technical",
    subcategory: "ad-format",
    labelZh: "广告格式不符合要求",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6021546",
    suggestedFix: "headline/description 字符超限或图片/视频规格不符。请检查长度和尺寸限制。",
  },
  unfair_advantage: {
    policyName: "unfair_advantage",
    category: "prohibited_practices",
    subcategory: "misrepresentation/unfair-advantage",
    labelZh: "不公平优势宣称",
    severity: "critical",
    officialUrl: "https://support.google.com/adspolicy/answer/6020955",
    suggestedFix: "禁止 Trusted by Millions / Award-Winning / Best in Class / Guaranteed / #1 / Stops All 等无证据绝对化宣称。请改用具体可验证的事实。",
  },
  free_desktop_software: {
    policyName: "free_desktop_software",
    category: "restricted",
    subcategory: "free-desktop-software",
    labelZh: "免费桌面软件",
    severity: "warning",
    officialUrl: "https://support.google.com/adspolicy/answer/2616017",
    suggestedFix: "免费下载类软件（杀毒/VPN/工具）受限。需明确标注 publisher、不得绑安装、不得伪装系统通知。",
  },
};

/**
 * 主 API：把 Google Ads API 返回的 policyName / errorCode / 提示词 映射到 4 大类条目
 *
 * 优先级：
 *   1. policyViolationDetails.key.policyName（最权威）
 *   2. errorCode 字符串模糊匹配（兜底）
 *   3. message 关键词匹配（最弱兜底）
 *   4. unknown 占位（仍记录原始 errorCode + raw message 供后续人工分类）
 */
export function mapToPolicyCategory(input: {
  policyName?: string | null;
  externalPolicyName?: string | null;
  errorCode?: string | null;
  message?: string | null;
}): PolicyCategoryEntry {
  const policyName = (input.policyName || "").trim().toLowerCase();
  if (policyName && POLICY_CATEGORY_MAP[policyName]) {
    return POLICY_CATEGORY_MAP[policyName];
  }

  // externalPolicyName 模糊匹配（如 "Trademarks" / "Misrepresentation"）
  const ext = (input.externalPolicyName || "").trim().toLowerCase();
  if (ext) {
    if (ext.includes("trademark")) return POLICY_CATEGORY_MAP.trademark_in_ad_text;
    if (ext.includes("misrepresentation")) return POLICY_CATEGORY_MAP.misleading_representation;
    if (ext.includes("dangerous")) return POLICY_CATEGORY_MAP.dangerous_products;
    if (ext.includes("counterfeit")) return POLICY_CATEGORY_MAP.counterfeit;
    if (ext.includes("inappropriate")) return POLICY_CATEGORY_MAP.inappropriate_content;
    if (ext.includes("alcohol")) return POLICY_CATEGORY_MAP.alcohol_content;
    if (ext.includes("gambling")) return POLICY_CATEGORY_MAP.gambling_content;
    if (ext.includes("healthcare") || ext.includes("medical")) return POLICY_CATEGORY_MAP.healthcare_content;
    if (ext.includes("political")) return POLICY_CATEGORY_MAP.political_content;
    if (ext.includes("financial")) return POLICY_CATEGORY_MAP.financial_products;
    if (ext.includes("crypto")) return POLICY_CATEGORY_MAP.cryptocurrency_content;
    if (ext.includes("copyright")) return POLICY_CATEGORY_MAP.copyright;
    if (ext.includes("editorial")) return POLICY_CATEGORY_MAP.editorial;
    if (ext.includes("destination") || ext.includes("landing")) return POLICY_CATEGORY_MAP.destination_not_working;
    if (ext.includes("phone")) return POLICY_CATEGORY_MAP.unverified_phone_number;
    if (ext.includes("clickbait")) return POLICY_CATEGORY_MAP.clickbait_ads;
    if (ext.includes("unfair")) return POLICY_CATEGORY_MAP.unfair_advantage;
  }

  // errorCode 兜底
  const ec = (input.errorCode || "").toLowerCase();
  if (ec.includes("trademark")) return POLICY_CATEGORY_MAP.trademark_in_ad_text;
  if (ec.includes("policy_error") || ec.includes("policyviolationerror")) return POLICY_CATEGORY_MAP.editorial;
  if (ec.includes("prohibited")) return POLICY_CATEGORY_MAP.inappropriate_content;
  if (ec.includes("alcohol")) return POLICY_CATEGORY_MAP.alcohol_content;
  if (ec.includes("gambling")) return POLICY_CATEGORY_MAP.gambling_content;
  if (ec.includes("healthcare")) return POLICY_CATEGORY_MAP.healthcare_content;

  // message 关键词
  const msg = (input.message || "").toLowerCase();
  if (msg.includes("trademark")) return POLICY_CATEGORY_MAP.trademark_in_ad_text;
  if (msg.includes("disapproved") || msg.includes("policy")) return POLICY_CATEGORY_MAP.editorial;

  // 兜底：unknown 类别（仍保留原始信息供后续人工分类）
  return {
    policyName: policyName || ec || "unknown",
    category: "unknown",
    subcategory: "unknown",
    labelZh: "未识别政策",
    severity: "warning",
    officialUrl: "https://support.google.com/adspolicy/answer/6008942",
    suggestedFix: `Google Ads 返回了未在我方知识库映射的政策类型（policyName=${policyName || "n/a"}, errorCode=${input.errorCode || "n/a"}）。请把原始错误转给运营/开发团队分类，并补充到 policy-categories.ts。`,
  };
}

/** 4 大类显示名映射 */
export const POLICY_CATEGORY_LABELS: Record<PolicyCategoryId, string> = {
  prohibited: "禁止内容",
  prohibited_practices: "禁止做法",
  restricted: "限制内容",
  editorial_technical: "编辑/技术",
  unknown: "未识别",
};
