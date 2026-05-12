/**
 * C-088 ATC 广告投放域名 OCR 提取
 *
 * 设计：命中即用 + 异步补全（详见 设计方案.md C-088 章节）
 *
 * 维度：image_url 全局唯一，跨用户/跨商家共享 OCR 结果
 *
 * 公共入口：
 *   - queryCachedDomains(imageUrls): 一次性批量查缓存
 *   - enqueueOcrTasks(imageUrls):    把缺缓存的 URL INSERT pending
 *   - runOcrWorker():                cron 调用，拉 pending 批处理
 *   - isOcrEnabled():                读全局开关
 */

import prisma from "@/lib/prisma";

// ─── 公开类型 ───

export type OcrCacheStatus =
  | "pending"
  | "processing"
  | "success"
  | "failed"
  | "permanent_failure";

export interface OcrCacheLookup {
  /** OCR 已成功识别出的域名（仅 status=success 时存在）*/
  domain?: string;
  /** 该 image_url 当前在缓存中的状态；undefined = 缓存里没这条 */
  status?: OcrCacheStatus;
}

// ─── 全局开关 / 系统配置 ───

const DEFAULTS = {
  enabled: 1,
  maxTries: 3,
  batchSize: 5,
  concurrent: 3,
  processingTimeoutSec: 120,
} as const;

