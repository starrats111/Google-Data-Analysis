import type { CountryParams } from "./types";
import { AD_CREATE_COUNTRY_CODES } from "@/lib/rival-intel/ad-create/country-options";

/**
 * 品牌评估支持的国家白名单（ISO-2，大写），与广告创建/广告生成保持一致。
 */
export const COUNTRY_WHITELIST = AD_CREATE_COUNTRY_CODES;

export type SupportedCountry = (typeof COUNTRY_WHITELIST)[number];

export function normalizeCountryCode(country: string): string {
  const upper = country?.trim().toUpperCase();
  return upper === "UK" ? "GB" : upper;
}

export function countryLookupCodes(country: string): string[] {
  const normalized = normalizeCountryCode(country);
  return normalized === "GB" ? ["GB", "UK"] : [normalized];
}

/**
 * 白名单国家 → SerpApi 参数。
 * gl: 国家；hl: UI 语言；google_domain: 对应 google.xx 二级域。
 */
const GOOGLE_DOMAIN_BY_COUNTRY: Record<string, string> = {
  US: "google.com",
  CA: "google.ca",
  MX: "google.com.mx",
  GB: "google.co.uk",
  IE: "google.ie",
  DE: "google.de",
  FR: "google.fr",
  IT: "google.it",
  ES: "google.es",
  PT: "google.pt",
  NL: "google.nl",
  BE: "google.be",
  CH: "google.ch",
  AT: "google.at",
  SE: "google.se",
  NO: "google.no",
  DK: "google.dk",
  FI: "google.fi",
  PL: "google.pl",
  CZ: "google.cz",
  HU: "google.hu",
  RO: "google.ro",
  GR: "google.gr",
  TR: "google.com.tr",
  RU: "google.ru",
  UA: "google.com.ua",
  JP: "google.co.jp",
  KR: "google.co.kr",
  CN: "google.com.hk",
  HK: "google.com.hk",
  TW: "google.com.tw",
  SG: "google.com.sg",
  MY: "google.com.my",
  TH: "google.co.th",
  ID: "google.co.id",
  PH: "google.com.ph",
  VN: "google.com.vn",
  IN: "google.co.in",
  PK: "google.com.pk",
  BD: "google.com.bd",
  AE: "google.ae",
  SA: "google.com.sa",
  IL: "google.co.il",
  EG: "google.com.eg",
  ZA: "google.co.za",
  NG: "google.com.ng",
  KE: "google.co.ke",
  MA: "google.co.ma",
  AU: "google.com.au",
  NZ: "google.co.nz",
  BR: "google.com.br",
  AR: "google.com.ar",
  CL: "google.cl",
  CO: "google.com.co",
  PE: "google.com.pe",
};

const HL_BY_COUNTRY: Record<string, string> = {
  US: "en",
  CA: "en",
  MX: "es-MX",
  GB: "en",
  IE: "en",
  DE: "de",
  FR: "fr",
  IT: "it",
  ES: "es",
  PT: "pt-PT",
  NL: "nl",
  BE: "nl",
  CH: "de",
  AT: "de",
  SE: "sv",
  NO: "no",
  DK: "da",
  FI: "fi",
  PL: "pl",
  CZ: "cs",
  HU: "hu",
  RO: "ro",
  GR: "el",
  TR: "tr",
  RU: "ru",
  UA: "uk",
  JP: "ja",
  KR: "ko",
  CN: "zh-CN",
  // SerpApi 的 hl 白名单不接受 `zh-HK`（HTTP 400 "Unsupported `zh-HK` interface
  // language - hl parameter."），香港 google.com.hk 默认界面语言为繁中，与台湾
  // 共享 `zh-TW`，故映射为 zh-TW。详见 job=177 的事故复盘。
  HK: "zh-TW",
  TW: "zh-TW",
  SG: "en",
  MY: "ms",
  TH: "th",
  ID: "id",
  PH: "en",
  VN: "vi",
  IN: "en",
  PK: "en",
  BD: "bn",
  AE: "ar",
  SA: "ar",
  IL: "he",
  EG: "ar",
  ZA: "en",
  NG: "en",
  KE: "en",
  MA: "ar",
  AU: "en",
  NZ: "en",
  BR: "pt-BR",
  AR: "es-AR",
  CL: "es-CL",
  CO: "es-CO",
  PE: "es-PE",
};

