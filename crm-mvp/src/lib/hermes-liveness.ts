import prisma from "@/lib/prisma";

/**
 * D-362：Hermes「状态主权」托管门的活性判据。
 *
 * 起因（01 反馈 2026-09-26）：wj07 在数据中心点暂停，弹「该系列由 Hermes 智能投放体托管，
 * 状态主权归 Hermes」，可 Hermes 的投放侧从 2026-09-21 15:43 起就不跑了。四条 ENABLED 的
 * 系列（kixies / estarcase / fosiaudio / lauriesportecpa）谁都停不了：Hermes 不在，CRM 被
 * D-247 拦着，钱照烧。
 *
 * D-247 的门是 `campaigns.hermes_managed_at IS NOT NULL` —— 一个只写一次、永不清除的单向闩，
 * 而 CRM 侧从来没有任何「Hermes 还活着吗」的判据。托管关系一旦建立就是永久的，哪怕对面已经
 * 死了五天。全库 1062 条挂着这个闩。
 *
 * 这里补的就是那个缺失的判据：主权只在 Hermes 还在行使时有效。
 *
 * 心跳来源刻意选 /api/hermes/campaign-state（Hermes 改完名/预算/CPC/状态后的回推），
 * 不是「任何 /api/hermes/* 请求」——因为只读汇报类任务（campaign-stats 每小时、
 * policy-verdicts / merchant-intelligence 每天）在投放侧停摆后仍然照跑。9-21 之后它们一次
 * 没断过，拿它们当心跳等于永远判活，正好复现今天这个故障。
 *
 * 窗口默认 24 小时，出处：Hermes 活着时 campaign-state 是 10 次/天（9-21 当天 10 次，
 * 之前几天同量级），整整一个日历日无推送已远在正常波动之外。敏感度：调到 6 小时能更快解锁，
 * 但夜间本来就可能连续几小时无变更，会误判成死；调到 48 小时则留出两天停不下来的花费。
 * 要改不必改代码：system_configs.hermes_gate_stale_hours，或 env HERMES_GATE_STALE_HOURS。
 */

const HEARTBEAT_KEY = "hermes_status_pipeline_last_seen";
const WINDOW_KEY = "hermes_gate_stale_hours";
const DEFAULT_STALE_HOURS = 24;

/** 判活结果在一次 cron 里会被问很多遍，缓存 60 秒，避免每条系列两次查库 */
let cache: { at: number; gate: HermesGate } | null = null;
const CACHE_MS = 60_000;

export type HermesGate = {
  /** true = Hermes 仍在行使状态主权，CRM 不写状态 */
  alive: boolean;
  /** 最近一次被判定为「Hermes 在管状态」的时刻 */
  lastSeenAt: Date | null;
  /** 判死阈值（小时） */
  staleHours: number;
  /** 已静默多久（小时，一位小数）；从未见过 Hermes 时为 null */
  silentHours: number | null;
  /** heartbeat = D-362 心跳键；fallback = 退回 campaigns.hermes_managed_at 最大值；none = 从没见过 */
  source: "heartbeat" | "fallback" | "none";
};

/**
 * Hermes 回推状态时打一次心跳。
 *
 * 刻意写在「无论有没有字段变化」之外：push-crm-state 那边是按指纹过滤后才发请求，
 * 所以只要这个请求到了，就说明 Hermes 的投放侧活着。
 * 失败只记日志不抛——心跳挂了不该让 Hermes 的回推失败。
 */
export async function recordHermesStatusHeartbeat(): Promise<void> {
  try {
    const now = new Date().toISOString();
    await prisma.system_configs.upsert({
      where: { config_key: HEARTBEAT_KEY },
      create: {
        config_key: HEARTBEAT_KEY,
        config_value: now,
        description: "D-362：Hermes 状态主权心跳（每次 /api/hermes/campaign-state 回推刷新）",
      },
      update: { config_value: now, is_deleted: 0 },
    });
    cache = null;
  } catch (err) {
    console.error("[HermesLiveness] 心跳写入失败（不阻塞回推）:", err);
  }
}

async function readStaleHours(): Promise<number> {
  const fromEnv = Number(process.env.HERMES_GATE_STALE_HOURS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.min(Math.max(fromEnv, 1), 168);
  try {
    const row = await prisma.system_configs.findFirst({
      where: { config_key: WINDOW_KEY, is_deleted: 0 },
      select: { config_value: true },
    });
    const n = Number(row?.config_value);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.max(n, 1), 168);
  } catch {
    // 读配置失败就用默认值，不影响判活
  }
  return DEFAULT_STALE_HOURS;
}

