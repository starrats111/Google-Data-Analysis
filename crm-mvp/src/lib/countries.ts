/**
 * D-288：全站「国家 / 地区」单一信源
 *
 * 背景：此前站内至少有 4 份互相不同步的国家清单——
 *   - `lib/constants.ts` 的 `ALL_COUNTRIES`（48 国，有 HK）
 *   - `lib/rival-intel/ad-create/country-options.ts`（分组 60 国，有 HK）
 *   - `app/user/articles/publish/page.tsx` 页内硬编码（26 国，**没有 HK**）
 *   - `app/user/intelligence/_components/BrandAssessmentPanel.tsx` 页内硬编码（15 国）
 * 结果就是 07 反馈的「文章生成的地区选择搜不到 HK」：同一个商家在领取弹窗能选香港，
 * 换到文章发布页就没有。本文件把清单收敛成一份，覆盖 ISO 3166-1 alpha-2 全量
 * 国家 / 地区，任何「选国家」的下拉都从这里取，不再各页自己列。
 *
 * 数据来源与生成方式（不手维护 249 行名字表）：
 *   - 代码 / 数字码：`ISO_NUMERIC` 标准码表（原在 lib/atc-regions.ts，本次上移到这里）
 *   - 中文名：`Intl.DisplayNames("zh-Hans")` 运行时生成，个别用 `ZH_NAME_OVERRIDES` 覆写
 *     （港澳台用「中国香港 / 中国澳门 / 中国台湾」，避免 ICU 的「…特别行政区」长名）
 *   - 英文名：`Intl.DisplayNames("en")` 生成，个别用 `EN_NAME_OVERRIDES` 覆写成
 *     SerpApi / Google location 惯用写法（Hong Kong 而非 Hong Kong SAR China）
 *   - 国旗 emoji：由 2 字母码的 Regional Indicator 码点计算
 *
 * 排序：`MARKET_PRIORITY` 里的主投市场置顶（沿用 07 团队原有顺序），其余按中文名排序。
 * 搜索：`countryFilterOption` 同时匹配「代码 / 中文名 / 英文名」，输入 hk、香港、hong 都能命中。
 */

