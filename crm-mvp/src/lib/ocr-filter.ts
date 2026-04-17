/**
 * OCR 图片文字检测过滤器
 *
 * 功能：对候选图片列表做 OCR 扫描，丢弃含过多文字的图片（促销 banner / 文字海报等）。
 * 过滤规则（07 确认）：
 *   - 检测词数 > 5  → 丢弃（含文字图）
 *   - OCR 超时 / 出错 / 图片不可达 → 保留（不影响主流程）
 *
 * 架构：模块级单例 scheduler（3 个并行 worker），首次调用时初始化，后续请求复用。
 */

const OCR_WORD_THRESHOLD_DEFAULT = 5;
const OCR_IMAGE_TIMEOUT_MS = 8000;   // 单张图片 OCR 超时（超时则保留）
const OCR_BATCH_TIMEOUT_MS = 35000;  // 整批 OCR 总超时（超时则返回已处理结果）
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// ── 单例 scheduler ────────────────────────────────────────────────────────────

let _schedulerPromise: Promise<import("tesseract.js").Scheduler> | null = null;

async function getScheduler(): Promise<import("tesseract.js").Scheduler> {
  if (!_schedulerPromise) {
    _schedulerPromise = _initScheduler().catch((err) => {
      _schedulerPromise = null; // 失败后允许下次重试
      throw err;
    });
  }
  return _schedulerPromise;
}

async function _initScheduler(): Promise<import("tesseract.js").Scheduler> {
  const { createScheduler, createWorker } = await import("tesseract.js");
  const scheduler = createScheduler();

  // 并行初始化 3 个 worker，共享语言数据（首次会下载/读取本地 eng.traineddata）
  const workerResults = await Promise.allSettled(
    [1, 2, 3].map(() => createWorker("eng")),
  );

  let added = 0;
  for (const r of workerResults) {
    if (r.status === "fulfilled") {
      scheduler.addWorker(r.value);
      added++;
    } else {
      console.warn("[OCRFilter] worker 初始化失败:", r.reason instanceof Error ? r.reason.message : r.reason);
    }
  }

  if (added === 0) throw new Error("所有 OCR worker 均初始化失败");
  console.log(`[OCRFilter] scheduler 就绪（${added}/3 workers）`);
  return scheduler;
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 对图片 URL 列表进行 OCR 检测，丢弃含过多文字的图片。
 *
 * @param urls            候选图片 URL 列表（建议 ≤ 30 张以控制总耗时）
 * @param options.wordThreshold   词数阈值，超过则丢弃（默认 5）
 * @param options.imageTimeoutMs  单张 OCR 超时毫秒（超时 → 保留，默认 8000）
 * @returns 过滤后的 URL 列表
 */
export async function ocrFilterImages(
  urls: string[],
  options: {
    wordThreshold?: number;
    imageTimeoutMs?: number;
  } = {},
): Promise<string[]> {
  if (urls.length === 0) return [];

  const {
    wordThreshold = OCR_WORD_THRESHOLD_DEFAULT,
    imageTimeoutMs = OCR_IMAGE_TIMEOUT_MS,
  } = options;

  let scheduler: import("tesseract.js").Scheduler;
  try {
    scheduler = await getScheduler();
  } catch (e) {
    console.warn(
      "[OCRFilter] scheduler 不可用，跳过 OCR 过滤:",
      e instanceof Error ? e.message : e,
    );
    return urls;
  }

  const keep = new Array<boolean>(urls.length).fill(true);

  const tasks = urls.map(async (url, idx) => {
    try {
      // 1. 获取图片数据（5s 超时）
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { "User-Agent": BROWSER_UA },
      });
      if (!resp.ok) return; // 不可达 → 保留

      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length < 2000) return; // 极小文件（< 2KB）可能不是真实图片 → 保留

      // 2. OCR 识别（带单张超时）
      const wordCount = await Promise.race([
        scheduler
          .addJob("recognize", buffer)
          .then((r: import("tesseract.js").RecognizeResult) => r?.data?.words?.length ?? 0),
        new Promise<number>((resolve) =>
          setTimeout(() => resolve(-1), imageTimeoutMs),
        ),
      ]);

      if (wordCount < 0) {
        // 超时 → 保留
        console.log(`[OCRFilter] 超时保留: ...${url.slice(-50)}`);
        return;
      }

      if (wordCount > wordThreshold) {
        keep[idx] = false;
        console.log(
          `[OCRFilter] 丢弃(词数=${wordCount}>阈值${wordThreshold}): ...${url.slice(-60)}`,
        );
      }
    } catch {
      // 任何异常 → 保留（不影响主流程）
    }
  });

  // 整批最多等待 OCR_BATCH_TIMEOUT_MS（超时已处理的先返回）
  await Promise.race([
    Promise.all(tasks),
    new Promise<void>((resolve) => setTimeout(resolve, OCR_BATCH_TIMEOUT_MS)),
  ]);

  const filtered = urls.filter((_, idx) => keep[idx]);
  console.log(
    `[OCRFilter] 扫描完成: ${urls.length} 张候选 → 丢弃 ${urls.length - filtered.length} 张含文字图 → 保留 ${filtered.length} 张`,
  );
  return filtered;
}
