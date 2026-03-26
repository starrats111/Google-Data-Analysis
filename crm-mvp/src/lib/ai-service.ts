/**
 * AI 服务层 — 统一的 AI 调用接口
 * 从 ai_providers + ai_model_configs 读取配置，支持 fallback
 * 场景：ad_copy（广告文案）、article（文章生成）、data_insight（数据洞察）
 */
import prisma from "@/lib/prisma";
import { getAdMarketConfig, type AdMarketConfig } from "@/lib/ad-market";
import { buildAiRulePrompt } from "@/lib/ai-rule-profile";

interface AiModelConfig {
  providerName: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  maxTokens: number;
  temperature: number;
}

interface PadCopyOptions {
  referenceItems?: string[];
  keywords?: string[];
  /** 与标题 token 重叠过高会被过滤，贴合 Google RSA「描述更独特」反馈 */
  headlinesForUniqueness?: string[];
  dailyBudget?: number;
  maxCpc?: number;
  biddingStrategy?: string;
  aiRuleProfile?: unknown;
}

/** 显示路径（path1/path2）每条 ≤15 字符，字母数字与连字符；用于提升 RSA 完整度与点击率 */
export function suggestDisplayPaths(merchantName: string, keywords: string[], country: string): { path1: string; path2: string } {
  const market = getAdMarketConfig(country);
  const segments: string[] = [];
  const seen = new Set<string>();
  const pushSeg = (raw: string) => {
    const s = slugDisplayPathSegment(raw, 15);
    if (s.length < 2 || seen.has(s)) return;
    seen.add(s);
    segments.push(s);
  };
  for (const k of keywords) {
    pushSeg(k);
    if (segments.length >= 4) break;
  }
  pushSeg(merchantName);
  const shop = market.languageCode === "de" ? "shop" : market.languageCode === "fr" ? "boutique" : "shop";
  const extra = market.languageCode === "de" ? "angebote" : market.languageCode === "fr" ? "promos" : "deals";
  const path1 = (segments[0] || shop).slice(0, 15);
  const path2 = (segments[1] || segments[2] || extra).slice(0, 15);
  return { path1, path2 };
}

interface SanitizeDescriptionOpts {
  headlineTokenSets?: Set<string>[];
  /** 描述之间的 Jaccard 上限，默认 0.55（更严以贴近 Google「描述独特性」） */
  maxDescJaccard?: number;
  /** 描述相对单条标题的 Jaccard 上限，默认 0.42 */
  maxHeadlineJaccard?: number;
}

function buildHeadlineTokenSets(headlines: string[], merchantName: string): Set<string>[] {
  const sets: Set<string>[] = [];
  const seen = new Set<string>();
  for (const h of headlines) {
    const ts = tokenSet(h, merchantName);
    if (ts.size === 0) continue;
    const key = [...ts].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    sets.push(ts);
  }
  return sets;
}

