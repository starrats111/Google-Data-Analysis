import { googleAdsLength } from "./text-length";
import { findAdCopyLanguage } from "./language-options";

export const RSA_PUBLISH_QUALITY_THRESHOLD = 75;

export interface TargetLanguage {
  code: string;
  label: string;
}

/**
 * `english_phrase`: 命中多词英文广告短语（如 "Visit The Official Site"）。优先级最高。
 * `english_word`: 命中单个英文广告词（如 "Save" / "Sale" / "Official"）。
 * `no_localized_script`: 文案完全未出现目标语言的文字片（CJK / 阿拉伯 / 希伯来）。
 */
export type LocalizationViolationRule = "english_phrase" | "english_word" | "no_localized_script";

export type LocalizationViolationSeverity = "high" | "medium" | "low";

export interface LocalizationViolation {
  text: string;
  term: string;
  suggestion: string;
  rule: LocalizationViolationRule;
  severity: LocalizationViolationSeverity;
}

export interface LocalizationAuditResult {
  expectedLanguage: TargetLanguage | null;
  violations: LocalizationViolation[];
  passed: boolean;
}

export interface RsaQualityResult {
  score: number;
  threshold: number;
  passed: boolean;
  reasons: string[];
}

const TARGET_LANGUAGES: Record<string, TargetLanguage> = {
  US: { code: "en", label: "English" },
  GB: { code: "en", label: "English" },
  CA: { code: "en", label: "English" },
  AU: { code: "en", label: "English" },
  IE: { code: "en", label: "English" },
  NZ: { code: "en", label: "English" },
  DE: { code: "de", label: "German" },
  AT: { code: "de", label: "German" },
  CH: { code: "de", label: "German" },
  FR: { code: "fr", label: "French" },
  ES: { code: "es", label: "Spanish" },
  MX: { code: "es", label: "Spanish" },
  AR: { code: "es", label: "Spanish" },
  CL: { code: "es", label: "Spanish" },
  CO: { code: "es", label: "Spanish" },
  PE: { code: "es", label: "Spanish" },
  IT: { code: "it", label: "Italian" },
  BR: { code: "pt", label: "Portuguese" },
  PT: { code: "pt", label: "Portuguese" },
  NL: { code: "nl", label: "Dutch" },
  BE: { code: "nl", label: "Dutch/French" },
  SE: { code: "sv", label: "Swedish" },
  NO: { code: "no", label: "Norwegian" },
  DK: { code: "da", label: "Danish" },
  FI: { code: "fi", label: "Finnish" },
  PL: { code: "pl", label: "Polish" },
  CZ: { code: "cs", label: "Czech" },
  HU: { code: "hu", label: "Hungarian" },
  RO: { code: "ro", label: "Romanian" },
  GR: { code: "el", label: "Greek" },
  TR: { code: "tr", label: "Turkish" },
  RU: { code: "ru", label: "Russian" },
  UA: { code: "uk", label: "Ukrainian" },
  JP: { code: "ja", label: "Japanese" },
  KR: { code: "ko", label: "Korean" },
  CN: { code: "zh", label: "Chinese" },
  HK: { code: "zh", label: "Traditional Chinese" },
  TW: { code: "zh", label: "Traditional Chinese" },
  TH: { code: "th", label: "Thai" },
  ID: { code: "id", label: "Indonesian" },
  VN: { code: "vi", label: "Vietnamese" },
  AE: { code: "ar", label: "Arabic" },
  SA: { code: "ar", label: "Arabic" },
  EG: { code: "ar", label: "Arabic" },
  MA: { code: "ar", label: "Arabic/French" },
  IL: { code: "he", label: "Hebrew" },
};

