export interface AdMarketConfig {
  countryCode: string;
  countryNameZh: string;
  languageCode: string;
  languageName: string;
  style: string;
  currencyCode: string;
  shippingLabel: string;
  returnLabel: string;
  genericPromotionTarget: string;
  snippetHeader: string;
  priceLanguageCode: string;
  promotionLanguageCode: string;
}

const DEFAULT_MARKET: AdMarketConfig = {
  countryCode: "US",
  countryNameZh: "美国",
  languageCode: "en",
  languageName: "English (US)",
  style: "直接、行动导向、强调价值和优惠",
  currencyCode: "USD",
  shippingLabel: "Free US Shipping",
  returnLabel: "Easy Returns",
  genericPromotionTarget: "Special Offers",
  snippetHeader: "Brands",
  priceLanguageCode: "en",
  promotionLanguageCode: "en",
};

export const AD_MARKET_MAP: Record<string, AdMarketConfig> = {
  US: DEFAULT_MARKET,
  UK: {
    countryCode: "UK",
    countryNameZh: "英国",
    languageCode: "en",
    languageName: "English (UK)",
    style: "含蓄、品质导向、使用英式表达",
    currencyCode: "GBP",
    shippingLabel: "Free UK Delivery",
    returnLabel: "Easy Returns",
    genericPromotionTarget: "Limited-Time Offers",
    snippetHeader: "Brands",
    priceLanguageCode: "en",
    promotionLanguageCode: "en",
  },
  GB: {
    countryCode: "GB",
    countryNameZh: "英国",
    languageCode: "en",
    languageName: "English (UK)",
    style: "含蓄、品质导向、使用英式表达",
    currencyCode: "GBP",
    shippingLabel: "Free UK Delivery",
    returnLabel: "Easy Returns",
    genericPromotionTarget: "Limited-Time Offers",
    snippetHeader: "Brands",
    priceLanguageCode: "en",
    promotionLanguageCode: "en",
  },
  CA: {
    countryCode: "CA",
    countryNameZh: "加拿大",
    languageCode: "en",
    languageName: "English (CA)",
    style: "强调价值、信任感与可持续感",
    currencyCode: "CAD",
    shippingLabel: "Free CA Shipping",
    returnLabel: "Easy Returns",
    genericPromotionTarget: "Special Offers",
    snippetHeader: "Brands",
    priceLanguageCode: "en",
    promotionLanguageCode: "en",
  },
  AU: {
    countryCode: "AU",
    countryNameZh: "澳大利亚",
    languageCode: "en",
    languageName: "English (AU)",
    style: "轻快直接、强调易用性与日常场景",
    currencyCode: "AUD",
    shippingLabel: "Free AU Shipping",
    returnLabel: "Easy Returns",
    genericPromotionTarget: "Special Offers",
    snippetHeader: "Brands",
    priceLanguageCode: "en",
    promotionLanguageCode: "en",
  },
  DE: {
    countryCode: "DE",
    countryNameZh: "德国",
    languageCode: "de",
    languageName: "German",
    style: "严谨、强调品质、参数、效率与可信度",
    currencyCode: "EUR",
    shippingLabel: "Kostenloser Versand",
    returnLabel: "Kostenlose Rückgabe",
    genericPromotionTarget: "Sonderangebote",
    snippetHeader: "Brands",
    priceLanguageCode: "de",
    promotionLanguageCode: "de",
  },
  AT: {
    countryCode: "AT",
    countryNameZh: "奥地利",
    languageCode: "de",
    languageName: "German",
    style: "严谨、强调品质、参数与可信度",
    currencyCode: "EUR",
    shippingLabel: "Kostenloser Versand",
    returnLabel: "Kostenlose Rückgabe",
    genericPromotionTarget: "Sonderangebote",
    snippetHeader: "Brands",
    priceLanguageCode: "de",
    promotionLanguageCode: "de",
  },
  CH: {
    countryCode: "CH",
    countryNameZh: "瑞士",
    languageCode: "de",
    languageName: "German",
    style: "严谨、强调品质、参数与可信度",
    currencyCode: "CHF",
    shippingLabel: "Kostenloser Versand",
    returnLabel: "Kostenlose Rückgabe",
    genericPromotionTarget: "Sonderangebote",
    snippetHeader: "Brands",
    priceLanguageCode: "de",
    promotionLanguageCode: "de",
  },
  FR: {
    countryCode: "FR",
    countryNameZh: "法国",
    languageCode: "fr",
    languageName: "French",
    style: "优雅、重视设计感与品质表达",
    currencyCode: "EUR",
    shippingLabel: "Livraison offerte",
    returnLabel: "Retours faciles",
    genericPromotionTarget: "Offres spéciales",
    snippetHeader: "Brands",
    priceLanguageCode: "fr",
    promotionLanguageCode: "fr",
  },
  BE: {
    countryCode: "BE",
    countryNameZh: "比利时",
    languageCode: "fr",
    languageName: "French",
    style: "优雅、重视设计感与品质表达",
    currencyCode: "EUR",
    shippingLabel: "Livraison offerte",
    returnLabel: "Retours faciles",
    genericPromotionTarget: "Offres spéciales",
    snippetHeader: "Brands",
    priceLanguageCode: "fr",
    promotionLanguageCode: "fr",
  },
  ES: {
    countryCode: "ES",
    countryNameZh: "西班牙",
    languageCode: "es",
    languageName: "Spanish",
    style: "热情直接、强调优惠和购买动机",
    currencyCode: "EUR",
    shippingLabel: "Envío gratis",
    returnLabel: "Devoluciones fáciles",
    genericPromotionTarget: "Ofertas especiales",
    snippetHeader: "Brands",
    priceLanguageCode: "es",
    promotionLanguageCode: "es",
  },
  IT: {
    countryCode: "IT",
    countryNameZh: "意大利",
    languageCode: "it",
    languageName: "Italian",
    style: "强调品质、风格与价值感",
    currencyCode: "EUR",
    shippingLabel: "Spedizione gratuita",
    returnLabel: "Resi facili",
    genericPromotionTarget: "Offerte speciali",
    snippetHeader: "Marchi",
    priceLanguageCode: "it",
    promotionLanguageCode: "it",
  },
  PT: {
    countryCode: "PT",
    countryNameZh: "葡萄牙",
    languageCode: "pt",
    languageName: "Portuguese",
    style: "强调优惠与可信感",
    currencyCode: "EUR",
    shippingLabel: "Envio grátis",
    returnLabel: "Devoluções fáceis",
    genericPromotionTarget: "Ofertas especiais",
    snippetHeader: "Brands",
    priceLanguageCode: "pt",
    promotionLanguageCode: "pt",
  },
  BR: {
    countryCode: "BR",
    countryNameZh: "巴西",
    languageCode: "pt",
    languageName: "Portuguese (BR)",
    style: "热情、强调优惠、社交证明和购买欲",
    currencyCode: "BRL",
    shippingLabel: "Frete grátis",
    returnLabel: "Troca fácil",
    genericPromotionTarget: "Ofertas especiais",
    snippetHeader: "Brands",
    priceLanguageCode: "pt",
    promotionLanguageCode: "pt",
  },
  NL: {
    countryCode: "NL",
    countryNameZh: "荷兰",
    languageCode: "nl",
    languageName: "Dutch",
    style: "简洁务实、强调清晰价值",
    currencyCode: "EUR",
    shippingLabel: "Gratis verzending",
    returnLabel: "Eenvoudig retourneren",
    genericPromotionTarget: "Speciale aanbiedingen",
    snippetHeader: "Merken",
    priceLanguageCode: "nl",
    promotionLanguageCode: "nl",
  },
  JP: {
    countryCode: "JP",
    countryNameZh: "日本",
    languageCode: "ja",
    languageName: "Japanese",
    style: "礼貌克制、强调品质、服务与信赖",
    currencyCode: "JPY",
    shippingLabel: "全国送料無料",
    returnLabel: "返品対応",
    genericPromotionTarget: "おすすめキャンペーン",
    snippetHeader: "ブランド",
    priceLanguageCode: "ja",
    promotionLanguageCode: "ja",
  },
};

export function getAdMarketConfig(country?: string): AdMarketConfig {
  const key = String(country || "US").toUpperCase();
  return AD_MARKET_MAP[key] || DEFAULT_MARKET;
}

export function getLanguageCodeByCountry(country?: string): string {
  return getAdMarketConfig(country).languageCode;
}

export function getCurrencyCodeByCountry(country?: string): string {
  return getAdMarketConfig(country).currencyCode;
}

export function getPromotionLanguageCodeByCountry(country?: string): string {
  return getAdMarketConfig(country).promotionLanguageCode;
}

export function getPriceLanguageCodeByCountry(country?: string): string {
  return getAdMarketConfig(country).priceLanguageCode;
}

export function getSnippetHeaderByCountry(country?: string): string {
  return getAdMarketConfig(country).snippetHeader;
}
