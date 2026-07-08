/**
 * D-008 F-1：ATC 区域 / 国家清单（单一信源）
 *
 * 前后端共用：
 *   - 后端 atc-service.ts 通过 REGION_CODE_MAP 将 ISO code 转 SerpApi 数字码
 *   - 前端 3 个入口（intelligence / merchants / advertisers）通过 GET /api/user/atc/regions 异步拉取
 *
 * 全量国家支持：SerpApi google_ads_transparency_center 的 region 数字码
 * 规律为「2000 + ISO 3166-1 数字码」（US 840→2840、GB 826→2826、AU 036→2036，
 * 已对原 26 国逐一验证吻合），因此这里只维护标准 ISO 码表即可覆盖全部国家/地区：
 *   - 中文名：运行时用 Intl.DisplayNames("zh-Hans") 自动生成
 *   - 国旗 emoji：由 2 字母码的 Regional Indicator 码点计算
 *   - 排序：07 团队主投市场（priority < 100）置顶，其余按 ISO 码字母序
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

/** 07 团队主投市场排序优先级（数字越小越靠前），未列出的国家排在后面按码字母序 */
const REGION_PRIORITY: Record<string, number> = {
  US: 1, GB: 2, AU: 3, CA: 4,
  DE: 10, FR: 11, IT: 12, ES: 13, NL: 14, SE: 15, NO: 16, DK: 17, FI: 18,
  PL: 19, AT: 20, CH: 21, BE: 22, IE: 23, PT: 24,
  JP: 30, SG: 31, KR: 32, IN: 33, NZ: 34,
  BR: 40, MX: 41,
};

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

/** 由 2 字母 ISO 码计算国旗 emoji（Regional Indicator Symbols） */
export function flagEmoji(code: string): string {
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

const zhDisplayNames = (() => {
  try {
    return new Intl.DisplayNames(["zh-Hans"], { type: "region" });
  } catch {
    return null;
  }
})();

/** ISO 码 → 中文名（Intl 自动生成；缺失时回退为码本身） */
export function zhRegionName(code: string): string {
  const upper = code.toUpperCase();
  try {
    const name = zhDisplayNames?.of(upper);
    return name && name !== upper ? name : upper;
  } catch {
    return upper;
  }
}

/**
 * 返回前端展示用的 region 列表（主投市场置顶，其余按码字母序）。
 * 用于 /api/user/atc/regions 接口与前端 SSR fallback。
 */
export function getDisplayRegions(): Array<{
  value: string;
  label: string;
  zhName: string;
  flag: string;
}> {
  return Object.keys(ISO_NUMERIC)
    .sort((a, b) => {
      const pa = REGION_PRIORITY[a] ?? 1000;
      const pb = REGION_PRIORITY[b] ?? 1000;
      return pa !== pb ? pa - pb : a.localeCompare(b);
    })
    .map((code) => {
      const zhName = zhRegionName(code);
      const flag = flagEmoji(code);
      return {
        value: code,
        label: `${flag} ${zhName} (${code})`,
        zhName,
        flag,
      };
    });
}
