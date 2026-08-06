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
 *   - 改造：新增 exchange 车道，两路配额——
 *       保底快车道（EXCHANGE_FAST_SLOTS=1）：可借完整 MAX 池（含主爬预留余量），唤醒优先级仅次于
 *         main，保证换链接在 sitelinks/图片代理长批量压满 normal 池时也 ≤1 个会话时长内必有槽；
 *       弹性配额：换链接突发（补货批量 CONCURRENCY=5 / 点击补刷）时，额外会话可用 normal 池余量
 *         （不碰主爬预留），唤醒优先级排在 normal 之后——突发不饿死 sitelinks，也不比旧行为差。
 *   - 代价评估：最坏情况主爬多等一个换链接会话（通常 25-40s，主爬超时 60s 内可承受）；
 *     换链接 Chrome 因重资源拦截（图/媒体/CSS 全 abort）显著轻于爬虫 Chrome，内存风险不变（总并发仍 ≤3）。
 *     ⚠️ D-199 实测推翻了本行的「显著轻」：换链接 352MB vs 爬虫 323MB，只轻 7%。拦截省的是流量，
 *     内存花在 Chromium 进程结构上（单会话 1 gpu + 5 renderer + 2 utility，跟链每过一个域名按站点隔离
 *     各起一个渲染器），与页面里有没有图基本无关。总并发 ≤3 的内存结论不变，但依据不是「换链接更轻」。
 *
 * D-199 借用预留槽（2026-07-29，第 3 槽空转事件）：
 *   - 实证：当日 29 次 no_puppeteer_slot 全部来自换链接、爬虫车道 0 次；每次现场快照都是
 *     `active=2/3, mainQ=0` —— 快车道已占满（_activeExchangeFast=1）、normal 判定 `_active < 2`
 *     也不成立，两条路全断，而第 3 槽空着且无人排队。属调度浪费，不是资源不足
 *     （同期看门狗强制释放 0 次、实测并发从未超过 3，无泄漏）。
 *   - 改造：exchange 增加第三条路 exchangeReserve —— 主爬队列为空且总池未满时借用预留槽，
 *     唤醒优先级垫最底（main > 快车道 > normal > 弹性 > 借预留），main/normal 一到即抢回。
 *   - 代价评估：主爬排队拿的是**第一个释放**的槽，等的是「剩余最短」而非多个会话之和，故最坏仍与
 *     D-172 已接受的口径同量级；且实测换链接会话仅 1-14s，远低于当初假设的 25-40s 和主爬 60s 超时。
 *
 * D-220 槽位与进程绑定 + 内存反压（2026-08-06，wj11「API Key 已失效」误报事故）：
 *   - 现象：全站 14 个联盟连接被标成密钥失效，实测密钥全部有效。真因是进程内 fetch 全部
 *     报 UND_ERR_CONNECT_TIMEOUT，而同一时刻 curl 直连这些域名只要 40-220ms —— 网络没问题，
 *     是 Node 卡到连 undici 的 10s 建连计时器都超了。
 *   - 根因：D-067 看门狗强制释放的是**计数**，D-184 收割器管的是**进程**，两者脱节。
 *     合法长批量任务靠 refreshBrowserAge 不断给 browser 续命（按活动计龄，可远超 180s），
 *     它的槽位却仍在 150s 被无条件强制释放 → 槽位还回池子、Chrome 还在跑 → 新任务立刻
 *     launch → 实测「计数 ≤3、真实 Chrome 32 个占 3.1GB」，3.6G 机器被打穿：
 *     next-server 1.67GB 进 swap、主要页错误 235 万次、事件循环长时间冻结。
 *   - 对策一（生命周期绑定）：槽位释放器新增 heartbeat/bindBrowser。长批量任务续 browser 龄
 *     时同步续槽位看门狗，两者不再脱节；看门狗真的超时强制释放时，一并 SIGKILL 绑定的 browser
 *     ——既然判定失控，就不能只放计数留着进程继续吃内存。heartbeat 受 HARD_MAX_HOLD_MS 绝对
 *     封顶，防卡死任务无限续期。
 *   - 对策二（内存反压）：授予槽位前看 MemAvailable，低于水位直接拒绝，让调用方降级走 HTTP。
 *     内存紧张时再 launch 只会把整机拖进 swap，连带所有出网请求超时——宁可这次不抓，
 *     也不能让全站误判密钥失效。
 *
 * 环境变量 PUPPETEER_SEMAPHORE_OFF=1 可一键 bypass（用于快速回滚定位）。
 * 环境变量 PUPPETEER_EXCHANGE_RESERVE_OFF=1 可单独回滚 D-199 借预留（无需重新部署）。
 * 环境变量 PUPPETEER_MIN_AVAILABLE_MB 调内存水位（默认 500，设 0 关闭 D-220 反压）。
 */

