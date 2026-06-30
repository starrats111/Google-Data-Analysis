/**
 * SemRush 自动修复工具库
 *
 * 功能：
 *  1. testConnection()     — 执行分步诊断，返回步骤结果和整体状态
 *  2. trySwitchNode()      — 遍历节点 1-10，找到可用节点并写入 DB
 *  3. refreshApiKey()      — 登录 3UE、访问 sem.3ue.co 页面、从 window.sm2.user 中
 *                            提取最新 api_key / userId，写入 DB
 */

import { getSystemConfigsByPrefix } from "@/lib/system-config";
import { curlFetch } from "@/lib/semrush-client";
import prisma from "@/lib/prisma";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const LOGIN_URL = "https://dash.3ue.co/api/account/login";
const LOGOUT_URL = "https://dash.3ue.co/api/account/logout";
const LOGIN_ORIGIN = "https://dash.3ue.co";
const RPC_URL = "https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU";
const RPC_ORIGIN = "https://sem.3ue.co";
const ANALYTICS_URL = "https://sem.3ue.co/analytics/overview/?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU";

// ─── 类型定义 ───

export type StepStatus = "success" | "fail" | "skip";

export interface DiagStep {
  step: string;
  status: StepStatus;
  detail: string;
}

export interface TestResult {
  overall: "success" | "fail";
  steps: DiagStep[];
  errorType?: "node" | "apikey" | "login" | "unknown";
}

export interface AutoFixResult {
  action: "none" | "switched_node" | "refreshed_apikey" | "failed";
  detail: string;
  newNode?: string;
  newApiKey?: string;
  newUserId?: string;
}

// ─── 工具函数 ───

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

function buildConfig(node: string): string {
  return JSON.stringify({
    chat: { node, lang: "zh_CN" },
    semrush: { node, lang: "zh" },
  });
}

/**
 * BUG-07b：尽力登出本次诊断/修复刚开的 3UE 会话，释放它在账号侧占用的「在线设备」。
 *
 * 真因：semrush-health cron 每整点调 testConnection() 全新登录建会话却从不登出，
 * 每小时在 3UE 侧累积一个僵尸设备；几小时后填满账号「同时在线设备」配额，
 * 真正的广告生成/竞品查询再来就报「超出同一时间设备数量限制」（生产实证：
 * 设备超限每天数百次、白天高峰每天 20-30 次最终失败）。诊断本身必须真实登录，
 * 故正解是「用完即登出」。全程吞错 + 短超时，登出失败不影响诊断结果。
 */
async function bestEffortLogout(cookies: Record<string, string>): Promise<void> {
  if (!cookies || Object.keys(cookies).length === 0) return;
  try {
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    await curlFetch(LOGOUT_URL, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        origin: LOGIN_ORIGIN,
        accept: "application/json, text/plain, */*",
        cookie: cookieStr,
      },
      timeoutMs: 6000,
    });
  } catch {
    /* 登出失败不影响主流程 */
  }
}

async function updateSystemConfig(key: string, value: string): Promise<void> {
  await prisma.system_configs.updateMany({
    where: { config_key: key, is_deleted: 0 },
    data: { config_value: value },
  });
}

// ─── 1. 连接诊断 ───