/**
 * SerpApi `google_ads` 引擎要求的 `location` 英文地名（canonical name）。
 * 与 `gl` 搭配使用，避免仅依赖代理 IP 导致广告结果为空或跑偏。
 */
const SERPAPI_LOCATION_BY_COUNTRY: Record<string, string> = {
  US: "United States",
  CA: "Canada",
  MX: "Mexico",
  GB: "United Kingdom",
  IE: "Ireland",
  DE: "Germany",
  FR: "France",
  IT: "Italy",
  ES: "Spain",
  PT: "Portugal",
  NL: "Netherlands",
  BE: "Belgium",
  CH: "Switzerland",
  AT: "Austria",
  SE: "Sweden",
  NO: "Norway",
  DK: "Denmark",
  FI: "Finland",
  PL: "Poland",
  CZ: "Czechia",
  HU: "Hungary",
  RO: "Romania",
  GR: "Greece",
  TR: "Turkey",
  RU: "Russia",
  UA: "Ukraine",
  JP: "Japan",
  KR: "South Korea",
  CN: "China",
  HK: "Hong Kong",
  TW: "Taiwan",
  SG: "Singapore",
  MY: "Malaysia",
  TH: "Thailand",
  ID: "Indonesia",
  PH: "Philippines",
  VN: "Vietnam",
  IN: "India",
  PK: "Pakistan",
  BD: "Bangladesh",
  AE: "United Arab Emirates",
  SA: "Saudi Arabia",
  IL: "Israel",
  EG: "Egypt",
  ZA: "South Africa",
  NG: "Nigeria",
  KE: "Kenya",
  MA: "Morocco",
  AU: "Australia",
  NZ: "New Zealand",
  BR: "Brazil",
  AR: "Argentina",
  CL: "Chile",
  CO: "Colombia",
  PE: "Peru",
};

function serpapiLocationForCountry(country: string): string {
  return SERPAPI_LOCATION_BY_COUNTRY[country] ?? "United States";
}

function buildCountryParams(country: string) {
  return {
    gl: country.toLowerCase(),
    hl: HL_BY_COUNTRY[country] ?? "en",
    google_domain: GOOGLE_DOMAIN_BY_COUNTRY[country] ?? "google.com",
    trends_geo: country,
    serpapi_location: serpapiLocationForCountry(country),
  };
}

const COUNTRY_MAP = Object.fromEntries(
  COUNTRY_WHITELIST.map((country) => [country, buildCountryParams(country)]),
) as Record<
  string,
  {
    gl: string;
    hl: string;
    google_domain: string;
    trends_geo: string;
    serpapi_location: string;
  }
>;

/**
 * 解析国家 ISO-2 为 SerpApi 查询参数。
 * 不在白名单内的国家回退到 US（`isFallback=true`），上层应按 warning 处理。
 */
export function countryToParams(country: string): CountryParams {
  const normalized = normalizeCountryCode(country);
  if (normalized === "GB") {
    return { ...COUNTRY_MAP.GB, gl: "uk", isFallback: false };
  }
  const hit = COUNTRY_MAP[normalized];
  if (hit) {
    return { ...hit, isFallback: false };
  }
  return { ...COUNTRY_MAP.US, isFallback: true };
}

/**
 * 校验一个 ISO-2 是否属于白名单。
 */
export function isSupportedCountry(country: string): country is SupportedCountry {
  const normalized = normalizeCountryCode(country);
  return (COUNTRY_WHITELIST as readonly string[]).includes(normalized);
}
