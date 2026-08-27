/**
 * D-266 批四 + D-269 修订：MCC 级重大危险定向弹窗通知
 *
 * D-269（07 2026-08-21 拍板）：告警**只发给需要警告的人**（该 MCC 的归属人），
 * 数据隔离——别人的 MCC 出事不弹给无关用户。归属人失效（离职/停用）时
 * 兜底发管理员，保证危险不静默。飞书群通道（sendAlert）不变。
 *
 * 事件（Sheet 被封 / 表格结构未识别 / 统一脚本停更）写成 notifications 行
 * （metadata.popup=true），前端 CriticalAlertGate 轮询到即弹阻断式弹窗；
 * 正在建广告的用户延迟到离开创建流程后再弹。
 *
 * 去重：同 key 窗口内只发一次（查库判定，跨进程/重启有效——
 * today-cost 每 30 分钟一轮，进程内去重挡不住 PM2 重启）。
 */
import prisma from "@/lib/prisma";
import { sendAlert, type AlertLevel } from "@/lib/alert";
import type { SheetIssue } from "@/lib/today-merchants-sheet";

export interface CriticalAlertInput {
  /** 去重键，如 sheet_blocked_218-718-2682 */
  key: string;
  /** 接收人（MCC 归属人）；空数组时自动兜底发管理员 */
  userIds: bigint[];
  title: string;
  content: string;
  level?: AlertLevel;
  /** 去重窗口小时数，默认 24 */
  dedupeHours?: number;
}

const DEDUPE_HOURS = 24;

/**
 * 近期活跃闸门：该 MCC 最近 N 天内在 ads_daily_stats 有数据才算「活着的 MCC 突发危险」。
 * 生产预演（2026-08-21）实测存量里有 14 个 DailyData 停在 4~8 月的废弃 MCC、4 个封了很久的
 * Sheet——这些是陈年旧账不是突发事件，没有闸门会在上线首轮弹 20+ 条风暴且每天重复（狼来了）。
 * 副作用即自愈机制：活跃 MCC 出事 → 连报 ~N 天后数据断流超窗 → 自动停报。
 */
async function mccRecentlyActive(mccInternalId: bigint, days = 7): Promise<boolean> {
  try {
    const rows = await prisma.$queryRaw<Array<{ d: Date | null }>>`
      SELECT MAX(s.date) AS d
      FROM ads_daily_stats s
      JOIN campaigns c ON s.campaign_id = c.id
      WHERE c.mcc_id = ${mccInternalId}`;
    const d = rows[0]?.d;
    if (!d) return false;
    return Date.now() - new Date(d).getTime() < days * 86400_000;
  } catch {
    return false; // 查不到按不活跃处理，宁可漏报废弃 MCC 也不弹风暴
  }
}

/**
 * 解析实际接收人：归属人在职就发归属人；归属人失效或缺失则兜底发全体管理员
 * （危险不能静默，但也绝不群发无关用户——D-269 数据隔离）。
 */
async function resolveRecipients(userIds: bigint[]): Promise<bigint[]> {
  if (userIds.length > 0) {
    const owners = await prisma.users.findMany({
      where: { id: { in: userIds }, is_deleted: 0, status: "active" },
      select: { id: true },
    });
    if (owners.length > 0) return owners.map((u) => u.id);
  }
  const admins = await prisma.users.findMany({
    where: { role: "admin", is_deleted: 0, status: "active" },
    select: { id: true },
  });
  return admins.map((u) => u.id);
}

/**
 * 向指定用户发一条弹窗级告警（同时推飞书群）。
 * 返回 true=本次真正发送了；false=去重窗口内已有同 key 发送，跳过。
 * 永不抛异常（告警系统不能反过来弄坏业务主流程）。
 */