export const LOCALIZATION_EXAMPLES: Record<string, Array<{ english: string; local: string }>> = {
  fr: [
    { english: "Visit The Official Site", local: "Visitez le site officiel" },
    { english: "Official Store", local: "Boutique officielle" },
    { english: "Official Site", local: "Site officiel" },
    { english: "Online Store", local: "Boutique en ligne" },
    { english: "Store Online", local: "Boutique en ligne" },
    { english: "Shop Now", local: "Achetez maintenant" },
    { english: "Save", local: "Économisez" },
    { english: "Sale", local: "Promotion" },
    { english: "Discount", local: "Promotion" },
    { english: "Discounts", local: "Promotions" },
    { english: "Deals", local: "Offres" },
    { english: "Offer", local: "Offre" },
    { english: "Offers", local: "Offres" },
    { english: "Limited Time Offer", local: "Offre limitée" },
    { english: "Free Shipping", local: "Livraison gratuite" },
    { english: "Off", local: "Réduction" },
    { english: "Today", local: "Aujourd’hui" },
    { english: "Official", local: "Officiel" },
    { english: "Site", local: "Site officiel" },
  ],
  de: [
    { english: "Visit The Official Site", local: "Offizielle Website besuchen" },
    { english: "Official Store", local: "Offizieller Shop" },
    { english: "Official Site", local: "Offizielle Website" },
    { english: "Online Store", local: "Online-Shop" },
    { english: "Store Online", local: "Online-Shop" },
    { english: "Shop Now", local: "Jetzt kaufen" },
    { english: "Save", local: "Sparen" },
    { english: "Sale", local: "Angebot" },
    { english: "Discount", local: "Rabatt" },
    { english: "Discounts", local: "Rabatte" },
    { english: "Deals", local: "Angebote" },
    { english: "Offer", local: "Angebot" },
    { english: "Offers", local: "Angebote" },
    { english: "Limited Time Offer", local: "Zeitlich begrenztes Angebot" },
    { english: "Free Shipping", local: "Kostenloser Versand" },
    { english: "Off", local: "Rabatt" },
    { english: "Today", local: "Heute" },
    { english: "Official", local: "Offiziell" },
    { english: "Site", local: "Website" },
  ],
  es: [
    { english: "Visit The Official Site", local: "Visita el sitio oficial" },
    { english: "Official Store", local: "Tienda oficial" },
    { english: "Official Site", local: "Sitio oficial" },
    { english: "Online Store", local: "Tienda online" },
    { english: "Store Online", local: "Tienda online" },
    { english: "Shop Now", local: "Compra ahora" },
    { english: "Save", local: "Ahorra" },
    { english: "Sale", local: "Oferta" },
    { english: "Discount", local: "Descuento" },
    { english: "Discounts", local: "Descuentos" },
    { english: "Deals", local: "Ofertas" },
    { english: "Offer", local: "Oferta" },
    { english: "Offers", local: "Ofertas" },
    { english: "Limited Time Offer", local: "Oferta por tiempo limitado" },
    { english: "Free Shipping", local: "Envío gratis" },
    { english: "Off", local: "De descuento" },
    { english: "Today", local: "Hoy" },
    { english: "Official", local: "Oficial" },
    { english: "Site", local: "Sitio" },
  ],
  pt: [
    { english: "Visit The Official Site", local: "Visite o site oficial" },
    { english: "Official Store", local: "Loja oficial" },
    { english: "Official Site", local: "Site oficial" },
    { english: "Online Store", local: "Loja online" },
    { english: "Store Online", local: "Loja online" },
    { english: "Shop Now", local: "Compre agora" },
    { english: "Save", local: "Economize" },
    { english: "Sale", local: "Oferta" },
    { english: "Discount", local: "Desconto" },
    { english: "Discounts", local: "Descontos" },
    { english: "Deals", local: "Ofertas" },
    { english: "Offer", local: "Oferta" },
    { english: "Offers", local: "Ofertas" },
    { english: "Limited Time Offer", local: "Oferta por tempo limitado" },
    { english: "Free Shipping", local: "Frete grátis" },
    { english: "Off", local: "De desconto" },
    { english: "Today", local: "Hoje" },
    { english: "Official", local: "Oficial" },
    { english: "Site", local: "Site" },
  ],
  pl: [
    { english: "Visit The Official Site", local: "Odwiedź oficjalną stronę" },
    { english: "Official Store", local: "Oficjalny sklep" },
    { english: "Official Site", local: "Oficjalna strona" },
    { english: "Online Store", local: "Sklep online" },
    { english: "Store Online", local: "Sklep online" },
    { english: "Shop Now", local: "Kup teraz" },
    { english: "Save", local: "Oszczędź" },
    { english: "Sale", local: "Wyprzedaż" },
    { english: "Discount", local: "Rabat" },
    { english: "Discounts", local: "Rabaty" },
    { english: "Deals", local: "Okazje" },
    { english: "Offer", local: "Oferta" },
    { english: "Offers", local: "Oferty" },
    { english: "Limited Time Offer", local: "Oferta ograniczona czasowo" },
    { english: "Free Shipping", local: "Darmowa dostawa" },
    { english: "Off", local: "Zniżki" },
    { english: "Today", local: "Dzisiaj" },
    { english: "Official", local: "Oficjalny" },
    { english: "Site", local: "Strona" },
  ],
  it: [
    { english: "Visit The Official Site", local: "Visita il sito ufficiale" },
    { english: "Official Store", local: "Negozio ufficiale" },
    { english: "Official Site", local: "Sito ufficiale" },
    { english: "Online Store", local: "Negozio online" },
    { english: "Store Online", local: "Negozio online" },
    { english: "Shop Now", local: "Acquista ora" },
    { english: "Save", local: "Risparmia" },
    { english: "Sale", local: "Offerta" },
    { english: "Discount", local: "Sconto" },
    { english: "Discounts", local: "Sconti" },
    { english: "Deals", local: "Offerte" },
    { english: "Offer", local: "Offerta" },
    { english: "Offers", local: "Offerte" },
    { english: "Limited Time Offer", local: "Offerta a tempo limitato" },
    { english: "Free Shipping", local: "Spedizione gratuita" },
    { english: "Off", local: "Di sconto" },
    { english: "Today", local: "Oggi" },
    { english: "Official", local: "Ufficiale" },
    { english: "Site", local: "Sito" },
  ],
  cs: [
    { english: "Visit The Official Site", local: "Navštivte oficiální web" },
    { english: "Official Store", local: "Oficiální obchod" },
    { english: "Official Site", local: "Oficiální web" },
    { english: "Online Store", local: "Online obchod" },
    { english: "Store Online", local: "Online obchod" },
    { english: "Shop Now", local: "Nakupte nyní" },
    { english: "Save", local: "Ušetřete" },
    { english: "Sale", local: "Sleva" },
    { english: "Discount", local: "Sleva" },
    { english: "Discounts", local: "Slevy" },
    { english: "Deals", local: "Nabídky" },
    { english: "Offer", local: "Nabídka" },
    { english: "Offers", local: "Nabídky" },
    { english: "Limited Time Offer", local: "Časově omezená nabídka" },
    { english: "Free Shipping", local: "Doprava zdarma" },
    { english: "Off", local: "Sleva" },
    { english: "Today", local: "Dnes" },
    { english: "Official", local: "Oficiální" },
    { english: "Site", local: "Web" },
  ],
  ja: [
    { english: "Visit The Official Site", local: "公式サイトはこちら" },
    { english: "Official Store", local: "公式ストア" },
    { english: "Official Site", local: "公式サイト" },
    { english: "Online Store", local: "オンラインストア" },
    { english: "Store Online", local: "オンラインストア" },
    { english: "Shop Now", local: "今すぐ購入" },
    { english: "Save", local: "お得に" },
    { english: "Sale", local: "セール" },
    { english: "Discount", local: "割引" },
    { english: "Discounts", local: "割引" },
    { english: "Deals", local: "お買い得情報" },
    { english: "Offer", local: "特典" },
    { english: "Offers", local: "特典" },
    { english: "Limited Time Offer", local: "期間限定オファー" },
    { english: "Free Shipping", local: "送料無料" },
    { english: "Off", local: "オフ" },
    { english: "Today", local: "本日" },
    { english: "Official", local: "公式" },
    { english: "Site", local: "サイト" },
  ],
  ko: [
    { english: "Visit The Official Site", local: "공식 사이트 방문" },
    { english: "Official Store", local: "공식 스토어" },
    { english: "Official Site", local: "공식 사이트" },
    { english: "Online Store", local: "온라인 스토어" },
    { english: "Store Online", local: "온라인 스토어" },
    { english: "Shop Now", local: "지금 쇼핑하기" },
    { english: "Save", local: "절약하세요" },
    { english: "Sale", local: "세일" },
    { english: "Discount", local: "할인" },
    { english: "Discounts", local: "할인" },
    { english: "Deals", local: "특가" },
    { english: "Offer", local: "혜택" },
    { english: "Offers", local: "혜택" },
    { english: "Limited Time Offer", local: "기간 한정 혜택" },
    { english: "Free Shipping", local: "무료 배송" },
    { english: "Off", local: "할인" },
    { english: "Today", local: "오늘" },
    { english: "Official", local: "공식" },
    { english: "Site", local: "사이트" },
  ],
  zh: [
    { english: "Visit The Official Site", local: "访问官方网站" },
    { english: "Official Store", local: "官方商店" },
    { english: "Official Site", local: "官方网站" },
    { english: "Online Store", local: "在线商店" },
    { english: "Store Online", local: "在线商店" },
    { english: "Shop Now", local: "立即购买" },
    { english: "Save", local: "节省" },
    { english: "Sale", local: "促销" },
    { english: "Discount", local: "折扣" },
    { english: "Discounts", local: "折扣" },
    { english: "Deals", local: "优惠" },
    { english: "Offer", local: "优惠" },
    { english: "Offers", local: "优惠" },
    { english: "Limited Time Offer", local: "限时优惠" },
    { english: "Free Shipping", local: "免费配送" },
    { english: "Off", local: "折扣" },
    { english: "Today", local: "今日" },
    { english: "Official", local: "官方" },
    { english: "Site", local: "网站" },
  ],
  ar: [
    { english: "Visit The Official Site", local: "زر الموقع الرسمي" },
    { english: "Official Store", local: "المتجر الرسمي" },
    { english: "Official Site", local: "الموقع الرسمي" },
    { english: "Online Store", local: "المتجر الإلكتروني" },
    { english: "Store Online", local: "المتجر الإلكتروني" },
    { english: "Shop Now", local: "تسوق الآن" },
    { english: "Save", local: "وفر" },
    { english: "Sale", local: "تخفيضات" },
    { english: "Discount", local: "خصم" },
    { english: "Discounts", local: "خصومات" },
    { english: "Deals", local: "عروض" },
    { english: "Offer", local: "عرض" },
    { english: "Offers", local: "عروض" },
    { english: "Limited Time Offer", local: "عرض لفترة محدودة" },
    { english: "Free Shipping", local: "شحن مجاني" },
    { english: "Off", local: "خصم" },
    { english: "Today", local: "اليوم" },
    { english: "Official", local: "رسمي" },
    { english: "Site", local: "موقع" },
  ],
  he: [
    { english: "Visit The Official Site", local: "בקרו באתר הרשמי" },
    { english: "Official Store", local: "החנות הרשמית" },
    { english: "Official Site", local: "האתר הרשמי" },
    { english: "Online Store", local: "חנות אונליין" },
    { english: "Store Online", local: "חנות אונליין" },
    { english: "Shop Now", local: "קנו עכשיו" },
    { english: "Save", local: "חסכו" },
    { english: "Sale", local: "מבצע" },
    { english: "Discount", local: "הנחה" },
    { english: "Discounts", local: "הנחות" },
    { english: "Deals", local: "דילים" },
    { english: "Offer", local: "הצעה" },
    { english: "Offers", local: "הצעות" },
    { english: "Limited Time Offer", local: "מבצע לזמן מוגבל" },
    { english: "Free Shipping", local: "משלוח חינם" },
    { english: "Off", local: "הנחה" },
    { english: "Today", local: "היום" },
    { english: "Official", local: "רשמי" },
    { english: "Site", local: "אתר" },
  ],
};