const DISCOUNT_RE = /discount|sale|off|%|save|deal|promo|solde|rabatt|reduc|sparen|remise|descuento|sconto|割引|セール|angebot/i;
const SHIPPING_RE = /ship|deliver|livra|versand|envio|freight|expedit|lieferung|envoi|配送|送料|spedizione/i;
const CTA_RE = /shop|buy|discover|explore|get|save|order|upgrade|find|choose|jetzt|kaufen|entdecken|sichern|découvrez|acheter|profitez|compra|descubre|ordina|scopri/i;
const TRUST_RE = /official|trusted|quality|premium|certified|garantie|garantie|zuverlässig|verlässlich|qualité|fiable|安心|信頼/i;
const GENERIC_HEADLINE_RE = /^(official site|official store|official page|homepage|home page|shop now|learn more|click here|offizielle seite|offizieller shop|site officiel|tienda oficial)$/i;
const GENERIC_DESCRIPTION_RE = /(learn more online|visit our website|click to learn more|shop today|discover more online|great products at great prices)/i;
const EXPIRED_RE = /(ends?\s+(today|tonight|soon)|last chance|early bird|limited\s+time\s+only|bis\s+\d{1,2}\.?\s*(jan|feb|mär|mar|apr|mai|may|jun|jul|aug|sep|sept|okt|oct|nov|dez|dec)|jusqu[’']?au\s+\d{1,2}|hasta\s+el\s+\d{1,2}|fino\s+al\s+\d{1,2})/i;
const DATE_RE = /(\b(?:jan|january|feb|february|mar|march|märz|apr|april|mai|may|jun|june|jul|july|aug|august|sep|sept|september|okt|oct|october|nov|november|dez|dec|december)\b)|(\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b)|(\b\d{1,2}\s*(?:jan|feb|mar|mär|apr|mai|may|jun|jul|aug|sep|sept|okt|oct|nov|dez|dec)\b)|(\b20\d{2}\b)/i;
const STOPWORDS = new Set([
  "the", "and", "for", "with", "your", "you", "our", "from", "shop", "buy", "now", "online", "official", "site", "store",
  "offizielle", "seite", "offizieller", "shoppen", "jetzt", "mit", "und", "für", "der", "die", "das", "zum", "zur", "bei",
  "free", "shipping", "delivery", "returns", "return", "easy", "save", "deal", "deals", "special", "offer", "offers",
  "kostenloser", "versand", "rückgabe", "rabatt", "angebote", "angebot", "marke", "brand", "brands",
]);

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function slugDisplayPathSegment(text: string, maxLen: number): string {
  const base = normalizeWhitespace(text).toLowerCase();
  const s = base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, maxLen).replace(/-+$/g, "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeForCompare(text: string): string {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[“”"'`´’]/g, "")
    .replace(/[!?,.;:/\\|()[\]{}+]/g, " ")
    .replace(/[-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  return normalizeForCompare(text)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function tokenSet(text: string, merchantName: string): Set<string> {
  const brandTokens = new Set(tokenize(merchantName));
  return new Set(tokenize(text).filter((t) => !brandTokens.has(t)));
}

function semanticKey(text: string, merchantName: string): string {
  return Array.from(tokenSet(text, merchantName)).sort().join("|");
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const v of a) if (b.has(v)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function truncateAtWord(text: string, maxLen: number): string {
  const clean = normalizeWhitespace(text);
  if (clean.length <= maxLen) return clean;
  const sliced = clean.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.55) return sliced.slice(0, lastSpace).trim();
  return sliced.trim();
}

function getShortBrand(merchantName: string, maxLen = 18): string {
  const clean = normalizeWhitespace(merchantName);
  if (!clean) return "Brand";
  return truncateAtWord(clean, maxLen);
}

function inferProductPhrase(keywords: string[], merchantName: string, fallbackByLanguage: string): string {
  const brandTokens = new Set(tokenize(merchantName));
  for (const keyword of keywords) {
    const cleaned = normalizeWhitespace(keyword);
    if (!cleaned) continue;
    const words = tokenize(cleaned).filter((w) => !brandTokens.has(w) && !DISCOUNT_RE.test(w) && !SHIPPING_RE.test(w));
    if (words.length >= 1) {
      return truncateAtWord(cleaned, 18);
    }
  }
  return fallbackByLanguage;
}

function hasExplicitDateOrExpiredSignal(text: string): boolean {
  return EXPIRED_RE.test(text) || DATE_RE.test(text);
}

function isMeaninglessHeadline(text: string, merchantName: string): boolean {
  const normalized = normalizeForCompare(text);
  const brandNormalized = normalizeForCompare(merchantName);
  if (!normalized) return true;
  if (normalized === brandNormalized) return true;
  if (normalized.replace(/\s+/g, "") === brandNormalized.replace(/\s+/g, "")) return true;
  if (GENERIC_HEADLINE_RE.test(normalized)) return true;
  if (/^(official|offizielle|oficial|site|seite|homepage|store|shop)$/.test(normalized)) return true;
  if (normalized.length <= 5) return true;

  const stripped = normalized.replace(new RegExp(`\\b${escapeRegExp(brandNormalized)}\\b`, "g"), "").trim();
  if (!stripped) return true;
  if (/^(official|offizielle|seite|site|store|shop|homepage|webseite)$/.test(stripped)) return true;
  return false;
}

function isMeaninglessDescription(text: string, merchantName: string): boolean {
  const normalized = normalizeForCompare(text);
  if (!normalized || normalized.length < 40) return true;
  if (GENERIC_DESCRIPTION_RE.test(normalized)) return true;
  const brandNormalized = normalizeForCompare(merchantName);
  if (normalized === brandNormalized) return true;
  return false;
}

function hasCommercialIntent(text: string): boolean {
  return DISCOUNT_RE.test(text) || SHIPPING_RE.test(text) || CTA_RE.test(text) || TRUST_RE.test(text);
}

function sanitizeHeadlineCandidates(
  candidates: string[],
  merchantName: string,
  maxLen: number,
  maxCount: number,
): string[] {
  const result: string[] = [];
  const exactSet = new Set<string>();
  const semanticSet = new Set<string>();
  const tokenSets: Set<string>[] = [];

  for (const raw of candidates) {
    let candidate = normalizeWhitespace(raw)
      .replace(/[|•·]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    candidate = candidate.replace(/[!]{2,}/g, "!");
    candidate = candidate.replace(/^[\-–—:;,./\s]+|[\-–—:;,./\s]+$/g, "");

    if (!candidate || candidate.length > maxLen) continue;
    if (hasExplicitDateOrExpiredSignal(candidate)) continue;
    if (isMeaninglessHeadline(candidate, merchantName)) continue;
    if (!hasCommercialIntent(candidate) && tokenSet(candidate, merchantName).size < 2) continue;

    const exact = normalizeForCompare(candidate);
    const semantic = semanticKey(candidate, merchantName);
    const currentTokenSet = tokenSet(candidate, merchantName);

    if (exactSet.has(exact)) continue;
    if (semantic && semanticSet.has(semantic)) continue;

    let tooSimilar = false;
    for (const existing of tokenSets) {
      if (jaccard(existing, currentTokenSet) >= 0.8) {
        tooSimilar = true;
        break;
      }
    }
    if (tooSimilar) continue;

    result.push(candidate);
    exactSet.add(exact);
    if (semantic) semanticSet.add(semantic);
    tokenSets.push(currentTokenSet);
    if (result.length >= maxCount) break;
  }

  return result;
}

function sanitizeDescriptionCandidates(
  candidates: string[],
  merchantName: string,
  maxLen: number,
  maxCount: number,
  opts?: SanitizeDescriptionOpts,
): string[] {
  const maxDescJ = opts?.maxDescJaccard ?? 0.55;
  const maxHeadlineJ = opts?.maxHeadlineJaccard ?? 0.42;
  const headlineSets = opts?.headlineTokenSets || [];

  const result: string[] = [];
  const exactSet = new Set<string>();
  const semanticSet = new Set<string>();
  const tokenSets: Set<string>[] = [];

  for (const raw of candidates) {
    let candidate = normalizeWhitespace(raw)
      .replace(/[|•·]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    candidate = candidate.replace(/[!]{2,}/g, "!");
    candidate = candidate.replace(/^[\-–—:;,./\s]+|[\-–—:;,./\s]+$/g, "");

    if (!candidate || candidate.length > maxLen || candidate.length < 50) continue;
    if (hasExplicitDateOrExpiredSignal(candidate)) continue;
    if (isMeaninglessDescription(candidate, merchantName)) continue;
    if (!hasCommercialIntent(candidate) && tokenSet(candidate, merchantName).size < 4) continue;

    const exact = normalizeForCompare(candidate);
    const semantic = semanticKey(candidate, merchantName);
    const currentTokenSet = tokenSet(candidate, merchantName);

    if (exactSet.has(exact)) continue;
    if (semantic && semanticSet.has(semantic)) continue;

    let tooSimilar = false;
    for (const existing of tokenSets) {
      if (jaccard(existing, currentTokenSet) >= maxDescJ) {
        tooSimilar = true;
        break;
      }
    }
    if (!tooSimilar && headlineSets.length > 0) {
      for (const hSet of headlineSets) {
        if (hSet.size > 0 && jaccard(currentTokenSet, hSet) > maxHeadlineJ) {
          tooSimilar = true;
          break;
        }
      }
    }
    if (tooSimilar) continue;

    result.push(candidate);
    exactSet.add(exact);
    if (semantic) semanticSet.add(semantic);
    tokenSets.push(currentTokenSet);
    if (result.length >= maxCount) break;
  }

  return result;
}

function getFallbackHeadlineCandidates(
  merchantName: string,
  market: AdMarketConfig,
  keywords: string[],
): string[] {
  const brand = getShortBrand(merchantName);
  const genericProduct = market.languageCode === "de"
    ? "Saugroboter"
    : market.languageCode === "fr"
      ? "Produits premium"
      : market.languageCode === "es"
        ? "Productos top"
        : market.languageCode === "it"
          ? "Prodotti top"
          : market.languageCode === "nl"
            ? "Topproducten"
            : market.languageCode === "ja"
              ? "人気アイテム"
              : "Top Picks";
  const product = inferProductPhrase(keywords, merchantName, genericProduct);

  if (market.languageCode === "de") {
    return [
      `${brand} ${product}`,
      "Bis zu 20% Rabatt",
      market.shippingLabel,
      `${product} jetzt sichern`,
      "Starke Leistung Zuhause",
      "Mehr Komfort im Alltag",
      "Qualität für Ihr Zuhause",
      "Jetzt Angebote entdecken",
      "Zuverlässig & effizient",
      "Premium Auswahl online",
    ];
  }

  if (market.languageCode === "fr") {
    return [
      `${brand} ${product}`,
      "Jusqu'à -20%",
      market.shippingLabel,
      `${product} à découvrir`,
      "Qualité pensée pour vous",
      "Confort au quotidien",
      "Choix premium en ligne",
      "Offres à ne pas manquer",
    ];
  }

  if (market.languageCode === "es") {
    return [
      `${brand} ${product}`,
      "Hasta 20% de descuento",
      market.shippingLabel,
      `Compra ${product} hoy`,
      "Calidad para tu hogar",
      "Ahorra con estilo",
      "Ofertas que sí convencen",
      "Descubre tu mejor opción",
    ];
  }

  if (market.languageCode === "it") {
    return [
      `${brand} ${product}`,
      "Fino al 20% di sconto",
      market.shippingLabel,
      `Scopri ${product} ora`,
      "Qualità per ogni giorno",
      "Più comfort a casa",
      "Offerte da non perdere",
      "Scelta premium online",
    ];
  }

  if (market.languageCode === "nl") {
    return [
      `${brand} ${product}`,
      "Tot 20% korting",
      market.shippingLabel,
      `${product} nu ontdekken`,
      "Slim gemak voor thuis",
      "Kwaliteit die overtuigt",
      "Sterke deals online",
      "Maak thuis slimmer schoon",
    ];
  }

  if (market.languageCode === "ja") {
    return [
      `${brand} ${product}`,
      "最大20%オフ",
      market.shippingLabel,
      `${product}を今すぐ確認`,
      "毎日に頼れる品質",
      "使いやすさで選ぶなら",
      "公式級の安心感",
      "納得の人気アイテム",
    ];
  }

  return [
    `${brand} ${product}`,
    "Save Up to 20% Today",
    market.shippingLabel,
    `Shop ${product} Now`,
    "Quality You Can Trust",
    "Upgrade Your Everyday",
    "Top Deals Worth Clicking",
    "Premium Picks Online",
    "Smart Value For Home",
    "Find Your Best Match",
  ];
}

function getFallbackDescriptionCandidates(
  merchantName: string,
  market: AdMarketConfig,
  keywords: string[],
): string[] {
  const brand = getShortBrand(merchantName, 22);
  const genericProduct = market.languageCode === "de"
    ? "smarte Lösungen"
    : market.languageCode === "fr"
      ? "solutions premium"
      : market.languageCode === "es"
        ? "soluciones premium"
        : market.languageCode === "it"
          ? "soluzioni premium"
          : market.languageCode === "nl"
            ? "slimme oplossingen"
            : market.languageCode === "ja"
              ? "人気アイテム"
              : "premium picks";
  const product = inferProductPhrase(keywords, merchantName, genericProduct);

  if (market.languageCode === "de") {
    return [
      `Bis zu 20% Rabatt + ${market.shippingLabel} bei ${brand} sichern.`,
      `${brand} bietet ${product} mit starker Qualität, Komfort und Vertrauen.`,
      `Entdecken Sie leistungsstarke ${product} für mehr Effizienz im Alltag.`,
      `Jetzt attraktive Angebote prüfen und die passende ${product} Auswahl finden.`,
    ];
  }

  if (market.languageCode === "fr") {
    return [
      `Jusqu'à -20% + ${market.shippingLabel.toLowerCase()} chez ${brand}.`,
      `${brand} propose ${product} avec qualité, style et confiance au quotidien.`,
      `Découvrez une sélection ${product} pensée pour plus de confort chaque jour.`,
      `Profitez d'offres fiables et trouvez la solution idéale dès aujourd'hui.`,
    ];
  }

  if (market.languageCode === "es") {
    return [
      `Ahorra hasta 20% + ${market.shippingLabel.toLowerCase()} con ${brand}.`,
      `${brand} reúne ${product} con calidad real, confianza y mejor experiencia.`,
      `Descubre opciones ${product} para comprar con más valor y menos dudas.`,
      `Encuentra ofertas convincentes y elige la mejor solución para ti hoy.`,
    ];
  }

  if (market.languageCode === "it") {
    return [
      `Fino al 20% di sconto + ${market.shippingLabel.toLowerCase()} con ${brand}.`,
      `${brand} offre ${product} con qualità affidabile e comfort ogni giorno.`,
      `Scopri una selezione ${product} pensata per valore, stile e praticità.`,
      `Approfitta di offerte credibili e scegli la soluzione giusta subito.`,
    ];
  }

  if (market.languageCode === "nl") {
    return [
      `Tot 20% korting + ${market.shippingLabel.toLowerCase()} bij ${brand}.`,
      `${brand} biedt ${product} met kwaliteit, gemak en vertrouwen voor thuis.`,
      `Ontdek slimme ${product} keuzes voor meer comfort in je dagelijkse routine.`,
      `Bekijk sterke aanbiedingen en kies vandaag nog de beste oplossing.`,
    ];
  }

  if (market.languageCode === "ja") {
    return [
      `最大20%オフ + ${market.shippingLabel}で${brand}をお得にチェック。`,
      `${brand}は品質・使いやすさ・安心感で選ばれる${product}を提案します。`,
      `毎日をもっと快適にする${product}を比較しながら選べます。`,
      `納得できる価値と信頼感のある一台を今すぐ見つけましょう。`,
    ];
  }

  return [
    `Save up to 20% + ${market.shippingLabel} when you shop ${brand} today.`,
    `${brand} delivers ${product} with trusted quality, comfort and standout value.`,
    `Explore high-conviction ${product} options built for smarter everyday choices.`,
    `Find the right fit faster with strong offers, clear value and easy buying.`,
  ];
}

/** 从 ai_providers 表获取第一个可用的 Provider 作为默认配置 */
async function getFirstActiveProvider(_scene?: string): Promise<AiModelConfig[]> {
  const provider = await prisma.ai_providers.findFirst({
    where: { status: "active", is_deleted: 0 },
    orderBy: { id: "asc" },
  });
  if (!provider || !provider.api_key) return [];

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
      console.log(`[AI] 场景 ${scene} 无专属配置，使用第一个可用 Provider: ${fallbacks[0].providerName}/${fallbacks.map((f) => f.modelName).join(",")}`);
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
      console.warn(`[AI] 场景 ${scene} 的 provider 均不可用，使用第一个可用 Provider: ${fallbacks[0].providerName}/${fallbacks.map((f) => f.modelName).join(",")}`);
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
      await new Promise((r) => setTimeout(r, delayMs));
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

  const usedNames = new Set(models.map((m) => m.modelName));
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
  if (text.startsWith("```")) {
    const firstNl = text.indexOf("\n");
    if (firstNl > 0) text = text.slice(firstNl + 1);
    if (text.trimEnd().endsWith("```")) text = text.trimEnd().slice(0, -3);
    text = text.trim();
  }
  if (text[0] === "{" || text[0] === "[") return text;
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const idx = text.indexOf(open);
    if (idx >= 0) {
      const ridx = text.lastIndexOf(close);
      if (ridx > idx) return text.slice(idx, ridx + 1);
    }
  }
  return text;
}

export async function padHeadlines(
  existing: string[],
  merchantName: string,
  country: string,
  count = 15,
  options: PadCopyOptions = {},
): Promise<string[]> {
  const market = getAdMarketConfig(country);
  const locked = sanitizeHeadlineCandidates(existing, merchantName, 30, count);
  if (locked.length >= count) return locked.slice(0, count);

  const references = sanitizeHeadlineCandidates(options.referenceItems || [], merchantName, 30, 12);
  const keywords = (options.keywords || []).map((k) => normalizeWhitespace(k)).filter(Boolean).slice(0, 12);
  const dailyBudget = Number(options.dailyBudget) > 0 ? Number(options.dailyBudget) : 1.5;
  const maxCpc = Number(options.maxCpc) > 0 ? Number(options.maxCpc) : 0.3;
  const biddingStrategy = options.biddingStrategy || "MAXIMIZE_CLICKS";
  const aiRulePrompt = buildAiRulePrompt(options.aiRuleProfile, "ad_copy");

  for (let attempt = 0; attempt < 4; attempt++) {
    const needed = count - locked.length;
    const prompt = `You are a senior Google Ads search ads copywriter with 30 years of experience.

Context:
- Merchant: ${merchantName}
- Target country: ${market.countryNameZh} (${market.languageName})
- Writing style: ${market.style}
- Budget: $${dailyBudget.toFixed(2)}/day, CPC $${maxCpc.toFixed(2)}
- Bidding strategy: ${biddingStrategy}
- Goal: create high-conversion RSA headlines that real users would click, not filler.

${aiRulePrompt ? `User hard rules (MUST follow):\n${aiRulePrompt}\n\n` : ""}${keywords.length > 0 ? `Top keywords / product phrases:\n${keywords.map((k, i) => `${i + 1}. ${k}`).join("\n")}\n` : ""}
${references.length > 0 ? `Market references for inspiration only (DO NOT copy literally):\n${references.map((h, i) => `${i + 1}. \"${h}\"`).join("\n")}\n` : ""}
${locked.length > 0 ? `Already locked headlines that must remain untouched:\n${locked.map((h, i) => `${i + 1}. \"${h}\"`).join("\n")}\n` : ""}
Generate exactly ${needed} NEW headlines. Return ONLY a JSON array of exactly ${needed} strings.

MANDATORY RULES:
1. Headline #1 in your output must be brand-related and must include \"${merchantName}\" or a clear brand reference.
2. Include exactly one discount headline near the top. Use the strongest truthful discount phrasing.
3. Include exactly one shipping headline for ${market.countryNameZh} only.
4. Make the set commercially strong: emphasize product/category fit, trust, buying motivation, convenience, quality, or CTA.
5. Each headline must be <= 30 characters.
6. Write in ${market.languageName}. Never fall back to English unless the target market language is English.
7. Do NOT output expired or time-bound copy: no dates, months, years, countdowns, \"Early Bird\", \"Ends Soon\", or specific event deadlines.
8. Do NOT output low-value filler such as brand only, \"Official Site\", \"Home Page\", or near-duplicates.
9. Avoid repeating the same phrase pattern across multiple headlines.
10. Output must comply with Google Ads policy and remain truthful.
11. If any user hard rule conflicts with these defaults, follow the user hard rule first unless it violates policy.

Return ONLY JSON array.`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 2048);
      const parsed = JSON.parse(extractJson(raw)) as string[];
      const generated = sanitizeHeadlineCandidates(parsed, merchantName, 30, needed + 8);
      const combined = sanitizeHeadlineCandidates([...locked, ...generated], merchantName, 30, count);
      const hasDiscount = combined.some((h) => DISCOUNT_RE.test(h));
      const hasShipping = combined.some((h) => SHIPPING_RE.test(h));
      const firstIsBrand = combined.length > 0 && normalizeForCompare(combined[0]).includes(normalizeForCompare(getShortBrand(merchantName, 20)).split(" ")[0] || "");

      if (combined.length >= count && hasDiscount && hasShipping && firstIsBrand) {
        console.log(`[padHeadlines] 校验通过 (attempt ${attempt + 1}): 折扣=${hasDiscount}, 物流=${hasShipping}, 品牌首条=${firstIsBrand}, 共${combined.length}条`);
        return combined.slice(0, count);
      }

      console.warn(`[padHeadlines] 校验不通过 (attempt ${attempt + 1}): 折扣=${hasDiscount}, 物流=${hasShipping}, 品牌首条=${firstIsBrand}, 共${combined.length}条 → 重试`);
    } catch (err) {
      console.error(`[padHeadlines] AI 生成失败 (attempt ${attempt + 1}):`, err);
    }
  }

  const fallbackCandidates = getFallbackHeadlineCandidates(merchantName, market, keywords);
  const fallback = sanitizeHeadlineCandidates([...locked, ...fallbackCandidates], merchantName, 30, count);
  return fallback.slice(0, count);
}

export async function padDescriptions(
  existing: string[],
  merchantName: string,
  country: string,
  count = 4,
  options: PadCopyOptions = {},
): Promise<string[]> {
  const market = getAdMarketConfig(country);
  const locked = sanitizeDescriptionCandidates(existing, merchantName, 90, count);
  if (locked.length >= count) return locked.slice(0, count);

  const references = sanitizeDescriptionCandidates(options.referenceItems || [], merchantName, 90, 8);
  const keywords = (options.keywords || []).map((k) => normalizeWhitespace(k)).filter(Boolean).slice(0, 12);
  const dailyBudget = Number(options.dailyBudget) > 0 ? Number(options.dailyBudget) : 1.5;
  const maxCpc = Number(options.maxCpc) > 0 ? Number(options.maxCpc) : 0.3;
  const biddingStrategy = options.biddingStrategy || "MAXIMIZE_CLICKS";
  const aiRulePrompt = buildAiRulePrompt(options.aiRuleProfile, "ad_copy");
  const uniqHeadlines = (options.headlinesForUniqueness || [])
    .map((h) => normalizeWhitespace(h))
    .filter(Boolean)
    .slice(0, 15);
  const headlineSets = buildHeadlineTokenSets(uniqHeadlines, merchantName);
  const descSanitizeOpts: SanitizeDescriptionOpts = {
    maxDescJaccard: 0.55,
    ...(headlineSets.length > 0 ? { headlineTokenSets: headlineSets } : {}),
  };
  const headlineBlock = uniqHeadlines.length > 0
    ? `Current RSA headlines (descriptions must NOT paraphrase or stack the same phrases; Google flags \"Make your descriptions more unique\"):\n${uniqHeadlines.map((h, i) => `${i + 1}. \"${h}\"`).join("\n")}\n\n`
    : "";

  for (let attempt = 0; attempt < 4; attempt++) {
    const needed = count - locked.length;
    const prompt = `You are a senior Google Ads RSA copywriter focused on conversion-driving descriptions.

Context:
- Merchant: ${merchantName}
- Target country: ${market.countryNameZh} (${market.languageName})
- Writing style: ${market.style}
- Budget: $${dailyBudget.toFixed(2)}/day, CPC $${maxCpc.toFixed(2)}
- Bidding strategy: ${biddingStrategy}
- Goal: write persuasive, realistic ad descriptions that feel commercially useful.

GOOGLE ADS AD STRENGTH (Responsive Search Ads — official feedback patterns):
- Descriptions are rated for UNIQUENESS vs headlines and vs each other; repeating headline wording lowers Ad strength.
- Prefer full-sentence flow with DISTINCT openings (e.g. \"Whether you need...\", \"From daily commutes to...\", \"Built to...\", \"Worried about...?\", \"Install in minutes and...\").
- Avoid copying 3+ consecutive content words from any headline; use different benefits: fit, care/cleaning, durability, use-case, warranty/trust — not the same angle twice.
- Sitelink count (6+) is separate in the UI; your job here is only stronger, more distinct descriptions.

${headlineBlock}${aiRulePrompt ? `User hard rules (MUST follow):\n${aiRulePrompt}\n\n` : ""}${keywords.length > 0 ? `Top keywords / product phrases (weave naturally; do not mirror headline lines):\n${keywords.map((k, i) => `${i + 1}. ${k}`).join("\n")}\n` : ""}
${references.length > 0 ? `Market reference descriptions for inspiration only (DO NOT copy literally):\n${references.map((d, i) => `${i + 1}. \"${d}\"`).join("\n")}\n` : ""}
${locked.length > 0 ? `Already locked descriptions that must remain untouched:\n${locked.map((d, i) => `${i + 1}. \"${d}\"`).join("\n")}\n` : ""}
Generate exactly ${needed} NEW descriptions. Return ONLY a JSON array of exactly ${needed} strings.

MANDATORY RULES:
1. Exactly ONE description must combine both discount and shipping in one line.
2. Each description must be 50-90 characters.
3. Write in ${market.languageName}. Never fall back to English unless the target market language is English.
4. Each line must have a different persuasion angle: offer, trust, product fit, convenience, or CTA.
5. Avoid generic filler. The copy must feel like it can actually drive revenue.
6. Do NOT use dates, months, years, countdowns, \"Early Bird\", \"Ends Soon\", or expired event language.
7. Do NOT repeat the same wording structure across lines; vary syntax and first words.
8. Comply with Google Ads policy and keep claims truthful.
9. If any user hard rule conflicts with these defaults, follow the user hard rule first unless it violates policy.

Return ONLY JSON array.`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 2048);
      const parsed = JSON.parse(extractJson(raw)) as string[];
      const generated = sanitizeDescriptionCandidates(parsed, merchantName, 90, needed + 4, descSanitizeOpts);
      const combined = sanitizeDescriptionCandidates([...locked, ...generated], merchantName, 90, count, descSanitizeOpts);
      const comboCount = combined.filter((d) => DISCOUNT_RE.test(d) && SHIPPING_RE.test(d)).length;

      if (combined.length >= count && comboCount === 1) {
        console.log(`[padDescriptions] 校验通过 (attempt ${attempt + 1}): 折扣+物流组合=${comboCount}, 共${combined.length}条`);
        return combined.slice(0, count);
      }

      console.warn(`[padDescriptions] 校验不通过 (attempt ${attempt + 1}): 折扣+物流组合=${comboCount}, 共${combined.length}条 → 重试`);
    } catch (err) {
      console.error(`[padDescriptions] AI 生成失败 (attempt ${attempt + 1}):`, err);
    }
  }

  const fallbackCandidates = getFallbackDescriptionCandidates(merchantName, market, keywords);
  const fallback = sanitizeDescriptionCandidates([...locked, ...fallbackCandidates], merchantName, 90, count, descSanitizeOpts);
  const comboCount = fallback.filter((d) => DISCOUNT_RE.test(d) && SHIPPING_RE.test(d)).length;
  if (comboCount === 1) return fallback.slice(0, count);

  const withForcedCombo = sanitizeDescriptionCandidates([
    ...fallback,
    ...getFallbackDescriptionCandidates(merchantName, market, keywords),
  ], merchantName, 90, count, descSanitizeOpts);
  return withForcedCombo.slice(0, count);
}
