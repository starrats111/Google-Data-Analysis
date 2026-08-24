/**
 * 竞品创意文案识图（D-273.4）
 *
 * 背景：Google 广告透明中心把文本广告渲染成图片存档，SerpApi 无论列表还是详情接口
 * 都只回一个 `image` 链接、不回任何文字（D-273.2 生产实证），文案全印在图里。
 * 此前这些创意在 `normalizeTransparencyCreative` 处被整批丢弃（单域名可达 247 条）。
 *
 * 通道：图片 URL 直传视觉模型，本机既不下载图也不做图像处理（沿用 domain_ocr 的做法，
 * 满足「OCR 不拖累服务器」）。该模型按次计费，一次调用喂 1 张和喂 20 张同价，
 * 所以批量是纯赚。
 *
 * 但批量不能无限大：生产实测 48 张时，返回条数（48/48）、finish_reason（stop）、
 * 空结果数（0）全部正常，图文却已错位——埋在第 24、48 位的探针图一个返回空、
 * 一个返回了别家文案。表面指标全绿的脏数据比报错危险得多，故：
 *   ① 单批上限压在 20 张（16/24/32 张实测均正确，离失效点留足余量）；
 *   ② 强制串位自检——要求模型顺带回报它在每张图上看到的网址，与 SerpApi 结构化
 *      字段 `target_domain` 核对；对不上就拆半重跑。自检字段在同一次调用里产出，
 *      不额外花钱。
 *
 * 注意自检基准只能用 SerpApi 的 target_domain，不能用 ad_image_ocr_cache 里
 * tesseract 识别的域名——实测 20 张里有 6 张历史域名本身就是错的（l/i 混淆等）。
 */

import { prisma } from "@/lib/prisma";
import { normalizeAdEntry } from "@/lib/rival-intel/brand-assessment/derive";
import type { AdEntry } from "@/lib/rival-intel/brand-assessment/types";

/** 单批上限。实测 48 张会串位，16/24/32 张正确，取 20 留余量。 */
const MAX_IMAGES_PER_CALL = 20;
/** 一次竞品拉取最多识图多少张（07 定的量级）。 */
const MAX_CREATIVES_PER_RUN = 20;
/** 串位后最多再拆两层（20 → 10+10 → 5×4），再深就认了并留 warning。 */
const MAX_SPLIT_DEPTH = 2;
/** 有效比对样本达到这个数才判串位，样本太少时不符可能只是模型没读到网址。 */
const MISALIGN_MIN_SAMPLES = 4;
const MISALIGN_RATIO = 0.4;
const VISION_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 8000;

export interface ImageCreative {
  imageUrl: string;
  /** SerpApi 结构化字段，串位自检的基准，也用于判 brand_own / non_brand */
  targetDomain: string | null;
  advertiser: string | null;
  link: string | null;
  /** 透明中心的 last_shown，用于「取最近还在投的」 */
  lastShown: string | null;
}

export interface CreativeCopyStats {
  /** 只有图、提不出文字的创意总数 */
  imageOnlyCandidates: number;
  attempted: number;
  cacheHits: number;
  aiCalls: number;
  /** 真正提出文案的条数 */
  recovered: number;
  shoppingSkipped: number;
  emptyResults: number;
  misalignedRetries: number;
  failed: number;
}

export interface CreativeCopyResult {
  ads: AdEntry[];
  stats: CreativeCopyStats;
  warnings: string[];
}

interface CopyPayload {
  status: "success" | "empty" | "shopping" | "failed";
  headlines: string[];
  descriptions: string[];
  seenUrl: string | null;
}

