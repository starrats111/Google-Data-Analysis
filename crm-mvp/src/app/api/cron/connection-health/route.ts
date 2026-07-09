import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * D-026 每日 API 连接健康巡检
 *
 * 触发：每日 09:00 CST（cron `0 1 * * *` 服务器时间为 UTC，09:00 CST = 01:00 UTC）
 *
 * 任务：
 *   1. 扫所有 `platform_connections WHERE is_deleted=0`
 *   2. 筛出"异常"连接：status='error' OR last_synced_at < NOW() - 24h
 *   3. 为每个异常连接写一条 notifications（type='alert'）给所属用户
 *   4. 如所属用户有 leader（is_leader=0 + leader_user_id 关联），同时给 leader 发一条
 *
 * 07 决策：仅站内 notifications（不发邮件/WhatsApp）
 *
 * 输出：JSON 报告（scanned / unhealthy / notifications_created）
 */

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.error(`[CRON connection-health ${new Date().toISOString()}] ${msg}`);
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = new Date();
  log("开始 API 连接健康巡检...");

  // 24 小时前的时间点
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);

  // D-033: 只扫「确认异常」的连接，排除新增/瞬态失败的干扰
  //   - status='error'：已达 3 次连续失败阈值，确认异常
  //   - 从未同步 但 created_at > 6h 前 且 consecutive_failures >= 1：加了之后一直没验证通过
  //   - last_synced_at 过期 且 consecutive_failures >= 1：曾成功但现在连续出错
  //   排除：刚加的新连接（created_at < 6h）和 0 次失败的待验证连接（可能 API 有数据但 0 条交易）
  type RawConnRow = {
    id: bigint;
    user_id: bigint;
    platform: string;
    account_name: string;
    status: string;
    last_synced_at: Date | null;
    last_error: string | null;
    consecutive_failures: bigint | number;
    username: string;
    leader_id: bigint | null;
  };
  const sixHoursAgo = new Date(Date.now() - 6 * 3600 * 1000);
  const rawRows: RawConnRow[] = await prisma.$queryRawUnsafe(`
    SELECT pc.id, pc.user_id, pc.platform, pc.account_name, pc.status,
           pc.last_synced_at, pc.last_error, pc.consecutive_failures,
           u.username, t.leader_id
    FROM platform_connections pc
    JOIN users u ON u.id = pc.user_id
    LEFT JOIN teams t ON t.id = u.team_id AND t.is_deleted = 0
    WHERE pc.is_deleted = 0
      AND pc.api_key IS NOT NULL
      AND (
        pc.status = 'error'
        OR (pc.last_synced_at IS NULL AND pc.created_at < ? AND pc.consecutive_failures >= 1)
        OR (pc.last_synced_at < ? AND pc.consecutive_failures >= 1)
      )
    ORDER BY pc.user_id, pc.platform
  `, sixHoursAgo, cutoff);

  // raw query 的 unsigned int / bigint 字段统一 normalize（防 JSON.stringify TypeError）
  const rawConns = rawRows.map((r) => ({
    id: typeof r.id === "bigint" ? r.id : BigInt(r.id as unknown as string),
    user_id: typeof r.user_id === "bigint" ? r.user_id : BigInt(r.user_id as unknown as string),
    platform: r.platform,
    account_name: r.account_name,
    status: r.status,
    last_synced_at: r.last_synced_at,
    last_error: r.last_error,
    consecutive_failures: Number(r.consecutive_failures ?? 0),
    username: r.username,
    leader_id: r.leader_id == null ? null : (typeof r.leader_id === "bigint" ? r.leader_id : BigInt(r.leader_id as unknown as string)),
  }));

  log(`扫描完成：异常连接 ${rawConns.length} 条`);

  let notifsCreated = 0;
  const userIdsAlerted = new Set<string>();
  const leaderAggregate = new Map<string, string[]>(); // leader_user_id -> [conn label, ...]

  for (const c of rawConns) {
    const ageHours = c.last_synced_at
      ? Math.floor((Date.now() - c.last_synced_at.getTime()) / 3600000)
      : -1; // -1 = 从未同步
    const ageText = ageHours < 0 ? "从未成功同步" : `${ageHours} 小时未成功同步`;
    const label = `${c.platform} ${c.account_name}`;

    const title = c.status === "error"
      ? `平台连接异常：${label}`
      : `平台连接长时间未同步：${label}`;

    const content = [
      `平台账号：${label}`,
      `连接状态：${c.status}`,
      `${ageText}`,
      c.last_error ? `最近错误：${c.last_error}` : "",
      c.consecutive_failures > 0 ? `连续失败次数：${c.consecutive_failures}` : "",
      `请到「设置 → 联盟平台连接」点击「测试连接」并重新配置 API Key。`,
    ].filter(Boolean).join("\n");

    // 给所属用户发通知（避免短窗口重复通知：同一用户同一连接 24h 内只发一条）
    const recentDup = await prisma.notifications.count({
      where: {
        user_id: c.user_id,
        type: "alert",
        title,
        created_at: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
        is_deleted: 0,
      },
    });
    if (recentDup === 0) {
      // 防 BigInt 序列化：所有 BigInt 字段都 toString
      const metadata = JSON.stringify({
        source: "D-026 connection-health",
        conn_id: c.id.toString(),
        platform: c.platform,
        account_name: c.account_name,
        status: c.status,
        last_synced_at: c.last_synced_at?.toISOString() ?? null,
        consecutive_failures: Number(c.consecutive_failures ?? 0),
      }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      await prisma.notifications.create({
        data: {
          user_id: c.user_id,
          type: "alert",
          title,
          content,
          metadata,
        },
      });
      notifsCreated++;
      userIdsAlerted.add(c.user_id.toString());
    }

    // 同时聚合给 leader（避免 leader 收到太多条，每个 leader 只发一条聚合通知）
    // 跳过 leader 自己的连接（避免自己收两条）
    if (c.leader_id && c.leader_id !== c.user_id) {
      const key = c.leader_id.toString();
      const arr = leaderAggregate.get(key) ?? [];
      arr.push(`${c.username} - ${label}`);
      leaderAggregate.set(key, arr);
    }
  }

  // 给 leader 发聚合通知（每个 leader 一条，列出所有组员异常连接）
  for (const [leaderIdStr, items] of leaderAggregate.entries()) {
    const leaderId = BigInt(leaderIdStr);
    const recentDup = await prisma.notifications.count({
      where: {
        user_id: leaderId,
        type: "alert",
        title: { startsWith: "[组长视角] 组员平台连接异常" },
        created_at: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
        is_deleted: 0,
      },
    });
    if (recentDup === 0) {
      await prisma.notifications.create({
        data: {
          user_id: leaderId,
          type: "alert",
          title: `[组长视角] 组员平台连接异常 ${items.length} 条`,
          content: [
            `检测到 ${items.length} 条异常连接：`,
            ...items.slice(0, 20).map((s) => `  • ${s}`),
            items.length > 20 ? `  ...另外 ${items.length - 20} 条` : "",
            "",
            "请提醒相关组员前往「设置 → 联盟平台连接」重新配置 API Key。",
          ].filter(Boolean).join("\n"),
          metadata: JSON.stringify({ source: "D-026 connection-health leader aggregate", count: items.length }),
        },
      });
      notifsCreated++;
    }
  }

  const elapsed = Date.now() - startedAt.getTime();
  const result = {
    ok: true,
    scanned: rawConns.length,
    unhealthy: rawConns.length,
    notifications_created: notifsCreated,
    users_alerted: userIdsAlerted.size,
    leaders_alerted: leaderAggregate.size,
    elapsed_ms: elapsed,
  };
  if (notifsCreated > 0) {
    const { sendAlert } = await import("@/lib/alert");
    void sendAlert({
      level: "warning",
      title: "联盟平台连接异常",
      content: `本轮发现 ${rawConns.length} 条异常连接（涉及 ${userIdsAlerted.size} 个用户），已写站内通知。请相关用户到「设置 → 联盟平台连接」重新配置。`,
      source: "cron/connection-health",
    });
  }
  log(`完成：${JSON.stringify(result)}`);
  // 防止 raw query 返回的 BigInt 字段污染（用 replacer 把所有 BigInt 转字符串）
  const safeBody = JSON.parse(JSON.stringify(result, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
  return NextResponse.json(safeBody);
}