/** ISO 3166-1 alpha-2 → 数字码（标准码表，非业务硬编码） */
export const ISO_NUMERIC: Record<string, number> = {
  AD: 20, AE: 784, AF: 4, AG: 28, AI: 660, AL: 8, AM: 51, AO: 24, AQ: 10,
  AR: 32, AS: 16, AT: 40, AU: 36, AW: 533, AX: 248, AZ: 31,
  BA: 70, BB: 52, BD: 50, BE: 56, BF: 854, BG: 100, BH: 48, BI: 108,
  BJ: 204, BL: 652, BM: 60, BN: 96, BO: 68, BQ: 535, BR: 76, BS: 44,
  BT: 64, BV: 74, BW: 72, BY: 112, BZ: 84,
  CA: 124, CC: 166, CD: 180, CF: 140, CG: 178, CH: 756, CI: 384, CK: 184,
  CL: 152, CM: 120, CN: 156, CO: 170, CR: 188, CU: 192, CV: 132, CW: 531,
  CX: 162, CY: 196, CZ: 203,
  DE: 276, DJ: 262, DK: 208, DM: 212, DO: 214, DZ: 12,
  EC: 218, EE: 233, EG: 818, EH: 732, ER: 232, ES: 724, ET: 231,
  FI: 246, FJ: 242, FK: 238, FM: 583, FO: 234, FR: 250,
  GA: 266, GB: 826, GD: 308, GE: 268, GF: 254, GG: 831, GH: 288, GI: 292,
  GL: 304, GM: 270, GN: 324, GP: 312, GQ: 226, GR: 300, GS: 239, GT: 320,
  GU: 316, GW: 624, GY: 328,
  HK: 344, HM: 334, HN: 340, HR: 191, HT: 332, HU: 348,
  ID: 360, IE: 372, IL: 376, IM: 833, IN: 356, IO: 86, IQ: 368, IR: 364,
  IS: 352, IT: 380,
  JE: 832, JM: 388, JO: 400, JP: 392,
  KE: 404, KG: 417, KH: 116, KI: 296, KM: 174, KN: 659, KP: 408, KR: 410,
  KW: 414, KY: 136, KZ: 398,
  LA: 418, LB: 422, LC: 662, LI: 438, LK: 144, LR: 430, LS: 426, LT: 440,
  LU: 442, LV: 428, LY: 434,
  MA: 504, MC: 492, MD: 498, ME: 499, MF: 663, MG: 450, MH: 584, MK: 807,
  ML: 466, MM: 104, MN: 496, MO: 446, MP: 580, MQ: 474, MR: 478, MS: 500,
  MT: 470, MU: 480, MV: 462, MW: 454, MX: 484, MY: 458, MZ: 508,
  NA: 516, NC: 540, NE: 562, NF: 574, NG: 566, NI: 558, NL: 528, NO: 578,
  NP: 524, NR: 520, NU: 570, NZ: 554,
  OM: 512,
  PA: 591, PE: 604, PF: 258, PG: 598, PH: 608, PK: 586, PL: 616, PM: 666,
  PN: 612, PR: 630, PS: 275, PT: 620, PW: 585, PY: 600,
  QA: 634,
  RE: 638, RO: 642, RS: 688, RU: 643, RW: 646,
  SA: 682, SB: 90, SC: 690, SD: 729, SE: 752, SG: 702, SH: 654, SI: 705,
  SJ: 744, SK: 703, SL: 694, SM: 674, SN: 686, SO: 706, SR: 740, SS: 728,
  ST: 678, SV: 222, SX: 534, SY: 760, SZ: 748,
  TC: 796, TD: 148, TF: 260, TG: 768, TH: 764, TJ: 762, TK: 772, TL: 626,
  TM: 795, TN: 788, TO: 776, TR: 792, TT: 780, TV: 798, TW: 158, TZ: 834,
  UA: 804, UG: 800, UM: 581, US: 840, UY: 858, UZ: 860,
  VA: 336, VC: 670, VE: 862, VG: 92, VI: 850, VN: 704, VU: 548,
  WF: 876, WS: 882,
  YE: 887, YT: 175,
  ZA: 710, ZM: 894, ZW: 716,
};

/**
 * 07 团队主投市场排序优先级（数字越小越靠前），未列出的国家排在后面按中文名排序。
 * 与原 lib/atc-regions.ts 的 REGION_PRIORITY 同一份，避免两处各排各的。
 */
export const MARKET_PRIORITY: Record<string, number> = {
  US: 1, GB: 2, AU: 3, CA: 4,
  DE: 10, FR: 11, IT: 12, ES: 13, NL: 14, SE: 15, NO: 16, DK: 17, FI: 18,
  PL: 19, AT: 20, CH: 21, BE: 22, IE: 23, PT: 24,
  JP: 30, SG: 31, KR: 32, IN: 33, NZ: 34, HK: 35, TW: 36, MY: 37, TH: 38,
  BR: 40, MX: 41,
};

/** 中文名覆写：ICU 的长名 / 表述不合适时按公司口径写 */
const ZH_NAME_OVERRIDES: Record<string, string> = {
  HK: "中国香港",
  MO: "中国澳门",
  TW: "中国台湾",
  GB: "英国",
  KR: "韩国",
  KP: "朝鲜",
};

/** 英文名覆写：对齐 SerpApi / Google Ads location 的惯用写法 */
const EN_NAME_OVERRIDES: Record<string, string> = {
  HK: "Hong Kong",
  MO: "Macau",
  TW: "Taiwan",
  TR: "Turkey",
  CD: "Democratic Republic of the Congo",
  CG: "Republic of the Congo",
  CI: "Cote d Ivoire",
  KR: "South Korea",
  KP: "North Korea",
  CZ: "Czechia",
  VN: "Vietnam",
};

