/**
 * D-215 SerpApi 共享 Key 池
 *
 * 原来每处都按 `user_id` 取自己的 key：某个用户额度用完，他关注的广告主当天就全废，
 * 而别人富余的额度一点也调不动。实测 9 个 key 分属 7 个用户，36 个关注的广告主
 * 近 7 天只有 8 个还能扫出数据，大半的空转就是这么来的。
 *
 * 改成全局共享：谁的 key 都进同一个池子，按需取用；被判额度耗尽的 key 记下时间，
 * 冷却窗口内不再取，免得每轮都拿同一个废 key 反复撞墙。
 *
 * 冷却而不是直接封到月底，是因为 SerpApi 的限制有两种——月额度用尽（次月才回）
 * 和每小时吞吐超限（等一会儿就好），报错文案不总能分清，用冷却窗口两种都能自愈。
 */
import prisma from "@/lib/prisma";

/** 短时限流（每小时吞吐超限之类）的冷却时长，等一会儿就能自愈 */
const COOLDOWN_HOURS = Number(process.env.SERPAPI_KEY_COOLDOWN_HOURS ?? 6);

/**
 * 月额度用尽的冷却时长。
 *
 * 池子里全是免费版（250 次/月），月额度打满后 6 小时冷却远远不够——2026-08-24 就是这么翻的车：
 * 9 个 key 前一天下午被判耗尽，第二天早上冷却一过全被当成可用，而 getPoolKeys 是打乱顺序的，
 * 上广告随机抽到废 key 的概率约 90%，抽中就整单报 429。
 *
 * 不直接封到月底，是因为免费版按注册日重置而不是按自然月，算不准；也可能中途充值。
 * 24 小时是折中：一天最多白撞一次，撞完重新计时，额度真回来了当天就能自愈。
 */
const QUOTA_COOLDOWN_HOURS = Number(process.env.SERPAPI_QUOTA_COOLDOWN_HOURS ?? 24);

/** 一次调用最多换几个 key。池子里就 9 个，换到第 4 个还不行基本是全线耗尽 */
export const MAX_KEY_ATTEMPTS = Number(process.env.SERPAPI_MAX_KEY_ATTEMPTS ?? 4);

/** 月额度用尽的说法——等到下个计费周期才回，得长冷却 */
const MONTHLY_QUOTA_PATTERNS = [
  "run out of searches",
  "ran out of searches",
  "exceeded your",
  "account limit",
  "plan limit",
];

/** 短时限流的说法——等一会儿就好。裸 429 归到这类，宁可多试一次也别误封有额度的 key */
const THROTTLE_PATTERNS = ["hourly throughput", "http 429"];

export function isQuotaError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const s = msg.toLowerCase();
  return (
    MONTHLY_QUOTA_PATTERNS.some((p) => s.includes(p)) ||
    THROTTLE_PATTERNS.some((p) => s.includes(p))
  );
}

/** 是否为「月额度用尽」类报错。裸 429 不算——SerpApi 两种限制都回 429，文案才分得清 */
export function isMonthlyQuotaError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const s = msg.toLowerCase();
  return MONTHLY_QUOTA_PATTERNS.some((p) => s.includes(p));
}

function cooldownHoursFor(exhaustedMsg: string | null): number {
  return isMonthlyQuotaError(exhaustedMsg) ? QUOTA_COOLDOWN_HOURS : COOLDOWN_HOURS;
}

