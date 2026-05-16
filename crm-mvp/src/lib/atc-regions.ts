/**
 * D-008 F-1：ATC 区域 / 国家清单（单一信源）
 *
 * 前后端共用：
 *   - 后端 atc-service.ts 通过 REGION_CODE_MAP 将 ISO code 转 SerpApi 数字码
 *   - 前端 3 个入口（intelligence / merchants / advertisers）通过 GET /api/user/atc/regions 异步拉取
 *
 * 维护点：扩展新国家只改本文件，前端零改动（接口返回新列表，前端自动同步）
 *
 * 26 国选择依据：覆盖 SerpApi google_ads_transparency_center 引擎主流目标市场
 * + 团队历史 watchlist 国家分布（实测 96.6% US / 其余分散在 G7 + 北欧 + 主要亚太）
 */

/** 单个区域定义：ISO 2 字母 + SerpApi 数字码 + 中文名 + 国旗 emoji */
export interface AtcRegion {
  /** ISO 3166-1 alpha-2 大写 */
  code: string;
  /** SerpApi google_ads_transparency_center 引擎要求的数字码 */
  serpApiCode: string;
  /** 中文名 */
  zhName: string;
  /** 国旗 emoji（Unicode RIS 双字符） */
  flag: string;
  /** 排序优先级（数字越小越靠前），默认 100；07 团队主投市场 < 50 */
  priority?: number;
}

/** 26 国清单（按 SerpApi 文档 + 团队实际投放优先级排序） */
export const ATC_REGIONS: AtcRegion[] = [
  { code: "US", serpApiCode: "2840", zhName: "美国",     flag: "🇺🇸", priority: 1 },
  { code: "GB", serpApiCode: "2826", zhName: "英国",     flag: "🇬🇧", priority: 2 },
  { code: "AU", serpApiCode: "2036", zhName: "澳大利亚", flag: "🇦🇺", priority: 3 },
  { code: "CA", serpApiCode: "2124", zhName: "加拿大",   flag: "🇨🇦", priority: 4 },
  { code: "DE", serpApiCode: "2276", zhName: "德国",     flag: "🇩🇪", priority: 10 },
  { code: "FR", serpApiCode: "2250", zhName: "法国",     flag: "🇫🇷", priority: 11 },
  { code: "IT", serpApiCode: "2380", zhName: "意大利",   flag: "🇮🇹", priority: 12 },
  { code: "ES", serpApiCode: "2724", zhName: "西班牙",   flag: "🇪🇸", priority: 13 },
  { code: "NL", serpApiCode: "2528", zhName: "荷兰",     flag: "🇳🇱", priority: 14 },
  { code: "SE", serpApiCode: "2752", zhName: "瑞典",     flag: "🇸🇪", priority: 15 },
  { code: "NO", serpApiCode: "2578", zhName: "挪威",     flag: "🇳🇴", priority: 16 },
  { code: "DK", serpApiCode: "2208", zhName: "丹麦",     flag: "🇩🇰", priority: 17 },
  { code: "FI", serpApiCode: "2246", zhName: "芬兰",     flag: "🇫🇮", priority: 18 },
  { code: "PL", serpApiCode: "2616", zhName: "波兰",     flag: "🇵🇱", priority: 19 },
  { code: "AT", serpApiCode: "2040", zhName: "奥地利",   flag: "🇦🇹", priority: 20 },
  { code: "CH", serpApiCode: "2756", zhName: "瑞士",     flag: "🇨🇭", priority: 21 },
  { code: "BE", serpApiCode: "2056", zhName: "比利时",   flag: "🇧🇪", priority: 22 },
  { code: "IE", serpApiCode: "2372", zhName: "爱尔兰",   flag: "🇮🇪", priority: 23 },
  { code: "PT", serpApiCode: "2620", zhName: "葡萄牙",   flag: "🇵🇹", priority: 24 },
  { code: "JP", serpApiCode: "2392", zhName: "日本",     flag: "🇯🇵", priority: 30 },
  { code: "SG", serpApiCode: "2702", zhName: "新加坡",   flag: "🇸🇬", priority: 31 },
  { code: "KR", serpApiCode: "2410", zhName: "韩国",     flag: "🇰🇷", priority: 32 },
  { code: "IN", serpApiCode: "2356", zhName: "印度",     flag: "🇮🇳", priority: 33 },
  { code: "NZ", serpApiCode: "2554", zhName: "新西兰",   flag: "🇳🇿", priority: 34 },
  { code: "BR", serpApiCode: "2076", zhName: "巴西",     flag: "🇧🇷", priority: 40 },
  { code: "MX", serpApiCode: "2484", zhName: "墨西哥",   flag: "🇲🇽", priority: 41 },
];

/** ISO code 大写 → SerpApi 数字码（atc-service.ts 调用） */
export const REGION_CODE_MAP: Record<string, string> = Object.fromEntries(
  ATC_REGIONS.map((r) => [r.code, r.serpApiCode])
);

/** ISO code 集合（大写），用于白名单校验 */
export const SUPPORTED_REGION_CODES = new Set(ATC_REGIONS.map((r) => r.code));

/**
 * 校验前端传入的 region 是否在白名单内（D-008 F-6）。
 * 接受 ISO code（大小写不敏感）；已是数字码原样视为合法。
 */
export function isValidRegion(region: string | undefined | null): boolean {
  if (!region) return false;
  if (/^\d+$/.test(region)) return true; // 已是 SerpApi 数字码
  return SUPPORTED_REGION_CODES.has(region.toUpperCase());
}

/**
 * 返回前端展示用的 region 列表（已按 priority 排序）。
 * 用于 /api/user/atc/regions 接口与前端 SSR fallback。
 */
export function getDisplayRegions(): Array<{
  value: string;
  label: string;
  zhName: string;
  flag: string;
}> {
  return [...ATC_REGIONS]
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
    .map((r) => ({
      value: r.code,
      label: `${r.flag} ${r.zhName} (${r.code})`,
      zhName: r.zhName,
      flag: r.flag,
    }));
}
