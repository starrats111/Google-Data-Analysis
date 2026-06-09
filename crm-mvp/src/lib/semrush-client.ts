/**
 * SemRush 竞品分析客户端（移植自 sem01_client.py）
 * 通过 3UE 代理获取竞品域名的关键词、广告标题、广告描述
 * 使用 curl 发送请求以绕过 TLS 指纹检测（Node.js fetch 的 JA3 指纹会被 3UE 拦截）
 *
 * 安全防护：全局请求队列限流 + 域名结果缓存 + 会话复用
 */
import { getSystemConfig, getSystemConfigsByPrefix, setSystemConfig } from "@/lib/system-config";
import prisma from "@/lib/prisma";
import { execFile } from "child_process";
import { promisify } from "util";
import { AsyncLocalStorage } from "node:async_hooks";

const execFileAsync = promisify(execFile);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const RPC_URL = "https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU";
const LOGIN_URL = "https://dash.3ue.co/api/account/login";
const LOGIN_ORIGIN = "https://dash.3ue.co";
const RPC_ORIGIN = "https://sem.3ue.co";

// ─── 全局安全防护：限流 + 缓存 ───

const MIN_REQUEST_INTERVAL_MS = 1500;
const RANDOM_JITTER_MAX_MS = 1000;

// 看门狗 + 排队超时：防 release 漏调（异常路径）导致 SemRush 互斥锁永久死锁、
// 所有后续关键词查询静默挂死直到进程重启。对齐 puppeteer-semaphore D-067。
// 单次 queryDomain 含设备超限退避(4×最长8s)+多 RPC 重试，正常可达数分钟，故持有看门狗取 6min；
// 排队超时取 8min（看门狗已保证锁必释放，此为二次保险，仅在病态场景触发）。
const MAX_SEMRUSH_HOLD_MS = 360000;
const SEMRUSH_QUEUE_TIMEOUT_MS = 480000;

// SemRush 断链健壮化：curl 进程级连接失败（连接重置/TLS/连接超时/连接被拒/空回复）
// 属瞬时网络抖动，单次失败不应让整条查询挂掉 → 在 curlFetch 最底层做连接级退避重试。
const CURL_CONN_RETRIES = 2;                  // 连接级重试次数（不含首次）
const CURL_CONN_BACKOFF_MS = [800, 2000];     // 每次重试退避（叠加 ~0-400ms jitter）
// curl 瞬时网络错误退出码：6 解析失败 / 7 连接失败 / 16 HTTP2 / 28 超时 / 35 SSL连接 /
// 52 空回复 / 55 send失败 / 56 recv失败(连接重置) / 92 HTTP2流错误
const CURL_TRANSIENT_EXIT_CODES = new Set([6, 7, 16, 28, 35, 52, 55, 56, 92]);
const CURL_TRANSIENT_MSG_RE =
  /reset by peer|connection reset|recv failure|send failure|connection timed out|operation timed out|could not resolve|couldn't resolve|empty reply|ssl|gnutls|tls|transfer closed|http2|stream was reset/i;
const DOMAIN_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
// SEM-02 R1：广告创建以外默认登出。每次查询结束后臂定一个空闲计时器，超过该时长无新查询即
// 主动登出 3UE 并清会话（内存+持久化），把账号唯一在线设备名额还给员工自己的浏览器登录。
// 取 30s：足够覆盖一次广告创建/取词内多次查询的间隔（批内不抖动、不触发设备超限），
// 又能在员工离开广告创建后很快释放设备。
const SESSION_IDLE_LOGOUT_MS = 30 * 1000;

// BUG-04 A：跨进程/跨重启共享会话。会话仅存内存时，每次冷启动（ad-automation 累计重启 121 次）
// 都会在 3UE 侧新开一台"在线设备"且从不释放 → 设备配额被僵尸会话占满。持久化到 system_configs，
// 冷启动优先复用同一 token（= 同一台设备），从根上消除重启造成的设备堆积。
const SESSION_CONFIG_KEY = "semrush_session";
// BUG-04 B：丢弃/轮换旧会话时尽力登出，释放其在 3UE 侧占用的设备。
// 注意：仓库内无现成 logout 端点，此为最可能端点；全程吞错 + 短超时，失败不影响主流程。
// 绝不在进程优雅退出时登出——那会让 A 想复用的 token 失效，反而又新开设备。
const LOGOUT_URL = "https://dash.3ue.co/api/account/logout";

// D-061：3UE 多节点故障转移
// 节点宕机（"节点暂不可用"）短期拉黑；套餐不可用（"套餐无法使用该节点"）长期拉黑。
const NODE_DOWN_TTL_MS = 10 * 60 * 1000;        // 节点暂时宕机：10 分钟内不再尝试
const NODE_FORBIDDEN_TTL_MS = 12 * 60 * 60 * 1000; // 套餐不支持该节点：12 小时内不再尝试
// D-087：设备并发超限（账号级，与节点无关）→ 原地退避重试同一节点，绝不切节点/拉黑。
// "超出同一时间设备数量限制" 是 SemRush 账号同时在线会话数到顶，切节点换出口 IP 只会
// 再开一台设备→越切越糟，旧逻辑还会把健康节点误判为宕机全部拉黑，导致持续"所有节点不可用"。
const MAX_DEVICE_LIMIT_RETRIES = 4;
const DEVICE_LIMIT_BACKOFF_MS = [1500, 3000, 5000, 8000];
const DEVICE_LIMIT_RE = /设备数量限制|设备数限制|退出其他设备|同一时间设备|设备数超限/i;
// 候选节点全集（3UE 当前为 1..8；实际可用性以响应为准，本表仅决定尝试顺序与范围）
const NODE_UNIVERSE = ["1", "2", "3", "4", "5", "6", "7", "8"];
// D-061：与既有 health-cron（semrush-auto-fix.trySwitchNode）统一写回同一个 key，
// 避免双真相源；semrush_node 本就是运行时可变的有效节点（cron 已在写它）。
const NODE_CONFIG_KEY = "semrush_node";

export interface SemRushKeyword {
  phrase: string;
  volume: number;
  cpc?: number | null;
  competition?: string | number | null;
  suggested_bid?: number | null;
  trafficPercent?: number | null;
}

export interface SemRushResult {
  domain: string;
  keywords: SemRushKeyword[];
  paidKeywords: SemRushKeyword[];
  adsOverview: { title: string; description: string }[];
  copies: { date: string; total: number; samples: { title: string; description: string }[] };
  creativeSamples: { title: string; description: string }[];
  dedupedTitles: string[];
  dedupedDescriptions: string[];
}

interface CachedSession {
  token: string;
  cookies: Record<string, string>;
  username: string;
  expiresAt: number;
}

interface CachedDomainResult {
  data: SemRushResult;
  cachedAt: number;
}

// BUG-04 C：标记"当前异步上下文是否已持有独占槽"。queryDomain 用 withExclusive 在整条查询
// （login → 多次 rpc → copies）外层占一次槽；其内部 login()/rpc() 再调 waitForSlot 时直接
// 命中重入返回 no-op，避免自我死锁，同时保证"一条逻辑查询 = 一个连续独占会话"，彻底消除
// 登录→RPC 之间锁松开导致的多查询穿插（穿插会放大并发会话/登录竞态）。
const slotCtx = new AsyncLocalStorage<{ held: boolean }>();

class SemrushGuard {
  private lastRequestTime = 0;
  private queue: Array<{ resolve: () => void; cancelled?: boolean }> = [];
  private processing = false;
  private domainCache = new Map<string, CachedDomainResult>();
  private sessionCache: CachedSession | null = null;
  // D-061：节点故障转移状态
  private preferredNode: string | null = null;       // 最近成功的节点，优先复用
  private badNodes = new Map<string, number>();       // node → 失效截止时间戳（拉黑）