const COMMON_ENGLISH_AD_TERMS = [
  "Visit The Official Site",
  "Official Store",
  "Official Site",
  "Online Store",
  "Store Online",
  "Shop Now",
  "Save",
  "Sale",
  "Discount",
  "Discounts",
  "Deals",
  "Limited Time Offer",
  "Offer",
  "Offers",
  "Free Shipping",
  "Off",
  "Today",
  "Official",
];

/**
 * 返回广告创建国家对应的主要商业广告语言。
 */
export function getTargetLanguage(countryCode: string | null | undefined): TargetLanguage | null {
  const key = (countryCode ?? "").trim().toUpperCase() === "UK"
    ? "GB"
    : (countryCode ?? "").trim().toUpperCase();
  return TARGET_LANGUAGES[key] ?? null;
}

/**
 * 解析这份草稿真正要用的文案语言：用户在生成页显式选了语言就用它，否则回落到国家推导。
 *
 * 覆盖值必须走这里，而不是各处自己判断——生成提示词、英文词硬替换、发布前本地化门禁
 * 三条链路口径不一致时，会出现「按英语生成、按阿拉伯语审计」这种发不出去的草稿。
 */
export function resolveTargetLanguage(input: {
  countryCode?: string | null;
  languageCode?: string | null;
}): TargetLanguage | null {
  const override = findAdCopyLanguage(input.languageCode);
  if (override) return { code: override.code, label: override.label };
  return getTargetLanguage(input.countryCode);
}

