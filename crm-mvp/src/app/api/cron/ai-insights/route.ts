/**
 * GET /api/cron/ai-insights
 *
 * 每日 AI 数据洞察生成（历史报告 Tab 的数据源）
 *
 * - 每日 07:00（北京时间）为每个活跃用户生成「前一天」的 daily 洞察，落库 ai_insights
 * - 每周一额外生成上一周的 weekly 洞察；每月 1 号额外生成上个月的 monthly 洞察
 * - 幂等：同 user+date+type 已存在即跳过，crontab 可安排多次触发接力补齐
 * - 串行逐用户生成（低配服务器，避免并发打爆 AI/DB），单次运行有软时限，
 *   超时未处理的用户由同日下一次 cron 触发接力
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import timezone from "dayjs/plugin/timezone";
import {
  getInsightAiConfig,
  getUserActivePersona,
  buildInsightSystemPrompt,
  prefetchInsightData,
  generateInsightContent,
} from "@/lib/ai-insight";

dayjs.extend(utc);
dayjs.extend(timezone);

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TZ = "Asia/Shanghai";
/** 单次运行软时限（毫秒）：超过后不再开始新用户，剩余交给下一次触发 */
const SOFT_DEADLINE_MS = 250_000;

/** 简单进程内锁：防止上一轮未结束时重复执行 */
let running = false;

function log(msg: string) {
  console.error(`[cron/ai-insights ${new Date().toISOString()}] ${msg}`);
}

interface InsightTask {
  type: "daily" | "weekly" | "monthly";
  /** 落库的 insight_date（该周期的代表日：daily=当天，weekly=周一，monthly=月初1号） */
  insightDate: string;
  dateFrom: string;
  dateTo: string;
  /** 每日趋势的取数起点（daily 报告给 7 天趋势做上下文） */
  trendFrom: string;
  label: string;
}

/** 根据今天（CST）决定本轮要生成哪些周期的洞察 */
function buildTasks(now = dayjs().tz(TZ)): InsightTask[] {
  const tasks: InsightTask[] = [];
  const yesterday = now.subtract(1, "day");
  const yStr = yesterday.format("YYYY-MM-DD");

  tasks.push({
    type: "daily",
    insightDate: yStr,
    dateFrom: yStr,
    dateTo: yStr,
    trendFrom: yesterday.subtract(6, "day").format("YYYY-MM-DD"),
    label: `每日洞察 ${yStr}`,
  });

  // 周一：生成上一周（周一~周日）
  if (now.day() === 1) {
    const lastMonday = now.subtract(7, "day");
    const lastSunday = now.subtract(1, "day");
    tasks.push({
      type: "weekly",
      insightDate: lastMonday.format("YYYY-MM-DD"),
      dateFrom: lastMonday.format("YYYY-MM-DD"),
      dateTo: lastSunday.format("YYYY-MM-DD"),
      trendFrom: lastMonday.format("YYYY-MM-DD"),
      label: `每周洞察 ${lastMonday.format("YYYY-MM-DD")}~${lastSunday.format("YYYY-MM-DD")}`,
    });
  }

  // 每月 1 号：生成上个月
  if (now.date() === 1) {
    const firstOfLastMonth = now.subtract(1, "month").startOf("month");
    const endOfLastMonth = firstOfLastMonth.endOf("month");
    tasks.push({
      type: "monthly",
      insightDate: firstOfLastMonth.format("YYYY-MM-DD"),
      dateFrom: firstOfLastMonth.format("YYYY-MM-DD"),
      dateTo: endOfLastMonth.format("YYYY-MM-DD"),
      trendFrom: firstOfLastMonth.format("YYYY-MM-DD"),
      label: `每月洞察 ${firstOfLastMonth.format("YYYY-MM")}`,
    });
  }

  return tasks;
}

