import { NextRequest } from "next/server";
import { getAdminFromRequest } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { getSystemConfigsByPrefix } from "@/lib/system-config";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const LOGIN_URL = "https://dash.3ue.co/api/account/login";
const LOGIN_ORIGIN = "https://dash.3ue.co";
const RPC_URL = "https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU";
const RPC_ORIGIN = "https://sem.3ue.co";

/**
 * POST /api/admin/semrush-config/test
 * 分步诊断 SemRush/3UE 连接状态
 */
export async function POST(req: NextRequest) {
  const admin = getAdminFromRequest(req);
  if (!admin) return apiError("未授权", 401);

  const configs = await getSystemConfigsByPrefix("semrush_");
  const username = configs["semrush_username"];
  const password = configs["semrush_password"];
  const userId = configs["semrush_user_id"];
  const apiKey = configs["semrush_api_key"];
  const database = configs["semrush_database"] || "us";
  const node = configs["semrush_node"] || "3";

  const steps: { step: string; status: "success" | "fail" | "skip"; detail: string }[] = [];

  // Step 1: 检查配置完整性
  const missing: string[] = [];
  if (!username) missing.push("用户名");
  if (!password) missing.push("密码");
  if (!userId) missing.push("User ID");
  if (!apiKey) missing.push("API Key");
  if (missing.length > 0) {
    steps.push({ step: "配置检查", status: "fail", detail: `缺少: ${missing.join(", ")}` });
    return apiSuccess({ steps, overall: "fail" });
  }
  steps.push({
    step: "配置检查",
    status: "success",
    detail: `用户名: ${username}, User ID: ${userId}, API Key: ${apiKey.slice(0, 6)}..., 节点: ${node}, 数据库: ${database}`,
  });

  // Step 2: 登录测试
  let token = "";
  let cookies: Record<string, string> = {};
  try {
    const ts = Date.now();
    const loginUrl = `${LOGIN_URL}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&ts=${ts}`;
    const loginRes = await fetch(loginUrl, {
      headers: { "user-agent": USER_AGENT, origin: LOGIN_ORIGIN },
      signal: AbortSignal.timeout(15000),
    });
    if (!loginRes.ok) {
      steps.push({ step: "3UE 登录", status: "fail", detail: `HTTP ${loginRes.status} — 用户名或密码错误` });
      return apiSuccess({ steps, overall: "fail" });
    }
    const setCookies = loginRes.headers.getSetCookie?.() || [];
    for (const c of setCookies) {
      const [kv] = c.split(";");
      const [k, v] = kv.split("=");
      if (k && v) cookies[k.trim()] = v.trim();
    }
    const payload = await loginRes.json();
    token = extractToken(payload);
    if (!token) {
      steps.push({ step: "3UE 登录", status: "fail", detail: "登录响应中未找到 token，请检查凭据" });
      return apiSuccess({ steps, overall: "fail" });
    }
    steps.push({ step: "3UE 登录", status: "success", detail: `Token: ${token.slice(0, 10)}...` });
  } catch (err) {
    steps.push({ step: "3UE 登录", status: "fail", detail: `连接失败: ${err instanceof Error ? err.message : String(err)}` });
    return apiSuccess({ steps, overall: "fail" });
  }

  // Step 2.5: 访问分析页面获取完整 session cookies
  try {
    const configValue = JSON.stringify({
      chat: { node, lang: "zh_CN" },
      semrush: { node, lang: "zh" },
    });
    cookies["GMITM_token"] = token;
    cookies["GMITM_uname"] = username;
    cookies["GMITM_config"] = configValue;
    const initCookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const pageRes = await fetch("https://sem.3ue.co/analytics/overview/", {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,*/*",
        cookie: initCookieStr,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });
    const pageCookies = pageRes.headers.getSetCookie?.() || [];
    for (const c of pageCookies) {
      const [kv] = c.split(";");
      const eqIdx = kv.indexOf("=");
      if (eqIdx > 0) {
        const k = kv.slice(0, eqIdx).trim();
        const v = kv.slice(eqIdx + 1).trim();
        if (k && v) cookies[k] = v;
      }
    }
    await pageRes.text();
    steps.push({ step: "页面 Session", status: "success", detail: `获取到 ${Object.keys(cookies).length} 个 cookies` });
  } catch (err) {
    steps.push({ step: "页面 Session", status: "skip", detail: `页面访问失败（不影响主流程）: ${err instanceof Error ? err.message : String(err)}` });
  }

  // Step 3: RPC 调用测试
  try {
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");

    const rpcPayload = {
      id: 1,
      jsonrpc: "2.0",
      method: "user.Databases",
      params: { userId: parseInt(userId), apiKey },
    };
    const rpcHeaders: Record<string, string> = {
      "user-agent": USER_AGENT,
      "content-type": "application/json; charset=utf-8",
      origin: RPC_ORIGIN,
      referer: "https://sem.3ue.co/analytics/overview/",
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      cookie: cookieStr,
    };
    const rpcRes = await fetch(RPC_URL, {
      method: "POST",
      headers: rpcHeaders,
      body: JSON.stringify(rpcPayload),
      signal: AbortSignal.timeout(15000),
    });

    if (!rpcRes.ok) {
      const statusHints: Record<number, string> = {
        401: "认证失败 — Token 或凭据无效",
        403: "访问被拒绝 — 账户可能已过期，或 User ID / API Key 不匹配，或服务器 IP 被限制",
        429: "请求频率过高，请稍后再试",
      };
      steps.push({
        step: "RPC 调用",
        status: "fail",
        detail: `HTTP ${rpcRes.status} — ${statusHints[rpcRes.status] || "服务异常"}`,
      });
      return apiSuccess({ steps, overall: "fail" });
    }

    const rpcData = await rpcRes.json();
    const databases = rpcData?.result;
    if (databases) {
      const dbList = Array.isArray(databases) ? databases.slice(0, 5).join(", ") : JSON.stringify(databases).slice(0, 100);
      steps.push({ step: "RPC 调用", status: "success", detail: `可用数据库: ${dbList}` });
    } else {
      steps.push({ step: "RPC 调用", status: "success", detail: "RPC 响应正常" });
    }
  } catch (err) {
    steps.push({ step: "RPC 调用", status: "fail", detail: `连接失败: ${err instanceof Error ? err.message : String(err)}` });
    return apiSuccess({ steps, overall: "fail" });
  }

  // Step 4: 关键词查询测试
  try {
    const configValue = JSON.stringify({
      chat: { node, lang: "zh_CN" },
      semrush: { node, lang: "zh" },
    });
    cookies["GMITM_config"] = configValue;
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");

    const kwPayload = {
      id: 13,
      jsonrpc: "2.0",
      method: "organic.PositionsOverview",
      params: {
        request_id: crypto.randomUUID(),
        report: "domain.overview",
        args: { database, dateType: "daily", dateFormat: "date", searchItem: "google.com", searchType: "domain", positionsType: "all" },
        userId: parseInt(userId),
        apiKey,
      },
    };
    const kwRes = await fetch(RPC_URL, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        "content-type": "application/json; charset=utf-8",
        origin: RPC_ORIGIN,
        referer: "https://sem.3ue.co/analytics/overview/",
        accept: "application/json, text/plain, */*",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        cookie: cookieStr,
      },
      body: JSON.stringify(kwPayload),
      signal: AbortSignal.timeout(15000),
    });

    if (!kwRes.ok) {
      steps.push({ step: "关键词查询", status: "fail", detail: `HTTP ${kwRes.status}` });
      return apiSuccess({ steps, overall: "fail" });
    }
    const kwData = await kwRes.json();
    const rows = kwData?.result || [];
    steps.push({
      step: "关键词查询",
      status: "success",
      detail: `查询 google.com 返回 ${Array.isArray(rows) ? rows.length : 0} 条结果`,
    });
  } catch (err) {
    steps.push({ step: "关键词查询", status: "fail", detail: `查询异常: ${err instanceof Error ? err.message : String(err)}` });
    return apiSuccess({ steps, overall: "fail" });
  }

  return apiSuccess({
    steps,
    overall: steps.every((s) => s.status === "success") ? "success" : "fail",
  });
}

function extractToken(payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        const t = extractToken(item);
        if (t) return t;
      }
    } else {
      const obj = payload as Record<string, unknown>;
      if (typeof obj.token === "string" && obj.token) return obj.token;
      for (const v of Object.values(obj)) {
        const t = extractToken(v);
        if (t) return t;
      }
    }
  }
  return "";
}
