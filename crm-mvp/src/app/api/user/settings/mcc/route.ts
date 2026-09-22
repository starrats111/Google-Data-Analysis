import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
import { toBigIntId } from "@/lib/safe-bigint";
import prisma from "@/lib/prisma";
import { detectSheetFormat, type DetectResult } from "@/lib/sheet-sync";
import { logOperation } from "@/lib/operation-log";

/** 保存后自动识别表格结构（CRM 原生 / kyads 格式），失败不阻断保存 */
async function safeDetect(sheetUrl: string | null | undefined): Promise<DetectResult | null> {
  const url = sheetUrl?.trim();
  if (!url) return null;
  try {
    return await detectSheetFormat(url);
  } catch {
    return null;
  }
}

/** 从 Service Account JSON 中安全提取 client_email（用于审计，绝不记录私钥） */
function extractSaEmail(saJson: string | null | undefined): string | null {
  if (!saJson) return null;
  try {
    const o = JSON.parse(saJson);
    return typeof o?.client_email === "string" ? o.client_email : null;
  } catch {
    return null;
  }
}

/**
 * 保存前校验 MCC 凭据：用待保存的 SA + developer_token 对该 MCC 自身做一次只读查询。
 * 通过返回 null；失败返回面向用户的中文错误信息（调用方据此拒绝保存）。
 * 设计目的：杜绝把粘错/失权的服务账号静默落库，导致整批 CID 被误判停用。
 */
async function validateMccCredentials(
  mcc_id: string,
  developer_token: string,
  service_account_json: string,
): Promise<string | null> {
  // 先校验 JSON 结构
  let parsed: { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(service_account_json);
  } catch {
    return "服务账号 JSON 格式无效，请粘贴完整的 Service Account JSON。";
  }
  if (!parsed.client_email || !parsed.private_key) {
    return "服务账号 JSON 缺少 client_email 或 private_key 字段，请检查后重新粘贴。";
  }
  try {
    const { queryGoogleAds } = await import("@/lib/google-ads/client");
    await queryGoogleAds(
      { mcc_id, developer_token: developer_token || "", service_account_json },
      mcc_id,
      "SELECT customer.id FROM customer",
    );
    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `凭据校验未通过，未保存：${msg}`;
  }
}

/**
 * D-348：校验「本号接替哪个旧号」的指向。
 * 通过返回 null（并带回规范化后的值）；失败返回面向用户的中文错误。
 * 约束：同属本人 / 不能指向自己 / 不能成环 / 一个旧号只能被一个新号接替。
 */
async function validateSupersedes(
  rawValue: unknown,
  userId: bigint,
  selfId: bigint | null,
): Promise<{ error: string } | { value: bigint | null }> {
  if (rawValue === null || rawValue === undefined || rawValue === "") return { value: null };
  const targetId = toBigIntId(rawValue);
  if (!targetId) return { error: "「接替旧号」的 ID 格式无效" };
  if (selfId != null && targetId === selfId) return { error: "不能设置为接替自己" };

  const target = await prisma.google_mcc_accounts.findUnique({
    where: { id: targetId },
    select: { id: true, user_id: true, mcc_id: true },
  });
  if (!target) return { error: "「接替旧号」指向的 MCC 不存在" };
  if (target.user_id !== userId) return { error: "「接替旧号」只能选择你自己名下的 MCC" };

  // 一个旧号只能被一个新号接替（DB 有唯一索引兜底，这里给可读的提示）
  const taken = await prisma.google_mcc_accounts.findFirst({
    where: { supersedes_id: targetId, ...(selfId != null ? { id: { not: selfId } } : {}) },
    select: { mcc_id: true, mcc_name: true },
  });
  if (taken) {
    return { error: `旧号 ${target.mcc_id} 已被「${taken.mcc_name || taken.mcc_id}」接替，不能重复指向。` };
  }

  // 成环保护：沿 target 往上走，若回到 selfId 即成环
  if (selfId != null) {
    const seen = new Set<string>([String(targetId)]);
    let cursor = target.id;
    for (;;) {
      const row = await prisma.google_mcc_accounts.findUnique({
        where: { id: cursor },
        select: { supersedes_id: true },
      });
      const next = row?.supersedes_id;
      if (next == null) break;
      if (next === selfId) return { error: "接替关系不能成环" };
      const key = String(next);
      if (seen.has(key)) break; // 已有脏环，不在本次校验范围内
      seen.add(key);
      cursor = next;
    }
  }
  return { value: targetId };
}

