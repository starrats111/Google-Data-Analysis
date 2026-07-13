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
 * D-028 收紧（2026-05-26 11:30，2C/3.6G 服务器 swap 抖动事件）：
 *   - 实证：MAX=3 时同时 3 个 Chrome 总 RSS≈2.1GB，吃掉 60% 内存，挤压 next/mariadb
 *     进入 swap，高峰期 load 飙到 9-10、iowait 32%+。
 *   - 改造：MAX_SLOTS 3→2；保留 RESERVED_MAIN_CRAWL=1 给主爬独占，NORMAL=1。
 *
 * D-028 v2 回退（2026-05-26 12:15，发现降到 2 后 normalQ 严重排队）：
 *   - 实证：peaceoutskincare/agentprovocateur 等强反爬站 sitelinks 兜底 + 社交链接
 *     puppeteer 同时排队，normalQ 一度达 4，频繁 45s slot timeout，sitelinks 缺失，
 *     用户感知端到端 3-4 分钟。
 *   - 改回：MAX_SLOTS 2→3 / NORMAL=2（恢复 D-027 配置）；
 *     真正减压靠 D-028 v2 的「社交链接黑名单 + 单条 timeout 25s→12s」削减 puppeteer
 *     调用次数本身，而不是收紧 slot。
 *
 * D-172 换链接快车道（2026-07-13，no_puppeteer_slot 饥饿事件）：
 *   - 实证：换链接浏览器兜底（affiliate-link-resolver，30s 等待）与 sitelinks 兜底 / image proxy
 *     同挤 normal 队列，而爬虫 L1 批量一个 browser 连爬 16 条 URL、占 slot 可达 150s（watchdog 上限），
 *     兜底频繁 30s 超时 → 换链接生成失败刷 invalid_link 告警；同时主爬预留 slot 大部分时间闲置。
 *   - 改造：新增 exchange 车道——可用完整 MAX 池（即主爬不跑时可借预留余量），但自身并发封顶
 *     EXCHANGE_MAX_CONCURRENT=1（绝不挤占两个 normal slot），唤醒优先级 main > exchange > normal。
 *   - 代价评估：最坏情况主爬多等一个换链接会话（通常 25-40s，主爬超时 60s 内可承受）；
 *     换链接 Chrome 因重资源拦截（图/媒体/CSS 全 abort）显著轻于爬虫 Chrome，内存风险不变（总并发仍 ≤3）。
 *
 * 环境变量 PUPPETEER_SEMAPHORE_OFF=1 可一键 bypass（用于快速回滚定位）。
 */

const MAX_PUPPETEER_SLOTS = 3;
const RESERVED_MAIN_CRAWL_SLOTS = 1;
const NORMAL_SLOTS = MAX_PUPPETEER_SLOTS - RESERVED_MAIN_CRAWL_SLOTS;  // 2
const EXCHANGE_MAX_CONCURRENT = 1;

// D-067 安全网：任何 slot 被持有超过此时长则强制释放 + 唤醒队列。
// 真因：crawler.ts finally 的 browser.close() 在 swap 颠簸时可能永久挂起，导致其后的
// releasePuppeteerSlot() 永不执行 → 槽位永久泄漏 → 累积 3 个全占死后整个爬取子系统死锁
// （日志表现为持续 active=3/3 全超时）。正常一次爬取 ≤90s，故 150s 仍未释放必为泄漏。
const MAX_SLOT_HOLD_MS = 150000;

type SlotLane = "main" | "exchange" | "normal";

let _active = 0;
let _activeExchange = 0;
const _waitersMain: Array<(released: () => void) => void> = [];
const _waitersExchange: Array<(released: () => void) => void> = [];
const _waitersNormal: Array<(released: () => void) => void> = [];

function isDisabled(): boolean {
  return process.env.PUPPETEER_SEMAPHORE_OFF === "1";
}

function canGrant(lane: SlotLane): boolean {
  if (lane === "main") return _active < MAX_PUPPETEER_SLOTS;
  // exchange：可用完整池（主爬闲时借预留余量），但自身并发封顶，绝不同时占满 normal 池
  if (lane === "exchange") return _active < MAX_PUPPETEER_SLOTS && _activeExchange < EXCHANGE_MAX_CONCURRENT;
  // normal：维持原语义（总活跃 < NORMAL_SLOTS，不碰预留余量）——保住 D-027「主爬到达即有槽」的
  // 保证。exchange 借余量运行期间 normal 会被暂时挤到 1 并发，但 exchange cap=1 且单会话 25-40s，
  // 属可接受的瞬时收缩（与主爬运行期的既有表现一致）。
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
  return _acquire(timeoutMs, "normal");
}

