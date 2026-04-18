/**
 * C-027 FIX-B：按 (merchantUrl × country) 的 in-flight 去重锁
 *
 * 背景（见 设计方案.md §26.1 F-11 实证）：
 *   同一商家（如 aerosus.be）在 11 分钟内被完整爬取 6 轮
 *   （HTTP L0 × 120 条 + Puppeteer 兜底 × 48 次），
 *   原因是前端 Promise.allSettled([core, callouts, promotion]) 3 路并发到达后端，
 *   每一路都独立命中 "cache 需要重爬" 条件 → 3 次 buildCrawlCache 同时跑。
 *
 * 本模块把第一个到达的请求持有的 Promise 挂到 Map 里，
 *   后续相同 key 的请求不再启动新的 buildCrawlCache，而是 await 同一份结果，
 *   第一个 Promise 完成（成功或失败）后自动清理。
 *
 * 环境变量 CRAWL_INFLIGHT_LOCK_OFF=1 可一键 bypass。
 */

const LOCK_TIMEOUT_MS = 90_000;

const _inflight = new Map<string, { promise: Promise<unknown>; startedAt: number }>();

function isDisabled(): boolean {
  return process.env.CRAWL_INFLIGHT_LOCK_OFF === "1";
}

/**
 * 规范化 key：小写 + 去 fragment/query + 去尾部斜杠，加国家后缀。
 */
export function buildCrawlKey(merchantUrl: string, country: string): string {
  let normalized = merchantUrl.trim().toLowerCase();
  try {
    const u = new URL(merchantUrl);
    u.hash = "";
    u.search = "";
    normalized = u.toString().replace(/\/$/, "");
  } catch {
    normalized = normalized.replace(/[?#].*$/, "").replace(/\/$/, "");
  }
  return `${normalized}::${(country || "").toUpperCase()}`;
}

/**
 * 若同 key 已有 in-flight Promise，直接返回该 Promise（共享结果）；
 * 否则执行 producer 并把 Promise 挂到 Map 上，完成后清理。
 *
 * @param key 通常用 buildCrawlKey(merchantUrl, country) 生成
 * @param producer 真正执行爬取的函数（一次调用只会被触发 1 次）
 * @param timeoutMs 单个 in-flight Promise 最长持锁时间（默认 90s）
 */
export async function withCrawlInflightLock<T>(
  key: string,
  producer: () => Promise<T>,
  timeoutMs = LOCK_TIMEOUT_MS,
): Promise<T> {
  if (isDisabled()) {
    return producer();
  }

  const existing = _inflight.get(key);
  if (existing) {
    const age = Date.now() - existing.startedAt;
    if (age < timeoutMs) {
      console.warn(`[CrawlInflightLock] 命中去重：key=${key} age=${age}ms 复用现有 Promise`);
      return existing.promise as Promise<T>;
    }
    // 过期则强制清理，重新发起
    console.warn(`[CrawlInflightLock] 发现过期 in-flight (${age}ms > ${timeoutMs}ms)，丢弃并重启：key=${key}`);
    _inflight.delete(key);
  }

  const promise = producer().finally(() => {
    const cur = _inflight.get(key);
    if (cur && cur.promise === promise) {
      _inflight.delete(key);
    }
  });

  _inflight.set(key, { promise, startedAt: Date.now() });

  // 硬性超时防御：若 producer 超过 timeoutMs 仍未 settle，强制从 Map 删除；
  //   但返回给当前调用方的仍是原 promise（不会中断），只是不让后续请求卡死。
  setTimeout(() => {
    const cur = _inflight.get(key);
    if (cur && cur.promise === promise) {
      console.warn(`[CrawlInflightLock] 强制释放 ${timeoutMs}ms 未 settle 的 in-flight：key=${key}`);
      _inflight.delete(key);
    }
  }, timeoutMs).unref?.();

  return promise;
}

/** 仅供诊断/日志用。 */
export function crawlInflightStats(): { size: number; keys: string[]; disabled: boolean } {
  return {
    size: _inflight.size,
    keys: Array.from(_inflight.keys()),
    disabled: isDisabled(),
  };
}
