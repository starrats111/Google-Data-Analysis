/**
 * D-368 站点数据文件写入护栏：按站点互斥 + 写后语法校验
 *
 * 立项背景：omniportal.shop 首页白屏（员工 10-15 报障）。真因不是域名——
 * 域名有效期到 2027-04-24——而是 `assets/js/main.js` 在源站上就是个语法损坏的文件：
 * 结尾断在字符串中间（`...(i===page?'`），`node --check` 直接报
 * `Invalid or unexpected token`。那个文件是首页唯一的渲染器：文章列表、首图、分类、
 * 分页全靠它，HTML 里只有一个空的 `<div id="article-list"></div>`。脚本一不执行，
 * 列表就是空的；更糟的是「Nothing here yet」兜底块带 `hidden` 属性、也得靠 JS 掀开，
 * 所以页面连提示都没有，就是一片空白。44 篇文章的数据其实还在文件里，没丢。
 *
 * 公网抽查 19 个站，6 个的 main.js 是语法损坏的（omniportal.shop / kivanta.top /
 * novanest.one / keymint.co / vitasphere.top / bloomroots.top），文件时间散在
 * 09-05 到 10-15 凌晨——不是 D-319 那次重建的遗留，是持续在发生。
 *
 * 真因有两层：
 *   ① 发布一篇文章走的是「SFTP 读整个 main.js → 字符串拼接改 posts 数组 → 整体写回」
 *      （见 remote-publisher.ts `publishArticleToSite` 第 3 步 + `syncToHomepageDataFile`），
 *      中间没有任何串行化。各调用方自己是 await 串行的，但它们是不同的 HTTP 入口
 *      （user/articles/publish-to-site、hermes/publish-article、admin/regenerate-clean-article、
 *      article-backfill），两个请求同时发同一个站就是并发读改写 → 丢更新或互相覆盖到一半。
 *      vitasphere.top 的文件里留着 `daventListener('click'...` 这种两段内容错位重叠的残骸，
 *      正是并发写同一文件才有的痕迹；其余几个是写了一半。
 *   ② 写完不回读、不校验，所以上述损坏发生后发布接口照样返回「成功」，
 *      而 D-320 站点巡检只判首页 200 + 文章页 200，骨架在就算健康 —— 看不见这类故障。
 *
 * 本模块解决第二层，并为第一层提供锁原语：
 *   - withSiteLock：按站点根路径互斥，把同一站点的所有发布/撤回/改期串成队列
 *   - writeJsDataFileGuarded：写 JS 数据文件前先本地语法校验，写后回读比对，不一致即抛错
 *
 * 为什么进程内锁够用：PM2 配置是 `exec_mode: 'fork'` + `instances: 1`（ecosystem.config.cjs），
 * 全站只有一个 Node 进程。若将来改 cluster 模式，这里必须换成数据库行锁或 Redis 锁。
 */
import { Script } from "vm";

// ─── 按站点互斥 ─────────────────────────────────────────────────────────────

/** key = 站点根路径；value = 该站点当前排队尾部的 promise */
const siteLocks = new Map<string, Promise<unknown>>();

/** 等锁超时：超过这个时间仍拿不到锁就放弃，避免请求无限挂住 */
const LOCK_TIMEOUT_MS = 180_000;

/**
 * 按站点根路径串行化写操作。同一 siteRoot 的调用会排成队列依次执行，
 * 不同站点之间互不影响（站群 40+ 个站并行发布的吞吐不受影响）。
 *
 * 失败不传染：前一个任务抛错不会让后面排队的任务跟着失败。
 */
export async function withSiteLock<T>(siteRoot: string, fn: () => Promise<T>): Promise<T> {
  const key = siteRoot.replace(/\/+$/, "");
  const prev = siteLocks.get(key) || Promise.resolve();

  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  // 挂在前一个任务后面；catch 吞掉前者的错误，避免失败传染后续排队者
  siteLocks.set(key, prev.then(() => current, () => current));

  const waitStart = Date.now();
  // 注意：拿到锁后必须 clearTimeout，否则这个 180s 定时器会一直挂在事件循环上
  // 把进程拖住不退出（测试里直接表现为 node --test 跑完不结束）。
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      prev.catch(() => undefined),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`站点写入锁等待超时（${LOCK_TIMEOUT_MS / 1000}s）：${key}`)),
          LOCK_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (err) {
    release();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const waited = Date.now() - waitStart;
  if (waited > 1000) {
    console.log(`[SiteLock] ${key} 等待 ${waited}ms 后获得锁`);
  }

  try {
    return await fn();
  } finally {
    release();
    // 队列尾部还是自己时清掉，避免 Map 无界增长
    if (siteLocks.get(key) === current) siteLocks.delete(key);
  }
}

