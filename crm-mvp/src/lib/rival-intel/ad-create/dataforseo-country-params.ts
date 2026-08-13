/**
 * @fileoverview ISO-2 国家代码到 DataForSEO `location_code` + `language_code`
 * 的纯映射。覆盖 14 个一方支持国家（详见 spec §5.6），并在归一化失败时
 * 回退到 US（2840/en）并带上 `isFallback` 标记。仅导出单个查询函数，
 * 供 Phase B HTTP 客户端与编排器通过依赖注入复用。
 */

/**
 * @internal
 * 14 个一方支持国家的映射表（spec §5.6 单一事实来源）。
 * GB 为规范键；UK 在归一化阶段作为别名映射至 GB。
 * 使用 `as const satisfies …` 同时获得字面量类型与只读保护，下游消费者
 * 可推断到精确的 `locationCode` 数值与 `languageCode` 字面量。
 */
const COUNTRY_MAP = {
  US: { locationCode: 2840, languageCode: "en" },
  GB: { locationCode: 2826, languageCode: "en" },
  CA: { locationCode: 2124, languageCode: "en" },
  AU: { locationCode: 2036, languageCode: "en" },
  DE: { locationCode: 2276, languageCode: "de" },
  FR: { locationCode: 2250, languageCode: "fr" },
  JP: { locationCode: 2392, languageCode: "ja" },
  KR: { locationCode: 2410, languageCode: "ko" },
  BR: { locationCode: 2076, languageCode: "pt" },
  MX: { locationCode: 2484, languageCode: "es" },
  IN: { locationCode: 2356, languageCode: "en" },
  SG: { locationCode: 2702, languageCode: "en" },
  HK: { locationCode: 2344, languageCode: "zh" },
  TW: { locationCode: 2158, languageCode: "zh" },
} as const satisfies Record<string, { locationCode: number; languageCode: string }>;

/**
 * 将 ISO-2 国家代码映射为 DataForSEO 的 `location_code` 与 `language_code`。
 *
 * 归一化流程：去除首尾空白并转大写；`UK` 视作 `GB` 别名；空字符串、`null`、
 * `undefined` 以及未在表中的代码统一回退到 US（2840/en），并将 `isFallback`
 * 置为 `true`，便于调用方记录与告警。
 *
 * @param code ISO-2 国家代码，允许 `null` / `undefined` / 任意大小写与空白
 * @returns DataForSEO 查询参数及是否走了回退分支
 */
export function countryCodeToDataForSeoParams(
  code: string | null | undefined,
): { locationCode: number; languageCode: string; isFallback: boolean } {
  const normalized = (code ?? "").trim().toUpperCase();
  const key = normalized === "UK" ? "GB" : normalized;

  if (Object.prototype.hasOwnProperty.call(COUNTRY_MAP, key)) {
    const entry = COUNTRY_MAP[key as keyof typeof COUNTRY_MAP];
    return { ...entry, isFallback: false };
  }

  return { ...COUNTRY_MAP.US, isFallback: true };
}
