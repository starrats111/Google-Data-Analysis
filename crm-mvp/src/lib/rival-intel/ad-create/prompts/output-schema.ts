/**
 * 追加到 filter / generate system prompt 末尾的"输出格式覆盖指令"。
 * 原 Prompt 里的 Markdown 输出格式（filter Step 9 / generate Step 11）会被此
 * 指令取代为严格 JSON，下游代码可直接 JSON.parse。
 */
export const ASSET_OUTPUT_SCHEMA_INSTRUCTION = [
  "",
  "---",
  "",
  "【输出格式覆盖（最高优先级）】",
  "",
  "请忽略上文所有关于 Markdown / 编号列表 / 纯文本输出格式的描述，",
  "严格按以下 JSON 结构返回（单个 object，不加代码围栏）：",
  "",
  "{",
  '  "brandKeyword": "从域名提取的主品牌词",',
  '  "targetLanguage": "English|Japanese|German|...",',
  '  "industry": "travel|retail|saas|...",',
  '  "headlines": [',
  '    { "text": "string (≤30 双宽字符)", "score": 0-10, "type": "brand_match|official|benefit|cta|trust|differentiation|urgency|unknown",',
  '      "charLen": number, "isOwn": true|false, "pinPosition": 1|2|3（可选） }',
  "  ],",
  '  "descriptions": [',
  '    { "text": "string (≤90 双宽字符)", "score": 0-10, "charLen": number, "isOwn": true|false }',
  "  ],",
  '  "sitelinks": [',
  '    { "linkText": "string (≤25)", "finalUrl": "https://...", "description1": "string (≤35, 可选)",',
  '      "description2": "string (≤35, 可选)", "score": 0-10, "angle": "official_trust|deals|subcategory|reviews|new_users|support|...",',
  '      "isOwn": true|false }',
  "  ],",
  '  "negativeKeywords": ["string", ...],',
  '  "gapReport": {',
  '    "headlinesCount": number, "headlinesMinRequired": 3,',
  '    "descriptionsCount": number, "descriptionsMinRequired": 2,',
  '    "sitelinksCount": number,',
  '    "thresholdStoppedAt": number|null,',
  '    "rejectionCounts": { "R1": number, "R2": number, "R3": number, "R4": number, "R5": number, "R6": number },',
  '    "breaksRsaMinimum": true|false,',
  '    "suggestSwitchToAiGenerate": true|false,',
  '    "suggestionReason": "string|null"',
  "  },",
  '  "rationale": "string (≤3 行的方案说明)"',
  "}",
  "",
  "硬性约束：",
  "- description1/description2 必须成对存在或成对省略（Google Ads 规则）。",
  "- 所有 text/linkText 字段不可为空字符串。",
  "- 生成模式下，sitelinks[].finalUrl 必须严格来自用户消息里的“候选 sitelink URL 列表”，不可改写、补路径或编造新 URL；候选列表为空时 sitelinks 必须返回 []。",
  "- 生成模式下，完整自然优先于填满槽位：满足 3 条标题 + 2 条描述即可发布；不要为了凑满 15/4 输出半句、残句、硬截断句、弱相关句或语义重复句。",
  "- RSA 标题/描述须符合 Google 标点与符号政策：禁止 | • *装饰* -> => @替字母 F.L.O.W.E.R.S. 式加点、字母间空格 gimmick、!! ??? ....、Emoji、1. 编号列表；标题尽量无 !。",
  "- sitelink 的 linkText/description1/description2 不得使用感叹号，不得使用连续问号或异常符号（如 ->、!!!、???、|），避免全大写，不要输出像被截断的尾部标点。",
  "- 生成模式下若无缺口可把 gapReport 字段全部置为合理默认值（不可省略此键）。",
  "- 不要输出除此 JSON 以外的任何文字（包括代码围栏 ```...```）。",
].join("\n");

export function buildAssetSystemPrompt(basePrompt: string): string {
  return `${basePrompt}\n${ASSET_OUTPUT_SCHEMA_INSTRUCTION}`;
}