/** 仅用于测试/诊断：当前有多少站点持锁或排队 */
export function activeSiteLockCount(): number {
  return siteLocks.size;
}

// ─── JS 数据文件语法校验 ────────────────────────────────────────────────────

export interface JsSyntaxCheckResult {
  ok: boolean;
  /** 报错信息（ok=false 时有值） */
  error?: string;
  /** 出错行号（能解析出来时有值） */
  line?: number;
}

/**
 * 校验一段 JS 源码能否被解析。
 *
 * 用 `new Script()` 只编译不执行 —— 站点 main.js 里全是 document/window/
 * IntersectionObserver 这类浏览器 API，执行必然报 ReferenceError，但编译阶段
 * 不关心标识符是否存在，只看语法。这正好覆盖我们要防的那一类损坏：
 * 截断、字符串未闭合、括号不匹配、两段内容错位重叠。
 */
export function checkJsSyntax(source: string): JsSyntaxCheckResult {
  try {
    new Script(source, { filename: "site-data-file.js" });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack || "" : "";
    const m = stack.match(/site-data-file\.js:(\d+)/);
    return {
      ok: false,
      error: msg.slice(0, 300),
      line: m ? Number(m[1]) : undefined,
    };
  }
}

/**
 * 判断一个路径是否是需要语法校验的 JS 数据文件。
 * 只校验 .js，HTML/JSON/图片等不走这条路。
 */
export function isJsDataFile(path: string): boolean {
  return /\.js$/i.test(path.split("?")[0]);
}

// ─── 带护栏的写入 ───────────────────────────────────────────────────────────

export interface GuardedWriteIO {
  write: (path: string, content: string) => Promise<void>;
  read: (path: string) => Promise<string>;
}

/**
 * 写 JS 数据文件，带三道护栏：
 *   1. 写前语法校验 —— 拼坏的内容根本不往服务器送，旧文件保持原样（坏总比白屏好）
 *   2. 写后回读比对 —— 长度或内容不一致说明传输被截断，立即抛错
 *   3. 回读内容再校验一次 —— 防「本地拼对了但落盘坏了」
 *
 * 任何一道不过都抛错，让发布接口如实报失败。在此之前这条链路是静默的：
 * 文件写坏了、整站首页白屏，接口照样返回「发布成功」。
 */
export async function writeJsDataFileGuarded(
  io: GuardedWriteIO,
  path: string,
  content: string,
): Promise<void> {
  const pre = checkJsSyntax(content);
  if (!pre.ok) {
    throw new Error(
      `拒绝写入：生成的 JS 数据文件语法不合法（${path}）` +
      `${pre.line ? ` 第 ${pre.line} 行` : ""}：${pre.error}。` +
      `已中止写入，服务器上的旧文件保持不变。`,
    );
  }

  await io.write(path, content);

  let readBack: string;
  try {
    readBack = await io.read(path);
  } catch (err) {
    throw new Error(
      `写入后无法回读校验（${path}）：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (readBack.length !== content.length) {
    throw new Error(
      `写入后回读长度不符（${path}）：应为 ${content.length} 字节，实际 ${readBack.length} 字节。` +
      `可能是传输被截断或有并发写入。`,
    );
  }
  if (readBack !== content) {
    throw new Error(`写入后回读内容与预期不一致（${path}），长度相同但内容有差异，疑似并发写入。`);
  }

  const post = checkJsSyntax(readBack);
  if (!post.ok) {
    throw new Error(
      `写入后回读的内容语法不合法（${path}）` +
      `${post.line ? ` 第 ${post.line} 行` : ""}：${post.error}`,
    );
  }
}
