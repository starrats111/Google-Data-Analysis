import { NextRequest } from "next/server";
import { apiSuccess, apiError } from "@/lib/constants";
import { withLeader } from "@/lib/api-handler";
import { serializeData } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { getTokenCooldown, maskToken } from "@/lib/google-ads/token-pool";

export const dynamic = "force-dynamic";

const MIN_TOKEN_LENGTH = 15;

/** 解析组长所属 team_id（token 里没有时查库兜底） */
async function resolveTeamId(userId: string, tokenTeamId?: string): Promise<bigint | null> {
  if (tokenTeamId) return BigInt(tokenTeamId);
  const u = await prisma.users.findFirst({
    where: { id: BigInt(userId), is_deleted: 0 },
    select: { team_id: true },
  });
  return u?.team_id ?? null;
}

/** 校验 Service Account JSON 基本结构 */
function validateSaJson(raw: string): string | null {
  try {
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) {
      return "JSON 缺少 client_email 或 private_key 字段，请粘贴完整的 Service Account 密钥 JSON";
    }
    return null;
  } catch {
    return "Service Account JSON 格式无效（无法解析）";
  }
}

/** 东八区今日（与用量落库口径一致） */
function cstToday(): Date {
  const cst = new Date(Date.now() + 8 * 3600_000);
  return new Date(`${cst.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

/**
 * GET /api/user/team/token-pool
 * 本组 Token 池清单（组长专属），含每条的今日用量、使用人数、冷却状态。
 */
export const GET = withLeader(async (_req: NextRequest, { user }) => {
  const teamId = await resolveTeamId(user.userId, user.teamId);
  if (!teamId) return apiError("未关联小组");

  const rows = await prisma.team_developer_tokens.findMany({
    where: { team_id: teamId, is_deleted: 0 },
    orderBy: { created_at: "asc" },
  });

  // 今日用量（token + 日期唯一）
  const usageRows = rows.length > 0 ? await prisma.token_usage_daily.findMany({
    where: { token: { in: rows.map((r) => r.token) }, date: cstToday() },
  }) : [];
  const usageByToken = new Map(usageRows.map((u) => [u.token, u]));

  // mcc_ids → 持有用户数（使用人数）
  const allMccIds = new Set<string>();
  for (const u of usageRows) {
    try { for (const m of JSON.parse(u.mcc_ids || "[]")) allMccIds.add(String(m)); } catch {}
  }
  const mccOwners = allMccIds.size > 0 ? await prisma.google_mcc_accounts.findMany({
    where: { mcc_id: { in: [...allMccIds] }, is_deleted: 0 },
    select: { mcc_id: true, user_id: true },
  }) : [];
  const ownersByMcc = new Map<string, Set<string>>();
  for (const m of mccOwners) {
    const set = ownersByMcc.get(m.mcc_id) || new Set<string>();
    set.add(m.user_id.toString());
    ownersByMcc.set(m.mcc_id, set);
  }

  const data = rows.map((r) => {
    const usage = usageByToken.get(r.token);
    let userCount = 0;
    if (usage) {
      const users = new Set<string>();
      try {
        for (const m of JSON.parse(usage.mcc_ids || "[]")) {
          for (const uid of ownersByMcc.get(String(m)) || []) users.add(uid);
        }
      } catch {}
      userCount = users.size;
    }
    const cooldown = getTokenCooldown(r.token);
    let mccAccess: Record<string, string> = {};
    try { mccAccess = JSON.parse(r.mcc_access || "{}"); } catch {}
    const deniedMccs = Object.entries(mccAccess).filter(([, v]) => v === "denied").map(([k]) => k);
    const okMccs = Object.entries(mccAccess).filter(([, v]) => v === "ok").map(([k]) => k);
    return {
      id: r.id,
      token: r.token,
      token_masked: maskToken(r.token),
      has_sa_json: !!r.service_account_json,
      sa_email: (() => {
        try { return r.service_account_json ? JSON.parse(r.service_account_json).client_email || null : null; } catch { return null; }
      })(),
      daily_quota: r.daily_quota,
      detected_quota: r.detected_quota,
      today_requests: usage?.requests ?? 0,
      today_users: userCount,
      label: r.label,
      is_active: r.is_active,
      created_at: r.created_at,
      cooling_until: cooldown ? cooldown.toISOString() : null,
      // 系统自动标记
      health_status: r.health_status || "unknown",
      health_note: r.health_note,
      last_ok_at: r.last_ok_at,
      ok_mccs: okMccs,
      denied_mccs: deniedMccs,
    };
  });
  return apiSuccess(serializeData(data));
});

/**
 * POST /api/user/team/token-pool
 * 组长新增/编辑 { id?, token, service_account_json?, daily_quota?, label?, is_active? }
 * 编辑时 service_account_json 传空字符串表示保留原值，传 null 表示清除。
 */
export const POST = withLeader(async (req: NextRequest, { user }) => {
  const teamId = await resolveTeamId(user.userId, user.teamId);
  if (!teamId) return apiError("未关联小组");

  const body = await req.json();
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 64) : "";
  const isActive = body.is_active === 0 ? 0 : 1;
  const dailyQuota = Number.isFinite(Number(body.daily_quota)) && Number(body.daily_quota) > 0
    ? Math.floor(Number(body.daily_quota)) : 15000;

  if (!token) return apiError("Token 不能为空");
  if (token.length < MIN_TOKEN_LENGTH || token.length > 64) {
    return apiError(`Token 长度异常（${token.length} 位）。Google Ads Developer Token 一般为 22 位，请检查是否复制完整`);
  }

  // Service Account JSON：新增必填；编辑时空串=保留原值
  const rawSaJson = typeof body.service_account_json === "string" ? body.service_account_json.trim() : "";
  if (rawSaJson) {
    const err = validateSaJson(rawSaJson);
    if (err) return apiError(err);
  }

  if (body.id) {
    const existing = await prisma.team_developer_tokens.findFirst({
      where: { id: BigInt(body.id), team_id: teamId, is_deleted: 0 },
    });
    if (!existing) return apiError("该 Token 记录不存在");
    const dup = await prisma.team_developer_tokens.findFirst({
      where: { team_id: teamId, token, is_deleted: 0, id: { not: existing.id } },
    });
    if (dup) return apiError("该 Token 已存在于本组池中");
    // token 值或配对 JSON 变了 → 之前学到的标记不再可信，重置为 unknown 待重新探测
    const credentialChanged = token !== existing.token || !!rawSaJson;
    await prisma.team_developer_tokens.update({
      where: { id: existing.id },
      data: {
        token,
        label: label || null,
        is_active: isActive,
        daily_quota: dailyQuota,
        ...(rawSaJson ? { service_account_json: rawSaJson } : {}),
        ...(credentialChanged ? {
          health_status: "unknown", health_note: null, mcc_access: null,
          detected_quota: null, quota_detected_at: null,
        } : {}),
      },
    });
    return apiSuccess(null, "保存成功");
  }

  if (!rawSaJson) return apiError("请粘贴该 Token 配对的 Service Account JSON（两者一起存储、一起轮换）");

  const dup = await prisma.team_developer_tokens.findFirst({
    where: { team_id: teamId, token, is_deleted: 0 },
  });
  if (dup) return apiError("该 Token 已存在于本组池中");

  await prisma.team_developer_tokens.create({
    data: {
      team_id: teamId,
      token,
      service_account_json: rawSaJson,
      daily_quota: dailyQuota,
      label: label || null,
      is_active: isActive,
      created_by: BigInt(user.userId),
    },
  });
  return apiSuccess(null, "已加入 Token 池（1 分钟内生效）");
});

/**
 * DELETE /api/user/team/token-pool
 * 组长移除 token { id }（软删）
 */
export const DELETE = withLeader(async (req: NextRequest, { user }) => {
  const teamId = await resolveTeamId(user.userId, user.teamId);
  if (!teamId) return apiError("未关联小组");

  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");

  const existing = await prisma.team_developer_tokens.findFirst({
    where: { id: BigInt(id), team_id: teamId, is_deleted: 0 },
  });
  if (!existing) return apiError("该 Token 记录不存在");

  await prisma.team_developer_tokens.update({
    where: { id: existing.id },
    data: { is_deleted: 1 },
  });
  return apiSuccess(null, "已移除");
});