function isCooledDown(
  row: { exhausted_at: Date | null; exhausted_msg: string | null },
  now: number,
): boolean {
  if (!row.exhausted_at) return true;
  const hours = cooldownHoursFor(row.exhausted_msg);
  return now - row.exhausted_at.getTime() >= hours * 3600 * 1000;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 取全局可用的 key，已随机打乱。
 *
 * 若所有 key 都在冷却中，退回全量而不是返回空——返回空会让调用方报「请先配置 SerpApi Key」，
 * 那是误导，真实情况是额度打满了，得让调用方拿到 SerpApi 的原话。
 */
export async function getPoolKeys(): Promise<string[]> {
  // 冷却时长按报错类型分档（月额度 vs 短时限流），SQL 表达不了，取回来内存里判——
  // 池子只有十几行，一次全量查比拼 where 更清楚。
  const rows = await prisma.user_serpapi_keys.findMany({
    where: { is_active: 1, is_deleted: 0 },
    select: { api_key: true, exhausted_at: true, exhausted_msg: true },
  });
  const valid = rows.filter((r) => r.api_key && r.api_key.trim());
  const now = Date.now();

  const usableKeys = valid.filter((r) => isCooledDown(r, now)).map((r) => r.api_key);
  if (usableKeys.length > 0) return shuffle(usableKeys);

  const allKeys = valid.map((r) => r.api_key);
  if (allKeys.length > 0) {
    console.warn(`[SerpApiPool] 池内 ${allKeys.length} 个 key 全在冷却中，仍取用以便拿到真实报错`);
  }
  return shuffle(allKeys);
}

/** 从池里取一个还没试过的 key */
export async function pickUntriedKey(tried: Set<string>): Promise<string | null> {
  const keys = await getPoolKeys();
  return keys.find((k) => !tried.has(k)) ?? null;
}

export async function markKeyExhausted(apiKey: string, msg?: string | null): Promise<void> {
  try {
    await prisma.user_serpapi_keys.updateMany({
      where: { api_key: apiKey },
      data: { exhausted_at: new Date(), exhausted_msg: (msg ?? "").slice(0, 255) || null },
    });
  } catch {
    // 记账失败不能影响主流程，最坏结果只是下次还会取到这个 key
  }
}

/** 调用成功说明这个 key 又活了（充值 / 限流过去了），把冷却标记清掉 */
export async function markKeyHealthy(apiKey: string): Promise<void> {
  try {
    await prisma.user_serpapi_keys.updateMany({
      where: { api_key: apiKey, exhausted_at: { not: null } },
      data: { exhausted_at: null, exhausted_msg: null },
    });
  } catch {
    // 同上
  }
}

// ============================================================================
// 池化 HTTP 包装
// ============================================================================

export interface PooledHttpResponse {
  status: number;
  body: string;
}

export type PooledHttpGet = (url: string, timeoutMs: number) => Promise<PooledHttpResponse>;

function isSerpApiUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith("serpapi.com");
  } catch {
    return false;
  }
}

/** 把 URL 上的 api_key 换成指定 key（覆盖而非补齐：SerpApi 回给我们的 details_link 自带旧 key） */
function withKey(url: string, apiKey: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("api_key", apiKey);
    return parsed.toString();
  } catch {
    return url;
  }
}

const defaultFetchGet: PooledHttpGet = async (url, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * 造一个会自动换 key 的 httpGet，给「一次任务要连打几十个 SerpApi 请求」的场景用
 * （品牌评估、上广告取竞品创意）。
 *
 * 为什么包在 HTTP 层而不是每个 fetchXxx 调用点各写一遍：SerpApi 的请求全靠 URL 上的
 * api_key 参数认人，包装层重写这个参数就能覆盖所有引擎调用，连 SerpApi 自己回给我们的
 * `serpapi_details_link` 二次请求也一起管到，调用方零改动。
 *
 * 历史（D-215 的欠账，2026-08-24 补）：轮换当初只做进了 atc-service，品牌评估和上广告
 * 这两条路一直是「取池子里第一个 key 用到底」，撞额度既不换也不标记。池子打乱顺序返回，
 * 于是 10 个 key 里 9 个废掉时，上广告有九成概率随机抽到废 key 直接整单失败。
 *
 * 非 serpapi.com 的地址（如 autocomplete 走 Google 公开接口）原样透传，不碰 key。
 */
export function createPooledSerpApiHttpGet(
  opts: {
    baseHttpGet?: PooledHttpGet;
    /** 调用方已经取好的 key，省一次池子查询；用完了照样按池子换下一个 */
    initialKey?: string | null;
    maxKeyAttempts?: number;
  } = {},
): PooledHttpGet {
  const baseGet = opts.baseHttpGet ?? defaultFetchGet;
  const maxAttempts = opts.maxKeyAttempts ?? MAX_KEY_ATTEMPTS;
  const tried = new Set<string>();
  const healthyMarked = new Set<string>();
  let current = opts.initialKey?.trim() || null;

  return async (url, timeoutMs) => {
    if (!isSerpApiUrl(url)) return baseGet(url, timeoutMs);

    let last: PooledHttpResponse | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (!current) {
        current = await pickUntriedKey(tried);
        if (!current) break;
      }
      const key = current;
      tried.add(key);

      const res = await baseGet(withKey(url, key), timeoutMs);
      last = res;

      const quotaHit =
        res.status >= 400 && isQuotaError(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
      if (!quotaHit) {
        // 只清一次：一次任务几十个请求，没必要每次成功都发一条 UPDATE
        if (!healthyMarked.has(key)) {
          healthyMarked.add(key);
          await markKeyHealthy(key);
        }
        return res;
      }

      await markKeyExhausted(key, `HTTP ${res.status}: ${res.body.slice(0, 200)}`);
      current = await pickUntriedKey(tried);
      if (!current) break;
      // 换 key 属于线上要留痕的异常路径，生产构建的 removeConsole 只留 error/warn
      console.warn(`[SerpApiPool] key 额度耗尽，换用池内下一个（已试 ${tried.size} 个）`);
    }

    return (
      last ?? {
        status: 429,
        body: JSON.stringify({ error: "SerpApi key 池内已无可用额度" }),
      }
    );
  };
}
