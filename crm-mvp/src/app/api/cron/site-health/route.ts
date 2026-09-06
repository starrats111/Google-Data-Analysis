import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getSystemConfig, setSystemConfig } from "@/lib/system-config";
import { sendAlert } from "@/lib/alert";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

/**
 * D-320 站点公网可达性巡检
 *
 * 立项背景（D-319 事故）：发布链路只管把文件 SSH 写到服务器，从不检查目标站在公网上还活不活着。
 * 同一根因在 2026-09 那次事故里犯了三回——
 *   ① universehive.shop 域名 08-07 过期，yz03 一路发到 08-30，三周里发的文章没一篇能访问；
 *   ② widescope.site 域名已被注册局删除，yz01 09-04 当天还在往上发，系统照样显示「发布成功」；
 *   ③ 旧站群机报废，没有任何告警，靠 07 发现「发布不了」才知道。
 *
 * 触发：每日 09:20 CST（crontab `20 9 * * *`；本机时区是 CST，cron 按本地时间算）
 *
 * 判定：首页 200 **且** 随机取一篇已发布文章页 200，两者都通才算健康。
 *   只看首页不够——事故中出现过「首页 200、文章全 404」（骨架在但内容丢了）。
 *   站上一篇文章都没有时只看首页。
 *
 * 连续失败计数存在 system_configs 的 `site_health_state`（JSON），避免为此加表字段。
 * 连续 2 天不通才置灰（verified=0，站点选择器里自动变灰不可选）+ 通知，
 * 单次失败只累计不动作——防 Cloudflare 抖动、服务器重启这类瞬态误伤。
 * 恢复后若当初是本巡检置灰的，自动把 verified 改回 1。
 *
 * 参数：?dry=1 只检测不写库不通知；?only=<域名包含串> 只查匹配的站
 */

const STATE_KEY = "site_health_state";
const FAIL_THRESHOLD = 2; // 连续几次不通才置灰
const TIMEOUT_MS = 20_000;

interface SiteState {
  fails: number;
  last_ok?: string;
  last_fail?: string;
  last_reason?: string;
  /** 是否由本巡检置灰——只有自己置的灰才自动恢复，避免覆盖人工判断 */
  greyed_by_health?: boolean;
}

function verifyCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

function log(msg: string) {
  console.error(`[CRON site-health ${new Date().toISOString()}] ${msg}`);
}

async function probe(url: string): Promise<{ ok: boolean; code: number; err?: string }> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { ok: res.status === 200, code: res.status };
  } catch (e) {
    return { ok: false, code: 0, err: e instanceof Error ? e.message.slice(0, 120) : String(e) };
  }
}

