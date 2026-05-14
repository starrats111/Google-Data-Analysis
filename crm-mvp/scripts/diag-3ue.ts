/**
 * 3UE (SemRush 代理) 实地诊断
 *
 * 用法（在服务器 crm-mvp 目录下）：
 *   npx tsx scripts/diag-3ue.ts
 *
 * 依次：
 *   1. 从 DB 读 system_configs 里的 semrush_* 配置
 *   2. 用配置去登录 3UE，记录 login 状态码和响应体片段
 *   3. 拿到 token 后调用一次最简单的 user.Databases RPC，记录状态码和响应体片段
 *   4. 把每一步的"3UE 原始返回"打出来，便于判断真实失败原因（账户到期 / key 失效 / 配额耗尽 / ...）
 */
import { loadEnvFromProjectRoot } from "./load-env-from-dotenv-file";
loadEnvFromProjectRoot();

const LOGIN_URL = "https://dash.3ue.co/api/account/login";
const RPC_URL = "https://sem.3ue.co/dpa/rpc?__gmitm=ayWzA3*l4EVcTpZei43sW*qRvljSdU";
const LOGIN_ORIGIN = "https://dash.3ue.co";
const RPC_ORIGIN = "https://sem.3ue.co";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function main() {
  const { default: prisma } = await import("../src/lib/prisma");

  const rows = await prisma.system_configs.findMany({
    where: { config_key: { startsWith: "semrush_" }, is_deleted: 0 },
  });
  const cfg: Record<string, string> = {};
  for (const r of rows) cfg[r.config_key] = r.config_value ?? "";

  console.log("[diag] semrush_ 配置：");
  for (const k of Object.keys(cfg).sort()) {
    const v = cfg[k] ?? "";
    const masked = v.length > 6 ? v.slice(0, 3) + "***" + v.slice(-3) + ` (len=${v.length})` : `(len=${v.length})`;
    console.log(`  ${k} = ${masked}`);
  }

  const username = cfg.semrush_username;
  const password = cfg.semrush_password;
  const userId = cfg.semrush_user_id;
  const apiKey = cfg.semrush_api_key;
  const database = cfg.semrush_database || "us";

  if (!username || !password) {
    console.error("[diag] 缺少 username/password，无法继续");
    await prisma.$disconnect();
    return;
  }

  // 1) login
  console.log("\n[diag] === STEP 1: 登录 3UE ===");
  const ts = Date.now();
  const loginUrl = `${LOGIN_URL}?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&ts=${ts}`;
  const loginRes = await fetch(loginUrl, {
    headers: { "user-agent": USER_AGENT, origin: LOGIN_ORIGIN },
    signal: AbortSignal.timeout(20000),
  });
  console.log(`[diag] login status = ${loginRes.status} ${loginRes.statusText}`);
  const loginBody = await loginRes.text();
  console.log(`[diag] login body (前 500 字符): ${loginBody.slice(0, 500)}`);

  if (loginRes.status >= 400) {
    console.error("[diag] 登录已被拒绝，问题在用户名/密码层");
    await prisma.$disconnect();
    return;
  }

  let token = "";
  try {
    const parsed = JSON.parse(loginBody) as Record<string, unknown>;
    token = String(parsed.token ?? parsed.access_token ?? parsed.data ?? "");
    if (!token && parsed.data && typeof parsed.data === "object") {
      const inner = parsed.data as Record<string, unknown>;
      token = String(inner.token ?? inner.access_token ?? "");
    }
  } catch {
    console.error("[diag] login body 不是合法 JSON，无法提取 token");
    await prisma.$disconnect();
    return;
  }
  if (!token) {
    console.error("[diag] login 成功但响应体里没找到 token 字段");
    await prisma.$disconnect();
    return;
  }
  console.log(`[diag] token = ${token.slice(0, 12)}...${token.slice(-4)} (len=${token.length})`);

  // 2) RPC: 最简单的 user.Databases（验证 userId+apiKey 配额/权限）
  console.log("\n[diag] === STEP 2: 调一次 user.Databases RPC ===");
  const cookieStr = `GMITM_token=${token}; GMITM_uname=${username}`;
  const rpcPayload = [
    { id: 1, jsonrpc: "2.0", method: "user.Databases", params: { userId: parseInt(userId), apiKey } },
  ];
  const rpcRes = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "user-agent": USER_AGENT,
      "content-type": "application/json; charset=utf-8",
      origin: RPC_ORIGIN,
      referer: "https://sem.3ue.co/analytics/overview/",
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      cookie: cookieStr,
    },
    body: JSON.stringify(rpcPayload),
    signal: AbortSignal.timeout(30000),
  });
  console.log(`[diag] rpc status = ${rpcRes.status} ${rpcRes.statusText}`);
  for (const [hk, hv] of rpcRes.headers.entries()) {
    if (/x-/i.test(hk) || /retry/i.test(hk) || /error/i.test(hk) || /content-type/i.test(hk)) {
      console.log(`[diag] rpc header: ${hk}: ${hv}`);
    }
  }
  const rpcBody = await rpcRes.text();
  console.log(`[diag] rpc body (前 800 字符): ${rpcBody.slice(0, 800)}`);

  // 3) 也试一下 keywords RPC（业务上真正用的 method）
  if (rpcRes.status < 400) {
    console.log("\n[diag] === STEP 3: 调一次 organic.PositionsOverview RPC (实际业务) ===");
    const bizPayload = {
      id: 13, jsonrpc: "2.0", method: "organic.PositionsOverview",
      params: {
        request_id: "diag-" + Date.now(),
        report: "domain.overview",
        args: { database, dateType: "daily", dateFormat: "date", searchItem: "amazon.com", searchType: "domain", positionsType: "all" },
        userId: parseInt(userId), apiKey,
      },
    };
    const bizRes = await fetch(RPC_URL, {
      method: "POST",
      headers: {
        "user-agent": USER_AGENT,
        "content-type": "application/json; charset=utf-8",
        origin: RPC_ORIGIN,
        referer: "https://sem.3ue.co/analytics/overview/",
        accept: "application/json, text/plain, */*",
        cookie: cookieStr,
      },
      body: JSON.stringify(bizPayload),
      signal: AbortSignal.timeout(30000),
    });
    console.log(`[diag] biz status = ${bizRes.status} ${bizRes.statusText}`);
    const bizBody = await bizRes.text();
    console.log(`[diag] biz body (前 800 字符): ${bizBody.slice(0, 800)}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("[diag] 异常:", e);
  process.exit(1);
});
