/**
 * D-046.A IntelliCenter 商家智能画像 — 类型定义
 *
 * 详见设计方案"五、AI IntelliCenter MVP 详细方案 §五.2.2"。
 * 32 行业大类基于 Google Ads 推荐分类 + 平台实际业务覆盖。
 */

// ---------- 32 行业大类枚举 ----------
export const INDUSTRY_CATEGORIES = [
  "Animals_Pet",
  "Apparel_Accessories",
  "Arts_Entertainment",
  "Automotive",
  "Baby_Toddler",
  "Beauty_Personal_Care",
  "Books_Media",
  "Business_Industrial",
  "Cameras_Optics",
  "Computers_Electronics",
  "Crafts_Hobbies",
  "Dating_Services",
  "Electronics_Appliances",
  "Finance_Insurance",
  "Food_Beverage",
  "Furniture_Home",
  "Gambling",
  "Government",
  "Hardware_Tools",
  "Healthcare_Pharmacy",
  "Home_Garden",
  "Jewelry_Watches",
  "Legal_Services",
  "Mature_Adult",
  "Office_Supplies",
  "Religious_Ceremonial",
  "Software_Apps",
  "Sporting_Goods",
  "Toys_Games",
  "Travel_Hospitality",
  "Vehicles_Parts",
  "Other",
] as const;

export type IndustryCategory = (typeof INDUSTRY_CATEGORIES)[number];

export const INDUSTRY_LABELS_CN: Record<IndustryCategory, string> = {
  Animals_Pet: "宠物用品",
  Apparel_Accessories: "服装配饰",
  Arts_Entertainment: "艺术娱乐",
  Automotive: "汽车",
  Baby_Toddler: "母婴幼儿",
  Beauty_Personal_Care: "美妆个护",
  Books_Media: "书籍媒体",
  Business_Industrial: "商业工业",
  Cameras_Optics: "相机光学",
  Computers_Electronics: "电脑电子",
  Crafts_Hobbies: "手工爱好",
  Dating_Services: "婚恋交友",
  Electronics_Appliances: "家电",
  Finance_Insurance: "金融保险",
  Food_Beverage: "食品饮料",
  Furniture_Home: "家具家居",
  Gambling: "博彩",
  Government: "政府机构",
  Hardware_Tools: "五金工具",
  Healthcare_Pharmacy: "医药健康",
  Home_Garden: "家居园艺",
  Jewelry_Watches: "珠宝手表",
  Legal_Services: "法律服务",
  Mature_Adult: "成人内容",
  Office_Supplies: "办公用品",
  Religious_Ceremonial: "宗教礼仪",
  Software_Apps: "软件 / App",
  Sporting_Goods: "运动用品",
  Toys_Games: "玩具游戏",
  Travel_Hospitality: "旅游酒店",
  Vehicles_Parts: "车辆配件",
  Other: "其他",
};

// ---------- 商标授权状态 ----------
export const TRADEMARK_AUTH_STATUSES = [
  "unauthorized",
  "pending",
  "authorized",
  "own_brand",
] as const;

export type TrademarkAuthStatus = (typeof TRADEMARK_AUTH_STATUSES)[number];

export const TRADEMARK_AUTH_LABELS_CN: Record<TrademarkAuthStatus, string> = {
  unauthorized: "未授权",
  pending: "申请中",
  authorized: "已授权",
  own_brand: "自有品牌",
};

// ---------- 合规风险等级 ----------
export const COMPLIANCE_RISK_LEVELS = [
  "low",
  "medium",
  "high",
  "blocked",
] as const;

export type ComplianceRiskLevel = (typeof COMPLIANCE_RISK_LEVELS)[number];

export const COMPLIANCE_RISK_LABELS_CN: Record<ComplianceRiskLevel, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  blocked: "拦截",
};

// ---------- 画像来源 ----------
export const PROFILE_SOURCES = [
  "none",
  "ai_backfill",
  "manual",
  "feedback",
  "ai_failed",
] as const;

export type ProfileSource = (typeof PROFILE_SOURCES)[number];