export async function testConnection(): Promise<TestResult> {
  const configs = await getSystemConfigsByPrefix("semrush_");
  const username = configs["semrush_username"];
  const password = configs["semrush_password"];
  const userId = configs["semrush_user_id"];
  const apiKey = configs["semrush_api_key"];
  const node = configs["semrush_node"] || "14";

  const steps: DiagStep[] = [];

  // Step 1: 配置完整性
  const missing: string[] = [];
  if (!username) missing.push("用户名");
  if (!password) missing.push("密码");
  if (!userId) missing.push("User ID");
  if (!apiKey) missing.push("API Key");
  if (missing.length > 0) {
    steps.push({ step: "配置检查", status: "fail", detail: `缺少: ${missing.join(", ")}` });
    return { overall: "fail", steps, errorType: "unknown" };
  }
  steps.push({ step: "配置检查", status: "success", detail: `用户名: ${username}, UserID: ${userId}, 节点: ${node}` });

  // BUG-07b：token/cookies 提到 try 外，无论从哪条 return 退出都在 finally 里登出，
  // 释放本次诊断刚开的 3UE 设备，杜绝每小时健康检查累积僵尸设备 → 账号设备超限。
  let token = "";
  const cookies: Record<string, string> = {};
  try {
    return await runTestSteps();
  } finally {
    if (token) await bestEffortLogout(cookies);
  }

  // ── 内部：执行 Step 2~4 的实际诊断（共享外层 token/cookies 以便 finally 登出）──
  async function runTestSteps(): Promise<TestResult> {
  // Step 2: 登录
  try {
    const ts = Date.now();
    const loginUrl = `${LOGIN_URL}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&ts=${ts}`;
    const loginRes = await curlFetch(loginUrl, {
      headers: { "user-agent": USER_AGENT, origin: LOGIN_ORIGIN },
      timeoutMs: 15000,
    });
    if (loginRes.status >= 400) {
      steps.push({ step: "登录", status: "fail", detail: `HTTP ${loginRes.status} — 用户名或密码错误` });
      return { overall: "fail", steps, errorType: "login" };
    }
    Object.assign(cookies, loginRes.cookies);
    const payload = JSON.parse(loginRes.body);
    token = extractToken(payload);
    if (!token) {
      steps.push({ step: "登录", status: "fail", detail: "登录响应中未找到 token" });
      return { overall: "fail", steps, errorType: "login" };
    }
    steps.push({ step: "登录", status: "success", detail: `Token: ${token.slice(0, 10)}...` });
  } catch (err) {
    steps.push({ step: "登录", status: "fail", detail: `连接失败: ${err instanceof Error ? err.message : String(err)}` });
    return { overall: "fail", steps, errorType: "unknown" };
  }

  // Step 3: 建立 Session
  cookies["GMITM_token"] = token;
  cookies["GMITM_uname"] = username;
  cookies["GMITM_config"] = buildConfig(node);
  try {
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const pageRes = await curlFetch(ANALYTICS_URL, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        cookie: cookieStr,
      },
      followRedirects: true,
      timeoutMs: 15000,
    });
    Object.assign(cookies, pageRes.cookies);

    // 检测节点不可用的重定向信号（页面包含"套餐无法使用"说明节点不对）
    if (pageRes.body.includes("套餐无法使用") || pageRes.body.includes("location.href")) {
      steps.push({ step: "Session", status: "fail", detail: `节点 ${node} 不可用，账号套餐不支持此节点` });
      return { overall: "fail", steps, errorType: "node" };
    }
    steps.push({ step: "Session", status: "success", detail: `页面 HTTP ${pageRes.status}` });
  } catch (err) {
    steps.push({ step: "Session", status: "skip", detail: `页面访问失败（继续测试 RPC）` });
  }

  // Step 4: RPC 调用
  try {
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const rpcPayload = {
      id: 1,
      jsonrpc: "2.0",
      method: "user.Databases",
      params: { userId: parseInt(userId), apiKey },
    };
    const rpcRes = await curlFetch(RPC_URL, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        "content-type": "application/json; charset=utf-8",
        origin: RPC_ORIGIN,
        referer: "https://sem.3ue.co/analytics/overview/",
        accept: "application/json, text/plain, */*",
        cookie: cookieStr,
      },
      body: JSON.stringify(rpcPayload),
      timeoutMs: 15000,
    });

    if (rpcRes.status === 403) {
      steps.push({ step: "RPC 调用", status: "fail", detail: `HTTP 403 — API Key 可能已轮换或账号被限制` });
      return { overall: "fail", steps, errorType: "apikey" };
    }
    if (rpcRes.status >= 400) {
      steps.push({ step: "RPC 调用", status: "fail", detail: `HTTP ${rpcRes.status}` });
      return { overall: "fail", steps, errorType: rpcRes.status === 401 ? "apikey" : "unknown" };
    }

    let body = rpcRes.body.trim();
    if (body.startsWith("HTTP/")) {
      const sep = body.indexOf("\r\n\r\n");
      if (sep > 0) body = body.slice(sep + 4).trim();
    }
    if (!body || body.startsWith("<")) {
      steps.push({ step: "RPC 调用", status: "fail", detail: "返回 HTML 或空响应，节点可能不可用" });
      return { overall: "fail", steps, errorType: "node" };
    }

    const data = JSON.parse(body) as any;
    if (data.error) {
      const msg = data.error?.message || JSON.stringify(data.error);
      // "Invalid params" 通常是 userId/apiKey 参数格式问题
      const errType = msg.includes("Invalid params") ? "apikey" : "unknown";
      steps.push({ step: "RPC 调用", status: "fail", detail: `RPC 错误: ${msg}` });
      return { overall: "fail", steps, errorType: errType };
    }

    const dbCount = Array.isArray(data.result) ? data.result.length : 0;
    steps.push({ step: "RPC 调用", status: "success", detail: `可用数据库 ${dbCount} 个` });
  } catch (err) {
    steps.push({ step: "RPC 调用", status: "fail", detail: `连接异常: ${err instanceof Error ? err.message : String(err)}` });
    return { overall: "fail", steps, errorType: "unknown" };
  }

  // FIX-NODE-LIMIT Step 5：计量接口探测。user.Databases 是非计量方法，节点配额耗尽时它仍成功，
  // 旧健康检查因此一直误报「✅ 正常」、从不告警/切节点。这里用真正会消耗配额的 organic.PositionsOverview
  // 查 google.com（必有数据）：命中 Limits exceeded 或返回 0 条 → 判定当前节点不可用(errorType=node)，
  // 交由 health-cron 调 trySwitchNode 自动切到有配额的节点。
  try {
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const kwRes = await curlFetch(RPC_URL, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        "content-type": "application/json; charset=utf-8",
        origin: RPC_ORIGIN,
        referer: "https://sem.3ue.co/analytics/overview/",
        accept: "application/json, text/plain, */*",
        cookie: cookieStr,
      },
      body: JSON.stringify({
        id: 13,
        jsonrpc: "2.0",
        method: "organic.PositionsOverview",
        params: {
          request_id: crypto.randomUUID(),
          report: "domain.overview",
          args: { database: configs["semrush_database"] || "us", dateType: "daily", dateFormat: "date", searchItem: "google.com", searchType: "domain", positionsType: "all" },
          userId: parseInt(userId),
          apiKey,
        },
      }),
      timeoutMs: 15000,
    });
    let kb = kwRes.body.trim();
    if (kb.startsWith("HTTP/")) {
      const sep = kb.indexOf("\r\n\r\n");
      if (sep > 0) kb = kb.slice(sep + 4).trim();
    }
    if (!kb || kb.startsWith("<")) {
      steps.push({ step: "关键词查询", status: "fail", detail: "返回空响应或 HTML，节点可能不可用" });
      return { overall: "fail", steps, errorType: "node" };
    }
    const kd = JSON.parse(kb) as any;
    if (kd.error) {
      const msg = kd.error?.message || JSON.stringify(kd.error);
      const isLimit = kd.error?.code === -32098 || /limits?\s*exceeded|额度|配额/i.test(String(msg));
      steps.push({ step: "关键词查询", status: "fail", detail: `RPC 错误: ${msg}` });
      // 配额耗尽按 node 处理（切节点可解）；其它错误归 unknown
      return { overall: "fail", steps, errorType: isLimit ? "node" : "unknown" };
    }
    const kwCount = Array.isArray(kd.result) ? kd.result.length : 0;
    if (kwCount === 0) {
      steps.push({ step: "关键词查询", status: "fail", detail: "google.com 返回 0 条，当前节点配额可能已耗尽" });
      return { overall: "fail", steps, errorType: "node" };
    }
    steps.push({ step: "关键词查询", status: "success", detail: `google.com 返回 ${kwCount} 条` });
  } catch (err) {
    // 计量探测本身异常不阻断整体（前面 RPC 已通过）：记 skip，不误判为故障
    steps.push({ step: "关键词查询", status: "skip", detail: `查询异常（不阻断）: ${err instanceof Error ? err.message : String(err)}` });
  }

  return { overall: "success", steps };
  }
}