export async function getHermesStatusGate(): Promise<HermesGate> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.gate;

  const staleHours = await readStaleHours();
  let lastSeenAt: Date | null = null;
  let source: HermesGate["source"] = "none";

  try {
    const hb = await prisma.system_configs.findFirst({
      where: { config_key: HEARTBEAT_KEY, is_deleted: 0 },
      select: { config_value: true, updated_at: true },
    });
    if (hb) {
      const parsed = hb.config_value ? new Date(hb.config_value) : null;
      lastSeenAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : hb.updated_at;
      source = "heartbeat";
    }
  } catch (err) {
    console.error("[HermesLiveness] 读心跳失败:", err);
  }

  // 心跳键还不存在（本条上线前 Hermes 从没打过卡）时的兜底：
  // campaigns.hermes_managed_at 的最大值 —— 那是 Hermes 真实写库留下的时间戳。
  // 它只在「Hermes 首次推到某条新系列」时前进，所以偏保守（可能把活着的判成静默）；
  // 代价只是 CRM 抢着暂停一条 Hermes 随后会复活的广告，方向上是安全的那一侧。
  if (!lastSeenAt) {
    try {
      const agg = await prisma.campaigns.aggregate({
        where: { hermes_managed_at: { not: null }, is_deleted: 0 },
        _max: { hermes_managed_at: true },
      });
      if (agg._max.hermes_managed_at) {
        lastSeenAt = agg._max.hermes_managed_at;
        source = "fallback";
      }
    } catch (err) {
      console.error("[HermesLiveness] 读 hermes_managed_at 兜底失败:", err);
    }
  }

  const gate = decideHermesGate(lastSeenAt, staleHours, source);
  cache = { at: Date.now(), gate };
  return gate;
}

/**
 * 判活本身（纯函数，与库解耦，便于单测）。
 *
 * 「从没见过 Hermes」判死而不是判活：托管闩是 Hermes 自己写上的，
 * 连一次心跳都没有却拦着人停广告，是这条故障的原形。
 */
export function decideHermesGate(
  lastSeenAt: Date | null,
  staleHours: number,
  source: HermesGate["source"],
  now: Date = new Date(),
): HermesGate {
  const silentHours = lastSeenAt
    ? Math.round(((now.getTime() - lastSeenAt.getTime()) / 3_600_000) * 10) / 10
    : null;
  return {
    alive: silentHours !== null && silentHours < staleHours,
    lastSeenAt,
    staleHours,
    silentHours,
    source,
  };
}

/**
 * 固定按东八区显示。不能用 getHours() 那一套本机时区取值：DB 里的 DATETIME 存的是 UTC
 * （实证：同一次回推 nginx 记 21/Sep 15:43，campaigns.hermes_managed_at 是 07:43，差 8 小时），
 * 本机时区一变，这条「凭什么判死」的证据就会偏 8 小时，比不给还糟
 */
const fmt = (d: Date | null): string => {
  if (!d) return "从未";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d);
  return `${parts} (北京时间)`;
};

/** Hermes 判活时的拒绝文案（沿用 D-247 原文，补上「凭什么说它活着」） */
export function hermesAliveMessage(gate: HermesGate, scope: "toggle" | "apply"): string {
  const proof = `Hermes 最近一次回推状态是 ${fmt(gate.lastSeenAt)}（${gate.silentHours} 小时前，判死阈值 ${gate.staleHours} 小时），它还在管。`;
  return scope === "toggle"
    ? `该系列由 Hermes 智能投放体托管，状态主权归 Hermes：CRM 不能启用/暂停它，请通过飞书让 Hermes 处理（它的止损与复活会自动管理投放状态）。${proof}`
    : `该系列由 Hermes 托管，状态主权归 Hermes：CRM 不执行暂停，请通过飞书让 Hermes 处理。${proof}`;
}

/** Hermes 判死、CRM 接管时附在成功响应后面的说明 */
export function hermesTakeoverNote(gate: HermesGate): string {
  return `（Hermes 已静默 ${gate.silentHours} 小时，上次回推 ${fmt(gate.lastSeenAt)}，超过 ${gate.staleHours} 小时阈值，状态主权已按 D-362 回到 CRM）`;
}
