/**
 * /api/user/ai-analysis
 *
 * Adrian · 数据猎手 — 实时分析（服务端预取数据注入提示词，流式返回前端）
 * 数据工具 / AI 配置 / 提示词已抽到 @/lib/ai-insight，与每日洞察 cron 共用。
 */
import { NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  getInsightAiConfig,
  getUserActivePersona,
  buildInsightSystemPrompt,
  prefetchInsightData,
  type AiConfig,
} from "@/lib/ai-insight";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// ──────────────────────────────────────────────
// POST /api/user/ai-analysis
// Body: { date_from, date_to, question? }
// Returns: SSE stream (text/event-stream)
// ──────────────────────────────────────────────
export async function POST(req: NextRequest) {
  // 鉴权
  const userPayload = getUserFromRequest(req);
  if (!userPayload) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  const userId = BigInt(userPayload.userId);

  let body: { date_from?: string; date_to?: string; question?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const { date_from, date_to, question } = body;
  if (!date_from || !date_to) {
    return new Response(JSON.stringify({ error: "缺少日期参数" }), { status: 400 });
  }

  const baseContext = `分析时间范围：${date_from} 至 ${date_to}`;

  // 获取 AI 配置（严格使用控制台配置，不兜底）
  let aiConfig: AiConfig;
  try {
    aiConfig = await getInsightAiConfig();
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }

  // 当前日期（服务端取，避免 AI 误判年份）
  const todayStr = new Date().toISOString().slice(0, 10);

  // 读取用户激活人设
  const activePersona = await getUserActivePersona(userId);
  const systemPrompt = buildInsightSystemPrompt(activePersona, todayStr);

  // SSE 流：服务端预取数据 + 单轮（含截断续写）生成报告，不依赖模型 function calling。
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (event: string, data: string) => {
        if (closed) return;
        controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      // SSE 心跳：等待 AI 期间持续发注释行（以 ":" 开头，前端解析时忽略），
      // 防止 Cloudflare/Nginx 因长时间无字节把连接判为空闲而 reset（即前端看到的 network error）。
      const beat = () => { if (!closed) { try { controller.enqueue(enc.encode(`: keepalive ${Date.now()}\n\n`)); } catch { /* ignore */ } } };

      try {
        // ── 1) 服务端预取真实数据（替代模型工具调用）──
        send("status", `${activePersona.name} 正在读取账户数据...`);
        const { dataParts, nonEmpty } = await prefetchInsightData(
          userId, date_from, date_to, undefined,
          (title) => send("tool", `读取${title}...`),
        );

        if (nonEmpty === 0) {
          send("content", "该时段暂无数据，请确认数据同步状态后重试。");
          send("done", "无数据");
          closed = true; controller.close();
          return;
        }

        const dataContext = `${baseContext}\n\n【已为你预取的真实数据（JSON）】\n${dataParts.join("\n\n")}`;
        const finalUserMsg = question?.trim()
          ? `${dataContext}\n\n【分析要求】\n${question.trim()}`
          : `${dataContext}\n\n【分析要求】\n请基于以上真实数据进行全面分析：账户总览、各系列 ROI 诊断、联盟平台收入、每日趋势，并给出 3 条可执行的优化建议。`;

        const messages: Array<{ role: string; content: string }> = [
          { role: "system", content: systemPrompt },
          { role: "user", content: finalUserMsg },
        ];

        // ── 2) 单轮生成报告（token 截断时续写）──
        const base = aiConfig.baseUrl.replace(/\/+$/, "").replace(/\/v1\/messages$/, "").replace(/\/v1$/, "");
        const apiUrl = `${base}/v1/chat/completions`;
        const MAX_ROUNDS = 6;
        for (let round = 1; round <= MAX_ROUNDS; round++) {
          send("status", round === 1 ? `${activePersona.name} 正在分析...` : "内容较长，继续生成...");

          const hb = setInterval(beat, 12000);
          let res: Response;
          try {
            res = await fetch(apiUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${aiConfig.apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({ model: aiConfig.modelName, messages, max_tokens: 8192, temperature: 0.3, stream: false }),
              signal: AbortSignal.timeout(110000),
            });
          } finally {
            clearInterval(hb);
          }

          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`AI API 错误: HTTP ${res.status} - ${text.slice(0, 200)}`);
          }

          const data = await res.json() as {
            choices?: Array<{ finish_reason: string; message: { content: string | null } }>;
          };
          const choice = data.choices?.[0];
          if (!choice) throw new Error("AI 返回空响应");

          const content = choice.message?.content || "";
          if (content) {
            const chunkSize = 60;
            for (let i = 0; i < content.length; i += chunkSize) {
              send("content", content.slice(i, i + chunkSize));
              await new Promise((r) => setTimeout(r, 12));
            }
          }
          messages.push({ role: "assistant", content });

          if (choice.finish_reason === "length" && content) {
            messages.push({ role: "user", content: "请继续，从上文截断处接着写，不要重复已写内容。" });
            continue;
          }

          send("done", "分析完成");
          closed = true; controller.close();
          return;
        }

        send("content", "\n\n报告生成轮次超限，请重试。");
        send("done", "超限退出");
        closed = true; controller.close();
      } catch (err) {
        send("error", err instanceof Error ? err.message : String(err));
        closed = true;
        try { controller.close(); } catch { /* ignore */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