  // D-087：true 时表示已有一个 SemRush 请求在飞（互斥锁占用），新请求必须等其 release。
  private locked = false;

  // SEM-02 R1：空闲登出计时器。每条查询结束臂定，新查询取消重臂；触发即登出+清会话。
  private idleLogoutTimer: ReturnType<typeof setTimeout> | null = null;

  // 方案-09：每个 3UE 账号一个 guard 实例（不同员工账号各自串行、互不阻塞），
  // 会话持久化键按账号区分，避免多账号互相覆盖 session（旧全局账号过渡期仍单独一键）。
  private readonly sessionConfigKey: string;
  constructor(accountKey?: string) {
    this.sessionConfigKey = accountKey ? `${SESSION_CONFIG_KEY}:${accountKey}` : SESSION_CONFIG_KEY;
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length > 0) {
      // D-087：并发=1。已有请求在飞 → 暂停派发，等 release() 再驱动。
      // 这是设备并发超限的结构性根因修复：任一时刻只允许一个 SemRush 会话在线，
      // 从源头杜绝"超出同一时间设备数量限制"。
      if (this.locked) break;
      // 跳过已超时取消的队首（防其占锁）
      if (this.queue[0].cancelled) { this.queue.shift(); continue; }
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      const jitter = Math.floor(Math.random() * RANDOM_JITTER_MAX_MS);
      const requiredWait = MIN_REQUEST_INTERVAL_MS + jitter;
      if (elapsed < requiredWait) {
        await new Promise((r) => setTimeout(r, requiredWait - elapsed));
      }
      if (this.locked) break; // 退避期间可能已被占用，二次确认
      // 退避期间队首可能已超时取消，逐个清掉再派发
      while (this.queue.length > 0 && this.queue[0].cancelled) this.queue.shift();
      if (this.queue.length === 0) break;
      this.locked = true;
      const item = this.queue.shift();
      item?.resolve();
    }
    this.processing = false;
  }

  // D-087：获取一个串行槽位；返回 release 函数。调用方必须在网络请求结束后（try/finally）调用 release()，
  // 否则会死锁后续所有 SemRush 请求。返回的 release 幂等。
  // BUG-04 C：若当前异步上下文已通过 withExclusive 持有独占槽，则本次 waitForSlot 直接返回 no-op
  // release（重入），不再二次抢锁——否则 queryDomain 外层已占槽、内部 login/rpc 再抢会自我死锁。
  async waitForSlot(timeoutMs = SEMRUSH_QUEUE_TIMEOUT_MS): Promise<() => void> {
    if (slotCtx.getStore()?.held) {
      return () => {};
    }
    const item: { resolve: () => void; cancelled?: boolean } = { resolve: () => {} };
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let waitTimer: ReturnType<typeof setTimeout> | null = null;
      item.resolve = () => {
        if (settled) return;
        settled = true;
        if (waitTimer) clearTimeout(waitTimer);
        resolve();
      };
      // 排队超时：等不到锁就放弃（调用方降级/走缓存兜底），不无限挂起。
      if (timeoutMs > 0) {
        waitTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          item.cancelled = true;
          const idx = this.queue.indexOf(item);
          if (idx >= 0) this.queue.splice(idx, 1);
          const err = new Error(
            `SemRush slot wait timeout after ${timeoutMs}ms (locked=${this.locked}, queued=${this.queue.length})`,
          );
          (err as Error & { code?: string }).code = "SEMRUSH_SLOT_TIMEOUT";
          reject(err);
        }, timeoutMs);
        if (typeof waitTimer.unref === "function") waitTimer.unref();
      }
      this.queue.push(item);
      this.processQueue();
    });

    // 已拿到锁（locked=true）。挂看门狗：持有超 MAX_SEMRUSH_HOLD_MS 仍未释放 → 强制释放，
    // 防 release 漏调（异常路径）导致整个 SemRush 子系统永久死锁直到重启。
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (watchdog) clearTimeout(watchdog);
      this.locked = false;
      this.lastRequestTime = Date.now();
      void this.processQueue();
    };
    const watchdog = setTimeout(() => {
      if (released) return;
      console.warn(
        `[SemrushGuard] 槽位持有超过 ${MAX_SEMRUSH_HOLD_MS}ms，强制释放防死锁 (queued=${this.queue.length})`,
      );
      release();
    }, MAX_SEMRUSH_HOLD_MS);
    if (typeof watchdog.unref === "function") watchdog.unref();
    return release;
  }

  // BUG-04 C：在"整条查询"外层占一次独占槽，期间内部所有 waitForSlot 走重入 no-op。
  // 保证一条 queryDomain 全程只对应一个连续会话，且任一时刻全进程仅一条查询在飞。
  async withExclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (slotCtx.getStore()?.held) {
      // 已在独占上下文内（理论上不会嵌套，防御性处理）
      return fn();
    }
    // SEM-02 R1：新查询进入，取消挂起的空闲登出（避免查询途中把当前会话登出）。
    this.cancelIdleLogout();
    const release = await this.waitForSlot();
    try {
      return await slotCtx.run({ held: true }, fn);
    } finally {
      release();
      // SEM-02 R1：本条查询结束，臂定空闲登出；若 30s 内有新查询会被取消重臂。
      this.armIdleLogout();
    }
  }

  // SEM-02 R1：取消挂起的空闲登出计时器。
  cancelIdleLogout() {
    if (this.idleLogoutTimer) {
      clearTimeout(this.idleLogoutTimer);
      this.idleLogoutTimer = null;
    }
  }

  // SEM-02 R1：臂定空闲登出。超过 SESSION_IDLE_LOGOUT_MS 无新查询即登出 3UE 并清会话，
  // 把账号唯一在线设备名额还给员工自己的登录。登出全程吞错，不影响任何主流程。
  armIdleLogout() {
    this.cancelIdleLogout();
    if (!this.sessionCache) return; // 无会话无需登出
    this.idleLogoutTimer = setTimeout(() => {
      this.idleLogoutTimer = null;
      const old = this.sessionCache;
      this.sessionCache = null;
      if (old) {
        console.log("[SemRush] SEM-02：空闲超时，主动登出 3UE 释放设备（广告创建以外默认登出）");
        void logout3ue(old);
      }
      void this.clearPersistedSession();
    }, SESSION_IDLE_LOGOUT_MS);
    if (typeof this.idleLogoutTimer.unref === "function") this.idleLogoutTimer.unref();
  }

  getCachedDomain(domain: string): SemRushResult | null {
    const entry = this.domainCache.get(domain);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > DOMAIN_CACHE_TTL_MS) {
      this.domainCache.delete(domain);
      return null;
    }
    return entry.data;
  }

  setCachedDomain(domain: string, data: SemRushResult) {
    this.domainCache.set(domain, { data, cachedAt: Date.now() });
    if (this.domainCache.size > 500) {
      const oldest = [...this.domainCache.entries()]
        .sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
      if (oldest) this.domainCache.delete(oldest[0]);
    }
  }

  getCachedSession(username: string): CachedSession | null {
    if (!this.sessionCache) return null;
    if (this.sessionCache.username !== username) return null;
    if (Date.now() > this.sessionCache.expiresAt) {
      this.sessionCache = null;
      return null;
    }
    return this.sessionCache;
  }

  setCachedSession(username: string, token: string, cookies: Record<string, string>) {
    this.sessionCache = { token, cookies: { ...cookies }, username, expiresAt: Date.now() + SESSION_TTL_MS };
    void this.persistSession(this.sessionCache); // BUG-04 A：同步落库，供其它进程/重启后复用
  }

  invalidateSession() {
    // BUG-04 B：丢弃旧会话时尽力登出，释放其在 3UE 侧占用的"在线设备"（吞错、不阻塞）。
    const old = this.sessionCache;
    this.sessionCache = null;
    if (old) void logout3ue(old);
    void this.clearPersistedSession();
  }

  // SEM-单设备（修正版核心）：即将「全新登录」前，先登出上一台旧设备。
  //   关键点：读持久化里的旧 token 时**忽略本地 30 分钟 TTL**——本地 TTL 到期 ≠ 3UE 侧设备已下线，
  //   旧 token 对应的"在线设备"仍占着账号名额。若不先登出就直接再登一台，30 分钟一到期就 +1 台僵尸，
  //   单用户用一天也能把设备名额占满 → "同时在线设备数超限"。先登出旧的再建新的 → 任一时刻恒为 1 台。
  //   仅在 login() 确认缓存/持久化均无可复用会话（即真要新建设备）时调用；正常复用路径不触发、无额外开销。
  async logoutPreviousDeviceBeforeRelogin(): Promise<void> {
    try {
      const raw = await getSystemConfig(this.sessionConfigKey);
      if (!raw) return;
      const o = JSON.parse(raw) as { username?: string; token?: string; cookies?: Record<string, string> };
      if (!o?.token || !o.cookies || Object.keys(o.cookies).length === 0) return;
      await logout3ue({ token: o.token, cookies: o.cookies, username: o.username || "", expiresAt: 0 });
      console.log("[SemRush] SEM-单设备：新建会话前已登出上一台旧设备（保持账号恒为 1 台在线）");
    } catch { /* 登出失败吞错，不阻塞登录 */ }
  }

  // BUG-04 A：写持久化会话（fire-and-forget，失败仅警告，不影响主流程）
  private async persistSession(s: CachedSession): Promise<void> {
    try {
      await setSystemConfig(
        this.sessionConfigKey,
        JSON.stringify({ username: s.username, token: s.token, cookies: s.cookies, expiresAt: s.expiresAt }),
        "SemRush 会话（跨重启复用，避免设备数超限）",
      );
    } catch (e) {
      console.warn("[SemRush] BUG-04 A 会话持久化失败（忽略）:", e instanceof Error ? e.message : e);
    }
  }

  // BUG-04 A：冷启动/内存未命中时读持久化会话；校验用户名匹配 + 未过期，命中则同步进内存。
  async loadPersistedSession(username: string): Promise<CachedSession | null> {
    try {
      const raw = await getSystemConfig(this.sessionConfigKey);
      if (!raw) return null;
      const o = JSON.parse(raw) as { username?: string; token?: string; cookies?: Record<string, string>; expiresAt?: number };
      if (!o?.token || !o.username || o.username !== username) return null;
      if (!o.expiresAt || Date.now() > o.expiresAt) return null;
      const s: CachedSession = { token: o.token, cookies: { ...(o.cookies || {}) }, username: o.username, expiresAt: o.expiresAt };
      this.sessionCache = s;
      return s;
    } catch {
      return null;
    }
  }

  // BUG-04 A：清空持久化会话（登出/失效后调用）
  private async clearPersistedSession(): Promise<void> {
    try {
      await setSystemConfig(this.sessionConfigKey, "", "SemRush 会话（已清空）");
    } catch {
      /* 清空失败不影响主流程 */
    }
  }

  // ─── D-061：节点故障转移 ───
  getPreferredNode(): string | null {
    if (this.preferredNode && this.isNodeBad(this.preferredNode)) {
      this.preferredNode = null;
    }
    return this.preferredNode;
  }

  setPreferredNode(node: string) {
    this.preferredNode = node;
  }

  markNodeBad(node: string, ttlMs: number) {
    this.badNodes.set(node, Date.now() + ttlMs);
    if (this.preferredNode === node) this.preferredNode = null;
  }

  isNodeBad(node: string): boolean {
    const expireAt = this.badNodes.get(node);
    if (!expireAt) return false;
    if (Date.now() > expireAt) {
      this.badNodes.delete(node);
      return false;
    }
    return true;
  }

  getStats() {
    return {
      cacheSize: this.domainCache.size,
      queueLength: this.queue.length,
      hasSession: !!this.sessionCache,
      preferredNode: this.preferredNode,
      badNodes: [...this.badNodes.keys()],
    };
  }
}