/**
 * 申请主爬专用 slot —— 给 crawl-pipeline 主页主爬路径用（crawlWithPuppeteerFull）。
 * 优先级最高：可使用 RESERVED_MAIN_CRAWL_SLOTS 个预留 slot，等待队列也优先唤醒。
 * 默认 60s 超时（比普通 45s 长，因为主爬一旦失败整个广告创建流程 sitelinks 兜底变差）。
 */
export async function acquireMainCrawlSlot(timeoutMs = 60000): Promise<() => void> {
  return _acquire(timeoutMs, "main");
}

/**
 * 申请换链接专用 slot（affiliate-link-resolver 浏览器兜底，D-172 快车道）。
 * 可用完整 MAX 池（主爬不跑时可借预留余量），自身并发封顶 EXCHANGE_MAX_CONCURRENT=1，
 * 唤醒优先级 main > exchange > normal —— 不再被 sitelinks/图片代理的长队列饿死，
 * 也绝不反过来把 normal 池占满。
 */
export async function acquireExchangeSlot(timeoutMs = 30000): Promise<() => void> {
  return _acquire(timeoutMs, "exchange");
}

async function _acquire(timeoutMs: number, lane: SlotLane): Promise<() => void> {
  if (isDisabled()) {
    return () => {};
  }

  if (canGrant(lane)) {
    _active++;
    if (lane === "exchange") _activeExchange++;
    return makeReleaser(lane);
  }

  return new Promise<() => void>((resolve, reject) => {
    let settled = false;
    const queue = lane === "main" ? _waitersMain : lane === "exchange" ? _waitersExchange : _waitersNormal;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = queue.indexOf(onReady);
      if (idx >= 0) queue.splice(idx, 1);
      const err = new Error(
        `Puppeteer slot timeout after ${timeoutMs}ms ` +
          `(active=${_active}/${MAX_PUPPETEER_SLOTS}, mainQ=${_waitersMain.length}, exchangeQ=${_waitersExchange.length}, normalQ=${_waitersNormal.length}, lane=${lane})`,
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

function makeReleaser(lane: SlotLane): () => void {
  let done = false;

  const release = () => {
    if (done) return;
    done = true;
    if (watchdog) clearTimeout(watchdog);
    if (isDisabled()) return;
    _active = Math.max(0, _active - 1);
    if (lane === "exchange") _activeExchange = Math.max(0, _activeExchange - 1);

    // 主爬队列优先唤醒：只要 _active < MAX 即可（含预留 slot）
    if (_waitersMain.length > 0 && _active < MAX_PUPPETEER_SLOTS) {
      _active++;
      const next = _waitersMain.shift()!;
      next(makeReleaser("main"));
      return;
    }
    // 换链接队列次优先：可借预留余量，但自身并发封顶
    if (_waitersExchange.length > 0 && canGrant("exchange")) {
      _active++;
      _activeExchange++;
      const next = _waitersExchange.shift()!;
      next(makeReleaser("exchange"));
      return;
    }
    // 普通队列：必须 _active < NORMAL_SLOTS（不能占用预留 slot）
    if (_waitersNormal.length > 0 && _active < NORMAL_SLOTS) {
      _active++;
      const next = _waitersNormal.shift()!;
      next(makeReleaser("normal"));
      return;
    }
  };

  // D-067 看门狗：持有超过 MAX_SLOT_HOLD_MS 仍未释放 → 强制释放，防永久泄漏死锁。
  const watchdog = setTimeout(() => {
    if (done) return;
    console.warn(
      `[PuppeteerSemaphore] D-067 槽位持有超过 ${MAX_SLOT_HOLD_MS}ms，强制释放防死锁 ` +
        `(active=${_active}/${MAX_PUPPETEER_SLOTS}, lane=${lane}, mainQ=${_waitersMain.length}, exchangeQ=${_waitersExchange.length}, normalQ=${_waitersNormal.length})`,
    );
    release();
  }, MAX_SLOT_HOLD_MS);
  if (typeof watchdog.unref === "function") watchdog.unref();

  return release;
}

/** 仅供诊断/日志用，勿用于业务分支。 */
export function puppeteerSemaphoreStats(): {
  active: number;
  activeExchange: number;
  queuedMain: number;
  queuedExchange: number;
  queuedNormal: number;
  max: number;
  normalMax: number;
  exchangeMax: number;
  reservedMainCrawl: number;
  disabled: boolean;
} {
  return {
    active: _active,
    activeExchange: _activeExchange,
    queuedMain: _waitersMain.length,
    queuedExchange: _waitersExchange.length,
    queuedNormal: _waitersNormal.length,
    max: MAX_PUPPETEER_SLOTS,
    normalMax: NORMAL_SLOTS,
    exchangeMax: EXCHANGE_MAX_CONCURRENT,
    reservedMainCrawl: RESERVED_MAIN_CRAWL_SLOTS,
    disabled: isDisabled(),
  };
}
