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

// ─── 广告文案补充（严格对齐桌面文案提示词） ───

const DISCOUNT_RE = /discount|sale|off|%|save|deal|promo|solde|rabatt|reduc|sparen|remise|descuento|sconto|割引|セール/i;
const SHIPPING_RE = /ship|deliver|livra|versand|envio|freight|expedit|lieferung|envoi|配送|送料/i;

/**
 * 补充 headlines 到指定数量
 * 严格遵循桌面文案提示词规范：
 *  - 第一条必须品牌相关
 *  - 折扣和物流各一条并优先展示（折扣力度优选最大的）
 *  - 次要折扣从第四条输出
 *  - 字数 ≤ 30，避免过多大写
 *  - 有折扣/物流的一定要写入，不满足就重生成
 */
export async function padHeadlines(
  existing: string[],
  merchantName: string,
  country: string,
  count = 15,
): Promise<string[]> {
  const valid = existing.filter((h) => h.length <= 30 && h.length > 0);
  if (valid.length >= count) return valid.slice(0, count);

  const lang = COUNTRY_LANGUAGE_MAP[country.toUpperCase()] || COUNTRY_LANGUAGE_MAP.US;

  // 最多尝试 3 次，确保折扣/物流一定写入
  for (let attempt = 0; attempt < 3; attempt++) {
    const needed = count - valid.length;
    const allSoFar = [...valid];

    const prompt = `You are a senior Google Ads copywriter with 30 years of experience. You deeply understand Google search ad metrics, Ad Strength scoring, keyword selection, and platform policies.

Context:
- Merchant: ${merchantName}
- Target country: ${lang.name} (${lang.language})
- Style: ${lang.style}
- Budget: $1.5/day, CPC $0.3 — every headline must maximize click value.
- Based on SemRush keyword data, generate headlines that align with high-performing keywords.

${valid.length > 0 ? `Existing headlines (${valid.length}):\n${valid.map((h, i) => `${i + 1}. "${h}"`).join("\n")}\n` : ""}
Generate exactly ${needed} headlines. You MUST output a JSON array of exactly ${needed} strings.

=== MANDATORY RULES (violation = rejection) ===

RULE 1 — BRAND FIRST: Headline #1 (first in your output) MUST be strongly brand-related — include "${merchantName}" or a clear brand reference. This is the most important headline.

RULE 2 — DISCOUNT MANDATORY: You MUST include exactly ONE discount headline. Pick the BIGGEST discount available for ${merchantName}. Place it as headline #2 or #3 in your output for priority display. The discount must be real and truthful. Example: "Up to 60% Off ${merchantName}".

RULE 3 — SHIPPING MANDATORY: You MUST include exactly ONE shipping headline targeting ${lang.name} ONLY. Example: "Free ${lang.name} Shipping" or "Kostenloser Versand DE". Shipping must be country-specific, local only.

RULE 4 — PRIORITY ORDER: Brand headline first, then discount and shipping within the first 4 headlines. Secondary discount references (if any) start from headline #4 onward.

RULE 5 — CHARACTER LIMIT: Each headline MUST be ≤ 30 characters. Count EVERY character carefully. If over 30, rewrite shorter immediately.

RULE 6 — LANGUAGE: Write in ${lang.language}. Use Title Case. Avoid excessive UPPERCASE — never write entire words in caps unless it's an acronym.

RULE 7 — QUALITY: Language must reflect ${merchantName}'s brand character — authentic and compelling, NOT generic filler. Diversify remaining headlines across: quality/trust signals, strong CTAs, unique selling points, seasonal relevance.

RULE 8 — COMPLIANCE: No emoji. Max 1 exclamation mark across ALL headlines. Comply with Google Ads policies: no deceptive claims, no misleading info, no sensitive terms. Information must be truthful.

RULE 9 — FINAL CHECK: After generating, re-verify EVERY headline is ≤ 30 characters, contains no duplicates, and rules 1-3 are satisfied.

Return ONLY a JSON array of strings. Example: ["Brand Headline", "Discount Headline", "Shipping Headline", ...]`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 2048);
      const parsed = JSON.parse(extractJson(raw)) as string[];
      const aiHeadlines = parsed.map((h) => h.trim()).filter((h) => h.length > 0 && h.length <= 30);
      const combined = [...valid, ...aiHeadlines].slice(0, count);

      // ─── 二次硬校验 ───
      const hasDiscount = combined.some((h) => DISCOUNT_RE.test(h));
      const hasShipping = combined.some((h) => SHIPPING_RE.test(h));
      const firstIsBrand = combined.length > 0 && combined[0].toLowerCase().includes(merchantName.toLowerCase().slice(0, 5));

      if (hasDiscount && hasShipping) {
        console.log(`[padHeadlines] 校验通过 (attempt ${attempt + 1}): 折扣=${hasDiscount}, 物流=${hasShipping}, 品牌首条=${firstIsBrand}, 共${combined.length}条`);
        return combined;
      }

      console.warn(`[padHeadlines] 校验不通过 (attempt ${attempt + 1}): 折扣=${hasDiscount}, 物流=${hasShipping} → 重试`);
      // 不通过时不累加 valid，下次重新生成全部 AI 部分
    } catch (err) {
      console.error(`[padHeadlines] AI 生成失败 (attempt ${attempt + 1}):`, err);
    }
  }

  // 3 次都失败，返回已有的 + 强制插入兜底折扣/物流标题
  console.error("[padHeadlines] 3 次校验均失败，插入兜底折扣/物流标题");
  const fallback = [...valid];
  if (!fallback.some((h) => DISCOUNT_RE.test(h))) {
    const shortName = merchantName.length > 15 ? merchantName.slice(0, 15) : merchantName;
    fallback.push(`Save Big at ${shortName}`.slice(0, 30));
  }
  if (!fallback.some((h) => SHIPPING_RE.test(h))) {
    const langName = lang.name.length > 10 ? lang.name.slice(0, 10) : lang.name;
    fallback.push(`Free ${langName} Shipping`.slice(0, 30));
  }
  return fallback.slice(0, count);
}