import fs from "fs";

const MAX_PUPPETEER_SLOTS = 3;
const RESERVED_MAIN_CRAWL_SLOTS = 1;
const NORMAL_SLOTS = MAX_PUPPETEER_SLOTS - RESERVED_MAIN_CRAWL_SLOTS;  // 2
const EXCHANGE_FAST_SLOTS = 1;

// D-067 安全网：任何 slot 被持有超过此时长则强制释放 + 唤醒队列。
// 真因：crawler.ts finally 的 browser.close() 在 swap 颠簸时可能永久挂起，导致其后的
// releasePuppeteerSlot() 永不执行 → 槽位永久泄漏 → 累积 3 个全占死后整个爬取子系统死锁
// （日志表现为持续 active=3/3 全超时）。正常一次爬取 ≤90s，故 150s 仍未释放必为泄漏。
const MAX_SLOT_HOLD_MS = 150000;

/**
 * D-220：heartbeat 能把看门狗续到的绝对上限。合法长批量（6 页 harvest ≈ 300s、
 * 16 条批量 meta）需要续期，但卡死的任务同样会「看起来在活动」，故封一个硬顶——
 * 到点无论是否还在心跳都强制释放并杀进程。
 */
const HARD_MAX_HOLD_MS = 600000;

/** D-220：可用内存低于此值不再授予新槽位（MB）。0 = 关闭反压。 */
const DEFAULT_MIN_AVAILABLE_MB = 500;

type SlotLane = "main" | "exchange" | "normal";

/**
 * D-220：槽位释放器。除了释放本身，还带两个与 browser 生命周期挂钩的能力。
 * 仍可当普通 `() => void` 用，老调用点无需改动。
 */
export type SlotRelease = (() => void) & {
  /** 长批量任务每完成一个单元调用，续期看门狗（受 HARD_MAX_HOLD_MS 封顶） */
  heartbeat: () => void;
  /** launch 后绑定 browser，看门狗强制释放时一并强杀，防计数与进程脱节 */
  bindBrowser: (browser: unknown) => void;
};

/** 未持有槽位时的占位释放器（bypass / acquire 失败路径用） */
export function noopSlotRelease(): SlotRelease {
  const fn = (() => {}) as SlotRelease;
  fn.heartbeat = () => {};
  fn.bindBrowser = () => {};
  return fn;
}
/** 实际授予的槽位种类（exchange 分快车道/弹性/借预留三种，释放时分别扣减计数） */
type GrantKind = "main" | "exchangeFast" | "exchangeElastic" | "exchangeReserve" | "normal";

let _active = 0;
let _activeExchangeFast = 0;
const _waitersMain: Array<(released: SlotRelease) => void> = [];
const _waitersExchange: Array<(released: SlotRelease) => void> = [];
const _waitersNormal: Array<(released: SlotRelease) => void> = [];

function isDisabled(): boolean {
  return process.env.PUPPETEER_SEMAPHORE_OFF === "1";
}

// ── D-220 内存反压 ──

let _memCache = { at: 0, availableMb: -1 };

/**
 * 读 /proc/meminfo 的 MemAvailable（MB）。非 Linux 或读不到返回 -1（视为不限制）。
 * 2s 缓存：槽位申请可能密集，避免每次都读文件。
 */
