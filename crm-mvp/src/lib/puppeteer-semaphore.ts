/**
 * C-027 FIX-A：进程级 Puppeteer 并发信号量
 *
 * 背景（见 设计方案.md §26.11 实证）：
 *   单 Chromium browser 在 Linux headless 下约 200MB，3 路前端并发 × 每路 3 阶段
 *   (主流程 / pageLinks 兜底 / navLinks 兜底) = 最多 9 个 browser 同时存在，
 *   会冲破 PM2 max_memory_restart=900MB 触发 SIGINT 重启 → Cloudflare 524。
 *
 * 本模块在 browser.launch 前后夹住一个全进程信号量，
 *   把同时存在的 Chromium browser 实例上限锁死到 MAX_PUPPETEER_SLOTS=2。
 *
 * 环境变量 PUPPETEER_SEMAPHORE_OFF=1 可一键 bypass（用于快速回滚定位）。
 */

const MAX_PUPPETEER_SLOTS = 2;

let _active = 0;
const _waiters: Array<(released: () => void) => void> = [];

function isDisabled(): boolean {
  return process.env.PUPPETEER_SEMAPHORE_OFF === "1";
}

/**
 * 申请一个 Puppeteer browser slot。
 * @param timeoutMs 最长排队等待时间（默认 45000ms）。超时抛 PuppeteerSlotTimeout，
 *                   调用方应 catch 并降级（跳过 Puppeteer 阶段）。
 * @returns 释放函数（务必在 finally 调用一次；重复调用安全）。
 */
export async function acquirePuppeteerSlot(timeoutMs = 45000): Promise<() => void> {
  if (isDisabled()) {
    return () => {};
  }

  if (_active < MAX_PUPPETEER_SLOTS) {
    _active++;
    return makeReleaser();
  }

  return new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = _waiters.indexOf(onReady);
      if (idx >= 0) _waiters.splice(idx, 1);
      const err = new Error(`Puppeteer slot timeout after ${timeoutMs}ms (active=${_active}, queued=${_waiters.length})`);
      (err as Error & { code?: string }).code = "PUPPETEER_SLOT_TIMEOUT";
      reject(err);
    }, timeoutMs);

    const onReady = (released: () => void) => {
      if (settled) {
        released();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(released);
    };
    _waiters.push(onReady);
  });
}

function makeReleaser(): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (isDisabled()) return;
    const next = _waiters.shift();
    if (next) {
      next(makeReleaser());
    } else {
      _active = Math.max(0, _active - 1);
    }
  };
}

/** 仅供诊断/日志用，勿用于业务分支。 */
export function puppeteerSemaphoreStats(): { active: number; queued: number; max: number; disabled: boolean } {
  return { active: _active, queued: _waiters.length, max: MAX_PUPPETEER_SLOTS, disabled: isDisabled() };
}