export async function GET(req: NextRequest) {
  if (!verifyCron(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const only = (url.searchParams.get("only") || "").trim().toLowerCase();
  const startedAt = Date.now();

  let sites = await prisma.publish_sites.findMany({
    where: { is_deleted: 0, status: "active" },
    select: { id: true, domain: true, site_name: true, verified: true },
    orderBy: { id: "asc" },
  });
  if (only) sites = sites.filter((s) => s.domain.toLowerCase().includes(only));

  const stateRaw = await getSystemConfig(STATE_KEY);
  let state: Record<string, SiteState> = {};
  try {
    state = stateRaw ? JSON.parse(stateRaw) : {};
  } catch {
    log("site_health_state 解析失败，按空状态重来");
  }

  const results: Array<{ domain: string; ok: boolean; home: number; article: number | null; fails: number; action: string }> = [];
  const newlyDown: Array<{ id: bigint; domain: string; reason: string }> = [];
  const recovered: string[] = [];

  for (const site of sites) {
    const prev: SiteState = state[site.domain] ?? { fails: 0 };

    const home = await probe(`https://${site.domain}/`);
    let article: { ok: boolean; code: number; err?: string } | null = null;
    if (home.ok) {
      // 随机取一篇已发布文章，验证内容层也在
      const [art] = await prisma.$queryRawUnsafe<Array<{ published_url: string }>>(
        `SELECT published_url FROM articles
         WHERE publish_site_id = ? AND is_deleted = 0 AND status = 'published'
           AND published_url IS NOT NULL AND published_url <> ''
         ORDER BY RAND() LIMIT 1`,
        site.id,
      );
      if (art?.published_url) article = await probe(art.published_url);
    }

    const ok = home.ok && (article === null || article.ok);
    const reason = !home.ok
      ? `首页不可访问（HTTP ${home.code}${home.err ? " " + home.err : ""}）`
      : article && !article.ok
        ? `文章页不可访问（HTTP ${article.code}${article.err ? " " + article.err : ""}）`
        : "";

    let action = "正常";
    if (ok) {
      // 恢复：清零计数；若当初是本巡检置的灰，自动恢复
      if (prev.fails > 0) action = `恢复（此前连续失败 ${prev.fails} 次）`;
      if (prev.greyed_by_health && Number(site.verified) === 0) {
        if (!dry) {
          await prisma.publish_sites.update({ where: { id: site.id }, data: { verified: 1 } });
        }
        action = "恢复并解除置灰";
        recovered.push(site.domain);
      }
      state[site.domain] = { fails: 0, last_ok: new Date().toISOString() };
    } else {
      const fails = (prev.fails ?? 0) + 1;
      state[site.domain] = {
        fails,
        last_ok: prev.last_ok,
        last_fail: new Date().toISOString(),
        last_reason: reason,
        greyed_by_health: prev.greyed_by_health,
      };
      action = `不通（累计 ${fails} 次）`;
      if (fails >= FAIL_THRESHOLD && Number(site.verified) === 1) {
        if (!dry) {
          await prisma.publish_sites.update({ where: { id: site.id }, data: { verified: 0 } });
        }
        state[site.domain].greyed_by_health = true;
        action = `连续 ${fails} 次不通 → 已置灰`;
        newlyDown.push({ id: site.id, domain: site.domain, reason });
      }
    }

    results.push({
      domain: site.domain,
      ok,
      home: home.code,
      article: article ? article.code : null,
      fails: state[site.domain].fails,
      action,
    });
    log(`${site.domain}: ${action}${reason ? " — " + reason : ""}`);
  }

  // ─── 通知：站点没有归属人字段，按「谁在用这个站」反查相关人 ───
  let notifsCreated = 0;
  if (!dry && newlyDown.length > 0) {
    for (const down of newlyDown) {
      // ① 该站绑定的联盟账号归属人  ② 最近 30 天在该站发过文的人
      const owners = await prisma.$queryRawUnsafe<Array<{ user_id: bigint; username: string; leader_id: bigint | null }>>(
        `SELECT DISTINCT u.id AS user_id, u.username, t.leader_id
         FROM users u
         LEFT JOIN teams t ON t.id = u.team_id AND t.is_deleted = 0
         WHERE u.is_deleted = 0 AND u.id IN (
           SELECT pc.user_id FROM platform_connections pc
             WHERE pc.publish_site_id = ? AND pc.is_deleted = 0
           UNION
           SELECT a.user_id FROM articles a
             WHERE a.publish_site_id = ? AND a.is_deleted = 0 AND a.status = 'published'
               AND a.published_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         )`,
        down.id, down.id,
      );

      const title = `站点打不开：${down.domain}`;
      const content = [
        `站点 ${down.domain} 连续 ${FAIL_THRESHOLD} 天公网无法访问。`,
        `原因：${down.reason}`,
        `已自动置灰，发布页的站点下拉里暂时选不到它，避免文章发进黑洞。`,
        `常见原因：域名过期未续、DNS 被改、服务器宕机。请先确认域名状态和解析。`,
      ].join("\n");

      const targets = new Map<string, bigint>();
      for (const o of owners) targets.set(o.user_id.toString(), o.user_id);
      for (const o of owners) if (o.leader_id) targets.set(o.leader_id.toString(), o.leader_id);

      for (const uid of targets.values()) {
        const dup = await prisma.notifications.count({
          where: { user_id: uid, type: "alert", title, is_deleted: 0, created_at: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
        });
        if (dup > 0) continue;
        await prisma.notifications.create({
          data: {
            user_id: uid,
            type: "alert",
            title,
            content,
            metadata: JSON.stringify({ source: "D-320 site-health", domain: down.domain, reason: down.reason }),
          },
        });
        notifsCreated++;
      }
    }

    await sendAlert({
      level: "error",
      source: "site-health",
      title: `站点公网不可达：${newlyDown.length} 个`,
      content: newlyDown.map((d) => `${d.domain} — ${d.reason}`).join("\n") + "\n已自动置灰，站内已通知相关人。",
    });
  }

  if (!dry) {
    await setSystemConfig(STATE_KEY, JSON.stringify(state), "D-320 站点可达性巡检的连续失败计数");
  }

  const down = results.filter((r) => !r.ok);
  return NextResponse.json({
    ok: true,
    dry,
    checked: results.length,
    healthy: results.length - down.length,
    down: down.length,
    newly_greyed: newlyDown.map((d) => d.domain),
    recovered,
    notifications_created: notifsCreated,
    elapsed_ms: Date.now() - startedAt,
    results: down.length ? down : results.slice(0, 5),
  });
}
