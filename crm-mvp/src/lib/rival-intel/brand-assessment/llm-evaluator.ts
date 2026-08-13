/**
 * LLM 评估层。
 *
 * 职责：
 *   1. `buildPrompt` 组装 system + user（user = derived payload 的 JSON.stringify）
 *   2. `parseAndValidateOutput` 对 LLM 返回做硬校验（spec §7.4）
 *   3. `estimateLlmCostUsd` 按 tokens 估算成本
 *
 * 调用 LLM 的动作抽象成 `LlmCaller` 依赖注入接口，测试可直接 mock。
 */

import type {
  LlmDecision,
  LlmOutput,
  LlmScores,
} from "./types";

// ---------------------------------------------------------------------------
// LLM caller contract (DI)
// ---------------------------------------------------------------------------

export interface LlmCallInput {
  systemPrompt: string;
  userPrompt: string;
}

export interface LlmCallUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface LlmCallResult {
  content: string;
  usage?: LlmCallUsage;
  model: string;
}

export type LlmCaller = (input: LlmCallInput) => Promise<LlmCallResult>;

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/**
 * 当前后端使用中转 API（aicodewith 等），按次固定计费，与模型无关：
 * 每次成功发出的 LLM 请求一律记 $0.02，不再按 token 估算。历史上基于
 * prompt/completion tokens 的估算公式在这种计费模式下结果恒为 0（中转
 * 多数不回传 usage），导致日预算熔断形同虚设。
 *
 * 如日后切回按 token 计费的直连通道，恢复原 PRICE TABLE 即可——函数
 * 签名 `(model, usage)` 保留，以便上层零改动。
 */
export const LLM_FLAT_COST_PER_CALL_USD = 0.02;

/**
 * @deprecated 中转按次计费期间未使用；保留导出避免误伤外部引用。
 * 恢复 token 计费时需重新填充并在 estimateLlmCostUsd 内启用。
 */
export const LLM_PRICE_TABLE_USD_PER_1K: Record<
  string,
  { prompt: number; completion: number }
> = {};

export function estimateLlmCostUsd(
  _model: string,
  _usage: LlmCallUsage | undefined,
): number {
  void _model;
  void _usage;
  return LLM_FLAT_COST_PER_CALL_USD;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildPrompt(
  systemPrompt: string,
  userPayload: unknown,
): LlmCallInput {
  return {
    systemPrompt,
    userPrompt: JSON.stringify(userPayload),
  };
}

// ---------------------------------------------------------------------------
// Hard validation
// ---------------------------------------------------------------------------

const RECOMMENDED_ACTIONS = new Set([
  "launch_now",
  "launch",
  "test_small",
  "do_not_launch",
]);
const PRIORITIES = new Set(["high", "medium", "low"]);
const ARB_LEVELS = new Set([
  "high_potential",
  "testable",
  "cautious_test",
  "low_potential",
]);

function isIntegerInRange(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
}

export type ValidationResult =
  | { status: "ok"; output: LlmOutput; warnings: string[] }
  | { status: "failed"; error: string; output: null; warnings: string[] };

/**
 * Strip common non-JSON wrappers before parsing. Motivated by real-world
 * provider behavior observed in this codebase:
 *   - Anthropic Claude (especially Haiku) ignores "no markdown" prompt rules
 *     and routinely wraps replies in ```json ... ``` fences.
 *   - Some OpenAI-compat relays prepend a polite preface line before the
 *     JSON object.
 * The goal is to reach the first balanced `{...}` block without changing
 * the JSON content itself — we never try to "fix" broken JSON, only to
 * unwrap valid JSON hidden by envelope text.
 */
function extractJsonPayload(raw: string): string {
  let s = raw.trim();
  // Fenced: ```json\n{...}\n```  or  ```\n{...}\n```
  const fenceMatch = s.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  }
  // If there's still leading/trailing prose around a JSON object, slice to
  // the outermost braces. This only fires when the trimmed string does not
  // already start with `{`, avoiding corruption of pure-JSON payloads.
  if (s.length > 0 && s[0] !== "{") {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first !== -1 && last > first) {
      s = s.slice(first, last + 1);
    }
  }
  return s;
}