// ─── 小工具（与 competitor-source 同风格，各文件自带避免循环依赖）───

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function cleanStringList(value: unknown, limit = 8): string[] {
  const out: string[] = [];
  for (const item of asArray(value)) {
    const text = asString(item);
    if (!text) continue;
    if (out.includes(text)) continue;
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 界面噪音兜底：有些归档图其实是落地页预览而非标准搜索广告截图，模型会把页面控件
 * 文字拼进描述（实测 spiderfarmer 那张就混进了「Previous slide Next slide ... Shop by」）。
 * prompt 里已经要求排除但模型不总是听，所以代码这层再拦一道。
 * 只收几乎不可能出现在真实广告文案里的词，避免误杀正常文案。
 */
const UI_NOISE_MARKERS = [
  "previous slide",
  "next slide",
  "skip to content",
  "add to cart",
  "my account",
  "shop by",
  "return policy",
  "browse more",
  "check more",
] as const;

function isUiNoise(text: string): boolean {
  const t = text.toLowerCase();
  return UI_NOISE_MARKERS.some((marker) => t.includes(marker));
}

/** 取域名主体词用于宽松比对：www.lavetir.com/x → lavetir */
function domainCore(value: string): string {
  const host = value
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0] ?? "";
  return host.split(".")[0] ?? "";
}

// ─── 候选筛选 ───

/**
 * 从原始 transparency 创意里挑出「只有图、没有文字」的那批，按最近投放时间排序。
 * 有文字的创意走既有 normalizeTransparencyCreative 路径，不该重复识图。
 */
export function pickImageOnlyCreatives(
  creatives: unknown[],
  limit = MAX_CREATIVES_PER_RUN,
): ImageCreative[] {
  const seen = new Set<string>();
  const picked: { item: ImageCreative; order: number; ts: number }[] = [];

  creatives.forEach((raw, index) => {
    const c = asObject(raw);
    if (!c) return;

    const imageUrl = firstString(c.image, c.image_url, c.thumbnail);
    if (!imageUrl || imageUrl.length > 768) return;
    if (seen.has(imageUrl)) return;

    // 已经能提出文字的交给既有路径，避免重复识别与重复计数
    const hasText = Boolean(
      firstString(c.headline, c.long_headline, c.title, c.ad_title) ||
        firstString(c.description, c.body, c.snippet, c.text, c.creative_text),
    );
    if (hasText) return;

    seen.add(imageUrl);
    const lastShown = firstString(c.last_shown, c.lastShown) || null;
    const parsed = lastShown ? Date.parse(lastShown) : Number.NaN;
    picked.push({
      order: index,
      ts: Number.isNaN(parsed) ? -1 : parsed,
      item: {
        imageUrl,
        targetDomain: firstString(c.target_domain, c.domain, c.displayed_url, c.visible_link) || null,
        advertiser: firstString(c.advertiser, c.advertiser_name) || null,
        link: firstString(c.link, c.final_url, c.url) || null,
        lastShown,
      },
    });
  });

  // 有 last_shown 的按时间新→旧排前面；解析不出时间的保持 SerpApi 原顺序垫后
  picked.sort((a, b) => (b.ts - a.ts) || (a.order - b.order));
  return picked.slice(0, Math.max(0, limit)).map((p) => p.item);
}

// ─── 视觉模型配置 ───

interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  maxTokens: number;
}

/**
 * 优先用独立场景 creative_copy_ocr（便于单独换模型），迁移未跑或未配时回退到
 * domain_ocr——两者都是同一个视觉模型，回退不影响功能。
 */
async function loadCopyVisionConfig(): Promise<VisionConfig | null> {
  const cfg =
    (await prisma.ai_model_configs.findFirst({
      where: { scene: "creative_copy_ocr", is_active: 1, is_deleted: 0 },
      orderBy: { priority: "asc" },
    })) ??
    (await prisma.ai_model_configs.findFirst({
      where: { scene: "domain_ocr", is_active: 1, is_deleted: 0 },
      orderBy: { priority: "asc" },
    }));
  if (!cfg) return null;

  const provider = await prisma.ai_providers.findFirst({
    where: { id: cfg.provider_id, status: "active", is_deleted: 0 },
  });
  if (!provider?.api_key || !provider.api_base_url) return null;

  return {
    baseUrl: provider.api_base_url,
    apiKey: provider.api_key,
    modelName: cfg.model_name,
    maxTokens: cfg.max_tokens && cfg.max_tokens > 0 ? cfg.max_tokens : DEFAULT_MAX_TOKENS,
  };
}