async function readSystemConfigInt(key: string, fallback: number): Promise<number> {
  try {
    const row = await prisma.system_configs.findUnique({
      where: { config_key: key },
      select: { config_value: true },
    });
    const v = Number(row?.config_value);
    return Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export async function isOcrEnabled(): Promise<boolean> {
  const v = await readSystemConfigInt("ocr_domain_extract_enabled", DEFAULTS.enabled);
  return v === 1;
}

// ─── 域名规整化 ───

const BLOCK_DOMAINS = new Set([
  "google.com", "googleads.com", "googleadservices.com",
  "doubleclick.net", "googlesyndication.com",
  "facebook.com", "fb.com", "instagram.com", "twitter.com", "x.com",
  "youtube.com", "tiktok.com",
]);

/**
 * 把 OCR 返回值规整成 host（小写、剥 www/scheme/path）；
 * 通不过域名正则或被屏蔽 → 返回 null。
 */
export function normalizeDomain(raw: string): string | null {
  if (!raw) return null;
  let t = raw.trim().toLowerCase();
  // 模型偶发用单引号/反引号包裹
  t = t.replace(/^['"`]+|['"`]+$/g, "");
  // none / not found / null → 视为无结果
  if (!t || ["none", "null", "n/a", "not found", "no domain", "无", "未找到"].includes(t)) return null;

  t = t
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/[,;:.!?\s]+$/, "");

  if (!/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(t)) return null;
  if (BLOCK_DOMAINS.has(t)) return null;
  return t;
}

// ─── 缓存批量查询 ───

/**
 * 一次性查询多个 image_url 的 OCR 状态。
 * 返回 Map<image_url, OcrCacheLookup>；未命中的 URL 不出现在 Map 里。
 */
export async function queryCachedDomains(imageUrls: string[]): Promise<Map<string, OcrCacheLookup>> {
  const result = new Map<string, OcrCacheLookup>();
  if (imageUrls.length === 0) return result;

  const unique = Array.from(new Set(imageUrls.filter((u) => u && u.length <= 768)));
  if (unique.length === 0) return result;

  const rows = await prisma.ad_image_ocr_cache.findMany({
    where: { image_url: { in: unique } },
    select: { image_url: true, status: true, extracted_domain: true },
  });

  for (const r of rows) {
    result.set(r.image_url, {
      status: r.status as OcrCacheStatus,
      domain: r.status === "success" && r.extracted_domain ? r.extracted_domain : undefined,
    });
  }
  return result;
}

// ─── 入队（INSERT ON DUPLICATE KEY UPDATE）───

/**
 * 把一批 image_url 入队为 pending。
 * 对已存在的 URL：
 *   - status=permanent_failure/success/failed → 不动（避免反复重试已确诊失败的）
 *   - status=processing/pending → 只更新 updated_at（保留 tries）
 * 返回实际入队（新建）的数量。
 */
export async function enqueueOcrTasks(imageUrls: string[]): Promise<number> {
  const unique = Array.from(new Set(imageUrls.filter((u) => u && u.length <= 768)));
  if (unique.length === 0) return 0;

  let created = 0;
  for (const url of unique) {
    try {
      await prisma.ad_image_ocr_cache.create({ data: { image_url: url } });
      created++;
    } catch {
      /* unique key duplicate → 跳过；事务串行避免并发 race 时整批失败 */
    }
  }
  return created;
}

// ─── Vision 调用（直连 ai_providers，不走通用 callAi 以支持 multimodal）───

interface VisionConfig {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

async function loadVisionConfig(): Promise<VisionConfig | null> {
  const cfg = await prisma.ai_model_configs.findFirst({
    where: { scene: "domain_ocr", is_active: 1, is_deleted: 0 },
    orderBy: { priority: "asc" },
  });
  if (!cfg) return null;

  const provider = await prisma.ai_providers.findFirst({
    where: { id: cfg.provider_id, status: "active", is_deleted: 0 },
  });
  if (!provider?.api_key || !provider.api_base_url) return null;

  return {
    baseUrl: provider.api_base_url,
    apiKey: provider.api_key,
    modelName: cfg.model_name,
  };
}

const VISION_PROMPT =
  "图中如果出现网站域名（如 example.com）或品牌官网网址，只输出该域名一行，不要任何解释、前后缀或 www。如未发现任何域名，仅输出: none";

interface VisionOutput {
  raw: string;
  promptTokens?: number;
  completionTokens?: number;
}

async function callVisionForDomain(imageUrl: string, cfg: VisionConfig): Promise<VisionOutput> {
  const base = cfg.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
  const url = `${base}/v1/chat/completions`;
  const body = {
    model: cfg.modelName,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: VISION_PROMPT },
          { type: "image_url", image_url: { url: imageUrl } },
        ],
      },
    ],
    max_tokens: 64,
    temperature: 0,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Vision HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const msg = data.choices?.[0]?.message?.content;
  let raw = "";
  if (typeof msg === "string") raw = msg;
  else if (Array.isArray(msg)) raw = msg.map((p) => p?.text ?? "").join("");

  return {
    raw: raw.trim(),
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
  };
}

// ─── Worker（cron 调用）───

export interface OcrWorkerResult {
  picked: number;
  success: number;
  failed: number;
  permanentFailure: number;
  zombieReset: number;
  skipped: boolean;
  reason?: string;
}

/**
 * 处理一批 pending 任务。
 * - 先把超时 processing 重置为 pending
 * - SELECT ... LIMIT batch_size FOR UPDATE SKIP LOCKED（多 worker 安全）
 * - 并发 concurrent 路调 vision API
 * - 解析结果 → 更新 cache
 */
export async function runOcrWorker(): Promise<OcrWorkerResult> {
  const res: OcrWorkerResult = {
    picked: 0, success: 0, failed: 0, permanentFailure: 0, zombieReset: 0, skipped: false,
  };

  if (!(await isOcrEnabled())) {
    res.skipped = true;
    res.reason = "ocr_domain_extract_enabled=0";
    return res;
  }

  const cfg = await loadVisionConfig();
  if (!cfg) {
    res.skipped = true;
    res.reason = "no active ai_model_configs scene='domain_ocr'";
    return res;
  }

  const batchSize = await readSystemConfigInt("ocr_worker_batch_size", DEFAULTS.batchSize);
  const concurrent = Math.max(1, Math.min(
    await readSystemConfigInt("ocr_worker_concurrent", DEFAULTS.concurrent),
    batchSize,
  ));
  const maxTries = await readSystemConfigInt("ocr_max_tries", DEFAULTS.maxTries);
  const timeoutSec = await readSystemConfigInt("ocr_processing_timeout_sec", DEFAULTS.processingTimeoutSec);

  // ── 1. 僵尸重置：processing 超过 timeoutSec → pending ──
  const zombie = await prisma.$executeRawUnsafe(
    `UPDATE ad_image_ocr_cache
       SET status='pending', lock_at=NULL
     WHERE status='processing'
       AND lock_at IS NOT NULL
       AND lock_at < NOW() - INTERVAL ? SECOND`,
    timeoutSec,
  );
  res.zombieReset = Number(zombie) || 0;

  // ── 2. 拉取一批 pending（用 FOR UPDATE SKIP LOCKED 防多 worker 抢同行）──
  // Prisma 不支持 SKIP LOCKED 语法糖，用原生 SQL
  const pickedRows = await prisma.$queryRawUnsafe<Array<{ id: bigint; image_url: string; tries: number }>>(
    `SELECT id, image_url, tries
       FROM ad_image_ocr_cache
      WHERE status='pending' AND tries < ?
      ORDER BY id ASC
      LIMIT ?
      FOR UPDATE SKIP LOCKED`,
    maxTries,
    batchSize,
  );

  if (pickedRows.length === 0) return res;
  res.picked = pickedRows.length;

  // 立刻把它们标 processing，避免被其他 worker 重复拾起（事务在 raw query 之外，单独 update）
  const ids = pickedRows.map((r) => r.id);
  await prisma.ad_image_ocr_cache.updateMany({
    where: { id: { in: ids } },
    data: { status: "processing", lock_at: new Date() },
  });

  // ── 3. 并发处理 ──
  const tasks: Array<{ id: bigint; image_url: string; tries: number }> = pickedRows;

  async function processOne(row: { id: bigint; image_url: string; tries: number }) {
    const newTries = row.tries + 1;
    try {
      const out = await callVisionForDomain(row.image_url, cfg);
      const domain = normalizeDomain(out.raw);

      if (domain) {
        await prisma.ad_image_ocr_cache.update({
          where: { id: row.id },
          data: {
            status: "success",
            extracted_domain: domain,
            raw_output: out.raw.slice(0, 512),
            tries: newTries,
            model_used: cfg.modelName,
            prompt_tokens: out.promptTokens,
            completion_tokens: out.completionTokens,
            lock_at: null,
            last_error: null,
          },
        });
        res.success++;
      } else {
        // 模型明确返回 none 或返回值不像域名 → 标 failed（不再重试）
        await prisma.ad_image_ocr_cache.update({
          where: { id: row.id },
          data: {
            status: "failed",
            raw_output: out.raw.slice(0, 512),
            tries: newTries,
            model_used: cfg.modelName,
            prompt_tokens: out.promptTokens,
            completion_tokens: out.completionTokens,
            lock_at: null,
            last_error: "domain not found in image",
          },
        });
        res.failed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isImgGone = /HTTP 4(?:0[34]|10)/.test(msg);
      const reachedMax = newTries >= maxTries;
      const finalStatus: OcrCacheStatus = isImgGone || reachedMax ? "permanent_failure" : "pending";

      await prisma.ad_image_ocr_cache.update({
        where: { id: row.id },
        data: {
          status: finalStatus,
          tries: newTries,
          last_error: msg.slice(0, 512),
          lock_at: null,
        },
      });
      if (finalStatus === "permanent_failure") res.permanentFailure++;
    }
  }

  // 简单 worker pool 实现：分批
  while (tasks.length > 0) {
    const slice = tasks.splice(0, concurrent);
    await Promise.allSettled(slice.map(processOne));
  }

  return res;
}