// 获取 MCC 账户列表
// D-348：?candidates=1 返回可作为「接替旧号」的记录（含已软删 / 已停用），供下拉选择
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const userId = BigInt(user.userId);
  if (req.nextUrl.searchParams.get("candidates") === "1") {
    const rows = await prisma.google_mcc_accounts.findMany({
      where: { user_id: userId, OR: [{ is_deleted: 1 }, { is_active: 0 }] },
      select: { id: true, mcc_id: true, mcc_name: true, is_deleted: true, is_active: true, supersedes_id: true },
      orderBy: { created_at: "desc" },
    });
    // 已被别的号接替的旧号不再作为候选（一个旧号只能被接替一次）
    const takenRows = await prisma.google_mcc_accounts.findMany({
      where: { user_id: userId, supersedes_id: { not: null } },
      select: { id: true, supersedes_id: true },
    });
    const taken = new Map(takenRows.map((r) => [String(r.supersedes_id), String(r.id)]));
    return apiSuccess(serializeData(rows.map((r) => ({ ...r, takenBy: taken.get(String(r.id)) ?? null }))));
  }

  const accounts = await prisma.google_mcc_accounts.findMany({
    where: { user_id: userId, is_deleted: 0 },
    orderBy: { created_at: "desc" },
  });
  return apiSuccess(serializeData(accounts));
}

// 添加 MCC 账户
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { mcc_id, mcc_name, currency, service_account_json, sheet_url, developer_token, supersedes_id } = await req.json();
  if (!mcc_id) return apiError("MCC ID 不能为空");

  // 2026-07-10 根治：MCC 客户编号统一规范化为 XXX-XXX-XXXX。
  // 历史事故：同一 MCC 被录成 "785-636-5898-"（多个尾横杠）+ "785-636-5898" 两条活跃记录，
  // 广告归属分裂到两条记录上，CID 下拉的 ENABLED 计数全部显示 0。
  const mccDigits = String(mcc_id).replace(/\D/g, "");
  if (mccDigits.length !== 10) {
    return apiError("MCC ID 格式无效，应为 10 位数字的客户编号（如 785-636-5898）");
  }
  const normalizedMccId = `${mccDigits.slice(0, 3)}-${mccDigits.slice(3, 6)}-${mccDigits.slice(6)}`;

  // 查重：同一用户下同号（按纯数字比对，容忍历史脏格式）的活跃 MCC 只允许一条
  const activeMccs = await prisma.google_mcc_accounts.findMany({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
    select: { id: true, mcc_id: true, mcc_name: true },
  });
  const dup = activeMccs.find((m) => m.mcc_id.replace(/\D/g, "") === mccDigits);
  if (dup) {
    return apiError(
      `MCC ${normalizedMccId} 已存在（记录「${dup.mcc_name || dup.mcc_id}」）。同一 MCC 不允许重复添加，否则广告归属会分裂、CID 广告数量显示错误；如需修改凭证或 Sheet，请直接编辑现有记录。`,
    );
  }

  const sa = service_account_json?.trim() || null;
  // 加固①：若提供了服务账号，落库前先做一次只读测试调用，失败则拒绝保存
  if (sa) {
    const errMsg = await validateMccCredentials(normalizedMccId, developer_token?.trim() || "", sa);
    if (errMsg) return apiError(errMsg);
  }

  // D-348：新建时可声明本号接替哪个旧号（代理商转移 / 删号重绑）
  const sup = await validateSupersedes(supersedes_id, BigInt(user.userId), null);
  if ("error" in sup) return apiError(sup.error);

  const account = await prisma.google_mcc_accounts.create({
    data: {
      user_id: BigInt(user.userId),
      mcc_id: normalizedMccId,
      mcc_name: mcc_name?.trim() || null,
      currency: currency || "USD",
      service_account_json: sa,
      sheet_url: sheet_url?.trim() || null,
      developer_token: developer_token?.trim() || null,
      supersedes_id: sup.value,
    },
  });

  // 加固③：审计日志（只记 SA 邮箱，不记私钥）
  await logOperation({
    userId: user.userId,
    username: user.username,
    action: "mcc_create",
    targetType: "mcc",
    targetId: account.id,
      detail: {
      mcc_id: normalizedMccId,
      mcc_name: mcc_name?.trim() || null,
      sa_email: extractSaEmail(sa),
      has_token: !!(developer_token?.trim()),
      supersedes_id: sup.value != null ? String(sup.value) : null,
    },
    req,
  });

  const sheet_format = await safeDetect(sheet_url);
  return apiSuccess(serializeData({ ...account, sheet_format }));
}

