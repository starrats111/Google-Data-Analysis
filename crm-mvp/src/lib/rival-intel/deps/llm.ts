/**
 * D-233：kyads 的 LLM 出口改接 CRM 的 AI 服务层。
 *
 * kyads 原来在自己的凭据面板里存一组 baseUrl / apiKey / model，每次调用现取现传
 * （`lib/ai/llm-router`）。CRM 这边的唯一真相源是管理台的 `ai_providers` +
 * `ai_model_configs`，由 `callAiWithFallback` 按场景取模型并做 priority fallback。
 * 两套凭据体系并存必然出现「一处充值另一处欠费」的账，所以这里把 kyads 传进来的
 * baseUrl / apiKey / model 全部丢掉，只保留参数位以满足它的注入式 deps 签名。
 *
 * 场景名用 `rival_intel_copy`：管理台没配这个场景时，CRM 的 D-162 兜底会自动降级到
 * `ad_copy` 场景的模型并告警，所以上线不需要先去补配置；07 想给竞品情报引擎单独换
 * 模型时，在管理台加一条 `rival_intel_copy` 即可生效。
 */
import { callAiWithFallback } from "@/lib/ai-service";

export const RIVAL_INTEL_AI_SCENE = "rival_intel_copy";

export interface LlmCompletionArgs {
  /** 保留仅为兼容 kyads 注入签名，CRM 走管理台配置，此值被忽略 */
  baseUrl?: string;
  /** 同上，被忽略 */
  apiKey?: string;
  /** 同上，被忽略 */
  model?: string;
  systemPrompt: string;
  userPrompt: string;
  responseFormat?: "json_object" | "text";
  temperature?: number;
  timeoutMs?: number;
  maxTokens?: number;
  /** 覆盖场景名，默认 rival_intel_copy */
  scene?: string;
}

/**
 * CRM 的 `callAi` 不发 `response_format`，也不接受 per-call temperature（温度取管理台配置）。
 * responseFormat=json_object 时改用 prompt 约束，配合 parseAssetResponse 的去围栏 +
 * 正则兜底，实测足够；这是刻意不改 ai-service 公共签名的取舍。
 */
export async function requestLlmCompletion(args: LlmCompletionArgs): Promise<string> {
  const jsonHint =
    args.responseFormat === "json_object"
      ? "\n\nReturn ONLY a single valid JSON object. No markdown fences, no explanation before or after."
      : "";

  return callAiWithFallback(
    args.scene || RIVAL_INTEL_AI_SCENE,
    [
      { role: "system", content: args.systemPrompt + jsonHint },
      { role: "user", content: args.userPrompt },
    ],
    args.maxTokens ?? 4096,
  );
}
