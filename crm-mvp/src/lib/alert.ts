/**
 * 外部告警通道（批次4）：站内 notifications 之外的主动推送。
 *
 * 现状问题：所有异常只写 notifications 表，没人登录就没人知道。本模块把关键告警
 * 推到飞书群机器人（webhook），让「代理到期 / 同步失败 / 提交失败」第一时间可见。
 *
 * 配置：服务器 .env 增加 FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
 * 未配置时静默降级（只留 console 日志），绝不影响主流程；发送失败同样只记日志。
 *
 * 用法：
 *   await sendAlert({ level: "error", title: "每日同步失败", content: "..." });
 *   // 或不 await（fire-and-forget）：void sendAlert(...)
 */

const LEVEL_LABEL: Record<AlertLevel, string> = {
  info: "ℹ️ 提示",
  warning: "⚠️ 警告",
  error: "🔴 故障",
};

export type AlertLevel = "info" | "warning" | "error";

export interface AlertInput {
  level: AlertLevel;
  title: string;
  content?: string;
  /** 来源模块标识，如 "daily-sync" / "submit-runner"，帮助群里快速定位 */
  source?: string;
}

/** 进程内去重：同一 title 在窗口期内只发一次，防止 cron 重复刷屏 */
const recentSent = new Map<string, number>();
const DEDUPE_WINDOW_MS = 60 * 60_000; // 1 小时

function shouldSend(title: string): boolean {
  const now = Date.now();
  const last = recentSent.get(title) ?? 0;
  if (now - last < DEDUPE_WINDOW_MS) return false;
  recentSent.set(title, now);
  // 防止 Map 无界增长
  if (recentSent.size > 500) {
    for (const [k, t] of recentSent) {
      if (now - t > DEDUPE_WINDOW_MS) recentSent.delete(k);
    }
  }
  return true;
}

/**
 * 发送一条告警到飞书群。永不抛异常；未配置 webhook 或发送失败仅记 console。
 * 同一 title 1 小时内只发一次（进程内去重）。
 */
export async function sendAlert(input: AlertInput): Promise<boolean> {
  const webhook = (process.env.FEISHU_WEBHOOK_URL || "").trim();
  if (!webhook) return false;
  if (!shouldSend(input.title)) return false;

  const lines = [
    `${LEVEL_LABEL[input.level]}【CRM】${input.title}`,
    ...(input.content ? [input.content] : []),
    ...(input.source ? [`来源: ${input.source}`] : []),
    `时间: ${new Date(Date.now() + 8 * 3600_000).toISOString().replace("T", " ").slice(0, 19)} (UTC+8)`,
  ];

  try {
    const resp = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text: lines.join("\n") } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) {
      console.warn(`[Alert] 飞书 webhook 返回 ${resp.status}`);
      return false;
    }
    const body = (await resp.json().catch(() => null)) as { code?: number; msg?: string } | null;
    if (body && body.code !== 0) {
      console.warn(`[Alert] 飞书 webhook 业务失败 code=${body.code} msg=${body.msg}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[Alert] 飞书 webhook 发送异常（忽略）: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}
