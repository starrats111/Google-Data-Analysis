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

import { execSync } from "child_process";
import fs from "fs";
import path from "path";

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

let _sweepsSinceProfileClean = 0;

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
  // D-184：每 ~2 分钟（4 次 × 30s）扫一次孤儿 profile，避免每次 sweep 都 ps
  _sweepsSinceProfileClean++;
  if (_sweepsSinceProfileClean >= 4) {
    _sweepsSinceProfileClean = 0;
    try {
      cleanupOrphanPuppeteerProfiles();
    } catch {
      /* ignore */
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
 * 2026-07-13（第六轮）：合法长批量任务（逐页 harvest/批量 meta）每完成一页调用一次，
 * 刷新登记时间——收割器只看「距上次活动 180s」而非「距 launch 180s」。
 * 此前 6 页 harvest 正常要跑 250s+，第 4 页前后必被收割器误杀，后半批全空。
 * 真孤儿（race 输掉没人 await）不会有人刷新，仍会被收割。
 */
export function refreshBrowserAge(browser: any): void {
  for (const entry of registry) {
    if (entry.browser === browser) entry.startedAt = Date.now();
  }
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
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      page.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("page.close timeout")), 5000);
        timer.unref?.();
      }),
    ]);
  } catch {
    // 放弃等待；页面随浏览器关闭/强杀一并回收
  } finally {
    clearTimeout(timer); // 2026-07-13：close 先成功时清掉输家 timer，防 orphan rejection
  }
}

/**
 * D-184：清理无对应 chrome 进程的 /tmp/puppeteer_dev_profile-* 目录。
 * 强杀/异常退出路径常残留 profile，堆积挤占磁盘与 inode；仅删孤儿，不动活跃 browser。
 * 非 Linux 或 /tmp 不可读时静默 no-op。
 */
export function cleanupOrphanPuppeteerProfiles(): number {
  if (process.platform !== "linux") return 0;
  let cleaned = 0;
  try {
    const tmpDir = "/tmp";
    const entries = fs.readdirSync(tmpDir).filter((n) => n.startsWith("puppeteer_dev_profile-"));
    if (entries.length === 0) return 0;

    const active = new Set<string>();
    try {
      const out = execSync("ps -eo args=", {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 5000,
      });
      for (const line of out.split("\n")) {
        const m = line.match(/user-data-dir=(\/tmp\/puppeteer_dev_profile-[A-Za-z0-9]+)/);
        if (m) active.add(m[1]);
      }
    } catch {
      // ps 失败时宁可不清理，避免误删正在用的 profile
      return 0;
    }

    for (const name of entries) {
      const full = path.join(tmpDir, name);
      if (active.has(full)) continue;
      try {
        fs.rmSync(full, { recursive: true, force: true });
        cleaned++;
      } catch {
        // 并发删除 / 权限，忽略
      }
    }
  } catch {
    return 0;
  }
  if (cleaned > 0) {
    console.warn(`[BrowserReaper] D-184 清理孤儿 puppeteer profile ${cleaned} 个`);
  }
  return cleaned;
}

export async function closeBrowserSafely(browser: any): Promise<void> {
  if (!browser) return;
  // 正常关闭即注销，避免收割器扫到已关的实例
  for (const entry of registry) {
    if (entry.browser === browser) registry.delete(entry);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("browser.close timeout")), 8000);
        timer.unref?.();
      }),
    ]);
  } catch {
    killBrowser(browser);
  } finally {
    clearTimeout(timer);
    // D-184：全部 browser 已关时顺手清孤儿 profile（避免每次 close 都 ps）
    if (registry.size === 0) {
      try {
        cleanupOrphanPuppeteerProfiles();
      } catch {
        /* ignore */
      }
    }
  }
}
