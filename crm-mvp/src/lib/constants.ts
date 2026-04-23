// 联盟平台代码及全称
// LH: linkhaitao.com | LB: linkbux.com | RW: rewardoo.com
// CG: collabglow.com | PM: partnermatic.com | BSH: brandsparkhub.com | CF: creatorflare.com
// MUI: ultrainfluence.com | AD: adsdoubler.com (C-029) | EV: engagevantage.com
export const PLATFORMS = [
  { code: "CG", name: "CollabGlow", domain: "collabglow.com" },
  { code: "PM", name: "Partnermatic", domain: "partnermatic.com" },
  { code: "LH", name: "LinkHaiTao", domain: "linkhaitao.com" },
  { code: "RW", name: "Rewardoo", domain: "rewardoo.com" },
  { code: "LB", name: "LinkBux", domain: "linkbux.com" },
  { code: "BSH", name: "BrandSparkHub", domain: "brandsparkhub.com" },
  { code: "CF", name: "CreatorFlare", domain: "creatorflare.com" },
  { code: "MUI", name: "UltraInfluence", domain: "ultrainfluence.com" },
  { code: "AD", name: "AdsDoubler", domain: "adsdoubler.com" },
  { code: "EV", name: "EngageVantage", domain: "engagevantage.com" },
] as const;

export type PlatformCode = (typeof PLATFORMS)[number]["code"];

/**
 * 平台名称映射表：各种变体名 → 标准大写代码
 * 覆盖：大写缩写、小写缩写、全名、域名、常见变体
 */
const _PLATFORM_ALIAS_ENTRIES: [string, PlatformCode][] = [
  // CG = CollabGlow (collabglow.com)
  ["CG", "CG"], ["cg", "CG"],
  ["CollabGlow", "CG"], ["collabglow", "CG"], ["Collab Glow", "CG"], ["collab glow", "CG"],
  ["collabglow.com", "CG"], ["app.collabglow.com", "CG"],

  // RW = Rewardoo (rewardoo.com)
  ["RW", "RW"], ["rw", "RW"], ["RW1", "RW"], ["rw1", "RW"],
  ["Rewardoo", "RW"], ["rewardoo", "RW"],
  ["rewardoo.com", "RW"], ["account.rewardoo.com", "RW"],

  // LH = LinkHaiTao (linkhaitao.com)
  ["LH", "LH"], ["lh", "LH"],
  ["LinkHaiTao", "LH"], ["linkhaitao", "LH"], ["LinkHaitao", "LH"],
  ["Link HaiTao", "LH"], ["link haitao", "LH"],
  ["linkhaitao.com", "LH"], ["www.linkhaitao.com", "LH"],

  // PM = Partnermatic (partnermatic.com)
  ["PM", "PM"], ["pm", "PM"],
  ["Partnermatic", "PM"], ["partnermatic", "PM"], ["PartnerMatic", "PM"],
  ["partnermatic.com", "PM"], ["app.partnermatic.com", "PM"],

  // LB = LinkBux (linkbux.com)
  ["LB", "LB"], ["lb", "LB"],
  ["LinkBux", "LB"], ["linkbux", "LB"], ["Linkbux", "LB"],
  ["linkbux.com", "LB"], ["www.linkbux.com", "LB"],

  // BSH = BrandSparkHub (brandsparkhub.com)
  ["BSH", "BSH"], ["bsh", "BSH"],
  ["BrandSparkHub", "BSH"], ["brandsparkhub", "BSH"], ["BrandSpark Hub", "BSH"],
  ["Brand Spark Hub", "BSH"], ["brand spark hub", "BSH"],
  ["brandsparkhub.com", "BSH"], ["www.brandsparkhub.com", "BSH"],

  // CF = CreatorFlare (creatorflare.com)
  ["CF", "CF"], ["cf", "CF"],
  ["CreatorFlare", "CF"], ["creatorflare", "CF"], ["Creator Flare", "CF"], ["creator flare", "CF"],
  ["creatorflare.com", "CF"], ["www.creatorflare.com", "CF"],

  // MUI = UltraInfluence (ultrainfluence.com)
  ["MUI", "MUI"], ["mui", "MUI"],
  ["UltraInfluence", "MUI"], ["ultrainfluence", "MUI"],
  ["Ultra Influence", "MUI"], ["ultra influence", "MUI"],
  ["ultrainfluence.com", "MUI"], ["app.ultrainfluence.com", "MUI"],
  ["api.ultrainfluence.com", "MUI"],

  // AD = AdsDoubler (adsdoubler.com) — C-029
  ["AD", "AD"], ["ad", "AD"],
  ["AdsDoubler", "AD"], ["adsdoubler", "AD"], ["Ads Doubler", "AD"], ["ads doubler", "AD"],
  ["adsdoubler.com", "AD"], ["api.adsdoubler.com", "AD"], ["r.adsdoubler.com", "AD"],

  // EV = EngageVantage (engagevantage.com)
  ["EV", "EV"], ["ev", "EV"],
  ["EngageVantage", "EV"], ["engagevantage", "EV"], ["Engage Vantage", "EV"], ["engage vantage", "EV"],
  ["engagevantage.com", "EV"], ["app.engagevantage.com", "EV"], ["api.engagevantage.com", "EV"],
];