const ANALYSIS_ASK: Record<InsightTask["type"], string> = {
  daily: "这是每日自动洞察。请基于以上真实数据分析昨日表现（趋势数据含近7天做对比参照）：账户总览、异常与亮点、系列 ROI 诊断，并给出最多 3 条今天就能执行的优化建议。篇幅控制在中等长度，突出变化与行动项。",
  weekly: "这是每周自动洞察。请基于以上真实数据复盘上一周：整体盈亏、系列表现分层、平台收入结构、周内趋势拐点，并给出本周的 3 条优化重点。",
  monthly: "这是每月自动洞察。请基于以上真实数据复盘上个月：整体 ROI 与净利润、表现最好/最差的系列群组、平台收入与拒付结构、月内趋势，并给出下月的 3 条策略级建议。",
};

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (running) {
    log("上一轮仍在执行，本轮跳过");
    return NextResponse.json({ skipped: true, reason: "already running" });
  }
  running = true;
  const startedAt = Date.now();

  try {
    const aiConfig = await getInsightAiConfig();
    const tasks = buildTasks();
    const todayStr = dayjs().tz(TZ).format("YYYY-MM-DD");

    const users = await prisma.users.findMany({
      where: { is_deleted: 0, status: "active" },
      select: { id: true, username: true },
      orderBy: { id: "asc" },
    });

    let generated = 0, skippedExisting = 0, skippedNoData = 0, failed = 0, deferred = 0;

    for (const task of tasks) {
      const insightDateCol = new Date(`${task.insightDate}T00:00:00.000Z`);

      // 幂等：一次查出该周期已生成的用户
      const existing = await prisma.ai_insights.findMany({
        where: { insight_date: insightDateCol, insight_type: task.type, is_deleted: 0 },
        select: { user_id: true },
      });
      const doneUsers = new Set(existing.map((r) => String(r.user_id)));

      for (const u of users) {
        if (doneUsers.has(String(u.id))) { skippedExisting++; continue; }
        if (Date.now() - startedAt > SOFT_DEADLINE_MS) { deferred++; continue; }

        try {
          const { dataParts, nonEmpty, overview } = await prefetchInsightData(
            u.id, task.dateFrom, task.dateTo, task.trendFrom,
          );
          // 账户总览无数据（无系列或该时段无消耗无佣金）→ 不生成空报告
          if (nonEmpty === 0 || !overview) { skippedNoData++; continue; }

          const persona = await getUserActivePersona(u.id);
          const systemPrompt = buildInsightSystemPrompt(persona, todayStr);
          const userMsg =
            `分析时间范围：${task.dateFrom} 至 ${task.dateTo}\n\n` +
            `【已为你预取的真实数据（JSON）】\n${dataParts.join("\n\n")}\n\n` +
            `【分析要求】\n${ANALYSIS_ASK[task.type]}`;

          const content = await generateInsightContent(aiConfig, systemPrompt, userMsg);

          await prisma.ai_insights.upsert({
            where: {
              user_id_insight_date_insight_type: {
                user_id: u.id,
                insight_date: insightDateCol,
                insight_type: task.type,
              },
            },
            create: {
              user_id: u.id,
              insight_date: insightDateCol,
              insight_type: task.type,
              content,
              metrics_snapshot: overview as object,
            },
            update: { content, metrics_snapshot: overview as object, is_deleted: 0 },
          });
          generated++;
          log(`${task.label} user=${u.username} 生成成功 (${content.length} 字)`);
        } catch (e) {
          failed++;
          log(`${task.label} user=${u.username} 生成失败: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    const summary = { generated, skippedExisting, skippedNoData, failed, deferred, tasks: tasks.map((t) => t.label), elapsed_s: Math.round((Date.now() - startedAt) / 1000) };
    log(`本轮完成: ${JSON.stringify(summary)}`);
    return NextResponse.json(summary);
  } catch (e) {
    log(`执行异常: ${e instanceof Error ? e.message : e}`);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  } finally {
    running = false;
  }
}
