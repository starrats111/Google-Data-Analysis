/**
 * AI 服务层 — 统一的 AI 调用接口
 * 从 ai_providers + ai_model_configs 读取配置，支持 fallback
 * 场景：ad_copy（广告文案）、article（文章生成）、data_insight（数据洞察）
 */
import prisma from "@/lib/prisma";

// 国家语言映射（移植自 ad_copy_generator.py）
const COUNTRY_LANGUAGE_MAP: Record<string, { name: string; language: string; style: string }> = {
  US: { name: "美国", language: "English (US)", style: "直接、行动导向、强调价值和优惠" },
  UK: { name: "英国", language: "English (UK)", style: "含蓄、品质导向、用英式拼写如 colour/favourite" },
  CA: { name: "加拿大", language: "English (CA)", style: "混合美式英式、强调环保可持续" },
  AU: { name: "澳大利亚", language: "English (AU)", style: "随和口语化、强调户外生活方式" },
  DE: { name: "德国", language: "German", style: "严谨、技术参数导向、强调品质认证" },
  FR: { name: "法国", language: "French", style: "优雅、强调设计美学和生活品味" },
  JP: { name: "日本", language: "Japanese", style: "礼貌、详细、强调服务和可靠性" },
  BR: { name: "巴西", language: "Portuguese (BR)", style: "热情、情感导向、强调社交证明" },
};

interface AiModelConfig {
  providerName: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens: number;
  temperature: number;
}

/** 从 ai_providers 表获取第一个可用的 Provider 作为默认配置 */
async function getFirstActiveProvider(scene?: string): Promise<AiModelConfig[]> {
  const provider = await prisma.ai_providers.findFirst({
    where: { status: "active", is_deleted: 0 },
    orderBy: { id: "asc" },
  });
  if (!provider || !provider.api_key) return [];

  // 尝试查找该 provider 关联的 model_configs 以获取真实可用的 model_name
  const providerConfigs = await prisma.ai_model_configs.findMany({
    where: { provider_id: provider.id, is_active: 1, is_deleted: 0 },
    orderBy: { priority: "asc" },
  });

  if (providerConfigs.length > 0) {
    return providerConfigs.map((c) => ({
      providerName: provider.provider_name,
      apiKey: provider.api_key!,
      baseUrl: provider.api_base_url || "https://api.openai.com",
      modelName: c.model_name,
      maxTokens: c.max_tokens || 4096,
      temperature: Number(c.temperature ?? 0.7),
    }));
  }

  // 无 model_config 时使用代理可用的模型名作为回退链
  const fallbackModels = [
    "[特价]claude-sonnet-4-6",
    "[福利]claude-sonnet-4-6",
    "[官B]claude-sonnet-4-6",
    "deepseek-chat",
  ];

  return fallbackModels.map((modelName) => ({
    providerName: provider.provider_name,
    apiKey: provider.api_key!,
    baseUrl: provider.api_base_url || "https://api.openai.com",
    modelName,
    maxTokens: 4096,
    temperature: 0.7,
  }));
}

/** 获取指定场景的 AI 模型配置（按 priority 排序，支持 fallback） */
async function getSceneModels(scene: string): Promise<AiModelConfig[]> {
  const models = await prisma.ai_model_configs.findMany({
    where: { scene, is_active: 1, is_deleted: 0 },
    orderBy: { priority: "asc" },
  });

  if (models.length === 0) {
    const fallbacks = await getFirstActiveProvider(scene);
    if (fallbacks.length > 0) {
      console.log(`[AI] 场景 ${scene} 无专属配置，使用第一个可用 Provider: ${fallbacks[0].providerName}/${fallbacks.map(f => f.modelName).join(",")}`);
      return fallbacks;
    }
    throw new Error(`AI 未配置：场景 ${scene} 无可用模型，请在 AI 配置中添加供应商或场景模型`);
  }

  const providerIds = [...new Set(models.map((m) => m.provider_id))];
  const providers = await prisma.ai_providers.findMany({
    where: { id: { in: providerIds }, status: "active", is_deleted: 0 },
  });
  const providerMap = new Map(providers.map((p) => [String(p.id), p]));

  const result = models
    .map((m) => {
      const provider = providerMap.get(String(m.provider_id));
      if (!provider || !provider.api_key) return null;
      return {
        providerName: provider.provider_name,
        apiKey: provider.api_key,
        baseUrl: provider.api_base_url || "https://api.openai.com",
        modelName: m.model_name,
        maxTokens: m.max_tokens || 4096,
        temperature: Number(m.temperature ?? 0.7),
      };
    })
    .filter(Boolean) as AiModelConfig[];

  if (result.length === 0) {
    const fallbacks = await getFirstActiveProvider(scene);
    if (fallbacks.length > 0) {
      console.warn(`[AI] 场景 ${scene} 的 provider 均不可用，使用第一个可用 Provider: ${fallbacks[0].providerName}/${fallbacks.map(f => f.modelName).join(",")}`);
      return fallbacks;
    }
  }

  return result;
}

