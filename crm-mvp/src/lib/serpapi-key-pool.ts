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

/** 被判耗尽后多久可以再试。每天只扫一次，这个值只影响同一轮内会不会重复取到废 key */
const COOLDOWN_HOURS = Number(process.env.SERPAPI_KEY_COOLDOWN_HOURS ?? 6);

/** 一次调用最多换几个 key。池子里就 9 个，换到第 4 个还不行基本是全线耗尽 */
export const MAX_KEY_ATTEMPTS = Number(process.env.SERPAPI_MAX_KEY_ATTEMPTS ?? 4);

/** SerpApi 表示「这个 key 不能再用了」的几种说法 */
const QUOTA_PATTERNS = [
  "run out of searches",
  "ran out of searches",
  "exceeded your",
  "hourly throughput",
  "account limit",
  "plan limit",
  "http 429",
];

export function isQuotaError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  const s = msg.toLowerCase();
  return QUOTA_PATTERNS.some((p) => s.includes(p));
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
  const cutoff = new Date(Date.now() - COOLDOWN_HOURS * 3600 * 1000);

  const usable = await prisma.user_serpapi_keys.findMany({
    where: {
      is_active: 1,
      is_deleted: 0,
      OR: [{ exhausted_at: null }, { exhausted_at: { lt: cutoff } }],
    },
    select: { api_key: true },
  });
  const usableKeys = usable.map((r) => r.api_key).filter((k) => k && k.trim());
  if (usableKeys.length > 0) return shuffle(usableKeys);

  const all = await prisma.user_serpapi_keys.findMany({
    where: { is_active: 1, is_deleted: 0 },
    select: { api_key: true },
  });
  const allKeys = all.map((r) => r.api_key).filter((k) => k && k.trim());
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
