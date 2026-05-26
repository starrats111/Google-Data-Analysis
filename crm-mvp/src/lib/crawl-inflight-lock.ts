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
 * D-028 v4 修复（2026-05-26 12:48，agentprovocateur 实证）：
 *   原设计漏洞：inflight 命中时直接 `return existing.promise`，前次 promise 卡死则
 *   本次 await 跟着等死直到 90s 强制释放（`setTimeout` 只删 Map，不取消原 promise）。
 *   实证：用户体感 3 分钟里有 87 秒纯粹在等前次卡死的 promise。
 *   v4 修复：inflight 复用时加 race 超时（默认 30s），本次 await 超时后自己重跑；
 *           锁本身 timeout 90s → 60s；challenged host inflight 命中时立即放弃复用。
 *
 *   v5 紧急回滚 v4 race 重跑（alohas 实证）：race 30s 超时让 3-4 个并发 caller 各自
 *           重跑 producer 制造雪崩。修复：race 超时改 fail-fast 抛错让上游降级。
 *
 * D-028 v7 紧急回滚 v5 fail-fast（2026-05-26 13:25，mc2saintbarth.it 实证）：
 *   v5 fail-fast 雪崩：用户首次访问商家时 cache=null 没法降级，fail-fast 抛错穿透
 *   到 SSE 流顶层 try/catch 之外，导致前端"完全生成失败"——sitelinks/headlines/
 *   descriptions/callouts/promotion 全部 type 都没出来，UX 比原版还差。
 *   修复：inflight 复用时直接 await 原 promise，不再 race + fail-fast。
 *   原 promise 最坏在 60s 锁强制释放时被清理，本次 await 最多等 60s。
 *   challenged host 跳过复用逻辑保留（正确的，独立 producer 不受影响）。
 *
 * 环境变量 CRAWL_INFLIGHT_LOCK_OFF=1 可一键 bypass。
 */

import { isHostChallenged, getHostKey } from "@/lib/crawl-host-cache";

const LOCK_TIMEOUT_MS = 60_000; // D-028 v4：90s → 60s

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

    // D-028 v4：若锁对应的 host 已被标记为 challenged（CF/DataDome 强反爬），
    // 前次主爬大概率失败/超时，本次直接放弃 inflight 复用，自己走快速路径，
    // 避免被前次卡死的 promise 拖累 60s+。
    let challengedSkip = false;
    try {
      const merchantPart = key.split("::")[0];
      const host = getHostKey(merchantPart);
      if (host && isHostChallenged(host)) {
        challengedSkip = true;
      }
    } catch {}

    if (challengedSkip) {
      console.warn(`[CrawlInflightLock] 命中去重但 host 已 challenged，跳过复用直接重新执行：key=${key} age=${age}ms`);
      // 不删原 promise（它仍在跑），让本次 producer 独立运行
      return producer();
    }

    if (age < timeoutMs) {
      console.warn(`[CrawlInflightLock] 命中去重：key=${key} age=${age}ms 复用现有 Promise（最长等锁 ${timeoutMs}ms 强制释放）`);
      // D-028 v7：直接 await 原 promise，不再 race 超时也不 fail-fast。
      // 原因：v5 fail-fast 在用户首次访问商家时 cache=null 导致 SSE 流崩溃，比原版还差。
      // 原 promise 最坏在 timeoutMs (60s) 时被锁的 setTimeout 强制清理 map（虽然原 promise
      // 仍在跑），本次 await 最多被拖到原 promise settle，通常远少于 60s。
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