/** 调用 AI API（OpenAI 兼容格式），429 自动退避重试 */
async function callAi(
  config: AiModelConfig,
  messages: { role: string; content: string }[],
  maxTokens?: number,
): Promise<string> {
  const base = config.baseUrl
    .replace(/\/+$/, "")
    .replace(/\/v1\/messages$/, "")
    .replace(/\/v1$/, "");
  const url = `${base}/v1/chat/completions`;
  const body = JSON.stringify({
    model: config.modelName,
    messages,
    max_tokens: maxTokens || config.maxTokens,
    temperature: config.temperature,
  });

  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(300000),
    });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      const delayMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * Math.pow(2, attempt), 16000);
      console.log(`[AI] ${config.modelName} 429 限流，${(delayMs / 1000).toFixed(1)}s 后重试 (${attempt + 1}/${MAX_RETRIES})`);
      await new Promise(r => setTimeout(r, delayMs));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`AI API 错误 (${config.modelName}): HTTP ${res.status} - ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content?.trim()) throw new Error(`AI 返回空内容 (${config.modelName})`);
    return content.trim();
  }

  throw new Error(`AI API 限流 (${config.modelName}): 重试 ${MAX_RETRIES} 次后仍被限流`);
}

/** 带 fallback 的 AI 调用：场景模型 → 回退模型链 → 全部失败才报错 */
export async function callAiWithFallback(
  scene: string,
  messages: { role: string; content: string }[],
  maxTokens?: number,
): Promise<string> {
  const models = await getSceneModels(scene);
  if (models.length === 0) throw new Error(`场景 ${scene} 无可用 AI 模型`);

  const usedNames = new Set(models.map(m => m.modelName));
  if (models.length < 3) {
    const extraModels = await getFirstActiveProvider(scene);
    for (const extra of extraModels) {
      if (!usedNames.has(extra.modelName)) {
        usedNames.add(extra.modelName);
        models.push(extra);
      }
    }
  }

  let lastError: Error | null = null;
  for (const model of models) {
    try {
      return await callAi(model, messages, maxTokens);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[AI] ${model.modelName} 失败，尝试下一个:`, lastError.message);
    }
  }
  throw lastError || new Error("所有 AI 模型均失败");
}

/** 从 AI 响应中提取 JSON */
function extractJson(raw: string): string {
  let text = raw.trim();
  // 移除 markdown 代码块
  if (text.startsWith("```")) {
    const firstNl = text.indexOf("\n");
    if (firstNl > 0) text = text.slice(firstNl + 1);
    if (text.trimEnd().endsWith("```")) text = text.trimEnd().slice(0, -3);
    text = text.trim();
  }
  if (text[0] === "{" || text[0] === "[") return text;
  // 尝试提取 JSON
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ]) {
    const idx = text.indexOf(open);
    if (idx >= 0) {
      const ridx = text.lastIndexOf(close);
      if (ridx > idx) return text.slice(idx, ridx + 1);
    }
  }
  return text;
}

// ─── 广告文案补充 ───

/**
 * 补充 headlines 到指定数量
 * 先用 SemRush 去重后的标题，不足时 AI 补充
 */
