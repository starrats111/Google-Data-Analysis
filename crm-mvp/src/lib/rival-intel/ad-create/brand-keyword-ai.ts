/**
 * @fileoverview 品牌核心词 AI 提取层 (spec §6)。
 *
 * 纯 DI 设计：调用方注入 `llm` 实现（采用 `{ messages } => { content }` 形状），
 * 模块内不感知任何具体 LLM 客户端。orchestrator (Task 9) 负责把项目里
 * 现有的 `defaultLlm` 适配到这个最小接口，并决定 `prompt` 默认值。
 *
 * 流程：
 *   1. 用 `{{domain}} / {{country}} / {{brandTokenHint}} / {{topKeywordsJson}}`
 *      渲染传入的 `prompt` 模板；`brandTokenHint` 为空或仅空白时渲染为 "（无）"。
 *   2. 以单条 user 消息调用 `deps.llm`，并要求 `responseFormat: "json_object"`。
 *   3. 剥离可能存在的 markdown ```json ``` 围栏后 `JSON.parse`，失败则抛
 *      {@link AiParseError}。
 *   4. 校验 `brand_keywords` 必须是 `string[]`、`has_brand` 必须是 `boolean`，
 *      否则抛 {@link AiParseError}。
 *   5. 清洗 `brand_keywords`：trim、丢弃空串、丢弃 length > 60、忽略大小写去重
 *      （保留首次出现的大小写），最多取前 3 项。
 *   6. `hasBrand` 仅由清洗后的列表是否非空决定，**不透传** LLM 输出的 `has_brand`。
 *   7. `reasoning` 兜底为 `""`；超过 200 字符截断。
 */

/**
 * AI 品牌词提取的归一化输出。
 */
export type AiBrandExtraction = {
  /** 清洗后的品牌核心词，0..3 项，每项 1..60 字符，case-insensitive 去重。 */
  brandKeywords: string[];
  /** 仅当 `brandKeywords` 非空时为 true；忽略 LLM 自报的 `has_brand`。 */
  hasBrand: boolean;
  /** LLM 解释文本，最长 200 字符；不是 string 时兜底为 ""。 */
  reasoning: string;
};

/**
 * 调用 {@link extractCoreBrandKeywordsByAi} 的入参。
 */
export interface ExtractByAiArgs {
  /** 目标域名，例如 `nvidia.com`。 */
  domain: string;
  /** 国家代码，例如 `US`（与 DataForSEO locationCode 对齐的上游标识）。 */
  country: string;
  /** DataForSEO 排名前 5 的关键词（已归一化的四元组）。 */
  topKeywords: Array<{ keyword: string; etv: number; searchVolume: number; rank: number }>;
  /** 品牌评估系统给出的候选品牌词；为空（null/""/纯空白）时渲染为 "（无）"。 */
  brandTokenHint: string | null;
  /**
   * Prompt 模板。由 orchestrator 决定默认值（通常是
   * `DEFAULT_BRAND_KEYWORD_EXTRACT_PROMPT`），本模块刻意不导入它以保持纯 DI。
   * 必须包含 4 个占位符：`{{domain}} {{country}} {{brandTokenHint}} {{topKeywordsJson}}`。
   */
  prompt: string;
}

/**
 * {@link extractCoreBrandKeywordsByAi} 的依赖注入接口。
 *
 * 此处刻意使用 `{ messages } => { content }` 形状，与 `ai-asset-generator.ts:defaultLlm`
 * 形状不同：本模块有自己最小化的 LLM 接口，装配层负责适配。
 *
 * D-233：原签名里还有一个 `config: { apiBaseUrl, apiKey, model }`——kyads 每次调用
 * 现取现传自己那套凭据。CRM 的模型选择归 `ai-service` 按场景决定，这个参数已无处可传，
 * 整个去掉而不是留个被忽略的占位。
 */
export interface ExtractByAiDeps {
  llm: (args: {
    messages: Array<{ role: "system" | "user"; content: string }>;
    responseFormat?: "json_object";
  }) => Promise<{ content: string }>;
}

/**
 * LLM 输出无法被解析或形状不符合预期时抛出。
 */
export class AiParseError extends Error {
  /**
   * @param message 人类可读的错误描述
   * @param cause 原始错误（如 `JSON.parse` 抛出的 `SyntaxError`）
   */
  constructor(message: string, public cause?: unknown) {
    super(message);
    this.name = "AiParseError";
  }
}

/** 单项品牌词最大字符数（spec §6.3）。 */
const MAX_KEYWORD_LEN = 60;
/** 最终保留的品牌词最大条数（spec §6.3）。 */
const MAX_KEYWORDS = 3;
/** `reasoning` 字段最大字符数（spec §6.3）。 */
const MAX_REASONING_LEN = 200;

/**
 * 调 LLM 提取品牌核心词。详见文件 JSDoc 中的流程说明。
 *
 * @param args 业务入参（域名、国家、top 关键词、品牌提示、prompt 模板）
 * @param deps 依赖注入（必须提供 `llm`）
 * @returns 归一化后的 {@link AiBrandExtraction}
 * @throws {AiParseError} 当 LLM 返回非 JSON、或字段类型不符合预期时
 */
export async function extractCoreBrandKeywordsByAi(
  args: ExtractByAiArgs,
  deps: ExtractByAiDeps,
): Promise<AiBrandExtraction> {
  const hint =
    args.brandTokenHint && args.brandTokenHint.trim() ? args.brandTokenHint : "（无）";
  const topKeywordsJson = JSON.stringify(args.topKeywords);
  const placeholderValues: Record<string, string> = {
    domain: args.domain,
    country: args.country,
    brandTokenHint: hint,
    topKeywordsJson,
  };
  const userContent = args.prompt.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => placeholderValues[key] ?? `{{${key}}}`,
  );

  const { content } = await deps.llm({
    messages: [{ role: "user", content: userContent }],
    responseFormat: "json_object",
  });

  let stripped = typeof content === "string" ? content.trim() : "";
  const fenceMatch = stripped.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  if (fenceMatch) {
    stripped = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (e) {
    throw new AiParseError(
      `brand-keyword-ai: failed to parse LLM JSON: ${(e as Error).message}`,
      e,
    );
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new AiParseError("brand-keyword-ai: parsed value is not an object");
  }
  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.brand_keywords)) {
    throw new AiParseError("brand-keyword-ai: brand_keywords is not an array");
  }
  if (typeof obj.has_brand !== "boolean") {
    throw new AiParseError("brand-keyword-ai: has_brand is not a boolean");
  }
  for (const k of obj.brand_keywords) {
    if (typeof k !== "string") {
      throw new AiParseError("brand-keyword-ai: brand_keywords items must be strings");
    }
  }
  const rawList = obj.brand_keywords as string[];

  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawList) {
    const t = raw.trim();
    if (!t || t.length > MAX_KEYWORD_LEN) continue;
    const lower = t.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    cleaned.push(t);
    if (cleaned.length === MAX_KEYWORDS) break;
  }

  let reasoning = typeof obj.reasoning === "string" ? obj.reasoning : "";
  if (reasoning.length > MAX_REASONING_LEN) {
    reasoning = reasoning.slice(0, MAX_REASONING_LEN);
  }

  return {
    brandKeywords: cleaned,
    hasBrand: cleaned.length > 0,
    reasoning,
  };
}