export const PLATFORM_ALIASES: ReadonlyMap<string, PlatformCode> = new Map(_PLATFORM_ALIAS_ENTRIES);

const VALID_CODES = new Set<string>(PLATFORMS.map(p => p.code));

/**
 * 将任意平台名称/代码/域名规范化为标准大写代码（CG, RW, LH...）
 * 如果无法识别则原样返回
 */
export function normalizePlatformCode(raw: string): string {
  if (!raw) return raw;
  const trimmed = raw.trim();
  if (VALID_CODES.has(trimmed)) return trimmed;
  const upper = trimmed.toUpperCase();
  if (VALID_CODES.has(upper)) return upper;
  const alias = PLATFORM_ALIASES.get(trimmed) || PLATFORM_ALIASES.get(trimmed.toLowerCase());
  if (alias) return alias;
  // 账号名带数字后缀（如 CG2, PM3, BSH1）→ 去掉数字再匹配
  const stripped = upper.replace(/\d+$/, "");
  if (stripped && VALID_CODES.has(stripped)) return stripped;
  return trimmed;
}

// 商家状态
export const MERCHANT_STATUS = {
  AVAILABLE: "available",
  CLAIMED: "claimed",
} as const;

// 广告系列状态
export const CAMPAIGN_STATUS = {
  ACTIVE: "active",
  PAUSED: "paused",
  REMOVED: "removed",
} as const;

// 文章状态
export const ARTICLE_STATUS = {
  GENERATING: "generating",
  PREVIEW: "preview",
  PUBLISHED: "published",
  FAILED: "failed",
} as const;

// 出价策略
export const BIDDING_STRATEGIES = [
  { value: "MAXIMIZE_CLICKS", label: "尽可能多的点击" },
  { value: "MAXIMIZE_CONVERSIONS", label: "尽可能多的转化" },
  { value: "TARGET_CPA", label: "目标每次转化费用" },
  { value: "TARGET_ROAS", label: "目标广告支出回报率" },
] as const;

// AI 场景
export const AI_SCENES = [
  { value: "ad_copy", label: "广告文案生成" },
  { value: "article", label: "文章生成" },
  { value: "data_insight", label: "数据洞察分析" },
  { value: "translate", label: "一键翻译" },
] as const;

// 写作风格
export const WRITING_STYLES = [
  { value: "professional", label: "专业正式" },
  { value: "casual", label: "轻松活泼" },
  { value: "urgent", label: "紧迫促销" },
  { value: "storytelling", label: "故事叙述" },
] as const;

// 文章类型
export const ARTICLE_TYPES = [
  { value: "review", label: "产品评测" },
  { value: "guide", label: "使用指南" },
  { value: "comparison", label: "对比推荐" },
  { value: "news", label: "行业资讯" },
] as const;

// 文章长度
export const ARTICLE_LENGTHS = [
  { value: "short", label: "短文 (500词)" },
  { value: "medium", label: "中等 (1000词)" },
  { value: "long", label: "长文 (1500词)" },
] as const;

// 商家政策审核状态
export const POLICY_STATUS = {
  PENDING: "pending",
  CLEAN: "clean",
  RESTRICTED: "restricted",
  PROHIBITED: "prohibited",
} as const;

export const POLICY_STATUS_MAP: Record<string, { label: string; color: string }> = {
  pending: { label: "待审核", color: "default" },
  clean: { label: "无限制", color: "green" },
  restricted: { label: "限制", color: "orange" },
  prohibited: { label: "禁止", color: "red" },
};

// 政策限制等级
export const RESTRICTION_LEVELS = [
  { value: "restricted", label: "有限制（可投放）" },
  { value: "prohibited", label: "禁止投放" },
] as const;

// 重点标签
export const EMPHASIS_TAGS = [
  "价格优势", "品质保证", "限时优惠", "免费配送",
  "独家折扣", "新品首发", "热销爆款", "用户好评",
] as const;

// SEO 侧重
export const SEO_FOCUS_OPTIONS = [
  "长尾关键词", "问答式标题", "列表结构", "对比表格",
] as const;

// 部署方式
export const DEPLOY_TYPES = [
  { value: "bt_ssh", label: "宝塔 SSH" },
] as const;

// 节日类型
export const HOLIDAY_TYPES = [
  { value: "public", label: "公共假日" },
  { value: "commercial", label: "商业节日" },
  { value: "religious", label: "宗教节日" },
] as const;

// 通用 API 响应
export function apiSuccess<T>(data: T, message = "success") {
  return Response.json({ code: 0, message, data });
}

export function apiError(message: string, status = 400) {
  return Response.json({ code: -1, message, data: null }, { status });
}
