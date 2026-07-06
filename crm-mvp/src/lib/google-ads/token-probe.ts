/**
 * Token 池主动探测（体检）：系统自行验证每个凭证对「谁能用、谁不能用」。
 *
 * 对池中每个凭证对（Developer Token + 配对 SA JSON），向本组各 MCC 发一条
 * 最便宜的 GAQL 查询（SELECT customer.id FROM customer LIMIT 1，1 次操作），
 * 根据返回自动打标记：
 * - 成功            → health_status=ok，mcc_access[mcc]=ok
 * - token 未获批/被禁 → health_status=invalid（轮询自动跳过，次日复检自动复活）
 * - 对某 MCC 无权限  → mcc_access[mcc]=denied（仅该 MCC 跳过此凭证）
 * - 429            → 不改标记（限流不代表不可用），跳过该 token 的剩余探测
 *
 * 入口：
 * - 组长界面「立即检测」按钮（POST /api/user/team/token-pool/probe）
 * - 每日 cron daily-sync 自动体检全部团队（invalid 的 token 由此自动复活）
 */
import { JWT } from "google-auth-library";
import prisma from "@/lib/prisma";
import { maskToken, clearTokenCooldown } from "./token-pool";

const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const ADS_BASE_URL = "https://googleads.googleapis.com/v23";
const PROBE_TIMEOUT_MS = 15_000;

export interface ProbeResult {
  token_masked: string;
  health_status: string; // ok | invalid | limited | unknown
  note: string;
  mcc_results: { mcc_id: string; status: "ok" | "denied" | "skipped"; detail?: string }[];
}

async function probeOneMcc(
  devToken: string,
  saJson: string,
  mccKey: string,
): Promise<{ status: "ok" | "denied" | "invalid" | "rate_limited" | "auth_failed"; detail: string }> {
  let accessToken: string;
  try {
    const sa = JSON.parse(saJson);
    const jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [GOOGLE_ADS_SCOPE] });
    const { token } = await jwt.getAccessToken();
    if (!token) throw new Error("empty access_token");
    accessToken = token;
  } catch (e) {
    return { status: "auth_failed", detail: `SA JSON 无法换取 access_token：${e instanceof Error ? e.message.slice(0, 120) : e}` };
  }

  const resp = await fetch(`${ADS_BASE_URL}/customers/${mccKey}/googleAds:search`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "developer-token": devToken,
      "login-customer-id": mccKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: "SELECT customer.id FROM customer LIMIT 1" }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  }).catch((e) => {
    return { ok: false, status: 0, text: async () => `网络错误: ${e instanceof Error ? e.message : e}` } as Response;
  });

  if (resp.ok) return { status: "ok", detail: "" };
  const body = await resp.text().catch(() => "");

  if (body.includes("DEVELOPER_TOKEN_NOT_APPROVED") || body.includes("DEVELOPER_TOKEN_PROHIBITED") || body.includes("DEVELOPER_TOKEN_INVALID")) {
    return { status: "invalid", detail: "Developer Token 未获批准或已被禁用" };
  }
  if (resp.status === 429 || body.includes("RESOURCE_EXHAUSTED")) {
    return { status: "rate_limited", detail: "限流中（不代表不可用）" };
  }
  if (body.includes("USER_PERMISSION_DENIED") || (body.includes("PERMISSION_DENIED") && body.includes("authorizationError"))) {
    return { status: "denied", detail: "服务账号未被加入该 MCC（USER_PERMISSION_DENIED）" };
  }
  if (resp.status === 401 || body.includes("UNAUTHENTICATED")) {
    return { status: "auth_failed", detail: "SA 凭证无效（UNAUTHENTICATED）" };
  }
  return { status: "denied", detail: `HTTP ${resp.status}: ${body.slice(0, 160)}` };
}

/**
 * 探测某个团队的 token 池（tokenId 传 null = 全部活跃 token）。
 * 结果直接写回 team_developer_tokens 的标记列，并返回明细供 UI 展示。
 */