// ─── 2. 自动切换节点 ───

export async function trySwitchNode(): Promise<AutoFixResult> {
  const configs = await getSystemConfigsByPrefix("semrush_");
  const username = configs["semrush_username"];
  const password = configs["semrush_password"];
  const userId = configs["semrush_user_id"];
  const apiKey = configs["semrush_api_key"];
  const currentNode = configs["semrush_node"] || "14";

  if (!username || !password || !userId || !apiKey) {
    return { action: "failed", detail: "配置不完整，无法切换节点" };
  }

  // 登录获取 token
  let token = "";
  const cookies: Record<string, string> = {};
  try {
    const ts = Date.now();
    const loginRes = await curlFetch(
      `${LOGIN_URL}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&ts=${ts}`,
      { headers: { "user-agent": USER_AGENT, origin: LOGIN_ORIGIN }, timeoutMs: 15000 }
    );
    if (loginRes.status >= 400) {
      return { action: "failed", detail: `登录失败 HTTP ${loginRes.status}，无法切换节点` };
    }
    Object.assign(cookies, loginRes.cookies);
    token = extractToken(JSON.parse(loginRes.body));
    if (!token) return { action: "failed", detail: "登录成功但未获取到 token" };
  } catch (err) {
    return { action: "failed", detail: `登录异常: ${err instanceof Error ? err.message : String(err)}` };
  }

  // BUG-07b：登录后无论成功/失败，结束都登出本次会话，释放 3UE 设备。
  try {
  // FIX-NODE-LIMIT：候选节点改为现有 GURU 套餐有效节点 9~20（旧 1~8 多已失效），跳过当前节点。
  const nodesToTry = ["14", "13", "12", "11", "10", "15", "16", "17", "18", "19", "20", "9"].filter(n => n !== currentNode);

  for (const node of nodesToTry) {
    cookies["GMITM_token"] = token;
    cookies["GMITM_uname"] = username;
    cookies["GMITM_config"] = buildConfig(node);

    try {
      // 先访问页面建立 session
      const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      const pageRes = await curlFetch(ANALYTICS_URL, {
        headers: { "user-agent": USER_AGENT, accept: "text/html,*/*", cookie: cookieStr },
        followRedirects: true,
        timeoutMs: 10000,
      });
      Object.assign(cookies, pageRes.cookies);

      // 节点不可用的信号
      if (pageRes.body.includes("套餐无法使用") || pageRes.body.includes("location.href")) continue;

      // RPC 测试
      const rpcCookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
      const rpcRes = await curlFetch(RPC_URL, {
        method: "POST",
        headers: {
          "user-agent": USER_AGENT,
          "content-type": "application/json; charset=utf-8",
          origin: RPC_ORIGIN,
          referer: "https://sem.3ue.co/analytics/overview/",
          accept: "application/json, text/plain, */*",
          cookie: rpcCookieStr,
        },
        // FIX-NODE-LIMIT：用【计量接口】organic.PositionsOverview 测节点，而非 user.Databases。
        // user.Databases 不计配额，节点额度耗尽时仍成功 → 旧逻辑会把已耗尽节点误判为可用。
        // 只有该计量方法能查出数据(google.com 必有词)的节点，才是真正还有配额、可切过去的节点。
        body: JSON.stringify({
          id: 13, jsonrpc: "2.0", method: "organic.PositionsOverview",
          params: {
            request_id: crypto.randomUUID(), report: "domain.overview",
            args: { database: configs["semrush_database"] || "us", dateType: "daily", dateFormat: "date", searchItem: "google.com", searchType: "domain", positionsType: "all" },
            userId: parseInt(userId), apiKey,
          },
        }),
        timeoutMs: 15000,
      });

      if (rpcRes.status >= 400) continue;

      let body = rpcRes.body.trim();
      if (body.startsWith("HTTP/")) {
        const sep = body.indexOf("\r\n\r\n");
        if (sep > 0) body = body.slice(sep + 4).trim();
      }
      if (!body || body.startsWith("<")) continue;

      const data = JSON.parse(body) as any;
      if (data.error) continue; // 含 -32098 Limits exceeded：该节点配额耗尽，跳过
      if (!Array.isArray(data.result) || data.result.length === 0) continue;

      // 找到可用节点，更新 DB
      await updateSystemConfig("semrush_node", node);
      return { action: "switched_node", detail: `节点已从 ${currentNode} 切换为 ${node}`, newNode: node };
    } catch {
      // 继续尝试下一个节点
    }
  }

  return { action: "failed", detail: `已尝试所有节点（跳过当前 ${currentNode}），均不可用` };
  } finally {
    if (token) await bestEffortLogout(cookies);
  }
}

