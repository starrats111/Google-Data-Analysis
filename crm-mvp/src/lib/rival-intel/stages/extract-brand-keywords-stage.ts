/**
 * `extract_brand_keywords` 阶段的生产装配。
 *
 * 阶段本体（`ad-create/extract-brand-keywords.ts`）是纯 DI 编排器，缓存命中判定、
 * 预算门控、四级 fallback 链全在里面且有单测覆盖，移植时一行未改。这里只负责把它
 * 的依赖接到 CRM 的真实 I/O 上：
 *
 * | 依赖 | 接到哪 |
 * |---|---|
 * | DataForSEO 凭据 / 品牌 prompt / 预算上限 | `rival-intel/config.ts`（system_configs） |
 * | 今日已花 / 记账 | `brand-assessment/repository`（全公司共账，不按人分） |
 * | 7 天品牌词缓存 | `dataforseo_brand_keyword_cache`（按域名+国家+prompt hash 共享） |
 * | LLM | `deps/llm.ts` → CRM ai-service 按场景选模型 |
 */
import {
  runExtractBrandKeywordsStage as runOrchestrator,
  type ExtractBrandKeywordsResult,
  type RunExtractBrandKeywordsStageDeps,
} from "../ad-create/extract-brand-keywords";
import {
  computePromptHash,
  getCachedExtraction,
  setCachedExtraction,
} from "../ad-create/brand-keyword-cache";
import { extractCoreBrandKeywordsByAi } from "../ad-create/brand-keyword-ai";
import { countryCodeToDataForSeoParams } from "../ad-create/dataforseo-country-params";
import { defaultHttpPost, fetchRankedKeywords } from "../ad-create/dataforseo-client";
import * as brandRepo from "../brand-assessment/repository";
import { readBrandKeywordExtractPrompt, readDataForSeoCredentials } from "../config";
import { requestLlmCompletion } from "../deps/llm";

export interface ExtractBrandKeywordsStageInput {
  domain: string;
  countryCode: string | null;
  /** 阶段一写入的竞品数据，编排器只从里面读 brandToken 当 AI 提示 */
  sourcePayload: unknown;
}

export async function runExtractBrandKeywordsStage(
  input: ExtractBrandKeywordsStageInput,
): Promise<ExtractBrandKeywordsResult> {
  return runOrchestrator(
    {
      draft: {
        domain: input.domain,
        country_code: input.countryCode,
        source_payload: input.sourcePayload,
      },
    },
    buildDeps(),
  );
}

export function buildDeps(): RunExtractBrandKeywordsStageDeps {
  const httpPost = defaultHttpPost();
  return {
    loadConfig: async () => {
      const [creds, prompt, budget] = await Promise.all([
        readDataForSeoCredentials(),
        readBrandKeywordExtractPrompt(),
        brandRepo.readDailyBudgetUsd(),
      ]);
      // 凭据缺失不抛错：编排器有 credentials_missing_fallback，退回品牌评估给的
      // brandToken 或域名裸词，整条生成链照样能走完。
      return {
        dataforseoLogin: creds?.login ?? null,
        dataforseoPassword: creds?.password ?? null,
        brandKeywordExtractPrompt: prompt,
        dailyBrandBudgetUsd: budget,
      };
    },
    // 预算是一个总闸：今日 SerpApi + DataForSEO 合计，不分供应商各给一份额度
    getTodayTotalUsd: (params) => brandRepo.getTodayTotalUsd({ now: params.now }),
    addCostLedger: async (params) => {
      await brandRepo.addCostLedger({
        provider: "dataforseo",
        ledgerDate: params.ledgerDate,
        amountUsd: params.amountUsd,
      });
    },
    getCache: getCachedExtraction,
    setCache: setCachedExtraction,
    fetchRankedKeywords: (args) => fetchRankedKeywords(args, { httpPost }),
    extractByAi: (args) =>
      extractCoreBrandKeywordsByAi(args, {
        llm: async ({ messages, responseFormat }) => {
          const content = await requestLlmCompletion({
            systemPrompt: messages.find((m) => m.role === "system")?.content ?? "",
            userPrompt: messages.find((m) => m.role === "user")?.content ?? "",
            responseFormat,
          });
          return { content };
        },
      }),
    countryToParams: countryCodeToDataForSeoParams,
    computePromptHash,
    now: () => new Date(),
  };
}
