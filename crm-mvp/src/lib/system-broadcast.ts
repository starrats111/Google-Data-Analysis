/**
 * D-266 批四：全员弹窗通知（07 批复 #6，2026-08-21）
 *
 * MCC 级重大危险事件（Sheet 被封 / 表格结构未识别 / 统一脚本停更疑似被更换等）
 * 必须让全员第一时间知道——只写飞书群没人看、只进铃铛没人点。
 * 本模块把事件广播成全员 notifications 行（metadata.popup=true），
 * 前端 UserLayout 轮询到即弹阻断式弹窗；正在建广告的用户延迟到离开创建流程后再弹。
 *
 * 去重：同 key 24 小时内只广播一次（查库判定，跨进程/重启有效——
 * today-cost 每 30 分钟一轮，进程内去重挡不住 PM2 重启）。
 */
import prisma from "@/lib/prisma";
import { sendAlert, type AlertLevel } from "@/lib/alert";

export interface BroadcastInput {
  /** 去重键，如 sheet_blocked_218-718-2682 */
  key: string;
  title: string;
  content: string;
  level?: AlertLevel;
}

const DEDUPE_HOURS = 24;

/**
 * 向全体在职用户广播一条弹窗级告警（同时推飞书群）。
 * 返回 true=本次真正广播了；false=去重窗口内已有同 key 广播，跳过。
 * 永不抛异常（告警系统不能反过来弄坏业务主流程）。
 */
export async function broadcastCriticalAlert(input: BroadcastInput): Promise<boolean> {
  try {
    const since = new Date(Date.now() - DEDUPE_HOURS * 3600_000);
    const dup = await prisma.notifications.findFirst({
      where: {
        type: "alert",
        created_at: { gte: since },
        metadata: { contains: `"key":"${input.key}"` },
      },
      select: { id: true },
    });
    if (dup) return false;

    const users = await prisma.users.findMany({
      where: { is_deleted: 0, status: "active" },
      select: { id: true },
    });
    if (users.length === 0) return false;

    const metadata = JSON.stringify({ popup: true, key: input.key, level: input.level || "error" });
    await prisma.notifications.createMany({
      data: users.map((u) => ({
        user_id: u.id,
        type: "alert",
        title: input.title,
        content: input.content,
        metadata,
      })),
    });

    void sendAlert({
      level: input.level || "error",
      title: input.title,
      content: input.content,
      source: "system-broadcast",
    });
    console.log(`[SystemBroadcast] 已广播 ${users.length} 人: ${input.key} ${input.title}`);
    return true;
  } catch (e) {
    console.error(`[SystemBroadcast] 广播失败（不影响主流程）: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * Sheet 同步失败消息分类 → 广播（today-cost 每 30 分钟接线调用）。
 * 只对「确定的危险态」广播：权限不足（被封）/ 结构未识别；
 * 网络超时等瞬态失败不广播（质量闸：不确定 ≠ 危险，防狼来了）。
 */
export async function broadcastSheetFailure(
  mccId: string,
  mccName: string | null,
  message: string,
): Promise<void> {
  const label = mccName ? `${mccName}（${mccId}）` : mccId;
  if (message.includes("权限不足")) {
    await broadcastCriticalAlert({
      key: `sheet_blocked_${mccId}`,
      title: `MCC ${label} 的 Google Sheet 无法访问（疑似被封）`,
      content: `CRM 拉取该 MCC 的数据表时被拒绝（权限不足/403）。花费、点击、状态同步已中断，广告仍在 Google 侧继续投放烧钱。请立即：① 检查该 Sheet 是否被 Google 封禁或分享权限被改；② 若被封，参照 D-239/D-253 流程处理并评估是否止损。`,
    });
  } else if (message.includes("未识别的表格结构")) {
    await broadcastCriticalAlert({
      key: `sheet_structure_${mccId}`,
      title: `MCC ${label} 的数据表结构未识别`,
      content: `该 MCC 的 Google Sheet 既不是 CRM 格式也不是 kyads 格式，可能是统一脚本被更换/未正确安装。该 MCC 的花费与状态同步已中断。请到设置页重新生成统一脚本并粘贴到该 MCC 的 Google Ads Scripts。`,
    });
  }
}

/**
 * 统一脚本停更检测（daily-sync 每日一次）：DailyData 最新日期落后于昨天
 * → 脚本超过一整天没跑（被停用/被更换/持续报错）。
 * Sheet 拉不到 / 无 DailyData tab 的不在这里报（被封与结构问题由 broadcastSheetFailure 负责）。
 */
export async function checkSheetScriptFreshness(log: (msg: string) => void): Promise<void> {
  const { extractSheetId, readSheetCsv } = await import("@/lib/sheet-sync");
  const { todayCST } = await import("@/lib/date-utils");

  const yesterday = (() => {
    const d = new Date(`${todayCST()}T00:00:00+08:00`);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0, sheet_url: { not: null } },
    select: { mcc_id: true, mcc_name: true, sheet_url: true },
  });

  let stale = 0;
  for (const mcc of mccs) {
    const sid = extractSheetId(mcc.sheet_url || "");
    if (!sid) continue;
    let rows: string[][];
    try {
      rows = await readSheetCsv(sid, "DailyData");
    } catch {
      continue; // 拉取失败（含被封）→ 由 broadcastSheetFailure 通道负责，不重复报
    }
    if (rows.length < 2) continue;
    const hdr = rows[0].map((h) => h.trim().toLowerCase());
    const di = hdr.indexOf("date");
    if (di < 0) continue; // 结构问题由另一通道负责
    let maxDate = "";
    for (const r of rows.slice(1)) {
      const d = (r[di] || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d > maxDate) maxDate = d;
    }
    if (!maxDate || maxDate >= yesterday) continue;

    stale++;
    const label = mcc.mcc_name ? `${mcc.mcc_name}（${mcc.mcc_id}）` : mcc.mcc_id;
    await broadcastCriticalAlert({
      key: `sheet_stale_${mcc.mcc_id}`,
      title: `MCC ${label} 的统一脚本疑似停更`,
      content: `该 MCC 数据表 DailyData 的最新日期停在 ${maxDate}，已超过一整天没有更新。脚本可能被停用、被更换或持续报错，期间 CRM 看不到该 MCC 的花费与状态变化。请到 Google Ads Scripts 检查脚本运行记录；如脚本丢失请到设置页重新生成粘贴。`,
    });
    log(`  [Freshness] ⚠️ ${label}: DailyData 最新 ${maxDate}，疑似脚本停更`);
  }
  log(`  [Freshness] 检查 ${mccs.length} 个 MCC，停更 ${stale} 个`);
}