const zhDisplayNames = (() => {
  try {
    return new Intl.DisplayNames(["zh-Hans"], { type: "region" });
  } catch {
    return null;
  }
})();

const enDisplayNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

/**
 * 归一化国家代码：去空白 + 转大写，并把历史遗留的 `UK` 视作 `GB`。
 * 库里 / 表格里两种写法都出现过，查名字、查国旗都得先过这一层。
 */
export function normalizeCountryCode(code: string | null | undefined): string {
  const upper = String(code ?? "").trim().toUpperCase();
  return upper === "UK" ? "GB" : upper;
}

/** 由 2 字母 ISO 码计算国旗 emoji（Regional Indicator Symbols） */
export function flagEmoji(code: string): string {
  const upper = normalizeCountryCode(code);
  if (!/^[A-Z]{2}$/.test(upper)) return "";
  return String.fromCodePoint(
    ...[...upper].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

/** ISO 码 → 中文名（覆写优先，其次 Intl 自动生成，最后回退为码本身） */
export function zhCountryName(code: string): string {
  const upper = normalizeCountryCode(code);
  if (ZH_NAME_OVERRIDES[upper]) return ZH_NAME_OVERRIDES[upper];
  try {
    const name = zhDisplayNames?.of(upper);
    return name && name !== upper ? name : upper;
  } catch {
    return upper;
  }
}

/** ISO 码 → 英文名（覆写优先，其次 Intl 自动生成，最后回退为码本身） */
export function enCountryName(code: string): string {
  const upper = normalizeCountryCode(code);
  if (EN_NAME_OVERRIDES[upper]) return EN_NAME_OVERRIDES[upper];
  try {
    const name = enDisplayNames?.of(upper);
    return name && name !== upper ? name : upper;
  } catch {
    return upper;
  }
}

export interface CountryEntry {
  /** ISO 3166-1 alpha-2，大写 */
  code: string;
  /** 中文名 */
  name: string;
  /** 英文名 */
  enName: string;
  /** 国旗 emoji */
  flag: string;
  /** ISO 3166-1 数字码 */
  numeric: number;
  /** 主投市场优先级，非主投为 1000 */
  priority: number;
}

const zhCollator = (() => {
  try {
    return new Intl.Collator("zh-Hans-CN");
  } catch {
    return null;
  }
})();

function compareEntries(a: CountryEntry, b: CountryEntry): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const byName = zhCollator
    ? zhCollator.compare(a.name, b.name)
    : a.name.localeCompare(b.name);
  return byName !== 0 ? byName : a.code.localeCompare(b.code);
}

/** 全量国家 / 地区（主投市场置顶，其余按中文名排序） */
export const ALL_COUNTRY_ENTRIES: CountryEntry[] = Object.entries(ISO_NUMERIC)
  .map(([code, numeric]) => ({
    code,
    name: zhCountryName(code),
    enName: enCountryName(code),
    flag: flagEmoji(code),
    numeric,
    priority: MARKET_PRIORITY[code] ?? 1000,
  }))
  .sort(compareEntries);

/** 全量 ISO 码（排序同 ALL_COUNTRY_ENTRIES） */
export const ALL_COUNTRY_CODES: string[] = ALL_COUNTRY_ENTRIES.map((c) => c.code);

const ENTRY_BY_CODE = new Map(ALL_COUNTRY_ENTRIES.map((c) => [c.code, c]));

/** 查一条国家记录；代码非法或未收录返回 null */
export function getCountry(code: string | null | undefined): CountryEntry | null {
  return ENTRY_BY_CODE.get(normalizeCountryCode(code)) ?? null;
}

/** 是否为合法 ISO 3166-1 alpha-2 国家 / 地区代码（`UK` 按 `GB` 算） */
export function isValidCountryCode(code: string | null | undefined): boolean {
  return ENTRY_BY_CODE.has(normalizeCountryCode(code));
}

export interface CountrySelectOption {
  value: string;
  label: string;
  zhName: string;
  enName: string;
  flag: string;
}

function toOption(c: CountryEntry, starred = false): CountrySelectOption {
  return {
    value: c.code,
    label: `${starred ? "⭐ " : ""}${c.flag} ${c.code} - ${c.name}`,
    zhName: c.name,
    enName: c.enName,
    flag: c.flag,
  };
}

/** 全站通用的国家下拉选项（主投市场置顶） */
export const COUNTRY_OPTIONS: CountrySelectOption[] = ALL_COUNTRY_ENTRIES.map((c) => toOption(c));

/** 分组版：主投市场单独一组，其余归「全部国家 / 地区」 */
export const COUNTRY_OPTION_GROUPS: Array<{ label: string; options: CountrySelectOption[] }> = [
  {
    label: "常用投放市场",
    options: ALL_COUNTRY_ENTRIES.filter((c) => c.priority < 1000).map((c) => toOption(c)),
  },
  {
    label: "全部国家 / 地区",
    options: ALL_COUNTRY_ENTRIES.filter((c) => c.priority >= 1000).map((c) => toOption(c)),
  },
];

/**
 * antd Select 的 `filterOption`：按「代码 / 中文名 / 英文名」匹配。
 * 输入 `hk`、`HK`、`香港`、`hong` 都能选到中国香港——07 反馈的就是这个搜不到。
 */
export function countryFilterOption(
  input: string,
  option?: { value?: unknown; label?: unknown; zhName?: unknown; enName?: unknown },
): boolean {
  const kw = input.trim().toLowerCase();
  if (!kw) return true;
  if (!option) return false;
  const fields = [option.value, option.zhName, option.enName, option.label];
  return fields.some((f) => String(f ?? "").toLowerCase().includes(kw));
}

/**
 * 国家级地理定向 ID = 2000 + ISO 3166-1 数字码。
 *
 * Google Ads 的 `geoTargetConstants/<id>` 与 SerpApi ATC 的 region 数字码用的是同一套编号
 * （US 840→2840、GB 826→2826、HK 344→2344，已对两边原有的硬编码表逐条比对吻合）。
 * 代码非法 / 未收录时返回 null，调用方自己决定怎么兜底——**别默默落回美国**，
 * 那等于拿客户的钱在错误的国家投广告。
 */
export function geoTargetConstantId(code: string | null | undefined): string | null {
  const entry = ENTRY_BY_CODE.get(normalizeCountryCode(code));
  return entry ? String(2000 + entry.numeric) : null;
}

const ORDER_INDEX = new Map(ALL_COUNTRY_CODES.map((code, i) => [code, i]));

function matchRank(kw: string, option: { value?: unknown; label?: unknown; zhName?: unknown; enName?: unknown }): number {
  const code = String(option.value ?? "").toLowerCase();
  const zh = String(option.zhName ?? "");
  const en = String(option.enName ?? "").toLowerCase();
  let rank = 5;
  if (code === kw) rank = 0;
  else if (code.startsWith(kw)) rank = 1;
  else if (zh.startsWith(kw)) rank = 2;
  else if (en.startsWith(kw)) rank = 3;
  else if (zh.includes(kw) || en.includes(kw)) rank = 4;
  // ⭐ 商家支持地区在同档里再优先一点
  if (String(option.label ?? "").startsWith("⭐")) rank -= 0.5;
  return rank;
}

/**
 * antd Select 的 `filterSort`：让「代码正好等于输入」的国家排最前。
 * 不排的话输入 `IS` 会先冒出 Afghan**is**tan 这种子串命中，真正的冰岛沉到后面。
 * 输入为空时返回 0，保持 `buildCountryOptions` 的 ⭐ 置顶与主投市场顺序。
 */
export function countryFilterSort(
  a: { value?: unknown; label?: unknown; zhName?: unknown; enName?: unknown },
  b: { value?: unknown; label?: unknown; zhName?: unknown; enName?: unknown },
  info?: { searchValue?: string },
): number {
  const kw = (info?.searchValue ?? "").trim().toLowerCase();
  if (!kw) return 0;
  const diff = matchRank(kw, a) - matchRank(kw, b);
  if (diff !== 0) return diff;
  const ia = ORDER_INDEX.get(String(a.value)) ?? Number.MAX_SAFE_INTEGER;
  const ib = ORDER_INDEX.get(String(b.value)) ?? Number.MAX_SAFE_INTEGER;
  return ia - ib;
}

export interface MarketLanguage {
  /** 语言代码（BCP-47，如 en / de / zh-TW / pt-BR） */
  code: string;
  /** 母语写法，给用户看（English / Deutsch / 繁體中文） */
  nativeName: string;
  /** 英文名，喂给 AI 提示词用（Traditional Chinese） */
  enName: string;
}

const FALLBACK_LANGUAGE: MarketLanguage = { code: "en", nativeName: "English", enName: "English" };

const EN: MarketLanguage = FALLBACK_LANGUAGE;
const DE: MarketLanguage = { code: "de", nativeName: "Deutsch", enName: "German" };
const FR: MarketLanguage = { code: "fr", nativeName: "Français", enName: "French" };
const ES: MarketLanguage = { code: "es", nativeName: "Español", enName: "Spanish" };
const AR: MarketLanguage = { code: "ar", nativeName: "العربية", enName: "Arabic" };
const ZH_HANT: MarketLanguage = { code: "zh-TW", nativeName: "繁體中文", enName: "Traditional Chinese" };

/**
 * 市场主语言：文章 / 广告文案按投放国出稿时用哪门语言。
 *
 * D-288：原先 publish 页、lib/article-gen.ts、ad-creation/translate 各存一份 20 来国的映射，
 * 且都跟 brand-assessment 的 `HL_BY_COUNTRY` 对不上。这里按 `HL_BY_COUNTRY` 的口径合成一份，
 * 未列出的国家一律回退英语（与原先各处的 fallback 行为一致，不是新增的降级）。
 */
const MARKET_LANGUAGE_BY_COUNTRY: Record<string, MarketLanguage> = {
  // 英语市场
  US: EN, GB: EN, CA: EN, AU: EN, NZ: EN, IE: EN, SG: EN, IN: EN, PH: EN,
  ZA: EN, NG: EN, KE: EN, PK: EN, MT: EN,
  // 德语 / 法语 / 西语 / 葡语
  DE: DE, AT: DE, CH: DE, LI: DE,
  FR: FR, BE: FR, LU: FR, MC: FR,
  ES: ES, MX: ES, AR: ES, CL: ES, CO: ES, PE: ES, UY: ES, VE: ES, EC: ES,
  BO: ES, PY: ES, CR: ES, PA: ES, GT: ES, DO: ES, HN: ES, NI: ES, SV: ES,
  PT: { code: "pt", nativeName: "Português", enName: "Portuguese" },
  BR: { code: "pt-BR", nativeName: "Português (BR)", enName: "Brazilian Portuguese" },
  // 其余欧洲
  IT: { code: "it", nativeName: "Italiano", enName: "Italian" },
  NL: { code: "nl", nativeName: "Nederlands", enName: "Dutch" },
  SE: { code: "sv", nativeName: "Svenska", enName: "Swedish" },
  NO: { code: "no", nativeName: "Norsk", enName: "Norwegian" },
  DK: { code: "da", nativeName: "Dansk", enName: "Danish" },
  FI: { code: "fi", nativeName: "Suomi", enName: "Finnish" },
  IS: { code: "is", nativeName: "Íslenska", enName: "Icelandic" },
  PL: { code: "pl", nativeName: "Polski", enName: "Polish" },
  CZ: { code: "cs", nativeName: "Čeština", enName: "Czech" },
  SK: { code: "sk", nativeName: "Slovenčina", enName: "Slovak" },
  SI: { code: "sl", nativeName: "Slovenščina", enName: "Slovenian" },
  HR: { code: "hr", nativeName: "Hrvatski", enName: "Croatian" },
  RS: { code: "sr", nativeName: "Српски", enName: "Serbian" },
  BG: { code: "bg", nativeName: "Български", enName: "Bulgarian" },
  HU: { code: "hu", nativeName: "Magyar", enName: "Hungarian" },
  RO: { code: "ro", nativeName: "Română", enName: "Romanian" },
  GR: { code: "el", nativeName: "Ελληνικά", enName: "Greek" },
  CY: { code: "el", nativeName: "Ελληνικά", enName: "Greek" },
  EE: { code: "et", nativeName: "Eesti", enName: "Estonian" },
  LV: { code: "lv", nativeName: "Latviešu", enName: "Latvian" },
  LT: { code: "lt", nativeName: "Lietuvių", enName: "Lithuanian" },
  RU: { code: "ru", nativeName: "Русский", enName: "Russian" },
  UA: { code: "uk", nativeName: "Українська", enName: "Ukrainian" },
  TR: { code: "tr", nativeName: "Türkçe", enName: "Turkish" },
  // 亚太
  JP: { code: "ja", nativeName: "日本語", enName: "Japanese" },
  KR: { code: "ko", nativeName: "한국어", enName: "Korean" },
  CN: { code: "zh-CN", nativeName: "简体中文", enName: "Simplified Chinese" },
  HK: ZH_HANT, TW: ZH_HANT, MO: ZH_HANT,
  TH: { code: "th", nativeName: "ไทย", enName: "Thai" },
  VN: { code: "vi", nativeName: "Tiếng Việt", enName: "Vietnamese" },
  ID: { code: "id", nativeName: "Bahasa Indonesia", enName: "Indonesian" },
  MY: { code: "ms", nativeName: "Bahasa Melayu", enName: "Malay" },
  BD: { code: "bn", nativeName: "বাংলা", enName: "Bengali" },
  // 中东 / 北非
  AE: AR, SA: AR, EG: AR, MA: AR, QA: AR, KW: AR, BH: AR, OM: AR, JO: AR,
  LB: AR, DZ: AR, TN: AR,
  IL: { code: "he", nativeName: "עברית", enName: "Hebrew" },
};

/**
 * 投放国 → 市场主语言；未收录的国家回退英语。
 * 文章生成（lib/article-gen.ts）与文章发布页的「文章语言」提示共用这一份，
 * 避免页面上写着 English、后端却按别的语言出稿。
 */
export function marketLanguage(country: string | null | undefined): MarketLanguage {
  return MARKET_LANGUAGE_BY_COUNTRY[normalizeCountryCode(country)] ?? FALLBACK_LANGUAGE;
}

/**
 * 生成带 ⭐ 置顶的国家选项：商家 `supported_regions` 里的国家排最前并打星，
 * 其余按常规顺序跟在后面；`supported_regions` 里出现非 ISO 码时原样保留，
 * 免得商家平台给的自定义地区在下拉里凭空消失。
 */
export function buildCountryOptions(starCodes?: Array<string | null | undefined>): CountrySelectOption[] {
  const codes = (starCodes ?? [])
    .map((c) => normalizeCountryCode(c))
    .filter(Boolean);
  if (codes.length === 0) return COUNTRY_OPTIONS;

  const starSet = new Set(codes);
  const star: CountrySelectOption[] = [];
  const rest: CountrySelectOption[] = [];
  for (const c of ALL_COUNTRY_ENTRIES) {
    if (starSet.has(c.code)) star.push(toOption(c, true));
    else rest.push(toOption(c));
  }
  // supported_regions 里有 ISO 码表没收录的地区时也保留（如平台自定义地区码）
  const extra = codes
    .filter((code) => !ENTRY_BY_CODE.has(code))
    .filter((code, i, arr) => arr.indexOf(code) === i)
    .map((code) => ({
      value: code,
      label: `⭐ ${code} - 支持地区`,
      zhName: "",
      enName: "",
      flag: "",
    }));

  return [...star, ...extra, ...rest];
}