function buildPrompt(count: number): string {
  return [
    `下面依次给你 ${count} 张 Google 搜索广告截图，编号 1 到 ${count}。`,
    "对每一张都必须输出一条结果，不许跳过、不许合并，顺序必须与图片顺序完全一致。字段：",
    '  "i": 编号',
    '  "seen_url": 你在这张图上看到的网址或品牌官网域名原文（看不到就填空字符串）',
    '  "shopping": 是否是商品网格样式的购物广告（一堆商品小标题、没有正常的标题+描述结构）',
    '  "headlines": 广告标题原文数组',
    '  "descriptions": 广告描述原文数组',
    "规则：",
    "- 保持原语言原文，不翻译、不改写、不补全、不合并不同图的内容",
    "- headlines 只要广告最上方那一行醒目的主标题（通常 1 条，被 - 或 | 连接的算同一条）",
    "- 广告下方那排附加链接是站内导航（如「官网」「产品文档」「价格方案」「新手教程」",
    "  「Shop Now」这类短词），不是广告标题，一律不要放进 headlines",
    "- 排除 Sponsored、广告主名称、网址行、星级评分、评价条数、Return policy、",
    "  Previous slide、Next slide、Check More、Browse More 这类界面元素",
    "- shopping=true 时 headlines/descriptions 留空数组",
    "- 若这张图是网站页面/落地页截图而非搜索广告（没有「标题+描述+网址」结构），",
    "  descriptions 留空，别把页面上的按钮、轮播和导航文字拼成描述",
    "- 图看不清或确实没有文案就留空数组，不要编造",
    `只输出 JSON 数组，长度必须正好 ${count}，不要 markdown 代码块。`,
  ].join("\n");
}

interface BatchOutcome {
  /** 与入参等长；解析失败则为 null */
  payloads: (CopyPayload | null)[] | null;
  error?: string;
}

