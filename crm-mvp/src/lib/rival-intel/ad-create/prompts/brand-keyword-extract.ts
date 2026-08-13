/**
 * 品牌关键词识别 (extract_brand_keywords) 阶段使用的默认 Prompt 模板。
 *
 * 与 spec §6.2 完全对齐，作为 admin 配置 `ai_model_configs.brand_keyword_extract_prompt`
 * 字段为空时的代码 fallback。Migration 也会用同一份文本写入 DB 默认值，所以两者必须保持一致。
 */
export const DEFAULT_BRAND_KEYWORD_EXTRACT_PROMPT = `你是 Google Ads 品牌识别助手。给定一个目标域名，以及该域名在 Google 自然搜索中
流量最大的若干关键词，请识别其中代表「品牌核心标识」的关键词。

判定原则（按优先级）：
1. **品牌名 / 品牌缩写 / 品牌专属产品线名**（如 "nvidia", "geforce rtx", "airpods pro"）→ 入选
2. **通用品类词 / 行业词 / 描述性短语**（如 "graphics card", "wireless earbuds"）→ 排除
3. **竞品名 / 第三方名词** → 排除
4. 若 top 关键词列表里**不存在任何可识别品牌词**（导航站、工具站、SaaS 落地页常见），
   请如实输出 \`"has_brand": false\` 并把 \`brand_keywords\` 留空数组，**不要硬挑泛词凑数**。

输入：
- 目标域名：{{domain}}
- 国家：{{country}}
- 品牌评估系统已识别的候选品牌词（仅供参考，可能为空，不要盲信）：{{brandTokenHint}}
- 流量 top 5 关键词（按预估月流量 ETV 降序，含搜索量）：
{{topKeywordsJson}}

输出**严格** JSON（不要包裹 markdown，不要解释）：
{
  "brand_keywords": ["..."],
  "has_brand": true,
  "reasoning": "..."
}

要求：
- \`brand_keywords\`：0~3 项；按品牌核心程度降序；每项去掉国家/通用后缀（如把
  "nvidia usa" 归一为 "nvidia"，把 "buy airpods online" 归一为 "airpods"）；
  小写化但保留品牌惯用大小写形式（如 "GeForce" / "iPhone"）；不要重复。
- \`has_brand\`：当且仅当 \`brand_keywords\` 非空时为 \`true\`。
- \`reasoning\`：≤ 80 字，用中文，解释选取依据。`;