export async function padHeadlines(
  existing: string[],
  merchantName: string,
  country: string,
  count = 15,
): Promise<string[]> {
  // 过滤超长标题（Google Ads 限制 30 字符）
  const valid = existing.filter((h) => h.length <= 30 && h.length > 0);
  if (valid.length >= count) return valid.slice(0, count);

  const needed = count - valid.length;
  const lang = COUNTRY_LANGUAGE_MAP[country.toUpperCase()] || COUNTRY_LANGUAGE_MAP.US;

  const hasDiscountHeadline = valid.some((h) => /discount|sale|off|%|save|deal|promo|solde|rabatt|reduc/i.test(h));
  const hasShippingHeadline = valid.some((h) => /ship|deliver|livra|versand|envio|freight|expedit/i.test(h));
  const discountNeeded = !hasDiscountHeadline;
  const shippingNeeded = !hasShippingHeadline;

  const prompt = `You are a senior Google Ads copywriter and keyword specialist. You deeply understand Google search ad metrics, Ad Strength scoring, and platform policies.

Merchant: ${merchantName}
Target country: ${lang.name} (${lang.language})
Style: ${lang.style}
Budget context: $1.5/day budget, CPC $0.3 target — every headline must maximize click value.

Existing headlines (already have ${valid.length}):
${valid.map((h, i) => `${i + 1}. "${h}"`).join("\n")}

Generate exactly ${needed} MORE unique headlines for this merchant.

STRICT Rules — follow EVERY rule precisely:
1. Each headline MUST be ≤ 30 characters. Count carefully before outputting. If over 30, rewrite shorter.
2. Write in ${lang.language}.
3. Do NOT repeat or closely paraphrase any existing headline.
4. Headline #1 MUST be strongly brand-related — include "${merchantName}" or a clear brand reference. This is the most important headline.
${discountNeeded ? `5. MANDATORY: Include exactly ONE discount headline — pick the BIGGEST discount available (e.g. "Up to 60% Off ${merchantName}"). Place it prominently (headline #2 or #3 among generated ones). Prioritize the strongest offer.\n` : ""}${shippingNeeded ? `6. MANDATORY: Include exactly ONE shipping headline targeting ${lang.name} ONLY (e.g. "Free ${lang.name} Shipping", "Fast Local Delivery"). Shipping must be country-specific.\n` : ""}7. Discount and shipping headlines should appear EARLY (within first 4 generated headlines) for priority display.
8. Remaining headlines should diversify across: quality/trust signals, strong CTAs ("Shop Now", "Order Today"), unique selling points, seasonal relevance, brand differentiators.
9. Language must reflect the brand character of ${merchantName} — be authentic and compelling, NOT generic filler.
10. Use Title Case. Avoid excessive UPPERCASE — never write entire words in caps unless it's an acronym.
11. No emoji. Max 1 exclamation mark across ALL headlines.
12. Every headline must comply with Google Ads policies: no deceptive claims, no misleading info, no sensitive terms. Information must be truthful.
13. After generating, re-verify EACH headline is ≤ 30 characters. If any exceeds, rewrite it shorter.

Return ONLY a JSON array of strings, no explanation. Example: ["Headline 1", "Headline 2"]`;

  try {
    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 2048);
    const parsed = JSON.parse(extractJson(raw)) as string[];
    const aiHeadlines = parsed
      .map((h) => h.trim())
      .filter((h) => h.length > 0 && h.length <= 30);
    return [...valid, ...aiHeadlines].slice(0, count);
  } catch (err) {
    console.error("[padHeadlines] AI 补充失败:", err);
    return valid; // 返回已有的
  }
}

/**
 * 补充 descriptions 到指定数量
 */
export async function padDescriptions(
  existing: string[],
  merchantName: string,
  country: string,
  count = 4,
): Promise<string[]> {
  const valid = existing.filter((d) => d.length <= 90 && d.length > 0);
  if (valid.length >= count) return valid.slice(0, count);

  const needed = count - valid.length;
  const lang = COUNTRY_LANGUAGE_MAP[country.toUpperCase()] || COUNTRY_LANGUAGE_MAP.US;

  const hasDiscountAndShipping = valid.some((d) =>
    (/discount|sale|off|%|save|deal|promo|solde|rabatt|reduc/i.test(d))
    && (/ship|deliver|livra|versand|envio|freight|expedit/i.test(d)),
  );

  const prompt = `You are a senior Google Ads copywriter specializing in compelling RSA descriptions that drive conversions.

Merchant: ${merchantName}
Target country: ${lang.name} (${lang.language})
Style: ${lang.style}
Budget context: $1.5/day budget, CPC $0.3 target — descriptions must maximize conversion value.

Existing descriptions (already have ${valid.length}):
${valid.map((d, i) => `${i + 1}. "${d}"`).join("\n")}

Generate exactly ${needed} MORE unique descriptions for this merchant.

STRICT Rules — follow EVERY rule precisely:
1. Each description MUST be between 50-90 characters (Google Ads limit is 90). Count carefully.
2. Write in ${lang.language}.
3. Do NOT repeat or closely paraphrase any existing description.
${!hasDiscountAndShipping ? `4. MANDATORY: Exactly ONE description must combine both discount info AND shipping info in a single line (e.g. "Save 30% + Free ${lang.name} Shipping on All Orders"). Shipping must target ${lang.name} only. This is REQUIRED.\n` : ""}5. Other descriptions should cover: brand story/uniqueness, product quality, trust signals (reviews, guarantees), strong CTAs ("Shop Now", "Order Today"), brand differentiators.
6. Language must reflect the brand character of ${merchantName} — be authentic and compelling, NOT generic filler like "Great products at great prices".
7. Use natural sentence case. Avoid excessive UPPERCASE — never write entire words in caps unless it's an acronym.
8. No emoji. Comply with Google Ads policies: no deceptive or misleading claims, no sensitive terms. All information must be truthful.
9. After generating, re-verify each description is between 50-90 characters. If any is out of range, rewrite it.

Return ONLY a JSON array of strings. Example: ["Description 1", "Description 2"]`;

  try {
    const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 2048);
    const parsed = JSON.parse(extractJson(raw)) as string[];
    const aiDescs = parsed
      .map((d) => d.trim())
      .filter((d) => d.length > 0 && d.length <= 90);
    return [...valid, ...aiDescs].slice(0, count);
  } catch (err) {
    console.error("[padDescriptions] AI 补充失败:", err);
    return valid;
  }
}