// BUG-04 B：尽力登出 3UE，释放该会话占用的"在线设备"。仓库内无现成 logout 端点，
// 这里用最可能路径 /api/account/logout；全程吞错 + 短超时，失败不影响任何主流程。
// 仅在"丢弃/轮换旧会话"（invalidateSession）时调用——绝不在进程优雅退出时调用，
// 否则会让 BUG-04 A 想复用的持久化 token 失效，反而又新开设备。
async function logout3ue(session: CachedSession): Promise<void> {
  try {
    const cookieStr = Object.entries(session.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    await curlFetch(LOGOUT_URL, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        origin: LOGIN_ORIGIN,
        accept: "application/json, text/plain, */*",
        cookie: cookieStr,
      },
      timeoutMs: 6000,
    });
    console.log("[SemRush] BUG-04 B：已尝试登出旧会话以释放设备");
  } catch {
    /* 登出失败不影响主流程 */
  }
}

// 方案-09：按 3UE 账号(username)各持一个 guard，实现"不同员工账号并行、单账号内串行"，
// 从根上避免共享账号被批量并发打满设备数。旧全局账号(system_configs)也走此 Map（key=其 username）。
const guardByAccount = new Map<string, SemrushGuard>();
function getSemrushGuard(accountKey: string): SemrushGuard {
  let g = guardByAccount.get(accountKey);
  if (!g) {
    g = new SemrushGuard(accountKey);
    guardByAccount.set(accountKey, g);
  }
  return g;
}

// ─── curl 封装（绕过 TLS 指纹检测） ───

interface CurlResponse {
  status: number;
  body: string;
  cookies: Record<string, string>;
  location?: string; // D-061：3xx 重定向的 Location 头（用于识别 3UE 节点不可用跳转）
}