function availableMemoryMb(): number {
  // 测试注入口：生产不设此变量。反压逻辑只在 Linux 生效，否则本地/CI 无从验证。
  const fake = process.env.PUPPETEER_FAKE_AVAILABLE_MB;
  if (fake !== undefined) {
    const n = parseInt(fake, 10);
    return Number.isFinite(n) ? n : -1;
  }
  const now = Date.now();
  if (now - _memCache.at < 2000) return _memCache.availableMb;
  let mb = -1;
  try {
    const m = fs.readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m);
    if (m) mb = Math.round(parseInt(m[1], 10) / 1024);
  } catch {
    // 非 Linux / 读不到：不做限制，交给原有的并发上限兜底
  }
  _memCache = { at: now, availableMb: mb };
  return mb;
}

function minAvailableMb(): number {
  const raw = process.env.PUPPETEER_MIN_AVAILABLE_MB;
  if (raw === undefined) return DEFAULT_MIN_AVAILABLE_MB;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_AVAILABLE_MB;
}

/**
 * D-220：内存不足时拒绝授予新槽位。
 *
 * 已持有槽位的任务不受影响（不会被中途掐断），只挡新的 launch。调用方 catch 后
 * 降级走 HTTP，比让整机进 swap、把所有出网请求拖到超时要好得多。
 */
function checkMemoryHeadroom(lane: SlotLane): void {
  const floor = minAvailableMb();
  if (floor <= 0) return;
  const avail = availableMemoryMb();
  if (avail < 0 || avail >= floor) return;
  const err = new Error(
    `Puppeteer 内存反压：可用内存 ${avail}MB 低于水位 ${floor}MB，拒绝新建 browser ` +
      `(active=${_active}/${MAX_PUPPETEER_SLOTS}, lane=${lane})`,
  );
  (err as Error & { code?: string }).code = "PUPPETEER_LOW_MEMORY";
  throw err;
}

/** exchange 保底快车道可授予：可借完整池（含主爬预留余量），快车道自身并发封顶 */
function canGrantExchangeFast(): boolean {
  return _activeExchangeFast < EXCHANGE_FAST_SLOTS && _active < MAX_PUPPETEER_SLOTS;
}

/** normal 池余量可授予（normal 车道与 exchange 弹性配额共用此判定，不碰主爬预留） */
function canGrantNormalPool(): boolean {
  return _active < NORMAL_SLOTS;
}

/**
 * D-199：exchange 借用主爬预留槽——仅当主爬队列为空且总池未满。
 *
 * 真因（2026-07-29 生产实测）：当日 29 次 no_puppeteer_slot 全部来自换链接、爬虫车道 0 次，
 * 每次现场快照都是 `active=2/3, mainQ=0`。此时快车道已被占（_activeExchangeFast=1）、
 * normal 判定 `_active < 2` 也不成立，两条路全断，而第 3 槽空着且无人排队 —— 换链接干等
 * 30s 后失败，纯属调度浪费而非资源不足。
 *
 * 代价与 D-172 已接受的口径同量级：主爬排队时拿的是**第一个释放**的槽，等的是「剩余最短」
 * 而非三个会话之和，故最坏仍是「多等一个换链接会话」。实测换链接会话仅 1-14s，远低于主爬
 * 60s 超时。且唤醒优先级里 main 永远排第一，借用不改变主爬的抢回顺序。
 *
 * PUPPETEER_EXCHANGE_RESERVE_OFF=1 可单独回滚这一条，无需重新部署。
 */
function canGrantExchangeReserve(): boolean {
  if (process.env.PUPPETEER_EXCHANGE_RESERVE_OFF === "1") return false;
  return _waitersMain.length === 0 && _active < MAX_PUPPETEER_SLOTS;
}

/** 请求到达时的授予判定；exchange 返回实际授予的种类，不可授予返回 null */
function tryClassifyGrant(lane: SlotLane): GrantKind | null {
  if (lane === "main") return _active < MAX_PUPPETEER_SLOTS ? "main" : null;
  if (lane === "exchange") {
    if (canGrantExchangeFast()) return "exchangeFast";
    // 弹性配额：换链接突发（补货批量/点击补刷）时额外会话用 normal 池余量，与旧行为等价
    if (canGrantNormalPool()) return "exchangeElastic";
    // D-199 借预留：主爬没在排队时，空着的预留槽给换链接用，主爬一到按最高优先级抢回
    if (canGrantExchangeReserve()) return "exchangeReserve";
    return null;
  }
  // normal：维持原语义（总活跃 < NORMAL_SLOTS，不碰预留余量）——保住 D-027「主爬到达即有槽」的
  // 硬保证。exchange 快车道借余量运行期间 normal 会被暂时挤到 1 并发（与主爬运行期同语义，瞬时收缩）。
  return canGrantNormalPool() ? "normal" : null;
}