function isEnglishTarget(language: TargetLanguage | null): boolean {
  return language?.code === "en";
}

function examplesFor(language: TargetLanguage): Array<{ english: string; local: string }> {
  const localExamples = new Map((LOCALIZATION_EXAMPLES[language.code] ?? []).map((item) => [item.english, item.local]));
  return COMMON_ENGLISH_AD_TERMS.map((english) => ({
    english,
    local: localExamples.get(english) ?? `使用 ${language.label} 本地表达`,
  }));
}

/**
 * 将单条文案中的常见英文广告通用词替换为目标语言等价表达。
 * 多词短语优先于单词（如先替换 "Store Online" 再替换 "Store"）。
 * 仅对非英语目标市场生效。
 */
export function localizeEnglishAdTermsInText(
  text: string,
  countryCode: string,
  languageCode?: string | null,
): string {
  const language = resolveTargetLanguage({ countryCode, languageCode });
  if (!language || isEnglishTarget(language) || !text.trim()) return text;

  const examples = examplesFor(language)
    .filter((item) => item.local.length > 0 && !item.local.startsWith("使用 "))
    .sort((a, b) => b.english.length - a.english.length);

  let localized = text;
  for (const { english, local } of examples) {
    const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "gi");
    localized = localized.replace(pattern, local);
  }
  return localized;
}