export async function curlFetch(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; followRedirects?: boolean } = {},
): Promise<CurlResponse> {
  const args: string[] = ["-s", "-i", "--max-time", String(Math.ceil((opts.timeoutMs || 30000) / 1000))];
  if (opts.followRedirects) args.push("-L");
  if (opts.method) args.push("-X", opts.method);
  for (const [k, v] of Object.entries(opts.headers || {})) {
    args.push("-H", `${k}: ${v}`);
  }
  if (opts.body) args.push("-d", opts.body);
  args.push(url);

  let raw = "";
  let lastErr: { killed: boolean; exitCode?: number; message: string } | null = null;
  for (let attempt = 0; attempt <= CURL_CONN_RETRIES; attempt++) {
    try {
      const result = await execFileAsync("curl", args, {
        timeout: (opts.timeoutMs || 30000) + 5000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      raw = result.stdout;
      lastErr = null;
      break;
    } catch (execErr: any) {
      const killed = !!(execErr?.killed || execErr?.signal === "SIGTERM");
      const exitCode = typeof execErr?.code === "number" ? execErr.code : undefined;
      const message = String(execErr?.message || "");
      lastErr = { killed, exitCode, message };
      // 是否瞬时网络错误：execFile 超时杀进程 / curl 瞬时退出码 / 错误文案命中网络抖动特征
      const transient =
        killed ||
        (exitCode !== undefined && CURL_TRANSIENT_EXIT_CODES.has(exitCode)) ||
        CURL_TRANSIENT_MSG_RE.test(message);
      if (transient && attempt < CURL_CONN_RETRIES) {
        const wait = (CURL_CONN_BACKOFF_MS[attempt] ?? 2000) + Math.floor(Math.random() * 400);
        console.warn(
          `[SemRush] curl 连接失败（${killed ? "超时" : `exit ${exitCode ?? "?"}`}），` +
            `第 ${attempt + 1}/${CURL_CONN_RETRIES} 次退避重试 ${wait}ms：${message.slice(0, 100)}`,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      break; // 非瞬时错误或重试用尽 → 跳出，下面统一抛出
    }
  }

  if (lastErr) {
    if (lastErr.killed) throw new Error("请求超时，请稍后再试");
    throw new Error(`网络请求失败: ${lastErr.message.slice(0, 120) || "未知错误"}`);
  }

  if (!raw || !raw.trim()) {
    throw new Error("服务器返回空响应，请稍后再试");
  }

  // 遍历所有中间响应（1xx informational + 3xx redirect），累积 cookies，取最终响应的 status 和 body
  let remaining = raw;
  let headerSection = "";
  let body = remaining;
  const allCookieLines: string[] = [];

  while (true) {
    // 尝试 \r\n\r\n 分隔，fallback \n\n
    let sepIdx = remaining.indexOf("\r\n\r\n");
    let sepLen = 4;
    if (sepIdx < 0) { sepIdx = remaining.indexOf("\n\n"); sepLen = 2; }
    if (sepIdx < 0) { body = remaining; headerSection = ""; break; }

    const hPart = remaining.slice(0, sepIdx);
    // 收集当前响应的所有 Set-Cookie
    const partCookies = hPart.match(/^set-cookie:\s*(.+)$/gim) || [];
    allCookieLines.push(...partCookies);

    const isIntermediate = /^HTTP\/[\d.]+ [13]\d{2}\b/.test(hPart.trim());
    if (isIntermediate) {
      // 跳过当前响应头和 body，定位下一个 HTTP 响应
      const afterHeaders = remaining.slice(sepIdx + sepLen);
      const nextHttp = afterHeaders.indexOf("HTTP/");
      if (nextHttp >= 0) {
        remaining = afterHeaders.slice(nextHttp);
        continue;
      }
      // 没有后续响应，把剩余内容作为 body
      headerSection = hPart;
      body = afterHeaders;
      break;
    }

    // 最终响应
    headerSection = hPart;
    body = remaining.slice(sepIdx + sepLen);
    break;
  }

  // 解析状态码（从最终响应头部取）
  let status = 200;
  const statusLines = headerSection.match(/HTTP\/[\d.]+ (\d+)/g) || [];
  if (statusLines.length > 0) {
    const lastStatus = statusLines[statusLines.length - 1].match(/(\d+)$/);
    if (lastStatus) status = parseInt(lastStatus[1]);
  }

  // 解析 Set-Cookie（全链路累积）
  const cookies: Record<string, string> = {};
  for (const line of allCookieLines) {
    const val = line.replace(/^set-cookie:\s*/i, "");
    const [kv] = val.split(";");
    const eqIdx = kv.indexOf("=");
    if (eqIdx > 0) {
      const k = kv.slice(0, eqIdx).trim();
      const v = kv.slice(eqIdx + 1).trim();
      if (k && v) cookies[k] = v;
    }
  }

  // D-061：解析最终响应的 Location 头（curl 不带 -L 时 3xx 即为最终响应）
  const locMatch = headerSection.match(/^location:\s*(.+)$/im);
  const location = locMatch ? locMatch[1].trim() : undefined;

  return { status, body, cookies, location };
}

// ─── 工具函数 ───

export function normalizeDomain(value: string): string {
  const candidate = value.trim();
  if (!candidate) return "";
  let hostname: string;
  if (candidate.includes("://")) {
    try {
      hostname = new URL(candidate).hostname;
    } catch {
      hostname = candidate.split("/")[0];
    }
  } else {
    hostname = candidate.split("/")[0];
  }
  hostname = hostname.trim().toLowerCase();
  if (hostname.startsWith("www.")) hostname = hostname.slice(4);
  return hostname;
}

export function dedupeAdTitles(titles: string[]): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const title of titles) {
    const parts = title.includes(" - ") ? title.split(" - ") : [title];
    for (const part of parts) {
      const cleaned = part.trim();
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned);
        items.push(cleaned);
      }
    }
  }
  return items;
}

export function dedupeAdDescriptions(descriptions: string[]): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const description of descriptions) {
    const parts = description.includes(".") ? description.split(".") : [description];
    for (const part of parts) {
      const cleaned = part.trim();
      if (!cleaned) continue;
      const sentence = `${cleaned}.`;
      if (!seen.has(sentence)) {
        seen.add(sentence);
        items.push(sentence);
      }
    }
  }
  return items;
}

function parseKeywordRow(r: any): SemRushKeyword {
  return {
    phrase: String(r.phrase || r.keyword || ""),
    volume: Number(r.volume || r.search_volume || 0),
    cpc: r.cpc != null ? Number(r.cpc) : null,
    competition: r.competition ?? r.competition_level ?? null,
    suggested_bid: r.suggested_bid != null
      ? Number(r.suggested_bid)
      : r.suggestedBid != null
        ? Number(r.suggestedBid)
        : r.cpc != null
          ? Number(r.cpc)
          : null,
    trafficPercent: r.trafficPercent != null ? Number(r.trafficPercent) : null,
  };
}

function normalizeReportDate(value: string | number): string {
  const text = String(value).trim();
  if (text.length === 8 && /^\d+$/.test(text)) return text;
  if (text.length === 10 && /^\d+$/.test(text)) {
    const d = new Date(parseInt(text) * 1000);
    return d.toISOString().slice(0, 10).replace(/-/g, "");
  }
  throw new Error(`不支持的报告日期格式: ${value}`);
}

function selectCreativeSamples(
  adsOverview: { title: string; description: string }[],
  copiesSamples: { title: string; description: string }[],
) {
  return copiesSamples.length > 0 ? copiesSamples : adsOverview;
}

// D-083：SemRush 不提供以下国家的独立数据库，映射到最接近的可用库。
// 默认兜底：unknown → "us"（数据最全）。
const COUNTRY_EXCEPTIONS: Record<string, string> = {
  // 英国/爱尔兰
  GB:    "uk",
  UK:    "uk",
  IE:    "uk",   // 爱尔兰 → 英国库
  // 德语区（SemRush 无独立 AT/CH 库）
  AT:    "de",   // 奥地利 → 德国库
  CH:    "de",   // 瑞士 → 德国库
  // 比利时（无 be-fr 复合代码）
  "BE-FR": "be",
  // 大洋洲
  NZ:    "au",   // 新西兰 → 澳大利亚库
  // 亚太 — 无独立库，退到最近英语/区域库
  HK:    "sg",   // 香港 → 新加坡库（APAC 最近）
  TW:    "sg",   // 台湾 → 新加坡库
  MY:    "sg",   // 马来西亚 → 新加坡库
  ID:    "sg",   // 印度尼西亚 → 新加坡库
  TH:    "us",   // 泰国 → 美国库（SemRush 无东南亚泰语库）
  VN:    "us",   // 越南 → 美国库
  // 中东
  AE:    "sa",   // 阿联酋 → 沙特库（阿语最近）
};

// SemRush 确认支持的数据库白名单（来自 user.Databases 接口，维护成本低，主要用于兜底校验）
const KNOWN_DATABASES = new Set([
  "us","uk","ca","au","de","fr","es","it","pt","br","nl","jp",
  "be","se","no","dk","fi","pl","ru","in","sg","mx","ar","cl",
  "co","tr","il","sa","kr","gr","ro","cz","hu","bg",
]);

function countryToDatabase(country: string): string {
  const upper = country.toUpperCase();
  if (COUNTRY_EXCEPTIONS[upper]) return COUNTRY_EXCEPTIONS[upper];
  const lower = upper.toLowerCase();
  // 不在白名单 → 兜底 us（数据最全，优于返回 0）
  return KNOWN_DATABASES.has(lower) ? lower : "us";
}