/**
 * 申请一个普通 Puppeteer browser slot（sitelinks 兜底 / image proxy / 等元数据）。
 * 只能占用 NORMAL_SLOTS 个 slot，主爬保留 slot 不会被这里抢走。
 *
 * @param timeoutMs 最长排队等待时间（默认 45000ms）。超时抛 PUPPETEER_SLOT_TIMEOUT，
 *                   调用方应 catch 并降级（跳过 Puppeteer 阶段）。
 */
export async function acquirePuppeteerSlot(timeoutMs = 45000): Promise<SlotRelease> {
  return _acquire(timeoutMs, "normal");
}

/**
 * 申请主爬专用 slot —— 给 crawl-pipeline 主页主爬路径用（crawlWithPuppeteerFull）。
 * 优先级最高：可使用 RESERVED_MAIN_CRAWL_SLOTS 个预留 slot，等待队列也优先唤醒。
 * 默认 60s 超时（比普通 45s 长，因为主爬一旦失败整个广告创建流程 sitelinks 兜底变差）。
 */
export async function acquireMainCrawlSlot(timeoutMs = 60000): Promise<SlotRelease> {
  return _acquire(timeoutMs, "main");
}

/**
 * 申请换链接专用 slot（affiliate-link-resolver 浏览器兜底，D-172 快车道）。
 * 两路配额：保底快车道（EXCHANGE_FAST_SLOTS=1，可借主爬预留余量，唤醒优先级仅次于 main）
 * 保证不被 sitelinks/图片代理长批量饿死；突发时额外会话走弹性配额（normal 池余量，
 * 唤醒优先级排在 normal 之后），不反过来饿死 sitelinks。
 */
export async function acquireExchangeSlot(timeoutMs = 30000): Promise<SlotRelease> {
  return _acquire(timeoutMs, "exchange");
}

function grant(kind: GrantKind): SlotRelease {
  _active++;
  if (kind === "exchangeFast") _activeExchangeFast++;
  return makeReleaser(kind);
}

