import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * D-026 每日 API 连接健康巡检
 *
 * 触发：每日 09:00 CST（crontab `0 9 * * *`）
 * ⚠️ D-320 校准：本机时区是 CST 不是 UTC，原先写成 `0 1` 的表达式实际每天凌晨 1 点跑，
 *    通知发出去时没人看；2026-09-06 改回 `0 9`。同批 cron 的其余整点任务核对过，时间都是对的。
 *
 * 任务：
 *   1. 扫所有 `platform_connections WHERE is_deleted=0`
 *   2. 筛出"异常"连接：status='error' OR last_synced_at < NOW() - 24h
 *   3. 为每个异常连接写一条 notifications（type='alert'）给所属用户
 *   4. 如所属用户有 leader（is_leader=0 + leader_user_id 关联），同时给 leader 发一条
 *   5. D-323：扫「同一把 api_key 挂在多个用户名下」的串号，通知卷入的用户 + 全体管理员。
 *      这类连接骗得过第 2 步——它 status=connected、失败计数 0、每半小时刷新 last_synced_at，
 *      只是在更新别人的交易行；被占的一方名下 0 条。指纹只能靠 api_key 分组去查。
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

  // ── D-323：同一把 Key 挂在多个用户名下的撞车检测 ──
  //
  // 这是 D-322 那道闸的兜底：闸只拦新建/改 Key，拦不住已经存在的撞车，也拦不住直接改库。
  // 撞车的后果是佣金被静默吞掉——`affiliate_transactions` 的唯一键 (platform, transaction_id)
  // 全局唯一、不含 user_id，两条 sync 路径的 upsert `update` 分支又不改 user_id，
  // 所以**先同步的人占走全部佣金，后绑的人名下永远 0 条**。
  //
  // 上面那套 D-026 巡检一条都发现不了：撞车的连接 status=connected、consecutive_failures=0、
  // last_synced_at 每半小时刷新（它确实在同步，只是在更新别人的行）。2026-09-06 wj02 的
  // RW 佣金被工具账号「佣金查询」占了 9 笔 $27.62，全靠人肉发现。这里按指纹直接扫。
  type CollisionRow = { platform: string; conn_count: bigint | number; who: string; user_ids: string };
  const collisions: CollisionRow[] = await prisma.$queryRawUnsafe(`
    SELECT pc.platform,
           COUNT(*) AS conn_count,
           GROUP_CONCAT(CONCAT(u.username, ' / ', pc.account_name, ' #', pc.id) ORDER BY pc.id SEPARATOR ' | ') AS who,
           GROUP_CONCAT(DISTINCT pc.user_id ORDER BY pc.user_id) AS user_ids
    FROM platform_connections pc
    JOIN users u ON u.id = pc.user_id
    WHERE pc.is_deleted = 0 AND pc.api_key IS NOT NULL AND LENGTH(pc.api_key) > 5
    GROUP BY pc.platform, pc.api_key
    HAVING COUNT(DISTINCT pc.user_id) > 1
  `);

  let collisionNotifs = 0;
  if (collisions.length > 0) {
    log(`⚠ 发现 ${collisions.length} 组跨用户共用 API Key（佣金会被先同步的人占走）`);
    // 通知每一个卷入的用户 + 全体管理员：谁被谁占了，用户自己看不出来，必须点名
    const involvedUserIds = new Set<string>();
    for (const c of collisions) {
      for (const uid of String(c.user_ids).split(",")) {
        if (uid.trim()) involvedUserIds.add(uid.trim());
      }
    }
    const admins = await prisma.users.findMany({
      where: { role: "admin", status: "active", is_deleted: 0 },
      select: { id: true },
    });
    const targets = new Set<string>([
      ...involvedUserIds,
      ...admins.map((a) => a.id.toString()),
    ]);
    const title = `平台连接串号：${collisions.length} 组账号被多人共用`;
    const content = [
      `检测到同一把联盟 API Key 挂在多个用户名下。这种情况下佣金会被**先同步的那个人全部占走**，`,
      `后绑定的人名下一条交易都不会有，而且双方界面都是绿灯、看不出任何异常。`,
      "",
      ...collisions.slice(0, 20).map((c) => `  • ${c.platform}：${c.who}`),
      collisions.length > 20 ? `  ...另外 ${collisions.length - 20} 组` : "",
      "",
      `处理办法：确认这个联盟账号到底归谁，让其他人删除自己那条连接；`,
      `已经落到错误账号下的交易需要人工改判（改 user_id / platform_connection_id / user_merchant_id）。`,
    ].filter(Boolean).join("\n");

    for (const uid of targets) {
      const dup = await prisma.notifications.count({
        where: {
          user_id: BigInt(uid),
          type: "alert",
          title: { startsWith: "平台连接串号" },
          created_at: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
          is_deleted: 0,
        },
      });
      if (dup > 0) continue;
      await prisma.notifications.create({
        data: {
          user_id: BigInt(uid),
          type: "alert",
          title,
          content,
          metadata: JSON.stringify({
            source: "D-323 shared-api-key collision",
            groups: collisions.length,
            detail: collisions.map((c) => ({ platform: c.platform, who: c.who })),
          }),
        },
      });
      collisionNotifs++;
    }
    notifsCreated += collisionNotifs;

    const { sendAlert } = await import("@/lib/alert");
    void sendAlert({
      level: "warning",
      title: "平台连接串号：同一把 API Key 挂了多个用户",
      content: [
        `${collisions.length} 组共用凭据，佣金会被先同步的人占走，被占的一方名下 0 条且界面全绿。`,
        ...collisions.slice(0, 10).map((c) => `${c.platform}：${c.who}`),
      ].join("\n"),
      source: "cron/connection-health",
    });
  }

  const elapsed = Date.now() - startedAt.getTime();
  const result = {
    ok: true,
    scanned: rawConns.length,
    unhealthy: rawConns.length,
    key_collision_groups: collisions.length,
    key_collision_notifications: collisionNotifs,
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
