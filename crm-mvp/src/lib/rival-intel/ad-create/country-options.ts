export interface CountryOption {
  value: string;
  label: string;
}

export interface CountryOptionGroup {
  label: string;
  options: CountryOption[];
}

export const AD_CREATE_COUNTRY_OPTIONS: CountryOptionGroup[] = [
  {
    label: "北美",
    options: [
      { value: "US", label: "美国 (US)" },
      { value: "CA", label: "加拿大 (CA)" },
      { value: "MX", label: "墨西哥 (MX)" },
    ],
  },
  {
    label: "欧洲",
    options: [
      { value: "GB", label: "英国 (GB)" },
      { value: "IE", label: "爱尔兰 (IE)" },
      { value: "DE", label: "德国 (DE)" },
      { value: "FR", label: "法国 (FR)" },
      { value: "IT", label: "意大利 (IT)" },
      { value: "ES", label: "西班牙 (ES)" },
      { value: "PT", label: "葡萄牙 (PT)" },
      { value: "NL", label: "荷兰 (NL)" },
      { value: "BE", label: "比利时 (BE)" },
      { value: "CH", label: "瑞士 (CH)" },
      { value: "AT", label: "奥地利 (AT)" },
      { value: "SE", label: "瑞典 (SE)" },
      { value: "NO", label: "挪威 (NO)" },
      { value: "DK", label: "丹麦 (DK)" },
      { value: "FI", label: "芬兰 (FI)" },
      { value: "PL", label: "波兰 (PL)" },
      { value: "CZ", label: "捷克 (CZ)" },
      { value: "HU", label: "匈牙利 (HU)" },
      { value: "RO", label: "罗马尼亚 (RO)" },
      { value: "GR", label: "希腊 (GR)" },
      { value: "TR", label: "土耳其 (TR)" },
      { value: "RU", label: "俄罗斯 (RU)" },
      { value: "UA", label: "乌克兰 (UA)" },
    ],
  },
  {
    label: "亚洲",
    options: [
      { value: "JP", label: "日本 (JP)" },
      { value: "KR", label: "韩国 (KR)" },
      { value: "CN", label: "中国 (CN)" },
      { value: "HK", label: "中国香港 (HK)" },
      { value: "TW", label: "中国台湾 (TW)" },
      { value: "SG", label: "新加坡 (SG)" },
      { value: "MY", label: "马来西亚 (MY)" },
      { value: "TH", label: "泰国 (TH)" },
      { value: "ID", label: "印度尼西亚 (ID)" },
      { value: "PH", label: "菲律宾 (PH)" },
      { value: "VN", label: "越南 (VN)" },
      { value: "IN", label: "印度 (IN)" },
      { value: "PK", label: "巴基斯坦 (PK)" },
      { value: "BD", label: "孟加拉国 (BD)" },
    ],
  },
  {
    label: "中东 & 非洲",
    options: [
      { value: "AE", label: "阿联酋 (AE)" },
      { value: "SA", label: "沙特阿拉伯 (SA)" },
      { value: "IL", label: "以色列 (IL)" },
      { value: "EG", label: "埃及 (EG)" },
      { value: "ZA", label: "南非 (ZA)" },
      { value: "NG", label: "尼日利亚 (NG)" },
      { value: "KE", label: "肯尼亚 (KE)" },
      { value: "MA", label: "摩洛哥 (MA)" },
    ],
  },
  {
    label: "大洋洲",
    options: [
      { value: "AU", label: "澳大利亚 (AU)" },
      { value: "NZ", label: "新西兰 (NZ)" },
    ],
  },
  {
    label: "南美",
    options: [
      { value: "BR", label: "巴西 (BR)" },
      { value: "AR", label: "阿根廷 (AR)" },
      { value: "CL", label: "智利 (CL)" },
      { value: "CO", label: "哥伦比亚 (CO)" },
      { value: "PE", label: "秘鲁 (PE)" },
    ],
  },
];

export const AD_CREATE_COUNTRY_CODES = AD_CREATE_COUNTRY_OPTIONS.flatMap((group) =>
  group.options.map((option) => option.value),
);