export function parseAndValidateOutput(raw: string): ValidationResult {
  const warnings: string[] = [];
  let json: Record<string, unknown>;
  try {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) {
      return {
        status: "failed",
        error: "empty LLM content",
        output: null,
        warnings,
      };
    }
    const unwrapped = extractJsonPayload(trimmed);
    if (unwrapped !== trimmed) {
      warnings.push(
        `stripped non-JSON wrapper from LLM output (original len=${trimmed.length}, payload len=${unwrapped.length})`,
      );
    }
    json = JSON.parse(unwrapped);
  } catch (e) {
    return {
      status: "failed",
      error: `LLM output is not valid JSON: ${(e as Error).message}`,
      output: null,
      warnings,
    };
  }

  const scoresRaw = json.scores as Record<string, unknown> | undefined;
  if (!scoresRaw || typeof scoresRaw !== "object") {
    return {
      status: "failed",
      error: "missing scores object",
      output: null,
      warnings,
    };
  }
  const requiredScores: Array<[keyof LlmScores, number, number]> = [
    ["commercial_activity", 0, 10],
    ["interceptability", 0, 10],
    ["official_pressure", 0, 10],
    ["intent_expansion", 0, 10],
    ["country_fit", 0, 10],
    ["observable_arbitrage_score", 0, 50],
  ];
  const scores: Partial<LlmScores> = {};
  for (const [k, lo, hi] of requiredScores) {
    const v = scoresRaw[k];
    if (!isIntegerInRange(v, lo, hi)) {
      return {
        status: "failed",
        error: `scores.${String(k)} out of range [${lo},${hi}]: ${String(v)}`,
        output: null,
        warnings,
      };
    }
    scores[k] = Math.trunc(v);
  }

  const decisionRaw = json.decision as Record<string, unknown> | undefined;
  if (!decisionRaw) {
    return {
      status: "failed",
      error: "missing decision object",
      output: null,
      warnings,
    };
  }
  const action = decisionRaw.recommended_action;
  const priority = decisionRaw.priority;
  const level = decisionRaw.arbitrage_level;
  if (!RECOMMENDED_ACTIONS.has(String(action))) {
    return {
      status: "failed",
      error: `decision.recommended_action invalid: ${String(action)}`,
      output: null,
      warnings,
    };
  }
  if (!PRIORITIES.has(String(priority))) {
    return {
      status: "failed",
      error: `decision.priority invalid: ${String(priority)}`,
      output: null,
      warnings,
    };
  }
  if (!ARB_LEVELS.has(String(level))) {
    return {
      status: "failed",
      error: `decision.arbitrage_level invalid: ${String(level)}`,
      output: null,
      warnings,
    };
  }

  const dc = json.data_completeness;
  if (typeof dc !== "number" || !(dc >= 0 && dc <= 1)) {
    return {
      status: "failed",
      error: `data_completeness out of [0,1]: ${String(dc)}`,
      output: null,
      warnings,
    };
  }

  const metadataRaw = (json.metadata ?? {}) as Record<string, unknown>;
  if (
    typeof metadataRaw.brand_token !== "string" ||
    !metadataRaw.brand_token.trim()
  ) {
    warnings.push("metadata.brand_token missing");
  }

  const reasonsRaw = (json.reasons ?? {}) as Record<string, unknown>;
  const textFields = [
    "commercial_activity_reason",
    "interceptability_reason",
    "official_pressure_reason",
    "intent_expansion_reason",
    "country_fit_reason",
  ];
  for (const f of textFields) {
    if (
      typeof reasonsRaw[f] !== "string" ||
      !(reasonsRaw[f] as string).trim()
    ) {
      warnings.push(`reasons.${f} missing`);
    }
  }

  const decision: LlmDecision = {
    recommended_action: action as LlmDecision["recommended_action"],
    priority: priority as LlmDecision["priority"],
    arbitrage_level: level as LlmDecision["arbitrage_level"],
    test_directions: Array.isArray(decisionRaw.test_directions)
      ? (decisionRaw.test_directions as unknown[]).filter(
          (x): x is string => typeof x === "string",
        )
      : undefined,
    do_not_launch_reason:
      typeof decisionRaw.do_not_launch_reason === "string"
        ? decisionRaw.do_not_launch_reason
        : undefined,
  };

  const profitRaw =
    (json.profit_projection as Record<string, unknown> | undefined) ?? {
      projection_available: false,
    };

  const output: LlmOutput = {
    metadata: {
      brand_token: String(metadataRaw.brand_token ?? "").trim(),
      industry:
        typeof metadataRaw.industry === "string"
          ? metadataRaw.industry
          : undefined,
      is_strong_brand_entity:
        typeof metadataRaw.is_strong_brand_entity === "boolean"
          ? metadataRaw.is_strong_brand_entity
          : undefined,
      target_language:
        typeof metadataRaw.target_language === "string"
          ? metadataRaw.target_language
          : undefined,
    },
    scores: scores as LlmScores,
    reasons: {
      commercial_activity_reason:
        typeof reasonsRaw.commercial_activity_reason === "string"
          ? reasonsRaw.commercial_activity_reason
          : undefined,
      interceptability_reason:
        typeof reasonsRaw.interceptability_reason === "string"
          ? reasonsRaw.interceptability_reason
          : undefined,
      official_pressure_reason:
        typeof reasonsRaw.official_pressure_reason === "string"
          ? reasonsRaw.official_pressure_reason
          : undefined,
      intent_expansion_reason:
        typeof reasonsRaw.intent_expansion_reason === "string"
          ? reasonsRaw.intent_expansion_reason
          : undefined,
      country_fit_reason:
        typeof reasonsRaw.country_fit_reason === "string"
          ? reasonsRaw.country_fit_reason
          : undefined,
    },
    decision,
    profit_projection: {
      projection_available:
        profitRaw.projection_available === true,
      reason_if_unavailable:
        typeof profitRaw.reason_if_unavailable === "string"
          ? profitRaw.reason_if_unavailable
          : undefined,
      projected_clicks:
        typeof profitRaw.projected_clicks === "number"
          ? profitRaw.projected_clicks
          : undefined,
      projected_ad_cost:
        typeof profitRaw.projected_ad_cost === "number"
          ? profitRaw.projected_ad_cost
          : undefined,
      projected_conversions:
        typeof profitRaw.projected_conversions === "number"
          ? profitRaw.projected_conversions
          : undefined,
      projected_gross_profit:
        typeof profitRaw.projected_gross_profit === "number"
          ? profitRaw.projected_gross_profit
          : undefined,
      projected_net_profit:
        typeof profitRaw.projected_net_profit === "number"
          ? profitRaw.projected_net_profit
          : undefined,
      projected_roi:
        typeof profitRaw.projected_roi === "number"
          ? profitRaw.projected_roi
          : undefined,
      projected_roas:
        typeof profitRaw.projected_roas === "number"
          ? profitRaw.projected_roas
          : undefined,
    },
    data_completeness: dc,
  };

  return { status: "ok", output, warnings };
}

