/**
 * 竞品情报引擎的运行期配置。
 *
 * D-233：kyads 把 SerpApi key、DataForSEO 账号、三份 prompt、每日预算全塞在它
 * 自己的 `ai_model_configs` 一行里（它那张表是个杂物抽屉）。CRM 侧按用途分开取：
 *
 * | 配置 | CRM 位置 |
 * |---|---|
 * | SerpApi key | `user_serpapi_keys` 共享池（serpapi-key-pool.ts） |
 * | AI 模型凭据 | `ai_providers` + `ai_model_configs` 管理台（ai-service.ts 按场景取） |
 * | DataForSEO 账号 | `system_configs.dataforseo_login` / `dataforseo_password`（复用 kyads 账号） |
 * | 每日花费上限 | `system_configs.brand_intel_daily_budget_usd` |
 * | 三份 prompt | `system_configs` 可覆盖，缺省用代码里的默认值 |
 *
 * prompt 走「库里有就用库里的、没有就用代码默认值」的两层结构：上线不用先去后台
 * 粘 prompt，07 想改措辞也不用改代码重新部署。
 */
import { getSystemConfig } from "@/lib/system-config";
import type { AdGenerationMode } from "./deps/generation-mode";

export const RIVAL_INTEL_CONFIG_KEYS = {
  DATAFORSEO_LOGIN: "dataforseo_login",
  DATAFORSEO_PASSWORD: "dataforseo_password",
  BRAND_KEYWORD_EXTRACT_PROMPT: "brand_keyword_extract_prompt",
  AD_PROMPT_FILTER: "rival_intel_ad_prompt_filter",
  AD_PROMPT_GENERATE: "rival_intel_ad_prompt_generate",
} as const;

export interface DataForSeoCredentials {
  login: string;
  password: string;
}

/**
 * DataForSEO 是 Basic Auth 的单账号，没有 key 池的概念。取不到时返回 null，
 * 由 extract_brand_keywords 阶段走它自己的 `credentials_missing_fallback`
 * （退回品牌词兜底），不让整条生成链因为少一个可选数据源而失败。
 */
export async function readDataForSeoCredentials(): Promise<DataForSeoCredentials | null> {
  const [login, password] = await Promise.all([
    getSystemConfig(RIVAL_INTEL_CONFIG_KEYS.DATAFORSEO_LOGIN).catch(() => null),
    getSystemConfig(RIVAL_INTEL_CONFIG_KEYS.DATAFORSEO_PASSWORD).catch(() => null),
  ]);
  if (!login?.trim() || !password?.trim()) return null;
  return { login: login.trim(), password: password.trim() };
}

export async function readBrandKeywordExtractPrompt(): Promise<string> {
  const override = await getSystemConfig(
    RIVAL_INTEL_CONFIG_KEYS.BRAND_KEYWORD_EXTRACT_PROMPT,
  ).catch(() => null);
  if (override && override.trim()) return override;
  const { DEFAULT_BRAND_KEYWORD_EXTRACT_PROMPT } = await import(
    "./ad-create/prompts/brand-keyword-extract"
  );
  return DEFAULT_BRAND_KEYWORD_EXTRACT_PROMPT;
}

/**
 * 两种生成模式各有一份 prompt：filter 只让 AI 从竞品现成文案里挑，
 * ai_generate 让它照竞品打法重写。对应 kyads 的 `loadAdPrompt(mode)`。
 */
export async function readAdPrompt(mode: AdGenerationMode): Promise<string> {
  const key =
    mode === "filter"
      ? RIVAL_INTEL_CONFIG_KEYS.AD_PROMPT_FILTER
      : RIVAL_INTEL_CONFIG_KEYS.AD_PROMPT_GENERATE;
  const override = await getSystemConfig(key).catch(() => null);
  if (override && override.trim()) return override;

  if (mode === "filter") {
    const { DEFAULT_AD_FILTER_PROMPT } = await import("./ad-create/prompts/filter");
    return DEFAULT_AD_FILTER_PROMPT;
  }
  const { DEFAULT_AD_GENERATE_PROMPT } = await import("./ad-create/prompts/generate");
  return DEFAULT_AD_GENERATE_PROMPT;
}