// 更新 MCC 账户
export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id, mcc_name, currency, service_account_json, sheet_url, developer_token, is_active, supersedes_id } = await req.json();
  if (!id) return apiError("缺少 ID");
  const parsedId = toBigIntId(id);
  if (!parsedId) return apiError("ID 格式无效");

  // 加固②：属主校验，杜绝越权改他人 MCC（IDOR）
  const existing = await prisma.google_mcc_accounts.findUnique({ where: { id: parsedId } });
  if (!existing || existing.is_deleted === 1) return apiError("MCC 不存在", 404);
  if (existing.user_id !== BigInt(user.userId)) return apiError("无权操作该 MCC", 403);

  const data: Record<string, unknown> = {};
  if (mcc_name !== undefined) data.mcc_name = mcc_name;
  if (currency !== undefined) data.currency = currency;
  // D-163⑤：空串/空白视为「不修改」，与 developer_token 同策略；否则可静默清空 SA 凭证导致 MCC 全线失效
  if (service_account_json !== undefined && service_account_json !== null && String(service_account_json).trim() !== "") {
    data.service_account_json = service_account_json;
  }
  if (sheet_url !== undefined) data.sheet_url = sheet_url;
  if (developer_token !== undefined && developer_token !== "") data.developer_token = developer_token.trim();
  if (is_active !== undefined) data.is_active = is_active;
  // D-348：编辑已有 MCC 时也能设/清「接替旧号」——易诺这类已经建好的号靠这里补指向
  if (supersedes_id !== undefined) {
    const sup = await validateSupersedes(supersedes_id, BigInt(user.userId), parsedId);
    if ("error" in sup) return apiError(sup.error);
    data.supersedes_id = sup.value;
  }

  // 加固①：若本次会修改服务账号，落库前用「待保存的 SA + 最终生效的 token」做只读测试
  const saChanged = service_account_json !== undefined && service_account_json !== null && service_account_json.trim() !== "";
  if (saChanged) {
    const effectiveToken =
      (developer_token !== undefined && developer_token !== "" ? developer_token.trim() : existing.developer_token) || "";
    const errMsg = await validateMccCredentials(existing.mcc_id, effectiveToken, service_account_json.trim());
    if (errMsg) return apiError(errMsg);
    data.service_account_json = service_account_json.trim();
  }

  await prisma.google_mcc_accounts.update({ where: { id: parsedId }, data });

  // 加固③：审计日志，记录 SA 邮箱前后变化（不记私钥）
  const oldEmail = extractSaEmail(existing.service_account_json);
  const newEmail = saChanged ? extractSaEmail(service_account_json) : oldEmail;
  await logOperation({
    userId: user.userId,
    username: user.username,
    action: "mcc_update",
    targetType: "mcc",
    targetId: id,
    detail: {
      mcc_id: existing.mcc_id,
      changed: Object.keys(data),
      sa_email_old: oldEmail,
      sa_email_new: newEmail,
      sa_changed: saChanged,
      token_changed: developer_token !== undefined && developer_token !== "",
    },
    req,
  });

  const sheet_format = sheet_url !== undefined ? await safeDetect(sheet_url) : null;
  return apiSuccess(serializeData({ sheet_format }), "更新成功");
}

// 删除 MCC 账户
export async function DELETE(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id } = await req.json();
  if (!id) return apiError("缺少 ID");
  const parsedId = toBigIntId(id);
  if (!parsedId) return apiError("ID 格式无效");

  // 加固②：属主校验
  const existing = await prisma.google_mcc_accounts.findUnique({ where: { id: parsedId } });
  if (!existing || existing.is_deleted === 1) return apiError("MCC 不存在", 404);
  if (existing.user_id !== BigInt(user.userId)) return apiError("无权操作该 MCC", 403);

  await prisma.google_mcc_accounts.update({ where: { id: parsedId }, data: { is_deleted: 1 } });

  // 加固③：审计日志
  await logOperation({
    userId: user.userId,
    username: user.username,
    action: "mcc_delete",
    targetType: "mcc",
    targetId: id,
    detail: { mcc_id: existing.mcc_id, sa_email: extractSaEmail(existing.service_account_json) },
    req,
  });

  return apiSuccess(null, "删除成功");
}
