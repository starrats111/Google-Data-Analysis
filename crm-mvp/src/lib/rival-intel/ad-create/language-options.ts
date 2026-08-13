/**
 * 广告文案语言。
 *
 * 默认情况下语言由国家推导（见 `rsa-localization-quality.ts` 的 `TARGET_LANGUAGES`），
 * 本模块提供的是「用户在生成页显式指定语言」时的候选集合。
 * 典型场景：阿联酋 / 沙特这类国家默认推导为阿拉伯语，但实际投英文效果更好。
 */

export interface AdCopyLanguage {
  code: string;
  /** 传给 LLM 的语言名，与 `TARGET_LANGUAGES` 的 label 口径一致。 */
  label: string;
  /** 前端下拉展示用的中文名。 */
  cnLabel: string;
}

export const AD_COPY_LANGUAGES: AdCopyLanguage[] = [
  { code: "en", label: "English", cnLabel: "英语" },
  { code: "de", label: "German", cnLabel: "德语" },
  { code: "fr", label: "French", cnLabel: "法语" },
  { code: "es", label: "Spanish", cnLabel: "西班牙语" },
  { code: "it", label: "Italian", cnLabel: "意大利语" },
  { code: "pt", label: "Portuguese", cnLabel: "葡萄牙语" },
  { code: "nl", label: "Dutch", cnLabel: "荷兰语" },
  { code: "sv", label: "Swedish", cnLabel: "瑞典语" },
  { code: "no", label: "Norwegian", cnLabel: "挪威语" },
  { code: "da", label: "Danish", cnLabel: "丹麦语" },
  { code: "fi", label: "Finnish", cnLabel: "芬兰语" },
  { code: "pl", label: "Polish", cnLabel: "波兰语" },
  { code: "cs", label: "Czech", cnLabel: "捷克语" },
  { code: "hu", label: "Hungarian", cnLabel: "匈牙利语" },
  { code: "ro", label: "Romanian", cnLabel: "罗马尼亚语" },
  { code: "el", label: "Greek", cnLabel: "希腊语" },
  { code: "tr", label: "Turkish", cnLabel: "土耳其语" },
  { code: "ru", label: "Russian", cnLabel: "俄语" },
  { code: "uk", label: "Ukrainian", cnLabel: "乌克兰语" },
  { code: "ja", label: "Japanese", cnLabel: "日语" },
  { code: "ko", label: "Korean", cnLabel: "韩语" },
  { code: "zh", label: "Chinese", cnLabel: "中文" },
  { code: "th", label: "Thai", cnLabel: "泰语" },
  { code: "id", label: "Indonesian", cnLabel: "印尼语" },
  { code: "vi", label: "Vietnamese", cnLabel: "越南语" },
  { code: "ar", label: "Arabic", cnLabel: "阿拉伯语" },
  { code: "he", label: "Hebrew", cnLabel: "希伯来语" },
];

/** 前端「跟随国家」选项的哨兵值；不会落库，提交前会转成 null。 */
export const AD_COPY_LANGUAGE_AUTO = "auto";

export const AD_CREATE_LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: AD_COPY_LANGUAGE_AUTO, label: "跟随国家（默认）" },
  ...AD_COPY_LANGUAGES.map((item) => ({
    value: item.code,
    label: `${item.cnLabel} (${item.label})`,
  })),
];

/**
 * 归一化用户传入的语言代码：不认识的值、空值、`auto` 一律当作「跟随国家」返回 null。
 */
export function normalizeAdCopyLanguageCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === AD_COPY_LANGUAGE_AUTO) return null;
  return AD_COPY_LANGUAGES.some((item) => item.code === normalized) ? normalized : null;
}

export function findAdCopyLanguage(code: string | null | undefined): AdCopyLanguage | null {
  const normalized = normalizeAdCopyLanguageCode(code);
  if (!normalized) return null;
  return AD_COPY_LANGUAGES.find((item) => item.code === normalized) ?? null;
}
