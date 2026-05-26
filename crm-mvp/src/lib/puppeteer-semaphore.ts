/**
 * C-027 FIX-A：进程级 Puppeteer 并发信号量
 *
 * 背景（见 设计方案.md §26.11 实证）：
 *   单 Chromium browser 在 Linux headless 下约 200MB，3 路前端并发 × 每路 3 阶段
 *   (主流程 / pageLinks 兜底 / navLinks 兜底) = 最多 9 个 browser 同时存在，
 *   会冲破 PM2 max_memory_restart=900MB 触发 SIGINT 重启 → Cloudflare 524。
 *
 * 本模块在 browser.launch 前后夹住一个全进程信号量。
 *
 * D-027 升级（2026-05-26，katesomerville 主页 slot 饥饿事件）：
 *   - 单一 lawlessbeauty challenged 站点同时跑 17 条 sitelinks Puppeteer 兜底
 *     + image proxy 单次 170s 占 slot，2 个 slot 全被吃光，katesomerville 主页
 *     主爬等 45s 拿不到 slot 直接 return null，UI 显示「爬取失败」假象。
 *   - 改造：MAX_SLOTS 2→3；其中 RESERVED_MAIN_CRAWL=1 个仅供主页主爬路径使用，
 *     普通调用（sitelinks 兜底 / image proxy）只能用剩下 NORMAL_SLOTS=2 个。
 *
 * 环境变量 PUPPETEER_SEMAPHORE_OFF=1 可一键 bypass（用于快速回滚定位）。
 */

const MAX_PUPPETEER_SLOTS = 3;
const RESERVED_MAIN_CRAWL_SLOTS = 1;
const NORMAL_SLOTS = MAX_PUPPETEER_SLOTS - RESERVED_MAIN_CRAWL_SLOTS;  // 2

let _active = 0;
const _waitersMain: Array<(released: () => void) => void> = [];
const _waitersNormal: Array<(released: () => void) => void> = [];

function isDisabled(): boolean {
  return process.env.PUPPETEER_SEMAPHORE_OFF === "1";
}

function canGrant(isMainCrawl: boolean): boolean {
  if (isMainCrawl) return _active < MAX_PUPPETEER_SLOTS;
  return _active < NORMAL_SLOTS;
}

/**
 * 申请一个普通 Puppeteer browser slot（sitelinks 兜底 / image proxy / 等元数据）。
 * 只能占用 NORMAL_SLOTS 个 slot，主爬保留 slot 不会被这里抢走。
 *
 * @param timeoutMs 最长排队等待时间（默认 45000ms）。超时抛 PUPPETEER_SLOT_TIMEOUT，
 *                   调用方应 catch 并降级（跳过 Puppeteer 阶段）。
 */
export async function acquirePuppeteerSlot(timeoutMs = 45000): Promise<() => void> {
  return _acquire(timeoutMs, false);
}

/**
 * 申请主爬专用 slot —— 给 crawl-pipeline 主页主爬路径用（crawlWithPuppeteerFull）。
 * 优先级最高：可使用 RESERVED_MAIN_CRAWL_SLOTS 个预留 slot，等待队列也优先唤醒。
 * 默认 60s 超时（比普通 45s 长，因为主爬一旦失败整个广告创建流程 sitelinks 兜底变差）。
 */
export async function acquireMainCrawlSlot(timeoutMs = 60000): Promise<() => void> {
  return _acquire(timeoutMs, true);
}

async function _acquire(timeoutMs: number, isMainCrawl: boolean): Promise<() => void> {
  if (isDisabled()) {
    return () => {};
  }

  if (canGrant(isMainCrawl)) {
    _active++;
    return makeReleaser();
  }

  return new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const queue = isMainCrawl ? _waitersMain : _waitersNormal;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = queue.indexOf(onReady);
      if (idx >= 0) queue.splice(idx, 1);
      const err = new Error(
        `Puppeteer slot timeout after ${timeoutMs}ms ` +
          `(active=${_active}/${MAX_PUPPETEER_SLOTS}, mainQ=${_waitersMain.length}, normalQ=${_waitersNormal.length}, isMainCrawl=${isMainCrawl})`,
      );
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
    queue.push(onReady);
  });
}

function makeReleaser(): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (isDisabled()) return;
    _active = Math.max(0, _active - 1);

    // 主爬队列优先唤醒：只要 _active < MAX 即可（含预留 slot）
    if (_waitersMain.length > 0 && _active < MAX_PUPPETEER_SLOTS) {
      _active++;
      const next = _waitersMain.shift()!;
      next(makeReleaser());
      return;
    }
    // 普通队列：必须 _active < NORMAL_SLOTS（不能占用预留 slot）
    if (_waitersNormal.length > 0 && _active < NORMAL_SLOTS) {
      _active++;
      const next = _waitersNormal.shift()!;
      next(makeReleaser());
      return;
    }
  };
}

/** 仅供诊断/日志用，勿用于业务分支。 */
export function puppeteerSemaphoreStats(): {
  active: number;
  queuedMain: number;
  queuedNormal: number;
  max: number;
  normalMax: number;
  reservedMainCrawl: number;
  disabled: boolean;
} {
  return {
    active: _active,
    queuedMain: _waitersMain.length,
    queuedNormal: _waitersNormal.length,
    max: MAX_PUPPETEER_SLOTS,
    normalMax: NORMAL_SLOTS,
    reservedMainCrawl: RESERVED_MAIN_CRAWL_SLOTS,
    disabled: isDisabled(),
  };
}