/** 从 3UE SemRush 页面 URL 中提取被查询的域名 */
export function parseDomainFromSemrushUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes("3ue.co") && !parsed.hostname.includes("semrush")) return "";
    const q = parsed.searchParams.get("q") || parsed.searchParams.get("searchItem") || "";
    if (q) return normalizeDomain(q);
    const pathMatch = parsed.pathname.match(/\/(?:analytics|overview)\/.*?([a-z0-9][-a-z0-9]*\.[a-z]{2,})/i);
    if (pathMatch) return normalizeDomain(pathMatch[1]);
  } catch {}
  return "";
}

// ─── 客户端类 ───

interface NodeConfig {
  chatNode: string;
  chatLang: string;
  semrushNode: string;
  semrushLang: string;
}

interface SemRushCredentials {
  username: string;
  password: string;
  userId: string;
  apiKey: string;
  database: string;
  nodeConfig: NodeConfig;
}

export class SemRushClient {
  private creds: SemRushCredentials;
  private token: string | null = null;
  private cookies: Record<string, string> = {};
  // D-061：当前生效节点（构造时取自 active/seed，rpc 故障转移时动态切换）
  private activeNode: string;
  // 方案-09：本客户端绑定的账号级 guard（按 username 取实例）
  private guard: SemrushGuard;

  constructor(creds: SemRushCredentials) {
    this.creds = creds;
    this.activeNode = creds.nodeConfig.semrushNode || "3";
    this.guard = getSemrushGuard(creds.username);
  }

  /** 从 system_configs 读取凭据并创建客户端 */
  static async fromConfig(country?: string): Promise<SemRushClient> {
    const configs = await getSystemConfigsByPrefix("semrush_");
    const username = configs["semrush_username"];
    const password = configs["semrush_password"];
    const userId = configs["semrush_user_id"];
    const apiKey = configs["semrush_api_key"];
    if (!username || !password || !userId || !apiKey) {
      throw new Error("SemRush 凭据未配置，请在管理后台 SemRush 配置中设置");
    }
    const db = country ? countryToDatabase(country) : (configs["semrush_database"] || "us");
    // D-061：种子节点取自 semrush_node（health-cron 与本类的失败转移都会把它更新为最近可用节点），
    // 进程重启后即从上次可用节点起步，避免重启都撞已宕机的节点。
    const seedNode = configs[NODE_CONFIG_KEY] || "2";
    return new SemRushClient({
      username,
      password,
      userId,
      apiKey,
      database: db,
      nodeConfig: {
        chatNode: seedNode,
        chatLang: "zh_CN",
        semrushNode: seedNode,
        semrushLang: "zh",
      },
    });
  }

  /**
   * 方案-09：优先用「员工自配 SemRush 账号」创建客户端；员工未配置则回退到全局 system_configs（Q09-a/b/c）。
   * 各员工各用各账号 → 不同员工的查询走不同 guard 实例并行，单账号内串行，根治共享账号批量设备超限。
   */
  static async fromUserConfig(userId: string | number | bigint, country?: string): Promise<SemRushClient> {
    try {
      const uid = typeof userId === "bigint" ? userId : BigInt(userId);
      const row = await prisma.user_semrush_keys.findFirst({
        where: { user_id: uid, is_active: 1, is_deleted: 0 },
        orderBy: { created_at: "asc" },
      });
      // SEM-01：员工只配【用户名+密码】即视为有效；UserID/ApiKey/节点/默认库 始终跟管理台全局。
      //   - 兼容老记录：若该行自带 user_id_3ue/api_key/node 则优先用其自有值；新记录为空时用全局。
      //   - database 运行时始终按全局（有投放国则 countryToDatabase 覆盖）。
      if (row?.username && row.password) {
        const configs = await getSystemConfigsByPrefix("semrush_");
        const userId3ue = row.user_id_3ue || configs["semrush_user_id"];
        const apiKey = row.api_key || configs["semrush_api_key"];
        if (!userId3ue || !apiKey) {
          console.warn("[SemRush] 员工账号无 UserID/ApiKey 且全局未配置，回退全局账号");
          return SemRushClient.fromConfig(country);
        }
        const db = country ? countryToDatabase(country) : (configs["semrush_database"] || "us");
        const seedNode = configs[NODE_CONFIG_KEY] || row.node || "3";
        return new SemRushClient({
          username: row.username,
          password: row.password,
          userId: userId3ue,
          apiKey,
          database: db,
          nodeConfig: { chatNode: seedNode, chatLang: "zh_CN", semrushNode: seedNode, semrushLang: "zh" },
        });
      }
    } catch (e) {
      console.warn("[SemRush] fromUserConfig 读取员工配置失败，回退全局账号:", e instanceof Error ? e.message : e);
    }
    // 回退：员工未配置 / 配置不全 / 读取异常 → 用全局共享账号（过渡期兜底）
    return SemRushClient.fromConfig(country);
  }

  private buildConfigValue(node?: string): string {
    // D-061：node 决定路由到哪个 3UE 节点；不传则用当前生效节点
    const n = node || this.activeNode;
    return JSON.stringify({
      chat: { node: n, lang: this.creds.nodeConfig.chatLang },
      semrush: { node: n, lang: this.creds.nodeConfig.semrushLang },
    });
  }

  private buildCookieHeader(token: string, node?: string): string {
    return `GMITM_token=${token}; GMITM_uname=${this.creds.username}; GMITM_config=${this.buildConfigValue(node)}`;
  }

  // D-061：按「优先节点 → 种子节点 → 全集升序」的顺序，挑下一个未尝试且未拉黑的节点
  private selectNode(tried: Set<string>): string | null {
    const ordered: string[] = [];
    const push = (n?: string | null) => { if (n && !ordered.includes(n)) ordered.push(n); };
    push(this.guard.getPreferredNode());
    push(this.creds.nodeConfig.semrushNode);
    for (const n of NODE_UNIVERSE) push(n);
    // 先挑未尝试 + 未拉黑的
    for (const n of ordered) {
      if (!tried.has(n) && !this.guard.isNodeBad(n)) return n;
    }
    // 兜底：未尝试的（即便被拉黑，也比无节点可用强——拉黑可能已恢复）
    for (const n of ordered) {
      if (!tried.has(n)) return n;
    }
    return null;
  }

