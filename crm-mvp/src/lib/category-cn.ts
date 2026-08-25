/**
 * 商家主营业务品类字典（英文键 → 中文名）。
 * D-278 起为全系统唯一品类真相源：选品页展示、节点推荐品类扩展、AI 品类打标（封闭品类表，
 * AI 只许从这里选值）都用它。新增品类改这里一处。
 * 原先内嵌在 user/merchants/page.tsx，D-278 抽出共享。
 */
export const CATEGORY_CN: Record<string, string> = {
  "Others": "其他", "Health & Beauty": "健康美容", "Home & Garden": "家居园艺",
  "Online Services & Software": "在线服务与软件", "Telecommunications": "电信",
  "B2B": "企业服务", "Marketing": "营销", "Fashion": "时尚服饰",
  "Electronics": "电子产品", "Travel": "旅游出行", "Finance": "金融理财",
  "Education": "教育培训", "Food & Drink": "食品饮料", "Sports & Fitness": "运动健身",
  "Automotive": "汽车", "Entertainment": "娱乐", "Pets": "宠物",
  "Baby & Kids": "母婴", "Books & Media": "图书媒体", "Gifts & Flowers": "礼品鲜花",
  "Insurance": "保险", "Legal": "法律", "Real Estate": "房地产",
  "Art & Photography": "艺术摄影", "Music": "音乐", "Gaming": "游戏",
  "Jewelry & Watches": "珠宝手表", "Office Supplies": "办公用品",
  "Toys & Hobbies": "玩具爱好", "Outdoors": "户外运动", "Computers": "电脑",
  "Web Hosting": "网站托管", "VPN & Security": "VPN与安全", "Dating": "交友",
  "Clothing": "服装", "Shoes": "鞋类", "Accessories": "配饰",
  "Furniture": "家具", "Appliances": "家电", "Tools": "工具",
  "Software": "软件", "SaaS": "SaaS", "Crypto": "加密货币",
  "CBD & Cannabis": "CBD", "Supplements": "保健品", "Skincare": "护肤",
  "Cosmetics": "化妆品", "Fragrance": "香水", "Hair Care": "护发",
  // D-221：Hermes 禁投品类闸查出来的品类。联盟平台对这些商家一律只给 `Others>Others`，
  // 是 Hermes 抓落地页/数词频/回灌 Google 拒登才定出来的，落到这一栏是为了让看表的人一眼知道碰不得。
  "Adult": "成人用品", "Gambling": "博彩", "Tobacco & Vape": "烟草电子烟",
  "Weapons": "武器刀具", "Counterfeit": "仿冒商品",
};

export const catCn = (v: string | null | undefined): string => {
  if (!v) return "-";
  return CATEGORY_CN[v] || v;
};

/** Hermes 禁投品类（AI 打标允许打出——打出来正是提醒别碰；扩展层不推荐这些品类） */
export const FORBIDDEN_CATEGORIES = ["Adult", "Gambling", "Tobacco & Vape", "Weapons", "Counterfeit", "CBD & Cannabis"];