/**
 * 批量本地化 RSA 标题/描述文案。
 */
export function localizeRsaCopyTexts(
  texts: string[],
  countryCode: string,
  languageCode?: string | null,
): string[] {
  return texts.map((text) => localizeEnglishAdTermsInText(text, countryCode, languageCode));
}

/**
 * 构建生成阶段追加给模型的本地化硬约束。
 *
 * 用户显式指定语言时必须输出这段约束（哪怕目标语言就是英语），因为基础 prompt 的
 * 「Step 0：B. 国家 → 语言识别」会自行把 AE 推成阿拉伯语，不压住就会被它带偏。
 */
export function buildLocalizationPromptInstruction(
  countryCode: string,
  languageCode?: string | null,
): string {
  const language = resolveTargetLanguage({ countryCode, languageCode });
  if (!language) return "";
  const isExplicitOverride = findAdCopyLanguage(languageCode) !== null;
  if (isEnglishTarget(language) && !isExplicitOverride) return "";

  const overrideLine = isExplicitOverride
    ? "用户已显式指定文案语言，忽略【Step 0】里由国家推导出的语言。"
    : "";
  if (isEnglishTarget(language)) {
    return [
      "",
      "【广告文案语言硬约束】",
      `目标语言: ${language.label}`,
      overrideLine,
      "标题 / 描述 / Sitelink 全部使用英语；品牌名、注册商标、落地页固定产品名可以保留原文。",
    ].filter(Boolean).join("\n");
  }

  const examples = examplesFor(language)
    .map((item) => `${item.english} → ${item.local}`)
    .join("；");
  return [
    "",
    "【广告文案语言硬约束】",
    `目标语言: ${language.label}`,
    overrideLine,
    `通用广告词必须使用目标语言；品牌名、注册商标、落地页固定产品名可以保留原文。`,
    examples ? `本地化替换示例：${examples}` : "",
    "禁止使用未本地化的 English CTA / 促销 / 官方感通用词。",
  ].filter(Boolean).join("\n");
}

/**
 * 各非拉丁文字语言的"目标字符集"快速判断正则。命中任意一个字符即认为出现了目标语言。
 */