async function callVisionBatch(
  items: ImageCreative[],
  cfg: VisionConfig,
): Promise<BatchOutcome> {
  const base = cfg.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const content: unknown[] = [{ type: "text", text: buildPrompt(items.length) }];
  items.forEach((item, index) => {
    content.push({ type: "text", text: `第 ${index + 1} 张：` });
    // URL 直传：图由上游去取，本机不下载
    content.push({ type: "image_url", image_url: { url: item.imageUrl } });
  });

  let resp: Response;
  try {
    resp = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.modelName,
        messages: [{ role: "user", content }],
        max_tokens: cfg.maxTokens,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
    });
  } catch (err) {
    return { payloads: null, error: `vision 请求失败: ${(err as Error).message}`.slice(0, 200) };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { payloads: null, error: `vision HTTP ${resp.status}: ${text.slice(0, 160)}` };
  }

  const data = (await resp.json().catch(() => null)) as
    | {
        choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      }
    | null;
  const msg = data?.choices?.[0]?.message?.content;
  let raw = "";
  if (typeof msg === "string") raw = msg;
  else if (Array.isArray(msg)) raw = msg.map((p) => p?.text ?? "").join("");

  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return { payloads: null, error: `vision 返回无 JSON 数组: ${raw.slice(0, 160)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    return { payloads: null, error: `vision JSON 解析失败: ${(err as Error).message}`.slice(0, 200) };
  }

  const rows = asArray(parsed);
  const byIndex = new Map<number, Record<string, unknown>>();
  rows.forEach((row, fallbackIndex) => {
    const obj = asObject(row);
    if (!obj) return;
    const rawIndex = obj.i;
    const idx =
      typeof rawIndex === "number" && Number.isFinite(rawIndex)
        ? Math.trunc(rawIndex)
        : fallbackIndex + 1;
    if (!byIndex.has(idx)) byIndex.set(idx, obj);
  });

  const payloads = items.map((_, index) => {
    const obj = byIndex.get(index + 1);
    if (!obj) return null;
    const headlines = cleanStringList(obj.headlines).filter((t) => !isUiNoise(t));
    const descriptions = cleanStringList(obj.descriptions).filter((t) => !isUiNoise(t));
    const shopping = obj.shopping === true || obj.shopping === "true";
    const seenUrl = asString(obj.seen_url) || null;
    let status: CopyPayload["status"] = "success";
    if (shopping) status = "shopping";
    else if (headlines.length === 0 && descriptions.length === 0) status = "empty";
    return { status, headlines, descriptions, seenUrl } satisfies CopyPayload;
  });

  return { payloads };
}

/**
 * 串位检测：模型报的 seen_url 与 SerpApi 的 target_domain 对不上，说明这一批图文错位。
 * 只统计两边都有值、且主体词够长（短词容易假匹配）的条目。
 */
function isMisaligned(items: ImageCreative[], payloads: (CopyPayload | null)[]): boolean {
  let compared = 0;
  let mismatched = 0;
  items.forEach((item, index) => {
    const payload = payloads[index];
    if (!payload || payload.status === "failed") return;
    const core = item.targetDomain ? domainCore(item.targetDomain) : "";
    const seen = payload.seenUrl?.toLowerCase() ?? "";
    if (core.length < 4 || !seen) return;
    compared += 1;
    if (!seen.includes(core)) mismatched += 1;
  });
  if (compared < MISALIGN_MIN_SAMPLES) return false;
  return mismatched / compared > MISALIGN_RATIO;
}

/**
 * 识别一批图；发现串位就拆半重跑（每半各自再自检），最深 MAX_SPLIT_DEPTH 层。
 * 单张不做自检——一张图不存在错位，且拆不下去了。
 */
async function identifyWithSplit(
  items: ImageCreative[],
  cfg: VisionConfig,
  counters: { aiCalls: number; misalignedRetries: number; warnings: string[] },
  depth = 0,
): Promise<(CopyPayload | null)[]> {
  if (items.length === 0) return [];

  counters.aiCalls += 1;
  const outcome = await callVisionBatch(items, cfg);
  if (!outcome.payloads) {
    if (outcome.error) counters.warnings.push(outcome.error);
    return items.map(() => null);
  }

  const needSplit =
    items.length > 1 && depth < MAX_SPLIT_DEPTH && isMisaligned(items, outcome.payloads);
  if (!needSplit) {
    if (items.length > 1 && depth >= MAX_SPLIT_DEPTH && isMisaligned(items, outcome.payloads)) {
      counters.warnings.push(
        `识图结果与创意来源域名多处不符（已拆到 ${items.length} 张仍不符），该批文案可信度低`,
      );
    }
    return outcome.payloads;
  }

  counters.misalignedRetries += 1;
  const mid = Math.ceil(items.length / 2);
  const left = await identifyWithSplit(items.slice(0, mid), cfg, counters, depth + 1);
  const right = await identifyWithSplit(items.slice(mid), cfg, counters, depth + 1);
  return [...left, ...right];
}

// ─── 缓存 ───

async function readCopyCache(imageUrls: string[]): Promise<Map<string, CopyPayload>> {
  const out = new Map<string, CopyPayload>();
  if (imageUrls.length === 0) return out;
  const rows = await prisma.ad_creative_copy_cache.findMany({
    where: { image_url: { in: imageUrls } },
    select: {
      image_url: true,
      status: true,
      headlines: true,
      descriptions: true,
      seen_url: true,
    },
  });
  for (const row of rows) {
    // failed 不算命中，下次仍可重试
    if (row.status === "failed") continue;
    out.set(row.image_url, {
      status: row.status as CopyPayload["status"],
      headlines: cleanStringList(row.headlines),
      descriptions: cleanStringList(row.descriptions),
      seenUrl: row.seen_url,
    });
  }
  return out;
}

async function writeCopyCache(
  entries: { imageUrl: string; payload: CopyPayload }[],
  modelUsed: string,
): Promise<void> {
  for (const { imageUrl, payload } of entries) {
    const data = {
      status: payload.status,
      headlines: payload.headlines,
      descriptions: payload.descriptions,
      seen_url: payload.seenUrl?.slice(0, 255) ?? null,
      model_used: modelUsed.slice(0, 64),
      last_error: null,
    };
    try {
      await prisma.ad_creative_copy_cache.upsert({
        where: { image_url: imageUrl },
        create: { image_url: imageUrl, ...data },
        update: data,
      });
    } catch {
      /* 缓存写失败不该影响本次已拿到的文案 */
    }
  }
}

// ─── 结果组装 ───

/**
 * 一张广告图常带多条标题/描述（响应式广告在截图里就是这样），只取第一条会白扔素材。
 * 按下标配对成多个 AdEntry，短的一边复用首条，让下游 dedupedTitles/Descriptions 拿全。
 */
function toAdEntries(
  item: ImageCreative,
  payload: CopyPayload,
  fallbackDomain: string,
): AdEntry[] {
  const { headlines, descriptions } = payload;
  if (headlines.length === 0 && descriptions.length === 0) return [];

  // 展示域名优先用 SerpApi 结构化字段；它决定后续 brand_own / non_brand 归属
  const displayedLink = item.targetDomain ?? payload.seenUrl ?? fallbackDomain;
  const link = item.link ?? item.targetDomain ?? fallbackDomain;
  const count = Math.max(headlines.length, descriptions.length);

  const entries: AdEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const title = headlines[i] ?? headlines[0] ?? "";
    const description = descriptions[i] ?? descriptions[0] ?? "";
    if (!title && !description) continue;
    entries.push(
      normalizeAdEntry({ title, description, displayed_link: displayedLink, link, sitelinks: [] }),
    );
  }
  return entries;
}

/**
 * 主入口：把「只有图」的透明中心创意识别成可用广告文案。
 * 任何环节失败都只返回空结果 + warning，绝不让识图拖垮整条竞品拉取。
 */
export async function recoverCopyFromImageCreatives(
  rawCreatives: unknown[],
  fallbackDomain: string,
  options: { limit?: number } = {},
): Promise<CreativeCopyResult> {
  const stats: CreativeCopyStats = {
    imageOnlyCandidates: 0,
    attempted: 0,
    cacheHits: 0,
    aiCalls: 0,
    recovered: 0,
    shoppingSkipped: 0,
    emptyResults: 0,
    misalignedRetries: 0,
    failed: 0,
  };
  const warnings: string[] = [];

  const candidates = pickImageOnlyCreatives(rawCreatives, options.limit ?? MAX_CREATIVES_PER_RUN);
  stats.imageOnlyCandidates = candidates.length;
  if (candidates.length === 0) return { ads: [], stats, warnings };

  const cached = await readCopyCache(candidates.map((c) => c.imageUrl)).catch(() => {
    warnings.push("识图缓存读取失败，本次全部走实时识别");
    return new Map<string, CopyPayload>();
  });
  stats.cacheHits = cached.size;

  const pending = candidates.filter((c) => !cached.has(c.imageUrl));
  stats.attempted = pending.length;

  const resolved = new Map<string, CopyPayload>(cached);
  if (pending.length > 0) {
    const cfg = await loadCopyVisionConfig();
    if (!cfg) {
      warnings.push("未配置可用的识图模型（creative_copy_ocr / domain_ocr），跳过创意文案识别");
    } else {
      const counters = { aiCalls: 0, misalignedRetries: 0, warnings: [] as string[] };
      const fresh: { imageUrl: string; payload: CopyPayload }[] = [];

      for (let offset = 0; offset < pending.length; offset += MAX_IMAGES_PER_CALL) {
        const batch = pending.slice(offset, offset + MAX_IMAGES_PER_CALL);
        const payloads = await identifyWithSplit(batch, cfg, counters);
        batch.forEach((item, index) => {
          const payload = payloads[index];
          if (!payload) {
            stats.failed += 1;
            return;
          }
          resolved.set(item.imageUrl, payload);
          fresh.push({ imageUrl: item.imageUrl, payload });
        });
      }

      stats.aiCalls = counters.aiCalls;
      stats.misalignedRetries = counters.misalignedRetries;
      warnings.push(...counters.warnings);
      if (fresh.length > 0) await writeCopyCache(fresh, cfg.modelName);
    }
  }

  const ads: AdEntry[] = [];
  for (const candidate of candidates) {
    const payload = resolved.get(candidate.imageUrl);
    if (!payload) continue;
    if (payload.status === "shopping") {
      stats.shoppingSkipped += 1;
      continue;
    }
    if (payload.status === "empty") {
      stats.emptyResults += 1;
      continue;
    }
    const entries = toAdEntries(candidate, payload, fallbackDomain);
    if (entries.length > 0) {
      ads.push(...entries);
      // 按创意（图）计数，不按拆出的条数，便于与候选数对账
      stats.recovered += 1;
    } else {
      stats.emptyResults += 1;
    }
  }

  return { ads, stats, warnings };
}
