/**
 * AI 服务层 — 统一的 AI 调用接口
 * 从 ai_providers + ai_model_configs 读取配置，支持 fallback
 * 场景：ad_copy（广告文案）、article（文章生成）、data_insight（数据洞察）
 */
import prisma from "@/lib/prisma";
import { getAdMarketConfig, resolveLanguageName, type AdMarketConfig } from "@/lib/ad-market";
import { buildAiRulePrompt } from "@/lib/ai-rule-profile";
import { humanizeAdCopyBatch, AD_COPY_ANTI_AI_BLOCK } from "@/lib/humanizer";

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
  /** 用户在前端选择的广告语言代码（如 "da"），优先于国家推导的语言 */
  adLanguageCode?: string;
  /** 商家网站爬取文本，供 AI 生成具体描述（避免泛化） */
  pageText?: string;
  /** 商家真实产品列表（含名称/价格），供 AI 引用真实数据 */
  crawledProducts?: Array<{ name: string; price?: number; currency?: string }>;
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

/** CJK 文字检测（中日韩统一表意文字、假名等），用于跳过英文商业意图检测 */
function hasCjkChars(text: string): boolean {
  return /[\u3000-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF\uAC00-\uD7AF]/.test(text);
}
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
    // 修复重复标点
    candidate = candidate.replace(/([!?.])\1+/g, "$1");
    candidate = candidate.replace(/[!?]{2,}/g, "!");
    candidate = candidate.replace(/^[\-–—:;,./\s]+|[\-–—:;,./\s]+$/g, "");
    // 修复全大写（>50% 大写字母 → Title Case）
    const letters = candidate.replace(/[^a-zA-Z]/g, "");
    if (letters.length >= 3) {
      const upperCount = (candidate.match(/[A-Z]/g) || []).length;
      if (upperCount / letters.length > 0.5) {
        candidate = candidate.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      }
    }

    if (!candidate || candidate.length > maxLen) continue;
    if (hasExplicitDateOrExpiredSignal(candidate)) continue;
    if (isMeaninglessHeadline(candidate, merchantName)) continue;
    // CJK 文字（日/中/韩）不受英文商业意图检测约束
    if (!hasCjkChars(candidate) && !hasCommercialIntent(candidate) && tokenSet(candidate, merchantName).size < 2) continue;

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
    // 修复重复标点
    candidate = candidate.replace(/([!?.])\1+/g, "$1");
    candidate = candidate.replace(/[!?]{2,}/g, "!");
    candidate = candidate.replace(/^[\-–—:;,./\s]+|[\-–—:;,./\s]+$/g, "");
    // 修复全大写（>50% 大写字母 → Title Case）
    const letters = candidate.replace(/[^a-zA-Z]/g, "");
    if (letters.length >= 3) {
      const upperCount = (candidate.match(/[A-Z]/g) || []).length;
      if (upperCount / letters.length > 0.5) {
        candidate = candidate.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
      }
    }

    if (!candidate || candidate.length > maxLen || candidate.length < 50) continue;
    if (hasExplicitDateOrExpiredSignal(candidate)) continue;
    if (isMeaninglessDescription(candidate, merchantName)) continue;
    // CJK 文字（日/中/韩）不受英文商业意图检测约束
    if (!hasCjkChars(candidate) && !hasCommercialIntent(candidate) && tokenSet(candidate, merchantName).size < 4) continue;

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
      "Angebote entdecken",
      `${product} jetzt sichern`,
      "Starke Leistung Zuhause",
      "Mehr Komfort im Alltag",
      "Qualität für Ihr Zuhause",
      "Jetzt Auswahl ansehen",
      "Zuverlässig & effizient",
      "Premium Auswahl online",
    ];
  }

  if (market.languageCode === "fr") {
    return [
      `${brand} ${product}`,
      "Voir les offres",
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
      "Ver ofertas",
      `Compra ${product} hoy`,
      "Calidad para tu hogar",
      "Estilo y valor",
      "Ofertas que sí convencen",
      "Descubre tu mejor opción",
    ];
  }

  if (market.languageCode === "it") {
    return [
      `${brand} ${product}`,
      "Scopri le offerte",
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
      "Bekijk de aanbiedingen",
      `${product} nu ontdekken`,
      "Slim gemak voor thuis",
      "Kwaliteit die overtuigt",
      "Sterke deals online",
      "Ontdek slim winkelen",
    ];
  }

  if (market.languageCode === "ja") {
    return [
      `${brand} ${product}`,
      "お得な情報をチェック",
      `${product}を今すぐ確認`,
      "毎日に頼れる品質",
      "使いやすさで選ぶなら",
      "公式級の安心感",
      "納得の人気アイテム",
    ];
  }

  return [
    `${brand} ${product}`,
    "Browse Deals Today",
    `Shop ${product} Now`,
    "Quality You Can Trust",
    "Upgrade Your Everyday",
    "Top Picks Online",
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
      `${brand} bietet ${product} mit starker Qualität, Komfort und Vertrauen.`,
      `Entdecken Sie leistungsstarke ${product} für mehr Effizienz im Alltag.`,
      `Jetzt attraktive Angebote prüfen und die passende ${product} Auswahl finden.`,
      `Top-Auswahl an ${product} für Qualitätsbewusste jetzt bei ${brand} entdecken.`,
    ];
  }

  if (market.languageCode === "fr") {
    return [
      `${brand} propose ${product} avec qualité, style et confiance au quotidien.`,
      `Découvrez une sélection ${product} pensée pour plus de confort chaque jour.`,
      `Profitez d'offres fiables et trouvez la solution idéale dès aujourd'hui.`,
      `Explorez la gamme ${product} chez ${brand} pour des achats en toute confiance.`,
    ];
  }

  if (market.languageCode === "es") {
    return [
      `${brand} reúne ${product} con calidad real, confianza y mejor experiencia.`,
      `Descubre opciones ${product} para comprar con más valor y menos dudas.`,
      `Encuentra ofertas convincentes y elige la mejor solución para ti hoy.`,
      `Compra ${product} de calidad en ${brand} con total confianza y comodidad.`,
    ];
  }

  if (market.languageCode === "it") {
    return [
      `${brand} offre ${product} con qualità affidabile e comfort ogni giorno.`,
      `Scopri una selezione ${product} pensata per valore, stile e praticità.`,
      `Approfitta di offerte credibili e scegli la soluzione giusta subito.`,
      `Esplora la gamma ${product} su ${brand} per acquisti sicuri e di qualità.`,
    ];
  }

  if (market.languageCode === "nl") {
    return [
      `${brand} biedt ${product} met kwaliteit, gemak en vertrouwen voor thuis.`,
      `Ontdek slimme ${product} keuzes voor meer comfort in je dagelijkse routine.`,
      `Bekijk sterke aanbiedingen en kies vandaag nog de beste oplossing.`,
      `Verken ${product} bij ${brand} voor slim winkelen met vertrouwen.`,
    ];
  }

  if (market.languageCode === "ja") {
    return [
      `${brand}は品質・使いやすさ・安心感で選ばれる${product}を提案します。`,
      `毎日をもっと快適にする${product}を比較しながら選べます。`,
      `納得できる価値と信頼感のある一台を今すぐ見つけましょう。`,
      `${brand}で${product}をチェック。品質と信頼のお買い物体験をお届けします。`,
    ];
  }

  return [
    `${brand} delivers ${product} with trusted quality, comfort and standout value.`,
    `Explore high-conviction ${product} options built for smarter everyday choices.`,
    `Find the right fit faster with strong offers, clear value and easy buying.`,
    `Shop ${product} at ${brand} for quality you can trust and great value today.`,
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

/** 判断是否为连接超时/网络错误（值得立即重试） */
function isConnectError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message || "";
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  return (
    msg.includes("fetch failed") ||
    msg.includes("ConnectTimeoutError") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    cause?.code === "UND_ERR_CONNECT_TIMEOUT" ||
    cause?.code === "ECONNRESET"
  );
}

