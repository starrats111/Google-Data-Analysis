/**
 * D-008 F-1：ATC 区域 / 国家清单
 *
 * 前后端共用：
 *   - 后端 atc-service.ts 通过 REGION_CODE_MAP 将 ISO code 转 SerpApi 数字码
 *   - 前端 3 个入口（intelligence / merchants / advertisers）通过 GET /api/user/atc/regions 异步拉取
 *
 * D-288：国家码表 / 中文名 / 国旗 / 主投市场排序已上移到 `lib/countries.ts`（全站单一信源），
 * 本文件只保留 ATC 自己的东西——ISO 码 → SerpApi region 数字码的换算与展示列表拼装。
 *
 * 全量国家支持：SerpApi google_ads_transparency_center 的 region 数字码
 * 规律为「2000 + ISO 3166-1 数字码」（US 840→2840、GB 826→2826、AU 036→2036，
 * 已对原 26 国逐一验证吻合），因此只维护标准 ISO 码表即可覆盖全部国家/地区。
 */

import {
  ALL_COUNTRY_ENTRIES,
  ISO_NUMERIC,
  flagEmoji,
  zhCountryName,
} from "@/lib/countries";

// 历史导入路径兼容：atc-service.ts / serpapi-keys 仍从这里取这两个符号
export { ISO_NUMERIC, flagEmoji };

/** ISO 码 → 中文名（D-288 后统一走 lib/countries.ts） */
export const zhRegionName = zhCountryName;

/** ISO code 大写 → SerpApi 数字码（atc-service.ts 调用）：2000 + ISO 数字码 */
export const REGION_CODE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(ISO_NUMERIC).map(([code, num]) => [code, String(2000 + num)])
);

/** ISO code 集合（大写），用于白名单校验 */
export const SUPPORTED_REGION_CODES = new Set(Object.keys(ISO_NUMERIC));

/**
 * 校验前端传入的 region 是否合法（D-008 F-6）。
 * 接受 ISO code（大小写不敏感）；已是数字码原样视为合法。
 */
export function isValidRegion(region: string | undefined | null): boolean {
  if (!region) return false;
  if (/^\d+$/.test(region)) return true; // 已是 SerpApi 数字码
  return SUPPORTED_REGION_CODES.has(region.toUpperCase());
}

/**
 * 返回前端展示用的 region 列表（主投市场置顶，其余按中文名排序，顺序由 lib/countries.ts 定）。
 * 用于 /api/user/atc/regions 接口与前端 SSR fallback。
 */
export function getDisplayRegions(): Array<{
  value: string;
  label: string;
  zhName: string;
  flag: string;
}> {
  return ALL_COUNTRY_ENTRIES.map((c) => ({
    value: c.code,
    label: `${c.flag} ${c.name} (${c.code})`,
    zhName: c.name,
    flag: c.flag,
  }));
}