// ---------------------------------------------------------------------------
// Top-level evaluate
// ---------------------------------------------------------------------------

export interface EvaluateOutput {
  status: "ok" | "failed";
  output: LlmOutput | null;
  costUsd: number;
  warnings: string[];
  errorMessage?: string;
  raw: string;
}

export async function evaluateWithLlm(params: {
  systemPrompt: string;
  userPayload: unknown;
  caller: LlmCaller;
}): Promise<EvaluateOutput> {
  const prompt = buildPrompt(params.systemPrompt, params.userPayload);
  let res: LlmCallResult;
  try {
    res = await params.caller(prompt);
  } catch (e) {
    return {
      status: "failed",
      output: null,
      costUsd: 0,
      warnings: [],
      errorMessage: e instanceof Error ? e.message : String(e),
      raw: "",
    };
  }

  const cost = estimateLlmCostUsd(res.model, res.usage);
  const validated = parseAndValidateOutput(res.content);
  if (validated.status === "ok") {
    return {
      status: "ok",
      output: validated.output,
      costUsd: cost,
      warnings: validated.warnings,
      raw: res.content,
    };
  }
  return {
    status: "failed",
    output: null,
    costUsd: cost,
    warnings: validated.warnings,
    errorMessage: validated.error,
    raw: res.content,
  };
}
