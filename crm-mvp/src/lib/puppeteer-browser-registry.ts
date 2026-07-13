/**
 * 孤儿 Chrome 收割器（2026-07-13）
 *
 * 真因：爬取链路上有五层 Promise.race 超时（策略层/尾部兜底/路由层/桥接层/SSE 取消），
 * race 输掉只是放弃 await，**底下的 Puppeteer 任务照常在跑**——Chrome 进程没人关，
 * 最长可存活 360s+。150s 槽位看门狗只把计数放掉、不杀进程，结果是「计数上限 3、
 * 实际 Chrome 5-6 个」，2C/3.7G 服务器直接 swap 颠簸，进一步放大所有超时。
 *
 * 对策：所有 launch 出来的 browser 都在此登记，close 时注销；后台收割器每 30s 扫一遍，
 * 存活超过 MAX_AGE 的一律 SIGKILL——无论它是正常在跑还是已成孤儿。正常一次爬取 ≤90s，
 * 180s 仍存活的浏览器必属泄漏，杀掉零误伤。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type Entry = { browser: any; startedAt: number; label: string };

const registry = new Set<Entry>();

/** 超过此存活时长的 Chrome 一律强杀（正常爬取 ≤90s，翻倍留余量） */
const MAX_AGE_MS = 180_000;
const SWEEP_INTERVAL_MS = 30_000;

let sweeper: NodeJS.Timeout | null = null;

function killBrowser(browser: any): void {
  try {
    const proc = typeof browser.process === "function" ? browser.process() : null;
    if (proc && typeof proc.kill === "function") proc.kill("SIGKILL");
  } catch {
    // 进程已退出等情况，忽略
  }
}

function sweep(): void {
  const now = Date.now();
  for (const entry of registry) {
    if (now - entry.startedAt > MAX_AGE_MS) {
      registry.delete(entry);
      console.warn(
        `[BrowserReaper] 强杀超龄 Chrome（${entry.label}，存活 ${Math.round((now - entry.startedAt) / 1000)}s）`,
      );
      killBrowser(entry.browser);
    }
  }
  if (registry.size === 0 && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/**
 * 登记一个刚 launch 的 browser，返回注销函数（在安全关闭后调用）。
 * 注销幂等；忘记注销也没关系——收割器会在超龄时兜底杀掉。
 */
export function registerBrowser(browser: any, label: string): () => void {
  const entry: Entry = { browser, startedAt: Date.now(), label };
  registry.add(entry);
  if (!sweeper) {
    sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
    if (typeof sweeper.unref === "function") sweeper.unref();
  }
  return () => registry.delete(entry);
}

/**
 * 2026-07-13：stealth launcher 单例。
 * 此前 crawler.ts 4 处 + affiliate-link-resolver 1 处，每次 launch 前都
 * `puppeteerExtra.use(StealthPlugin())`——puppeteer-extra 的 use 是往共享插件数组 append，
 * 进程存活期间插件实例无限累积，每个新 page 的 onPageCreated 钩子被重复执行 N 遍
 * （内存 + CPU 双泄漏）。现在插件只注册一次，launcher 全局复用。
 */
let _stealthLauncher: any | null = null;
export async function getStealthLauncher(): Promise<any> {
  if (_stealthLauncher) return _stealthLauncher;
  const puppeteerExtra = await import("puppeteer-extra");
  const StealthPlugin = await import("puppeteer-extra-plugin-stealth");
  const stealthMod = StealthPlugin as any;
  const stealthFn = stealthMod.default || stealthMod;
  puppeteerExtra.default.use(stealthFn());
  _stealthLauncher = puppeteerExtra.default;
  return _stealthLauncher;
}

/**
 * 带超时 + 强杀的安全关闭（原 crawler.ts closeBrowserSafely 的公共版）。
 * browser.close() 在 swap 颠簸时可能永久挂起，8s 不返回则直接 SIGKILL，
 * 保证调用方 finally 里的槽位释放一定能执行到。
 */
/**
 * page.close() 同样可能在资源紧张时挂起——批量路径（多 URL 循环里逐页 close）一旦挂住，
 * 整个循环连同外层槽位一起卡死。5s 不返回就放弃等待（浏览器随后由 closeBrowserSafely/收割器兜底）。
 */
export async function closePageSafely(page: any): Promise<void> {
  if (!page) return;
  try {
    await Promise.race([
      page.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("page.close timeout")), 5000)),
    ]);
  } catch {
    // 放弃等待；页面随浏览器关闭/强杀一并回收
  }
}

export async function closeBrowserSafely(browser: any): Promise<void> {
  if (!browser) return;
  // 正常关闭即注销，避免收割器扫到已关的实例
  for (const entry of registry) {
    if (entry.browser === browser) registry.delete(entry);
  }
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("browser.close timeout")), 8000)),
    ]);
  } catch {
    killBrowser(browser);
  }
}