async function _acquire(timeoutMs: number, lane: SlotLane): Promise<SlotRelease> {
  if (isDisabled()) {
    return noopSlotRelease();
  }

  // D-220：内存不足直接拒绝，不进队列白等——排队等到的也只是再压垮一次
  checkMemoryHeadroom(lane);

  const kind = tryClassifyGrant(lane);
  if (kind) return grant(kind);

  return new Promise<SlotRelease>((resolve, reject) => {
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

    const onReady = (released: SlotRelease) => {
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

/**
 * D-220：强杀绑定的 browser。这里内联而不复用 puppeteer-browser-registry 的同名逻辑，
 * 是为了让本模块保持零依赖（registry 依赖 fs/child_process，反向 import 会成环）。
 */
function killBoundBrowser(browser: unknown, kind: GrantKind): void {
  try {
    const b = browser as { process?: () => { kill?: (sig: string) => void } | null };
    const proc = typeof b?.process === "function" ? b.process() : null;
    if (proc && typeof proc.kill === "function") {
      proc.kill("SIGKILL");
      console.warn(`[PuppeteerSemaphore] D-220 槽位失控，一并强杀绑定的 Chrome（kind=${kind}）`);
    }
  } catch {
    // 进程已退出等情况，忽略
  }
}

function makeReleaser(kind: GrantKind): SlotRelease {
  let done = false;
  let boundBrowser: unknown = null;
  const grantedAt = Date.now();

  const release = () => {
    if (done) return;
    done = true;
    if (watchdog) clearTimeout(watchdog);
    if (isDisabled()) return;
    _active = Math.max(0, _active - 1);
    if (kind === "exchangeFast") _activeExchangeFast = Math.max(0, _activeExchangeFast - 1);

    // 唤醒优先级：main > exchange 快车道 > normal > exchange 弹性 > exchange 借预留
    if (_waitersMain.length > 0 && _active < MAX_PUPPETEER_SLOTS) {
      const next = _waitersMain.shift()!;
      next(grant("main"));
      return;
    }
    if (_waitersExchange.length > 0 && canGrantExchangeFast()) {
      const next = _waitersExchange.shift()!;
      next(grant("exchangeFast"));
      return;
    }
    if (_waitersNormal.length > 0 && canGrantNormalPool()) {
      const next = _waitersNormal.shift()!;
      next(grant("normal"));
      return;
    }
    // exchange 弹性配额垫底：仅当 normal 队列空且 normal 池仍有余量时才给（突发不饿死 sitelinks）
    if (_waitersExchange.length > 0 && canGrantNormalPool()) {
      const next = _waitersExchange.shift()!;
      next(grant("exchangeElastic"));
      return;
    }
    // D-199 借预留垫最底：main/normal 队列都空了才把预留槽让给换链接，两者一到即按上面的顺序抢回
    if (_waitersExchange.length > 0 && canGrantExchangeReserve()) {
      const next = _waitersExchange.shift()!;
      next(grant("exchangeReserve"));
      return;
    }
  };

  // D-067 看门狗：持有超过 MAX_SLOT_HOLD_MS 仍未释放 → 强制释放，防永久泄漏死锁。
  // D-220：强制释放时连带强杀绑定的 browser——只放计数会让「计数 ≤3、真实 Chrome 32 个」重演。
  const onWatchdogFire = () => {
    if (done) return;
    console.warn(
      `[PuppeteerSemaphore] D-067 槽位持有超过 ${MAX_SLOT_HOLD_MS}ms，强制释放防死锁 ` +
        `(active=${_active}/${MAX_PUPPETEER_SLOTS}, kind=${kind}, mainQ=${_waitersMain.length}, exchangeQ=${_waitersExchange.length}, normalQ=${_waitersNormal.length})`,
    );
    if (boundBrowser) killBoundBrowser(boundBrowser, kind);
    release();
  };

  let watchdog = setTimeout(onWatchdogFire, MAX_SLOT_HOLD_MS);
  if (typeof watchdog.unref === "function") watchdog.unref();

  const out = release as SlotRelease;

  // D-220：长批量任务续期。与 refreshBrowserAge 成对调用，让槽位和 browser 同龄；
  // 超过 HARD_MAX_HOLD_MS 不再续，交给看门狗按失控处理。
  out.heartbeat = () => {
    if (done || isDisabled()) return;
    if (Date.now() - grantedAt >= HARD_MAX_HOLD_MS) return;
    clearTimeout(watchdog);
    watchdog = setTimeout(onWatchdogFire, MAX_SLOT_HOLD_MS);
    if (typeof watchdog.unref === "function") watchdog.unref();
  };

  out.bindBrowser = (browser: unknown) => {
    boundBrowser = browser;
  };

  return out;
}

/** 仅供诊断/日志用，勿用于业务分支。 */
export function puppeteerSemaphoreStats(): {
  active: number;
  activeExchangeFast: number;
  queuedMain: number;
  queuedExchange: number;
  queuedNormal: number;
  max: number;
  normalMax: number;
  exchangeFastMax: number;
  reservedMainCrawl: number;
  disabled: boolean;
  availableMb: number;
  minAvailableMb: number;
} {
  return {
    active: _active,
    activeExchangeFast: _activeExchangeFast,
    queuedMain: _waitersMain.length,
    queuedExchange: _waitersExchange.length,
    queuedNormal: _waitersNormal.length,
    max: MAX_PUPPETEER_SLOTS,
    normalMax: NORMAL_SLOTS,
    exchangeFastMax: EXCHANGE_FAST_SLOTS,
    reservedMainCrawl: RESERVED_MAIN_CRAWL_SLOTS,
    disabled: isDisabled(),
    availableMb: availableMemoryMb(),
    minAvailableMb: minAvailableMb(),
  };
}