/**
 * 补充 descriptions 到指定数量
 * 严格遵循桌面文案提示词规范：
 *  - 有且仅有一条同时包含折扣和物流信息
 *  - 字数 50-90，避免过多大写
 *  - 有折扣/物流的一定要写入，不满足就重生成
 */
export async function padDescriptions(
  existing: string[],
  merchantName: string,
  country: string,
  count = 4,
): Promise<string[]> {
  const valid = existing.filter((d) => d.length <= 90 && d.length > 0);
  if (valid.length >= count) return valid.slice(0, count);

  const lang = COUNTRY_LANGUAGE_MAP[country.toUpperCase()] || COUNTRY_LANGUAGE_MAP.US;

  for (let attempt = 0; attempt < 3; attempt++) {
    const needed = count - valid.length;

    const prompt = `You are a senior Google Ads copywriter with 30 years of experience, specializing in compelling RSA descriptions that drive conversions.

Context:
- Merchant: ${merchantName}
- Target country: ${lang.name} (${lang.language})
- Style: ${lang.style}
- Budget: $1.5/day, CPC $0.3 — descriptions must maximize conversion value.

${valid.length > 0 ? `Existing descriptions (${valid.length}):\n${valid.map((d, i) => `${i + 1}. "${d}"`).join("\n")}\n` : ""}
Generate exactly ${needed} descriptions. You MUST output a JSON array of exactly ${needed} strings.

=== MANDATORY RULES (violation = rejection) ===

RULE 1 — DISCOUNT + SHIPPING COMBINED: Exactly ONE description MUST combine BOTH discount info AND shipping info in a single line. Example: "Save 30% + Free ${lang.name} Shipping on All Orders" or "Bis zu 40% Rabatt + Kostenloser DE Versand". Shipping must target ${lang.name} only. This is REQUIRED and non-negotiable.

RULE 2 — CHARACTER LIMIT: Each description MUST be between 50-90 characters (Google Ads limit is 90). Count carefully.

RULE 3 — LANGUAGE: Write in ${lang.language}. Use natural sentence case. Avoid excessive UPPERCASE.

RULE 4 — QUALITY: Language must reflect ${merchantName}'s brand character — authentic and compelling, NOT generic filler like "Great products at great prices". Cover: brand story, product quality, trust signals, strong CTAs, brand differentiators.

RULE 5 — COMPLIANCE: No emoji. Comply with Google Ads policies: no deceptive or misleading claims, no sensitive terms. All information must be truthful.

RULE 6 — FINAL CHECK: After generating, re-verify each description is 50-90 characters, and RULE 1 is satisfied (exactly one line has both discount AND shipping).

Return ONLY a JSON array of strings. Example: ["Description with discount + shipping", "Brand description", ...]`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 2048);
      const parsed = JSON.parse(extractJson(raw)) as string[];
      const aiDescs = parsed.map((d) => d.trim()).filter((d) => d.length > 0 && d.length <= 90);
      const combined = [...valid, ...aiDescs].slice(0, count);

      // ─── 二次硬校验：必须有一条同时含折扣+物流 ───
      const hasCombo = combined.some((d) => DISCOUNT_RE.test(d) && SHIPPING_RE.test(d));

      if (hasCombo) {
        console.log(`[padDescriptions] 校验通过 (attempt ${attempt + 1}): 折扣+物流组合=${hasCombo}, 共${combined.length}条`);
        return combined;
      }

      console.warn(`[padDescriptions] 校验不通过 (attempt ${attempt + 1}): 缺少折扣+物流组合描述 → 重试`);
    } catch (err) {
      console.error(`[padDescriptions] AI 生成失败 (attempt ${attempt + 1}):`, err);
    }
  }

  // 3 次都失败，强制插入兜底
  console.error("[padDescriptions] 3 次校验均失败，插入兜底折扣+物流描述");
  const fallback = [...valid];
  if (!fallback.some((d) => DISCOUNT_RE.test(d) && SHIPPING_RE.test(d))) {
    const langName = lang.name.length > 8 ? lang.name.slice(0, 8) : lang.name;
    fallback.push(`Save Big + Free ${langName} Shipping on ${merchantName} Orders`.slice(0, 90));
  }
  return fallback.slice(0, count);
}