export async function sendCriticalAlert(input: CriticalAlertInput): Promise<boolean> {
  try {
    const since = new Date(Date.now() - (input.dedupeHours ?? DEDUPE_HOURS) * 3600_000);
    const dup = await prisma.notifications.findFirst({
      where: {
        type: "alert",
        created_at: { gte: since },
        metadata: { contains: `"key":"${input.key}"` },
      },
      select: { id: true },
    });
    if (dup) return false;

    const recipients = await resolveRecipients(input.userIds);
    if (recipients.length === 0) return false;

    const metadata = JSON.stringify({ popup: true, key: input.key, level: input.level || "error" });
    await prisma.notifications.createMany({
      data: recipients.map((uid) => ({
        user_id: uid,
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
    console.log(`[SystemBroadcast] 已定向通知 ${recipients.length} 人 (uid=${recipients.join(",")}): ${input.key} ${input.title}`);
    return true;
  } catch (e) {
    console.error(`[SystemBroadcast] 发送失败（不影响主流程）: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/**
 * Sheet 同步失败消息分类 → 定向告警 MCC 归属人（today-cost 每 30 分钟接线调用）。
 * 只对「确定的危险态」告警：权限不足（被封）/ 结构未识别；
 * 网络超时等瞬态失败不告警（质量闸：不确定 ≠ 危险，防狼来了）。
 */
export async function broadcastSheetFailure(
  mccInternalId: bigint,
  mccId: string,
  mccName: string | null,
  message: string,
): Promise<void> {
  const isDanger = message.includes("权限不足") || message.includes("未识别的表格结构");
  if (!isDanger) return;
  // 近期活跃闸门：废弃/久封 MCC 的旧账不弹（详见 mccRecentlyActive 注释）
  if (!(await mccRecentlyActive(mccInternalId))) {
    console.log(`[SystemBroadcast] MCC ${mccId} 同步失败但近 7 天无数据（陈年旧账），不弹窗: ${message.slice(0, 60)}`);
    return;
  }
  // D-269：只通知该 MCC 的归属人
  const mcc = await prisma.google_mcc_accounts.findUnique({
    where: { id: mccInternalId },
    select: { user_id: true },
  });
  const targets = mcc ? [mcc.user_id] : [];
  const label = mccName ? `${mccName}（${mccId}）` : mccId;
  // 去重 7 天：未解决的封禁/结构问题每周提醒一次即可——
  // 24h 会变成每天轰炸（已封 MCC 走 API 应急补数期间数据一直在流，闸门永远放行）
  const WEEKLY = 7 * 24;
  if (message.includes("权限不足")) {
    await sendCriticalAlert({
      key: `sheet_blocked_${mccId}`,
      userIds: targets,
      dedupeHours: WEEKLY,
      title: `你的 MCC ${label} 的 Google Sheet 无法访问（疑似被封）`,
      content: `CRM 拉取该 MCC 的数据表时被拒绝（权限不足/403）。花费、点击、状态同步已中断，广告仍在 Google 侧继续投放烧钱。请立即：① 检查该 Sheet 是否被 Google 封禁或分享权限被改；② 若被封，参照 D-239/D-253 流程处理并评估是否止损。`,
    });
  } else if (message.includes("未识别的表格结构")) {
    await sendCriticalAlert({
      key: `sheet_structure_${mccId}`,
      userIds: targets,
      dedupeHours: WEEKLY,
      title: `你的 MCC ${label} 的数据表结构未识别`,
      content: `该 MCC 的 Google Sheet 既不是 CRM 格式也不是 kyads 格式，可能是统一脚本被更换/未正确安装。该 MCC 的花费与状态同步已中断。请到设置页重新生成统一脚本并粘贴到该 MCC 的 Google Ads Scripts。`,
    });
  }
}

/**
 * D-285 弹窗一：MCC 还在旧版统一脚本（CampaignInfo 无 Budget 列）→ 定向弹窗催归属人换脚本。
 * 近期活跃闸门与其他 MCC 告警一致（废弃 MCC 的旧账不弹）；每周提醒一次；
 * 换上新脚本后检测不再触发，提醒自动停止。today-merchants-sync 每半小时接线调用。
 */
export async function notifyOldScriptMcc(
  mccInternalId: bigint,
  mccId: string,
  mccName: string | null,
  userId: bigint,
): Promise<void> {
  if (!(await mccRecentlyActive(mccInternalId))) return;
  const label = mccName ? `${mccName}（${mccId}）` : mccId;
  await sendCriticalAlert({
    key: `old_script_${mccId}`,
    userIds: [userId],
    dedupeHours: 7 * 24,
    level: "warning",
    title: `你的 MCC ${label} 还在旧版统一脚本，请尽快更换`,
    content: `该 MCC 的数据表 CampaignInfo 缺 Budget 列（旧版脚本），零花费/停投系列的预算无法同步回 CRM，数据中心的预算列会失真（例如实际 ¥13.46 显示成 $0.30）。请到「设置 → MCC 账户」对该 MCC 点「复制脚本」，把新脚本粘贴到 Google Ads 后台替换旧脚本（脚本功能不变，只是多导出预算等列）。换完后预算半小时内自动刷正，此提醒自动消失。`,
  });
}

/**
 * 统一脚本停更检测（daily-sync 每日一次）：DailyData 最新日期落后于昨天
 * → 脚本超过一整天没跑（被停用/被更换/持续报错）。
 * Sheet 拉不到 / 无 DailyData tab 的不在这里报（被封与结构问题由 broadcastSheetFailure 负责）。
 * 只报「近 7 天内死掉的」（maxDate ≥ 今天-8）——停更数月的废弃 MCC 是旧账不弹；
 * 去重键带 maxDate + 8 天窗口 → 一次停更事件全程只告警一次。只发 MCC 归属人（D-269）。
 */
export async function checkSheetScriptFreshness(log: (msg: string) => void): Promise<void> {
  const { extractSheetId, readSheetCsv } = await import("@/lib/sheet-sync");
  const { todayCST } = await import("@/lib/date-utils");

  const dayOffset = (n: number) => {
    const d = new Date(`${todayCST()}T00:00:00+08:00`);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const yesterday = dayOffset(1);
  const recencyFloor = dayOffset(8);

  const mccs = await prisma.google_mcc_accounts.findMany({
    where: { is_deleted: 0, sheet_url: { not: null } },
    select: { mcc_id: true, mcc_name: true, sheet_url: true, user_id: true },
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
    if (maxDate < recencyFloor) continue; // 停更超 8 天的旧账不弹

    stale++;
    const label = mcc.mcc_name ? `${mcc.mcc_name}（${mcc.mcc_id}）` : mcc.mcc_id;
    await sendCriticalAlert({
      key: `sheet_stale_${mcc.mcc_id}_${maxDate}`,
      userIds: [mcc.user_id],
      dedupeHours: 8 * 24,
      title: `你的 MCC ${label} 的统一脚本疑似停更`,
      content: `该 MCC 数据表 DailyData 的最新日期停在 ${maxDate}，已超过一整天没有更新。脚本可能被停用、被更换或持续报错，期间 CRM 看不到该 MCC 的花费与状态变化。请到 Google Ads Scripts 检查脚本运行记录；如脚本丢失请到设置页重新生成粘贴。`,
    });
    log(`  [Freshness] ⚠️ ${label}: DailyData 最新 ${maxDate}，疑似脚本停更（已通知归属人）`);
  }
  log(`  [Freshness] 检查 ${mccs.length} 个 MCC，停更 ${stale} 个`);
}

/**
 * CampaignInfo 读不到 → 定向弹窗催归属人修脚本（today-merchants-sync 每半小时接线调用）。
 *
 * 背景（2026-08-27 全量扫描）：59 个在用 MCC 里 29 个的 CampaignInfo 是坏的，
 * 但 cron 只报得出 14 个——HTTP 200 表头不对（11 个）与空表（4 个）三层告警全哑
 * （不进 errors、hasBudgetCol 为 null 连 D-285 旧脚本弹窗也跳过），
 * 成员只看到「今日投放数」偏小，无从知道是哪个 MCC 掉了（李金娜 2026-08-26 反馈根因）。
 *
 * 口径与同类告警一致：只发 MCC 归属人（D-269 数据隔离）、近期活跃闸门（废弃 MCC 旧账不弹）、
 * 每周提醒一次。脚本修好后检测不再触发，提醒自动停止。
 * PERM_DENIED 复用 broadcastSheetFailure 的 sheet_blocked_ 去重键，同一件事不弹两次。
 */
export async function notifyCampaignInfoIssue(
  mccInternalId: bigint,
  issue: SheetIssue,
): Promise<boolean> {
  if (!(await mccRecentlyActive(mccInternalId))) {
    console.log(`[SystemBroadcast] MCC ${issue.mccId} CampaignInfo 故障(${issue.kind})但近 7 天无数据（废弃 MCC），不弹窗`);
    return false;
  }
  const label = issue.mccName ? `${issue.mccName}（${issue.mccId}）` : issue.mccId;
  const WEEKLY = 7 * 24;
  const tail = `修好前，该 MCC 新上的广告不会计入数据中心的「今日投放数」，其它 MCC 不受影响。`;

  if (issue.kind === "PERM_DENIED") {
    return sendCriticalAlert({
      key: `sheet_blocked_${issue.mccId}`,
      userIds: [BigInt(issue.userId)],
      dedupeHours: WEEKLY,
      title: `你的 MCC ${label} 的 Google Sheet 无法访问（疑似被封）`,
      content: `CRM 拉取该 MCC 的数据表时被拒绝（权限不足/403）。请检查该 Sheet 是否被 Google 封禁，或分享权限是否被改——需设为「知道链接的任何人都可以查看」。${tail}`,
    });
  }
  if (issue.kind === "BAD_URL") {
    return sendCriticalAlert({
      key: `sheet_bad_url_${issue.mccId}`,
      userIds: [BigInt(issue.userId)],
      dedupeHours: WEEKLY,
      title: `你的 MCC ${label} 的表格链接无效`,
      content: `CRM 从该 MCC 配置的 Google Sheet 链接里解析不出表格 ID。请到「设置 → MCC 账户」重新粘贴完整的表格链接。${tail}`,
    });
  }
  if (issue.kind === "EMPTY_SHEET") {
    return sendCriticalAlert({
      key: `campaigninfo_empty_${issue.mccId}`,
      userIds: [BigInt(issue.userId)],
      dedupeHours: WEEKLY,
      level: "warning",
      title: `你的 MCC ${label} 的统一脚本没有产出数据`,
      content: `该 MCC 数据表的 CampaignInfo 只有表头、一条广告系列都没有，说明统一脚本装了但没跑起来（或每次运行都失败）。请到 Google Ads 后台该 MCC 的 Scripts 页面，检查脚本的运行记录与报错，并手动点一次「运行」。${tail}`,
    });
  }
  // MISSING_TAB
  return sendCriticalAlert({
    key: `campaigninfo_missing_${issue.mccId}`,
    userIds: [BigInt(issue.userId)],
    dedupeHours: WEEKLY,
    title: `你的 MCC ${label} 的数据表缺 CampaignInfo`,
    content: `CRM 在该 MCC 的 Google Sheet 里找不到 CampaignInfo 这张表——统一脚本没装、装的是旧版/别的脚本，或脚本从未成功运行过。请到「设置 → MCC 账户」对该 MCC 点「复制脚本」，把脚本粘贴到 Google Ads 后台该 MCC 的 Scripts 里运行一次。${tail}`,
  });
}