/** 调用 AI API（OpenAI 兼容格式），连接超时自动重试，429 自动退避 */
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

  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(120000),
      });
    } catch (err) {
      if (isConnectError(err) && attempt < MAX_RETRIES) {
        const delay = 2000 * (attempt + 1);
        console.warn(`[AI] ${config.modelName} 连接失败(${attempt + 1}/${MAX_RETRIES})，${delay / 1000}s 后重试`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw err;
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const retryAfter = parseInt(res.headers.get("retry-after") || "0", 10);
      const delayMs = retryAfter > 0 ? retryAfter * 1000 : 3000;
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
  const allModels = await getSceneModels(scene);
  if (allModels.length === 0) throw new Error(`场景 ${scene} 无可用 AI 模型`);

  const models = allModels.slice(0, 4);

  let lastError: Error | null = null;
  for (const model of models) {
    try {
      return await callAi(model, messages, maxTokens);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[AI] ${model.modelName} 失败，尝试下一个:`, lastError.message);
      if (lastError.message.includes("insufficient_user_quota")) {
        throw lastError;
      }
    }
  }

  // 场景模型全部失败时，尝试 deepseek-chat 兜底
  const fallbackProvider = await prisma.ai_providers.findFirst({
    where: { status: "active", is_deleted: 0 },
    orderBy: { id: "asc" },
  });
  if (fallbackProvider?.api_key) {
    const emergencyModels = ["deepseek-chat", "gpt-4o-mini"];
    for (const modelName of emergencyModels) {
      try {
        console.warn(`[AI] 场景 ${scene} 全部失败，尝试兜底模型: ${modelName}`);
        return await callAi({
          providerName: fallbackProvider.provider_name,
          apiKey: fallbackProvider.api_key,
          baseUrl: fallbackProvider.api_base_url || "https://api.openai.com",
          modelName,
          maxTokens: maxTokens || 4096,
          temperature: 0.7,
        }, messages, maxTokens);
      } catch (err) {
        console.warn(`[AI] 兜底模型 ${modelName} 也失败:`, err instanceof Error ? err.message : err);
      }
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
  const languageName = resolveLanguageName(country, options.adLanguageCode);
  const locked = sanitizeHeadlineCandidates(existing, merchantName, 30, count);
  if (locked.length >= count) return locked.slice(0, count);

  const references = sanitizeHeadlineCandidates(options.referenceItems || [], merchantName, 30, 12);
  const keywords = (options.keywords || []).map((k) => normalizeWhitespace(k)).filter(Boolean).slice(0, 12);
  const dailyBudget = Number(options.dailyBudget) > 0 ? Number(options.dailyBudget) : 1.5;
  const maxCpc = Number(options.maxCpc) > 0 ? Number(options.maxCpc) : 0.3;
  const biddingStrategy = options.biddingStrategy || "MAXIMIZE_CLICKS";
  const aiRulePrompt = buildAiRulePrompt(options.aiRuleProfile, "ad_copy");

  {
    const needed = count - locked.length;
    const isNonEnglish = market.languageCode !== "en";
    const langWarning = isNonEnglish
      ? `⚠️ CRITICAL: Write ONLY in ${languageName}. English is FORBIDDEN.\n\n`
      : "";
    const prompt = `You are Adrian · Data Hunter — not just a strategist, but a conversion copywriter who has written 10,000+ Google Ads headlines and knows exactly which words make people click. Your copy doesn't just fill space — it stops the scroll, sparks desire, and drives action.
${langWarning}
Context:
- Merchant: ${merchantName}
- Market: ${market.countryNameZh} — write in ${languageName}
- Style: ${market.style}
- Budget: $${dailyBudget.toFixed(2)}/day, Max CPC $${maxCpc.toFixed(2)}, Strategy: ${biddingStrategy}

${aiRulePrompt ? `Adrian's persona rules (MUST follow above all else):\n${aiRulePrompt}\n\n` : ""}${keywords.length > 0 ? `Confirmed high-intent keywords (build headlines around these):\n${keywords.map((k, i) => `${i + 1}. ${k}`).join("\n")}\n` : ""}
${references.length > 0 ? `Competitor/market reference headlines (study the angle, do NOT copy — rewrite in ${languageName}):\n${references.map((h, i) => `${i + 1}. \"${h}\"`).join("\n")}\n` : ""}
${locked.length > 0 ? `Already locked headlines (do NOT duplicate or rephrase):\n${locked.map((h, i) => `${i + 1}. \"${h}\"`).join("\n")}\n` : ""}
${AD_COPY_ANTI_AI_BLOCK}

Generate exactly ${needed} NEW headlines. Return ONLY a JSON array of exactly ${needed} strings.

═══ ADRIAN'S HEADLINE CRAFT — THE ART OF 30 CHARACTERS ═══

A great headline does ONE thing in under 30 characters: it makes the searcher think "this is for me."
Bad headlines describe the product. Great headlines describe the FEELING of owning it.

7-ANGLE FRAMEWORK — distribute across these angles:
  ① PAIN/DESIRE HOOK: Name the exact itch they're trying to scratch. Be specific enough to make them feel caught.
     ✗ "Skin Care Products" (boring, generic, invisible)
     ✓ "Breakouts? Not Anymore" (emotional, personal, specific)
     ✓ "Finally — Chargers That Last" (relief, frustration solved)
  ② RESULT YOU CAN SEE: Paint the after-picture in concrete terms. Numbers, timeframes, visible outcomes.
     ✗ "Great Quality" (meaningless)
     ✓ "Visibly Clearer in 14 Days" (timeline + outcome)
     ✓ "2x Faster — Proven" (measurable, credible)
  ③ TRUST MAGNET: Make skeptics feel safe. Real proof, not empty claims.
     ✓ "4.8★ by 12K+ Customers" / "As Featured in Forbes" / "Lab-Tested Formula"
  ④ SEARCH MIRROR: Echo EXACTLY what they typed. The brain scans for pattern matches.
     Searched "leather laptop bag" → "Leather Laptop Bags — Handmade"
     Searched "wireless charger stand" → "Wireless Charger Stand"
  ⑤ ONLY-WE-DO-THIS: The thing competitors can't say. Must be real, must be specific.
     ✓ "No Chemicals — Ever" / "The Only MagSafe That Folds" / "Handcrafted in Italy"
  ⑥ ACTION WITH REASON: Don't just say "Shop" — give them a reason to act NOW.
     ✗ "Shop Now" (why now? why you?)
     ✓ "Get Yours — Free Returns" / "Try Risk-Free for 30 Days"
  ⑦ BRAND ANCHOR: Make "${merchantName}" memorable, not just present.
     ✗ "${merchantName}" (just a name, zero information)
     ✓ "${merchantName} — Where Style Meets Durability"

POWER TECHNIQUES (use at least 3 across your ${needed} headlines):
  • CONTRAST: "Without the Harsh Chemicals" / "Not Another Generic Brand"
  • SPECIFICITY: "3 Active Ingredients" / "Made from Organic Bamboo"
  • QUESTION HOOK: "Still Using Products That Don't Work?"
  • URGENCY (without dates): "Limited Stock" / "Selling Fast"
  • SENSORY LANGUAGE: "Buttery Soft Leather" / "Crystal Clear Sound"

MANDATORY RULES:
1. Headline #1 MUST include "${merchantName}" — make it ownable and memorable.
2. Do NOT fabricate discount numbers or percentages. Value language is fine ("Save More", "Best Value").
3. Do NOT claim free shipping unless explicitly confirmed in context.
4. Each headline ≤ 30 characters STRICTLY. Count every character including spaces.
5. Write in ${languageName} ONLY. No English words unless part of the brand/product name.
6. No dates, countdowns, or time-limited language.
7. Every headline must have a specific hook — zero filler, zero generic padding.
8. Every headline must open with a DIFFERENT word — no two starting the same way.
9. Mix syntax: questions, statements, commands, noun phrases.
10. Comply with Google Ads policy. Follow all Adrian persona rules above.

Return ONLY a valid JSON array of strings. No explanation, no extra text.`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 2048);
      const parsed = JSON.parse(extractJson(raw)) as string[];
      const humanized = humanizeAdCopyBatch(parsed, 2, 30);
      const generated = sanitizeHeadlineCandidates(humanized, merchantName, 30, needed + 8);
      const combined = sanitizeHeadlineCandidates([...locked, ...generated], merchantName, 30, count);
      const firstIsBrand = combined.length > 0 && normalizeForCompare(combined[0]).includes(normalizeForCompare(getShortBrand(merchantName, 20)).split(" ")[0] || "");

      if (combined.length >= count && firstIsBrand) {
        console.log(`[padHeadlines] 校验通过: 品牌首条=${firstIsBrand}, 共${combined.length}条`);
        return combined.slice(0, count);
      }

      console.warn(`[padHeadlines] AI 输出校验未通过（品牌首条=${firstIsBrand}, 共${combined.length}条），使用 fallback`);
    } catch (err) {
      console.error("[padHeadlines] AI 生成失败:", err);
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
  const languageName = resolveLanguageName(country, options.adLanguageCode);
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

  {
    const needed = count - locked.length;
    const isNonEnglish = market.languageCode !== "en";
    const langWarning = isNonEnglish
      ? `⚠️ CRITICAL: Write ONLY in ${languageName}. English is FORBIDDEN.\n\n`
      : "";
    // 如果传入了 pageText/crawledProducts，构建真实上下文块
    const pageTextBlock = options.pageText
      ? `\nWebsite content (extract specific materials, collections, USPs — reference real facts):\n${options.pageText.slice(0, 3000)}\n`
      : "";
    const productBlock = (options.crawledProducts || []).length > 0
      ? `\nReal products on website (use names/prices as copy anchors — no fabrication):\n${(options.crawledProducts || []).slice(0, 10).map((p, i) => `${i + 1}. "${p.name}"${p.price ? ` — ${p.currency || ""}${p.price}` : ""}`).join("\n")}\n`
      : "";

    const prompt = `You are Adrian · Data Hunter — a conversion copywriter who treats every description as a 90-character sales pitch. Each description is a micro-ad: it must make someone who's on the fence lean forward and click.
${langWarning}
Context:
- Merchant: ${merchantName}
- Market: ${market.countryNameZh} — write in ${languageName}
- Style: ${market.style}
- Budget: $${dailyBudget.toFixed(2)}/day, Max CPC $${maxCpc.toFixed(2)}, Strategy: ${biddingStrategy}
${pageTextBlock}${productBlock}
GOOGLE RSA UNIQUENESS PRINCIPLE (critical for ad strength):
- Google explicitly penalizes descriptions that repeat headline wording — this drops ad strength to "Poor"
- Each description must carry a COMPLETELY DIFFERENT message from headlines AND from each other
- Never copy 3+ consecutive words from any headline — reframe the idea entirely

${headlineBlock}${aiRulePrompt ? `Adrian's persona rules (MUST follow above all else):\n${aiRulePrompt}\n\n` : ""}${keywords.length > 0 ? `Confirmed keywords (weave the intent naturally — do NOT mirror headlines):\n${keywords.map((k, i) => `${i + 1}. ${k}`).join("\n")}\n` : ""}
${references.length > 0 ? `Market reference descriptions (study the approach, rewrite in ${languageName}):\n${references.map((d, i) => `${i + 1}. \"${d}\"`).join("\n")}\n` : ""}
${locked.length > 0 ? `Already locked (do NOT change or duplicate):\n${locked.map((d, i) => `${i + 1}. \"${d}\"`).join("\n")}\n` : ""}
${AD_COPY_ANTI_AI_BLOCK}

Generate exactly ${needed} NEW descriptions. Return ONLY a JSON array of exactly ${needed} strings.

═══ ADRIAN'S DESCRIPTION CRAFT — 90 CHARACTERS TO CLOSE THE DEAL ═══

A headline gets the click-glance. A description closes it. Think of each description as your elevator pitch: you have 90 characters to make someone trust you enough to click.

4-ANGLE FRAMEWORK — one per description:

  Angle A — THE EMPATHY CLOSE: Start where the customer IS, not where you want them to be.
     Name their frustration, then pivot to the solution in one breath.
     ✗ "We offer high-quality skincare products for all skin types." (about YOU, boring)
     ✓ "Done with breakouts? Our 2-step system clears skin in 14 days." (about THEM, specific)
     ✓ "Tired of chargers that die? Ours lasts 3x longer — guaranteed." (pain → proof → promise)

  Angle B — THE IRRESISTIBLE OFFER: Lead with the ONE thing that makes this a no-brainer.
     Then tell them exactly what to do next.
     ✗ "Shop our collection of premium products today." (zero value, zero urgency)
     ✓ "Free shipping + free returns. Shop the best-selling collection now." (value stack + action)
     ✓ "From $19.99. Get the top-rated formula thousands swear by." (price anchor + social proof)

  Angle C — THE TRUST BUILDER: Remove every reason NOT to buy.
     Address the unspoken objection: "Is this legit? Will it work for me?"
     ✓ "Loved by 50K+ customers. 30-day money-back, no questions asked." (crowd + safety net)
     ✓ "Dermatologist-tested. Clinically proven. See why it's rated 4.8★." (authority + data)

  Angle D — THE COMPETITIVE WEDGE: One sentence that makes every alternative feel inferior.
     ✓ "The only formula with 3 patented ingredients. No generic substitutes." (exclusivity)
     ✓ "Handmade in Italy — not mass-produced. Feel the difference." (craft vs. commodity)

AVOID HEADLINE MIRRORING — mandatory check before output:
  - Do NOT repeat the first 3 words of any headline
  - Descriptions must ADD new information, not rephrase headlines
  - Each description must make the reader learn something NEW about the product

MANDATORY RULES:
1. Each description: 50–90 characters EXACTLY. Count every character including spaces and punctuation.
2. Write in ${languageName} ONLY. No English words unless part of the brand/product name.
3. Do NOT fabricate discount numbers, prices, or free shipping unless explicitly confirmed.
4. No dates, countdown timers, or expiry language.
5. Every description must open with a COMPLETELY DIFFERENT word or phrase — zero repetition.
6. Vary sentence structure — mix statements, commands, questions.
7. Full sentences preferred — but punchy fragments are OK if they hit hard.
8. Comply with Google Ads policy. Follow all Adrian persona rules above.

Return ONLY a valid JSON array of strings. No explanation, no extra text.`;

    try {
      const raw = await callAiWithFallback("ad_copy", [{ role: "user", content: prompt }], 2048);
      const parsed = JSON.parse(extractJson(raw)) as string[];
      const humanized = humanizeAdCopyBatch(parsed, 40, 90);
      const generated = sanitizeDescriptionCandidates(humanized, merchantName, 90, needed + 4, descSanitizeOpts);
      const combined = sanitizeDescriptionCandidates([...locked, ...generated], merchantName, 90, count, descSanitizeOpts);
      if (combined.length >= count) {
        console.log(`[padDescriptions] 校验通过: 共${combined.length}条`);
        return combined.slice(0, count);
      }

      console.warn(`[padDescriptions] AI 输出校验未通过（共${combined.length}条），使用 fallback`);
    } catch (err) {
      console.error("[padDescriptions] AI 生成失败:", err);
    }
  }

  const fallbackCandidates = getFallbackDescriptionCandidates(merchantName, market, keywords);
  const fallback = sanitizeDescriptionCandidates([...locked, ...fallbackCandidates], merchantName, 90, count, descSanitizeOpts);
  return fallback.slice(0, count);
}

// ─── Adrian 每日数据洞察 ──────────────────────────────────────

export interface DailyInsightMetrics {
  totalCost: number;
  totalCommission: number;
  totalRejectedCommission: number;
  totalApprovedCommission: number;
  totalPendingCommission: number;
  totalClicks: number;
  totalImpressions: number;
  avgCpc: number;
  roi: number;
  enabledCount: number;
  pausedCount: number;
  campaignCount: number;
}

export interface DailyInsightCampaignRow {
  campaign_name: string;
  status: string;
  cost: number;
  clicks: number;
  impressions: number;
  commission: number;
  rejected_commission: number;
  orders: number;
  roi: number;
  daily_budget?: number;
}

export interface DailyInsightAffiliatePlatform {
  platform: string;
  total_commission: number;
  rejected_commission: number;
  pending_commission: number;
  approved_commission: number;
  orders: number;
}

/**
 * Adrian · 数据猎手 每日洞察报告生成
 * 返回 Markdown 格式的专业分析报告
 */
export async function generateDailyInsight(params: {
  username: string;
  date: string;
  metrics: DailyInsightMetrics;
  campaigns: DailyInsightCampaignRow[];
  affiliatePlatforms: DailyInsightAffiliatePlatform[];
}): Promise<string> {
  const { username, date, metrics, campaigns, affiliatePlatforms } = params;

  const hasData = metrics.totalCost > 0 || metrics.totalCommission > 0 || metrics.totalClicks > 0;
  if (!hasData) {
    return `## 📊 ${username} 昨日数据洞察 · ${date}\n\n> 昨日无广告花费或联盟佣金数据，跳过分析。如账户已启用，请检查 MCC 数据同步状态。`;
  }

  // ROI 区间标注（用净利润率表述，更贴近业务）
  const roiPct = (metrics.roi * 100).toFixed(1);
  const roiLabel = metrics.roi < 0
    ? `亏损 ${Math.abs(metrics.roi * 100).toFixed(1)}%`
    : metrics.roi < 1
      ? `净利润率 ${roiPct}%（盈亏边缘）`
      : metrics.roi < 2
        ? `净利润率 ${roiPct}%（稳定盈利）`
        : `净利润率 ${roiPct}%（高效盈利）`;

  const roiZone = metrics.roi < 0 ? "亏损" : metrics.roi < 1 ? "盈亏边缘" : metrics.roi < 2 ? "稳定盈利" : "高效盈利";

  // 佣金说明：来自联盟平台全状态汇总（pending=待结算，approved=已结算，rejected=已拒付）
  const allCommission = metrics.totalCommission;
  const pendingPct = allCommission > 0 ? (metrics.totalPendingCommission / allCommission * 100).toFixed(0) : "0";
  const approvedPct = allCommission > 0 ? (metrics.totalApprovedCommission / allCommission * 100).toFixed(0) : "0";
  const rejectedPct = allCommission > 0 ? (metrics.totalRejectedCommission / allCommission * 100).toFixed(0) : "0";

  // 按花费排序 Top 5 系列
  const topCampaigns = [...campaigns].sort((a, b) => b.cost - a.cost).slice(0, 5);

  const platformTable = affiliatePlatforms.map((p) => {
    const rejRate = p.total_commission > 0 ? (p.rejected_commission / p.total_commission * 100).toFixed(0) : "0";
    const warn = parseFloat(rejRate) > 30 ? " ⚠️" : "";
    return `| ${p.platform} | $${p.total_commission.toFixed(2)} | $${p.approved_commission.toFixed(2)} | $${p.pending_commission.toFixed(2)} | ${rejRate}%${warn} | ${p.orders} |`;
  }).join("\n");

  const prompt = `你是 Adrian · 数据猎手，Google Ads 跨境电商广告数据分析师，专注 ROI 导向投放。

职业信条：「没有坏的产品，只有投错的人群和出不动的价。」

为用户「${username}」出具 **${date}** 昨日广告数据洞察报告。

══════════════════════════
数据来源说明（必读）：
- 广告花费/点击/曝光：来自 Google Ads MCC，实时同步
- 联盟佣金：来自联盟平台 API，**全状态汇总**（待结算+已结算+已拒付）
  · 待结算(Pending)：订单已生成，平台确认中，一般 7-30天到账
  · 已结算(Approved)：平台已确认，可提款
  · 已拒付(Rejected)：订单被取消或违规，不计入实收
══════════════════════════

【广告投放总览】
- 广告花费：**$${metrics.totalCost.toFixed(2)}**
- 总点击：**${metrics.totalClicks}**（曝光 ${metrics.totalImpressions.toLocaleString()}）
- 平均 CPC：**$${metrics.avgCpc.toFixed(4)}**
- 投放中系列：${metrics.enabledCount} 条 | 已暂停系列：${metrics.pausedCount} 条

【联盟收入总览（全状态）】
- 联盟佣金总额：**$${allCommission.toFixed(2)}**（含所有状态）
  · 待结算：**$${metrics.totalPendingCommission.toFixed(2)}**（${pendingPct}%）
  · 已结算：**$${metrics.totalApprovedCommission.toFixed(2)}**（${approvedPct}%）
  · 已拒付：**$${metrics.totalRejectedCommission.toFixed(2)}**（${rejectedPct}%）
- 净利润：**$${(allCommission - metrics.totalCost).toFixed(2)}**（${roiLabel}，处于${roiZone}区）

【各系列明细（按花费排序，最多5条）】
${topCampaigns.length > 0 ? topCampaigns.map((c) => {
  const netProfit = c.commission - c.cost;
  const cpc = c.clicks > 0 ? (c.cost / c.clicks).toFixed(4) : "N/A";
  const profitStr = netProfit >= 0 ? `盈利 $${netProfit.toFixed(2)}` : `亏损 $${Math.abs(netProfit).toFixed(2)} ⚠️`;
  return `- [${c.status}] ${c.campaign_name}：花费 $${c.cost.toFixed(2)}，点击 ${c.clicks}，CPC $${cpc}，佣金 $${c.commission.toFixed(2)} → ${profitStr}`;
}).join("\n") : "（无系列数据）"}

【各平台收入分布】
| 平台代号 | 佣金总额 | 已结算 | 待结算 | 拒付率 | 订单数 |
|----------|---------|--------|--------|--------|--------|
${platformTable || "| 暂无数据 | - | - | - | - | - |"}

══════════════════════════
输出要求：
- 纯中文 Markdown，数字加粗，使用业务化名词（不用 ENABLED/PAUSED/ROI/ROAS 等英文缩写）
- 分5段，每段 ## 二级标题
- 全文严格 600-800 字，不得超出
- 禁止臆造数据，禁止"一定""保证"等绝对化表达
- 行动建议必须具体（动词+对象+预期效果），最多3条
══════════════════════════

## 一、今日数据快照
用表格或列表呈现核心指标，加粗关键数字，末尾一句话给出 Adrian 对整体状态的直接判断

## 二、系列投放诊断
逐条分析各系列表现，花费>$1的重点分析。CPC异常（>$1或<$0.05）、有亏损的系列必须点名说明原因和建议动作

## 三、联盟收入解读
解释各平台佣金结构（待结算/已结算/拒付），拒付率>20%要单独预警，同时评估已结算金额是否能覆盖花费

## 四、今日行动建议
最多3条，格式：**N. [动作]** — 原因 — 预期效果。必须可操作，不写"继续观察""保持关注"等废话

## 五、明日重点盯盘
一句话，点明明天最值得关注的1个指标或事件`;

  try {
    const result = await callAiWithFallback("data_insight", [{ role: "user", content: prompt }], 1500);
    return result.trim();
  } catch (err) {
    console.error(`[generateDailyInsight] AI 生成失败 (${username}):`, err);
    // 降级输出结构化摘要
    return [
      `## 📊 ${username} 昨日数据洞察 · ${date}`,
      "",
      "### 一、核心指标雷达",
      `- **广告花费**：$${metrics.totalCost.toFixed(2)} | **联盟佣金**：$${metrics.totalCommission.toFixed(2)} | **ROI**：${metrics.roi.toFixed(2)}（${roasLabel}）`,
      `- 点击：${metrics.totalClicks} | 曝光：${metrics.totalImpressions.toLocaleString()} | 平均 CPC：$${metrics.avgCpc.toFixed(4)}`,
      `- 待确认佣金：$${metrics.totalPendingCommission.toFixed(2)} | 被拒佣金：$${metrics.totalRejectedCommission.toFixed(2)}`,
      "",
      "> AI 分析暂时不可用，以上为原始数据摘要。请稍后刷新或联系管理员。",
    ].join("\n");
  }
}