export const PROFILE_SOURCE_LABELS_CN: Record<ProfileSource, string> = {
  none: "未生成",
  ai_backfill: "AI 自动",
  manual: "人工录入",
  feedback: "反馈环",
  ai_failed: "AI 失败",
};

// ---------- 画像子结构 ----------
export interface BusinessProfile {
  main_products?: string[];
  price_range?: string;
  discount_mode?: string;
  shipping?: string;
  payment?: string;
  notes?: string;
}

export interface AudiencePersona {
  age?: string;
  gender?: string;
  regions?: string[];
  interests?: string[];
  purchasing_power?: string;
  notes?: string;
}

export interface BrandAssets {
  slogan?: string;
  usp?: string[];
  certifications?: string[];
  awards?: string[];
  endorsements?: string[];
  reputation_score?: number;
  notes?: string;
}

export interface RequiresCertification {
  healthcare?: boolean;
  financial?: boolean;
  crypto?: boolean;
  alcohol?: boolean;
  pharmacy?: boolean;
  political?: boolean;
  gambling?: boolean;
  legal?: boolean;
  [key: string]: boolean | undefined;
}

export interface SeasonalPattern {
  peak_months?: number[]; // [11, 12]
  holiday_events?: string[]; // ["BlackFriday", "Christmas"]
  promo_calendar?: { month: number; event: string }[];
  notes?: string;
}

export interface CompetitorBrand {
  name: string;
  domain?: string;
}

// ---------- 主画像类型 ----------
export interface MerchantIntelligenceProfile {
  industry_category: IndustryCategory | null;
  industry_subcategory: string | null;
  business_profile: BusinessProfile | null;
  audience_persona: AudiencePersona | null;
  brand_assets: BrandAssets | null;
  trademark_authorization_status: TrademarkAuthStatus;
  compliance_risk_level: ComplianceRiskLevel;
  requires_certification: RequiresCertification | null;
  successful_template_ids: number[] | null;
  failed_template_ids: number[] | null;
  seasonal_pattern: SeasonalPattern | null;
  competitor_brands: CompetitorBrand[] | null;
  profile_updated_at: Date | null;
  profile_source: ProfileSource;
}

// ---------- 可编辑表单类型（admin/user UI 用） ----------
export interface MerchantProfileFormPayload {
  industry_category?: IndustryCategory | null;
  industry_subcategory?: string | null;
  business_profile?: BusinessProfile | null;
  audience_persona?: AudiencePersona | null;
  brand_assets?: BrandAssets | null;
  trademark_authorization_status?: TrademarkAuthStatus;
  compliance_risk_level?: ComplianceRiskLevel;
  requires_certification?: RequiresCertification | null;
  seasonal_pattern?: SeasonalPattern | null;
  competitor_brands?: CompetitorBrand[] | null;
}

// ---------- 校验工具 ----------
export function isIndustryCategory(value: unknown): value is IndustryCategory {
  return (
    typeof value === "string" &&
    (INDUSTRY_CATEGORIES as readonly string[]).includes(value)
  );
}

export function isTrademarkAuthStatus(
  value: unknown,
): value is TrademarkAuthStatus {
  return (
    typeof value === "string" &&
    (TRADEMARK_AUTH_STATUSES as readonly string[]).includes(value)
  );
}

export function isComplianceRiskLevel(
  value: unknown,
): value is ComplianceRiskLevel {
  return (
    typeof value === "string" &&
    (COMPLIANCE_RISK_LEVELS as readonly string[]).includes(value)
  );
}

export function isProfileSource(value: unknown): value is ProfileSource {
  return (
    typeof value === "string" &&
    (PROFILE_SOURCES as readonly string[]).includes(value)
  );
}

// ---------- 默认空画像 ----------
export const DEFAULT_PROFILE: MerchantIntelligenceProfile = {
  industry_category: null,
  industry_subcategory: null,
  business_profile: null,
  audience_persona: null,
  brand_assets: null,
  trademark_authorization_status: "unauthorized",
  compliance_risk_level: "low",
  requires_certification: null,
  successful_template_ids: null,
  failed_template_ids: null,
  seasonal_pattern: null,
  competitor_brands: null,
  profile_updated_at: null,
  profile_source: "none",
};
