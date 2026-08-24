/**
 * 品牌评估引擎的生产装配：把注入式的 httpGet / llmCaller 接到 CRM 的实现上。
 *
 * D-233：kyads 侧这两个依赖在它的 API 路由里现场拼，且 LLM 走它自己的凭据表。
 * CRM 统一走 ai-service（管理台按场景选模型 + 失败降级），所以 `model` 字段回填的是
 * 场景名而不是具体模型名——真实用了哪个模型由 ai-service 的日志负责，这里只是给
 * llm-evaluator 的按次计费留个标识。
 */
import { callAiWithFallback } from "@/lib/ai-service";
import { createPooledSerpApiHttpGet } from "@/lib/serpapi-key-pool";
import type { LlmCaller } from "./llm-evaluator";
import type { HttpGet } from "./serpapi-client";

export const BRAND_ASSESSMENT_AI_SCENE = "brand_assessment";

const DEFAULT_TIMEOUT_MS = 30_000;

const rawHttpGet: HttpGet = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return { status: res.status, body: text };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 每跑一轮建一个新的池化 httpGet：撞额度自动换池内下一个 key。
 *
 * 必须是工厂而不是模块级单例——池化实例内部记着「本轮已试过哪些 key」，
 * 单例会让这份记录跨请求累积，某个 key 被试废一次后就再也轮不到它，
 * 哪怕它第二天额度已经重置。
 */
export function createBrandAssessmentHttpGet(): HttpGet {
  return createPooledSerpApiHttpGet({ baseHttpGet: rawHttpGet });
}

export const defaultLlmCaller: LlmCaller = async ({ systemPrompt, userPrompt }) => {
  const content = await callAiWithFallback(
    BRAND_ASSESSMENT_AI_SCENE,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    8192,
  );
  return { content, model: BRAND_ASSESSMENT_AI_SCENE };
};