export async function probeTeamTokens(teamId: bigint, tokenId?: bigint | null): Promise<ProbeResult[]> {
  const rows = await prisma.team_developer_tokens.findMany({
    where: { team_id: teamId, is_deleted: 0, ...(tokenId ? { id: tokenId } : { is_active: 1 }) },
    orderBy: { created_at: "asc" },
  });
  if (rows.length === 0) return [];

  // 本组成员的全部活跃 MCC（探测目标）
  const members = await prisma.users.findMany({
    where: { team_id: teamId, is_deleted: 0 },
    select: { id: true },
  });
  const mccs = members.length > 0 ? await prisma.google_mcc_accounts.findMany({
    where: { user_id: { in: members.map((m) => m.id) }, is_deleted: 0, is_active: 1 },
    select: { mcc_id: true },
  }) : [];
  const mccKeys = [...new Set(mccs.map((m) => m.mcc_id.replace(/-/g, "")))];

  const results: ProbeResult[] = [];
  for (const row of rows) {
    const result: ProbeResult = {
      token_masked: maskToken(row.token),
      health_status: "unknown",
      note: "",
      mcc_results: [],
    };

    if (!row.service_account_json) {
      result.health_status = "unknown";
      result.note = "未配置配对 JSON，无法探测";
      results.push(result);
      continue;
    }
    if (mccKeys.length === 0) {
      result.note = "本组暂无活跃 MCC，无探测目标";
      results.push(result);
      continue;
    }

    let mccAccess: Record<string, string> = {};
    try { mccAccess = JSON.parse(row.mcc_access || "{}"); } catch {}
    let tokenInvalid = false;
    let rateLimited = false;
    let anyOk = false;
    let firstErr = "";

    for (const mccKey of mccKeys) {
      if (tokenInvalid || rateLimited) {
        result.mcc_results.push({ mcc_id: mccKey, status: "skipped" });
        continue;
      }
      const r = await probeOneMcc(row.token, row.service_account_json, mccKey);
      if (r.status === "ok") {
        anyOk = true;
        mccAccess[mccKey] = "ok";
        result.mcc_results.push({ mcc_id: mccKey, status: "ok" });
      } else if (r.status === "invalid") {
        tokenInvalid = true;
        firstErr = r.detail;
        result.mcc_results.push({ mcc_id: mccKey, status: "skipped", detail: r.detail });
      } else if (r.status === "rate_limited") {
        rateLimited = true;
        result.mcc_results.push({ mcc_id: mccKey, status: "skipped", detail: r.detail });
      } else {
        // denied / auth_failed：都是「该凭证用不了这个 MCC」
        mccAccess[mccKey] = "denied";
        if (!firstErr) firstErr = r.detail;
        result.mcc_results.push({ mcc_id: mccKey, status: "denied", detail: r.detail });
      }
    }

    const now = new Date();
    if (tokenInvalid) {
      result.health_status = "invalid";
      result.note = firstErr;
      await prisma.team_developer_tokens.update({
        where: { id: row.id },
        data: { health_status: "invalid", health_note: firstErr, last_error_at: now, mcc_access: JSON.stringify(mccAccess) },
      });
    } else if (rateLimited && !anyOk) {
      // 限流探测不出结论，保留原状态，只记备注
      result.health_status = row.health_status || "unknown";
      result.note = "探测时限流，未能得出结论（稍后重试）";
      await prisma.team_developer_tokens.update({
        where: { id: row.id },
        data: { health_note: result.note, mcc_access: JSON.stringify(mccAccess) },
      });
    } else if (anyOk) {
      const deniedCount = Object.values(mccAccess).filter((v) => v === "denied").length;
      result.health_status = "ok";
      result.note = deniedCount > 0 ? `可用；${deniedCount} 个 MCC 无权限（详见明细）` : "全部 MCC 探测通过";
      await prisma.team_developer_tokens.update({
        where: { id: row.id },
        data: { health_status: "ok", health_note: result.note, last_ok_at: now, mcc_access: JSON.stringify(mccAccess) },
      });
      clearTokenCooldown(row.token); // 之前被标 invalid 的 token 复检通过后立即复活
    } else {
      result.health_status = "limited";
      result.note = firstErr ? `所有 MCC 均不可用：${firstErr}` : "所有 MCC 均不可用";
      await prisma.team_developer_tokens.update({
        where: { id: row.id },
        data: { health_status: "limited", health_note: result.note, last_error_at: now, mcc_access: JSON.stringify(mccAccess) },
      });
    }
    console.error(`[TokenProbe] team=${teamId} token=${result.token_masked} → ${result.health_status}（${result.note}）`);
    results.push(result);
  }
  return results;
}

/** 每日 cron：体检全部团队的 token 池（量小：token 数 × MCC 数，每次 1 条最便宜查询） */
export async function probeAllTeamTokens(): Promise<void> {
  const teams = await prisma.team_developer_tokens.findMany({
    where: { is_deleted: 0, is_active: 1 },
    select: { team_id: true },
    distinct: ["team_id"],
  });
  for (const t of teams) {
    try {
      await probeTeamTokens(t.team_id);
    } catch (e) {
      console.error(`[TokenProbe] team=${t.team_id} 探测失败:`, e instanceof Error ? e.message : e);
    }
  }
}
