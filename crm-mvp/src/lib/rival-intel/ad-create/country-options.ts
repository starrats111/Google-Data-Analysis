/**
 * 广告创建 / 竞品情报的国家下拉选项。
 *
 * D-288：原先这里手维护 60 国的分组清单，与 lib/constants.ts 的 48 国、文章发布页的
 * 26 国三份各不相同。现在统一从 lib/countries.ts（全站单一信源）派生，覆盖 ISO 3166-1
 * 全量国家 / 地区；加国家只改 lib/countries.ts 一处。
 */
import {
  ALL_COUNTRY_CODES,
  COUNTRY_OPTION_GROUPS,
  type CountrySelectOption,
} from "@/lib/countries";

export type CountryOption = CountrySelectOption;

export interface CountryOptionGroup {
  label: string;
  options: CountryOption[];
}

/** 分组下拉选项：「常用投放市场」置顶，其余归「全部国家 / 地区」 */
export const AD_CREATE_COUNTRY_OPTIONS: CountryOptionGroup[] = COUNTRY_OPTION_GROUPS;

/** 全量可投放国家代码（ISO-2，大写） */
export const AD_CREATE_COUNTRY_CODES = ALL_COUNTRY_CODES;