// ─── 3. 自动刷新 API Key ───

export async function refreshApiKey(): Promise<AutoFixResult> {
  const configs = await getSystemConfigsByPrefix("semrush_");
  const username = configs["semrush_username"];
  const password = configs["semrush_password"];
  const node = configs["semrush_node"] || "14";

  if (!username || !password) {
    return { action: "failed", detail: "用户名或密码未配置，无法刷新 API Key" };
  }

  // 登录
  let token = "";
  const cookies: Record<string, string> = {};
  try {
    const ts = Date.now();
    const loginRes = await curlFetch(
      `${LOGIN_URL}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&ts=${ts}`,
      { headers: { "user-agent": USER_AGENT, origin: LOGIN_ORIGIN }, timeoutMs: 15000 }
    );
    if (loginRes.status >= 400) {
      return { action: "failed", detail: `登录失败 HTTP ${loginRes.status}` };
    }
    Object.assign(cookies, loginRes.cookies);
    token = extractToken(JSON.parse(loginRes.body));
    if (!token) return { action: "failed", detail: "登录成功但未获取到 token" };
  } catch (err) {
    return { action: "failed", detail: `登录异常: ${err instanceof Error ? err.message : String(err)}` };
  }

  // 访问 sem.3ue.co 页面，从 window.sm2.user 中提取最新凭据
  cookies["GMITM_token"] = token;
  cookies["GMITM_uname"] = username;
  cookies["GMITM_config"] = buildConfig(node);

  try {
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    const pageRes = await curlFetch(ANALYTICS_URL, {
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9",
        cookie: cookieStr,
      },
      followRedirects: true,
      timeoutMs: 20000,
    });

    const html = pageRes.body;

    // 从 window.sm2.user = {...} 中提取 api_key 和 id
    const sm2Match = html.match(/window\.sm2\.user\s*=\s*(\{[^;]+\})/);
    if (!sm2Match) {
      // 页面可能重定向到登录，节点问题
      return { action: "failed", detail: "无法从页面提取用户信息，可能节点不可用或会话已过期" };
    }

    let userObj: { id?: number; api_key?: string } = {};
    try {
      userObj = JSON.parse(sm2Match[1]);
    } catch {
      return { action: "failed", detail: "解析 window.sm2.user JSON 失败" };
    }

    const newApiKey = userObj.api_key;
    const newUserId = userObj.id ? String(userObj.id) : undefined;

    if (!newApiKey) {
      return { action: "failed", detail: "页面中未找到 api_key 字段" };
    }

    // 检查是否与当前相同
    const currentApiKey = configs["semrush_api_key"];
    if (newApiKey === currentApiKey && (!newUserId || newUserId === configs["semrush_user_id"])) {
      return { action: "none", detail: `API Key 未变化（${newApiKey.slice(0, 8)}...），无需更新` };
    }

    // 写入 DB
    await updateSystemConfig("semrush_api_key", newApiKey);
    if (newUserId) await updateSystemConfig("semrush_user_id", newUserId);

    return {
      action: "refreshed_apikey",
      detail: `API Key 已更新: ...${newApiKey.slice(-8)}${newUserId ? `，User ID: ${newUserId}` : ""}`,
      newApiKey,
      newUserId,
    };
  } catch (err) {
    return { action: "failed", detail: `页面访问异常: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    // BUG-07b：登出本次刷新会话，释放 3UE 设备
    if (token) await bestEffortLogout(cookies);
  }
}
