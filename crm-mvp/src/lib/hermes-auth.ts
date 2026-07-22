import { NextRequest } from "next/server";

/**
 * HM-D23：Hermes → CRM 委托接口鉴权（/api/hermes/*）
 *
 * Hermes 服务器持有 HERMES_API_TOKEN（独立于 CRON_SECRET，避免把 cron 面板一并暴露），
 * 通过公网 https://google-data-analysis.top/api/hermes/* 调用。
 * 未配置该环境变量时接口整体禁用（返回 503），防止误上线裸口。
 */
export function verifyHermesToken(req: NextRequest): Response | null {
  const expected = process.env.HERMES_API_TOKEN;
  if (!expected) {
    return Response.json({ code: -1, message: "HERMES_API_TOKEN 未配置，接口禁用", data: null }, { status: 503 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${expected}`) {
    return Response.json({ code: -1, message: "未授权", data: null }, { status: 401 });
  }
  return null;
}