const TARGET_SCRIPT_PATTERNS: Partial<Record<string, RegExp>> = {
  ja: /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/,
  ko: /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/,
  zh: /[\u3400-\u4dbf\u4e00-\u9fff]/,
  ar: /[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/,
  he: /[\u0590-\u05ff\ufb1d-\ufb4f]/,
};

const SEVERITY_RANK: Record<LocalizationViolationSeverity, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * 当目标语言使用非拉丁字母（CJK / 阿拉伯 / 希伯来）且文案中完全没有出现该文字时返回 true。
 * 拉丁字母语言（fr/de/es/...）总是返回 false，由英文词检测兜底。
 */
function isMissingTargetScript(text: string, languageCode: string): boolean {
  const pattern = TARGET_SCRIPT_PATTERNS[languageCode];
  if (!pattern) return false;
  return !pattern.test(text);
}

/**
 * 文案是否只由"白名单品牌词 + 标点 / 数字 / 空白"构成。命中则跳过未本地化检测，
 * 避免误伤纯品牌词标题（如 "Nike" / "Owari Paris"）。
 */
function isWhitelistedBrandOnlyText(text: string, brandTokens: string[]): boolean {
  if (brandTokens.length === 0) return false;
  let stripped = text.toLowerCase();
  for (const token of brandTokens) {
    stripped = stripped.split(token).join(" ");
  }
  return /^[^a-z]*$/i.test(stripped);
}

/**
 * 检查非英语国家中常见英文广告通用词是否未本地化，并对 CJK / RTL 市场加做"目标字符集"硬检测。
 *
 * @param input.brandKeywords 可选品牌词白名单（小写匹配），命中后纯品牌词文案不会触发 no_localized_script。
 */
export function auditRsaLocalization(input: {
  countryCode: string | null | undefined;
  /** 生成时用户显式指定的文案语言；留空表示跟随国家。 */
  languageCode?: string | null;
  headlines: string[];
  descriptions: string[];
  brandKeywords?: string[];
}): LocalizationAuditResult {
  const expectedLanguage = resolveTargetLanguage({
    countryCode: input.countryCode,
    languageCode: input.languageCode,
  });
  if (!expectedLanguage || isEnglishTarget(expectedLanguage)) {
    return { expectedLanguage, violations: [], passed: true };
  }

  const brandTokens = (input.brandKeywords ?? [])
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => keyword.length > 0);

  const texts = [...input.headlines, ...input.descriptions];
  const violations: LocalizationViolation[] = [];
  const examples = examplesFor(expectedLanguage);
  for (const text of texts) {
    for (const example of examples) {
      const escaped = example.english.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`\\b${escaped}\\b`, "i");
      if (pattern.test(text)) {
        const isPhrase = example.english.includes(" ");
        violations.push({
          text,
          term: example.english,
          suggestion: example.local,
          rule: isPhrase ? "english_phrase" : "english_word",
          severity: isPhrase ? "high" : "low",
        });
      }
    }

    if (
      isMissingTargetScript(text, expectedLanguage.code) &&
      !isWhitelistedBrandOnlyText(text, brandTokens)
    ) {
      violations.push({
        text,
        term: "",
        suggestion: `请使用 ${expectedLanguage.label} 改写整条文案`,
        rule: "no_localized_script",
        severity: "medium",
      });
    }
  }

  violations.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return { expectedLanguage, violations, passed: violations.length === 0 };
}

function averageGoogleAdsLength(items: string[]): number {
  if (items.length === 0) return 0;
  return items.reduce((sum, item) => sum + googleAdsLength(item), 0) / items.length;
}

/**
 * 发布前内部质量分，参考 Google Ads 质量分的发布前可观测代理指标。
 */
export function scoreRsaPublishQuality(input: {
  headlines: string[];
  descriptions: string[];
}): RsaQualityResult {
  let score = 100;
  const reasons: string[] = [];

  if (input.headlines.length < 8) {
    const penalty = (8 - input.headlines.length) * 4;
    score -= penalty;
    reasons.push(`标题数量偏少，扣 ${penalty} 分`);
  }
  if (input.descriptions.length < 4) {
    const penalty = (4 - input.descriptions.length) * 5;
    score -= penalty;
    reasons.push(`描述数量偏少，扣 ${penalty} 分`);
  }

  const avgHeadlineLen = averageGoogleAdsLength(input.headlines);
  if (avgHeadlineLen > 0 && avgHeadlineLen < 12) {
    score -= 10;
    reasons.push("标题平均信息量偏低，扣 10 分");
  }

  const avgDescriptionLen = averageGoogleAdsLength(input.descriptions);
  if (avgDescriptionLen > 0 && avgDescriptionLen < 35) {
    score -= 10;
    reasons.push("描述平均信息量偏低，扣 10 分");
  }

  const uniqueHeadlineCount = new Set(input.headlines.map((item) => item.trim().toLowerCase())).size;
  if (uniqueHeadlineCount < input.headlines.length) {
    score -= 8;
    reasons.push("标题存在重复，扣 8 分");
  }

  const finalScore = Math.max(0, Math.round(score));
  return {
    score: finalScore,
    threshold: RSA_PUBLISH_QUALITY_THRESHOLD,
    passed: finalScore >= RSA_PUBLISH_QUALITY_THRESHOLD,
    reasons,
  };
}