  private buildHeaders(token: string, includeCookie = true): Record<string, string> {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      "content-type": "application/json; charset=utf-8",
      origin: RPC_ORIGIN,
    };
    if (includeCookie) headers["cookie"] = this.buildCookieHeader(token);
    return headers;
  }

  private extractToken(payload: unknown): string | null {
    if (typeof payload === "object" && payload !== null) {
      if (Array.isArray(payload)) {
        for (const item of payload) {
          const t = this.extractToken(item);
          if (t) return t;
        }
      } else {
        const obj = payload as Record<string, unknown>;
        if (typeof obj.token === "string" && obj.token) return obj.token;
        for (const v of Object.values(obj)) {
          const t = this.extractToken(v);
          if (t) return t;
        }
      }
    }
    return null;
  }

  async login(): Promise<string> {
    const cached = this.guard.getCachedSession(this.creds.username);
    if (cached) {
      this.token = cached.token;
      this.cookies = { ...cached.cookies };
      console.log("[SemRush] 复用缓存会话，跳过登录");
      return cached.token;
    }

    // BUG-04 A：内存未命中 → 尝试复用持久化会话（跨重启同一 token = 同一台设备），
    // 命中则不发起新登录，从根上避免重启造成的设备堆积。
    const persisted = await this.guard.loadPersistedSession(this.creds.username);
    if (persisted) {
      this.token = persisted.token;
      this.cookies = { ...persisted.cookies };
      console.log("[SemRush] BUG-04 A：复用持久化会话（跨重启同一设备），跳过登录");
      return persisted.token;
    }

    // SEM-单设备（修正版）：走到这里说明内存/持久化均无可复用会话，即将全新登录、新建一台设备。
    //   先登出上一台旧设备（忽略本地 TTL，旧 token 对应的在线设备可能仍占名额），再建新设备，
    //   保证账号任一时刻只占 1 台，根治 30 分钟 TTL 到期反复登录累积僵尸 → "设备数超限"。
    await this.guard.logoutPreviousDeviceBeforeRelogin();

    const releaseLogin = await this.guard.waitForSlot();
    const ts = Date.now();
    const url = `${LOGIN_URL}?username=${encodeURIComponent(this.creds.username)}&password=${encodeURIComponent(this.creds.password)}&ts=${ts}`;
    let res: CurlResponse;
    try {
      res = await curlFetch(url, {
        headers: { "user-agent": USER_AGENT, origin: LOGIN_ORIGIN },
        timeoutMs: 20000,
      });
    } finally {
      releaseLogin();
    }
    if (res.status >= 400) {
      if (res.status === 401 || res.status === 403) {
        throw new Error("3UE 登录失败：用户名或密码错误，请在管理后台检查 SemRush 配置");
      }
      throw new Error(`3UE 登录失败（HTTP ${res.status}），请稍后再试或联系管理员`);
    }
    Object.assign(this.cookies, res.cookies);
    const payload = JSON.parse(res.body);
    const token = this.extractToken(payload);
    if (!token) throw new Error(`登录成功但未找到 token`);
    this.token = token;
    this.cookies["GMITM_token"] = token;
    this.cookies["GMITM_uname"] = this.creds.username;
    this.cookies["GMITM_config"] = this.buildConfigValue();

    const releaseWarmup = await this.guard.waitForSlot();
    try {
      const cookieStr = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      const pageRes = await curlFetch("https://sem.3ue.co/analytics/overview/", {
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          cookie: cookieStr,
        },
        followRedirects: true,
        timeoutMs: 15000,
      });
      Object.assign(this.cookies, pageRes.cookies);
    } catch {
      // 页面访问失败不阻塞流程
    } finally {
      releaseWarmup();
    }

    this.guard.setCachedSession(this.creds.username, token, this.cookies);
    console.log("[SemRush] 登录成功，会话已缓存");
    return token;
  }

  private async rpc(
    payload: unknown,
    retryCount = 0,
    sessionRefreshed = false,
    emptyBodyRetryCount = 0,
    triedNodes: Set<string> = new Set(),
    deviceLimitRetryCount = 0,
  ): Promise<unknown> {
    const MAX_RPC_RETRIES = 2;
    // D-038c-v2 I5：空 body 指数退避（与 session 失效解耦）
    const MAX_EMPTY_BODY_RETRIES = 3;
    const EMPTY_BODY_BACKOFF_MS = [1000, 2000, 4000];
    if (!this.token) await this.login();

    // ── D-061：选定本次请求使用的节点 ──
    // 若当前生效节点已被拉黑/已尝试过，切换到下一个候选节点。
    if (this.guard.isNodeBad(this.activeNode) || triedNodes.has(this.activeNode)) {
      const pref = this.guard.getPreferredNode();
      const next = pref && !triedNodes.has(pref) ? pref : this.selectNode(triedNodes);
      if (next) this.activeNode = next;
    } else {
      // 进程内已发现更优的可用节点时优先复用
      const pref = this.guard.getPreferredNode();
      if (pref && !triedNodes.has(pref) && !this.guard.isNodeBad(pref)) this.activeNode = pref;
    }
    const node = this.activeNode;
    triedNodes.add(node);

    const releaseRpc = await this.guard.waitForSlot();
    // 以选定节点构造 cookie（覆盖 GMITM_config 的 node 字段，token 跨节点通用）
    const cookieStr = Object.entries({ ...this.cookies, GMITM_config: this.buildConfigValue(node) })
      .map(([k, v]) => `${k}=${v}`).join("; ");
    let res: CurlResponse;
    try {
      res = await curlFetch(RPC_URL, {
        method: "POST",
        headers: {
          "user-agent": USER_AGENT,
          "content-type": "application/json; charset=utf-8",
          origin: RPC_ORIGIN,
          referer: "https://sem.3ue.co/analytics/overview/",
          accept: "application/json, text/plain, */*",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          cookie: cookieStr,
        },
        body: JSON.stringify(payload),
        timeoutMs: 30000,
      });
    } finally {
      // D-087：网络请求结束立即释放串行槽位（成功/失败都释放），
      // 后续的响应解析/递归重试是纯本地逻辑，递归调用会重新 acquire。
      releaseRpc();
    }

    // ── D-061/D-087：3UE 302 跳 gmitm.redirect.dash → 区分三类原因分别处理 ──
    // 真因：配置节点宕机 / 套餐不支持 / 账号设备并发超限。旧逻辑把后者也当节点宕机，
    // 逐个切节点（每切=换出口IP=再开一台设备→越切越糟）并把健康节点全拉黑，导致持续"全不可用"。
    if (res.status >= 300 && res.status < 400 && res.location && /gmitm\.redirect/i.test(res.location)) {
      let msg = res.location;
      try { msg = decodeURIComponent(res.location); } catch { /* 保留原文 */ }
      const cleanMsg = msg.replace(/^https?:\/\/[^?]*\?msg=/, "").slice(0, 100);

      // ① 设备并发超限：账号级、与节点无关 → 不拉黑、不切节点，原地退避后重试同一节点
      if (DEVICE_LIMIT_RE.test(msg)) {
        if (deviceLimitRetryCount < MAX_DEVICE_LIMIT_RETRIES) {
          const wait = DEVICE_LIMIT_BACKOFF_MS[deviceLimitRetryCount] ?? 8000;
          console.warn(
            `[SemRush] 账号同时在线设备数超限（节点 ${node}，与节点无关），退避 ${wait}ms 后原地重试 ` +
              `(${deviceLimitRetryCount + 1}/${MAX_DEVICE_LIMIT_RETRIES})。3UE: ${cleanMsg}`,
          );
          await new Promise((r) => setTimeout(r, wait));
          // 不切节点、不加入 triedNodes、不拉黑：纯退避重试，靠并发=1 自然让其它会话先释放
          return this.rpc(payload, retryCount, sessionRefreshed, emptyBodyRetryCount, triedNodes, deviceLimitRetryCount + 1);
        }
        throw new Error(
          "SemRush 账号当前同时在线设备数已达上限（并发查询过多）。系统已自动排队退避重试仍超限，" +
            "请减少同时进行的广告生成/竞品查询后稍后再试。",
        );
      }

      // ② 套餐不支持该节点（长拉黑） / ③ 节点宕机（短拉黑）→ 切换其它节点
      const forbidden = /套餐|无法使用该节点|升级/i.test(msg);
      this.guard.markNodeBad(node, forbidden ? NODE_FORBIDDEN_TTL_MS : NODE_DOWN_TTL_MS);
      const next = this.selectNode(triedNodes);
      console.warn(
        `[SemRush] 节点 ${node} 不可用（${forbidden ? "套餐不支持" : "节点宕机"}），` +
          `${next ? `切换到节点 ${next} 重试` : "已无其它候选节点"}。3UE: ${cleanMsg}`,
      );
      if (next) {
        this.activeNode = next;
        return this.rpc(payload, retryCount, sessionRefreshed, emptyBodyRetryCount, triedNodes, deviceLimitRetryCount);
      }
      throw new Error("3UE 所有节点当前均不可用，请稍后重试；若持续如此请在管理后台更换 3UE 账号或升级套餐");
    }

    if (res.status >= 400) {
      if (res.status === 401 || res.status === 403) {
        this.guard.invalidateSession();
      }
      const statusMessages: Record<number, string> = {
        401: "3UE 账户认证失败，请检查用户名和密码是否正确",
        403: "3UE 账户访问被拒绝，可能是账户已过期或 API Key 无效，请联系管理员检查 SemRush 配置",
        429: "3UE 请求过于频繁，请稍后再试（系统已自动限流，建议等待几分钟后重试）",
        500: "3UE 服务器内部错误，请稍后再试",
        502: "3UE 服务暂时不可用，请稍后再试",
        503: "3UE 服务暂时不可用，请稍后再试",
      };
      throw new Error(statusMessages[res.status] || `3UE 服务请求失败 (HTTP ${res.status})，请稍后再试`);
    }

    let body = res.body.trim();

    // 如果 body 以 HTTP/ 开头，说明 curlFetch 解析时包含了嵌套的响应头（100 Continue 残留）
    if (body.startsWith("HTTP/")) {
      const innerSep = body.indexOf("\r\n\r\n");
      const innerSep2 = body.indexOf("\n\n");
      const sep = innerSep >= 0 ? innerSep : innerSep2;
      const sepLen = innerSep >= 0 ? 4 : 2;
      if (sep > 0) {
        body = body.slice(sep + sepLen).trim();
      }
    }

    // 如果 body 以 < 开头，说明返回了 HTML（可能是会话过期被重定向到登录页）
    if (body.startsWith("<") && !sessionRefreshed) {
      console.warn("[SemRush] RPC 返回 HTML 而非 JSON，会话可能已过期，刷新会话后重试");
      this.guard.invalidateSession();
      this.token = null;
      await this.login();
      return this.rpc(payload, 0, true);
    }

    if (!body) {
      // D-038c-v2 I5：空 body **不等于** session 失效（HTML 才是真信号）。
      // 3UE 服务端间歇性抽风经常返回空 body，与登录态无关；强制 relogin 反而浪费 1 次配额。
      // 正确策略：指数退避 1s→2s→4s 重试 3 次（带 20% jitter，不动 session）。
      if (emptyBodyRetryCount < MAX_EMPTY_BODY_RETRIES) {
        const base = EMPTY_BODY_BACKOFF_MS[emptyBodyRetryCount] ?? 4000;
        const jitter = Math.floor(Math.random() * base * 0.2);
        const wait = base + jitter;
        console.warn(
          `[SemRush] RPC 返回空 body (${emptyBodyRetryCount + 1}/${MAX_EMPTY_BODY_RETRIES})，` +
            `${wait}ms 后退避重试（保持 session，session_refreshed=${sessionRefreshed}）`,
        );
        await new Promise((r) => setTimeout(r, wait));
        return this.rpc(payload, retryCount, sessionRefreshed, emptyBodyRetryCount + 1);
      }
      console.error(
        `[SemRush] RPC 空 body 已重试 ${MAX_EMPTY_BODY_RETRIES} 次仍失败，3UE 服务端可能抽风`,
      );
      throw new Error("3UE 服务暂时不可用（RPC 多次空响应），请稍后重试");
    }

    try {
      const parsed = JSON.parse(body);
      // D-061：本次请求节点可用 → 记为进程内优先节点；若与种子节点不同（发生过故障转移），
      // 持久化到 semrush_node（= NODE_CONFIG_KEY，与 health-cron 同一真相源），使进程重启后直接复用，
      // 不再撞已宕机的种子节点。ARCH-01 T0b：旧注释误写 semrush_active_node（已废弃的孤儿 key），此处更正。
      if (this.guard.getPreferredNode() !== node) {
        this.guard.setPreferredNode(node);
        if (this.creds.nodeConfig.semrushNode !== node) {
          console.log(`[SemRush] 命中可用节点 ${node}（种子=${this.creds.nodeConfig.semrushNode}），持久化 semrush_node`);
          void setSystemConfig(NODE_CONFIG_KEY, node, "SemRush 当前可用 3UE 节点（D-061 自动故障转移写回）");
        }
      }
      return parsed;
    } catch (parseErr) {
      const safePreview = body.slice(0, 200).replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

      if (!sessionRefreshed && retryCount === 0) {
        console.warn(`[SemRush] JSON 解析失败，刷新会话后重试。body 前200字符: ${safePreview}`);
        this.guard.invalidateSession();
        this.token = null;
        await this.login();
        return this.rpc(payload, 0, true);
      }

      if (retryCount < MAX_RPC_RETRIES) {
        const wait = (retryCount + 1) * 3000 + Math.floor(Math.random() * 2000);
        console.warn(`[SemRush] JSON 解析失败 (${retryCount + 1}/${MAX_RPC_RETRIES})，${wait}ms 后重试。body 前200字符: ${safePreview}`);
        await new Promise((r) => setTimeout(r, wait));
        return this.rpc(payload, retryCount + 1, sessionRefreshed);
      }
      const preview = body.slice(0, 300).replace(/[\x00-\x1f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
      console.error(`[SemRush] JSON 解析最终失败 (已重试${MAX_RPC_RETRIES}次)。body 前300字符: ${preview}`);
      throw new Error("3UE 服务返回了不完整的数据，请稍后重试");
    }
  }

  async getRatesDate(domain: string): Promise<string> {
    const payload = [
      { id: 1, jsonrpc: "2.0", method: "user.Databases", params: { userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey } },
      { id: 2, jsonrpc: "2.0", method: "adwords.SnapshotDates", params: { database: this.creds.database, userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey } },
      { id: 3, jsonrpc: "2.0", method: "currency.Rates", params: { date: Date.now(), userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey } },
    ];
    const response = (await this.rpc(payload)) as any[];
    return String(response[1]?.result?.daily?.[0] || "");
  }

  async getReportToken(domain: string): Promise<string> {
    const payload = {
      id: 11, jsonrpc: "2.0", method: "token.Get",
      params: {
        reportType: "adwords.copies", database: this.creds.database,
        date: Date.now(), dateType: "daily", searchItem: domain,
        page: 1, pageSize: 100,
        userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey,
      },
    };
    const response = (await this.rpc(payload)) as any;
    return String(response?.result?.token || "");
  }

  async keywords(domain: string, limit = 100): Promise<SemRushKeyword[]> {
    const payload = {
      id: 13, jsonrpc: "2.0", method: "organic.PositionsOverview",
      params: {
        request_id: crypto.randomUUID(), report: "domain.overview",
        args: { database: this.creds.database, dateType: "daily", dateFormat: "date", searchItem: domain, searchType: "domain", positionsType: "all" },
        userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey,
      },
    };
    const response = (await this.rpc(payload)) as any;
    const rows = response?.result || [];
    return rows.slice(0, limit).map((r: any) => parseKeywordRow(r));
  }

  async adsOverview(domain: string, limit = 10): Promise<{ title: string; description: string }[]> {
    const payload = {
      id: 14, jsonrpc: "2.0", method: "adwords.PositionsOverview",
      params: {
        request_id: crypto.randomUUID(), report: "domain.overview",
        args: { database: this.creds.database, dateType: "daily", dateFormat: "date", searchItem: domain, searchType: "domain", positionsType: "all" },
        userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey,
      },
    };
    const response = (await this.rpc(payload)) as any;
    const rows = response?.result || [];
    return rows.slice(0, limit).map((r: any) => ({ title: r.title || "", description: r.description || "" }));
  }

  async copies(domain: string, reportToken: string, limit = 100): Promise<{ date: string; total: number; samples: { title: string; description: string }[] }> {
    const dateStr = normalizeReportDate(await this.getRatesDate(domain));
    const payload = [
      {
        id: 5, jsonrpc: "2.0", method: "adwords.Copies",
        params: {
          token: reportToken, database: this.creds.database, searchItem: domain, searchType: "domain",
          date: dateStr, dateType: "daily", filter: {},
          display: { order: { field: "copy_positions", direction: "desc" }, page: 1, pageSize: 100 },
          userId: parseInt(this.creds.userId),
        },
      },
      {
        id: 6, jsonrpc: "2.0", method: "adwords.CopiesTotal",
        params: {
          token: reportToken, database: this.creds.database, searchItem: domain, searchType: "domain",
          date: dateStr, dateType: "daily", filter: {},
          display: { order: { field: "copy_positions", direction: "desc" }, page: 1, pageSize: 100 },
          userId: parseInt(this.creds.userId),
        },
      },
    ];
    const response = (await this.rpc(payload)) as any[];
    const rows = response[0]?.result || [];
    const total = response[1]?.result || 0;
    const samples = rows.slice(0, limit).map((r: any) => ({ title: r.title || "", description: r.description || "" }));
    return { date: dateStr, total, samples };
  }

  /** 一站式查询：关键词 + 竞品广告标题/描述（去重）。自动使用缓存和限流。 */
  async queryDomain(domainOrUrl: string): Promise<SemRushResult> {
    const domain = normalizeDomain(domainOrUrl);
    if (!domain) throw new Error("无效的域名");

    const cacheKey = `${domain}:${this.creds.database}`;
    const cached = this.guard.getCachedDomain(cacheKey);
    if (cached) {
      console.log(`[SemRush] 命中缓存: ${domain} (db=${this.creds.database}, ${cached.keywords.length} 关键词)`);
      return cached;
    }

    // BUG-04 C：整条查询（login + 全部 rpc + copies）外层占一次独占槽，内部 waitForSlot 走重入
    // no-op，保证一条 queryDomain = 一个连续会话，且全进程任一时刻仅一条查询在飞（真串行=1）。
    return this.guard.withExclusive(async () => {
    // SEM-单设备（修正版）：复用同一台长会话设备，不再每查一次就重登。真正的单设备 = 一台
    //   长期复用的会话；只有当会话 TTL 到期/失效需要重建时，才在 login() 内部「先登出旧设备
    //   再建新设备」（见 login()）。此前"每查一次登出→重登"反而每查新建一台设备，3UE 登出有
    //   延迟 → 同账号瞬间多台并存 → 设备数超限，方向错误，已撤销。
    console.log(`[SemRush] 开始查询: ${domain} (db=${this.creds.database})（队列状态: ${JSON.stringify(this.guard.getStats())}）`);
    await this.login();

    // 批量 RPC：keywords + adsOverview + reportToken + ratesDate 合并为一次请求
    const batchPayload = [
      {
        id: 13, jsonrpc: "2.0", method: "organic.PositionsOverview",
        params: {
          request_id: crypto.randomUUID(), report: "domain.overview",
          args: { database: this.creds.database, dateType: "daily", dateFormat: "date", searchItem: domain, searchType: "domain", positionsType: "all" },
          userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey,
        },
      },
      {
        id: 14, jsonrpc: "2.0", method: "adwords.PositionsOverview",
        params: {
          request_id: crypto.randomUUID(), report: "domain.overview",
          args: { database: this.creds.database, dateType: "daily", dateFormat: "date", searchItem: domain, searchType: "domain", positionsType: "all" },
          userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey,
        },
      },
      {
        id: 11, jsonrpc: "2.0", method: "token.Get",
        params: {
          reportType: "adwords.copies", database: this.creds.database,
          date: Date.now(), dateType: "daily", searchItem: domain,
          page: 1, pageSize: 100,
          userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey,
        },
      },
      { id: 1, jsonrpc: "2.0", method: "user.Databases", params: { userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey } },
      { id: 2, jsonrpc: "2.0", method: "adwords.SnapshotDates", params: { database: this.creds.database, userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey } },
      { id: 3, jsonrpc: "2.0", method: "currency.Rates", params: { date: Date.now(), userId: parseInt(this.creds.userId), apiKey: this.creds.apiKey } },
    ];

    const batchResponse = (await this.rpc(batchPayload)) as any[];
    const byId = new Map(batchResponse.map((r: any) => [r.id, r]));

    const kwRows = byId.get(13)?.result || [];
    const kws = kwRows.slice(0, 100).map((r: any) => parseKeywordRow(r));
    console.log(`[SemRush] 获取 ${kws.length} 个关键词 for ${domain}`);

    const adsRows = byId.get(14)?.result || [];
    const ads = adsRows.slice(0, 20).map((r: any) => ({ title: r.title || "", description: r.description || "" }));
    const paidKws = adsRows
      .slice(0, 50)
      .map((r: any) => parseKeywordRow(r))
      .filter((kw: SemRushKeyword) => kw.phrase);

    const reportToken = String(byId.get(11)?.result?.token || "");
    const dateStr = normalizeReportDate(String(byId.get(2)?.result?.daily?.[0] || ""));

    let copiesData: { date: string; total: number; samples: { title: string; description: string }[] } = { date: "", total: 0, samples: [] };
    if (reportToken && dateStr) {
      try {
        const copiesPayload = [
          {
            id: 5, jsonrpc: "2.0", method: "adwords.Copies",
            params: {
              token: reportToken, database: this.creds.database, searchItem: domain, searchType: "domain",
              date: dateStr, dateType: "daily", filter: {},
              display: { order: { field: "copy_positions", direction: "desc" }, page: 1, pageSize: 100 },
              userId: parseInt(this.creds.userId),
            },
          },
          {
            id: 6, jsonrpc: "2.0", method: "adwords.CopiesTotal",
            params: {
              token: reportToken, database: this.creds.database, searchItem: domain, searchType: "domain",
              date: dateStr, dateType: "daily", filter: {},
              display: { order: { field: "copy_positions", direction: "desc" }, page: 1, pageSize: 100 },
              userId: parseInt(this.creds.userId),
            },
          },
        ];
        const copiesResp = (await this.rpc(copiesPayload)) as any[];
        const rows = copiesResp[0]?.result || [];
        const total = copiesResp[1]?.result || 0;
        copiesData = { date: dateStr, total, samples: rows.slice(0, 100).map((r: any) => ({ title: r.title || "", description: r.description || "" })) };
      } catch (err) {
        console.warn("[SemRush] copies 查询失败，使用 ads_overview 数据:", err);
      }
    }

    const creativeSamples = selectCreativeSamples(ads, copiesData.samples);
    const titlePool = creativeSamples.filter((s) => s.title).map((s) => s.title);
    const descPool = creativeSamples.filter((s) => s.description).map((s) => s.description);

    const result: SemRushResult = {
      domain,
      keywords: kws,
      paidKeywords: paidKws,
      adsOverview: ads,
      copies: copiesData,
      creativeSamples,
      dedupedTitles: dedupeAdTitles(titlePool),
      dedupedDescriptions: dedupeAdDescriptions(descPool),
    };

    this.guard.setCachedDomain(cacheKey, result);
    console.log(`[SemRush] 查询完成: ${domain} (db=${this.creds.database}, ${kws.length} 关键词, ${ads.length} 广告)`);
    return result;
    }); // BUG-04 C：withExclusive 结束
  }

  /** 获取缓存统计信息（聚合所有账号 guard） */
  static getGuardStats() {
    const all = [...guardByAccount.values()];
    if (all.length === 0) return { cacheSize: 0, queueLength: 0, hasSession: false, preferredNode: null, badNodes: [] as string[], accounts: 0 };
    return all.reduce(
      (acc, g) => {
        const s = g.getStats();
        acc.cacheSize += s.cacheSize;
        acc.queueLength += s.queueLength;
        acc.hasSession = acc.hasSession || s.hasSession;
        return acc;
      },
      { cacheSize: 0, queueLength: 0, hasSession: false, preferredNode: null as string | null, badNodes: [] as string[], accounts: all.length },
    );
  }
}
