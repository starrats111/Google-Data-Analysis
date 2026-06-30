import { NextRequest } from "next/server";
import { getUserFromRequest, serializeData } from "@/lib/auth";
import { apiSuccess, apiError } from "@/lib/constants";
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

// 获取 MCC 账户列表
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const accounts = await prisma.google_mcc_accounts.findMany({
    where: { user_id: BigInt(user.userId), is_deleted: 0 },
    orderBy: { created_at: "desc" },
  });
  return apiSuccess(serializeData(accounts));
}

// 添加 MCC 账户
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { mcc_id, mcc_name, currency, service_account_json, sheet_url, developer_token } = await req.json();
  if (!mcc_id) return apiError("MCC ID 不能为空");

  const sa = service_account_json?.trim() || null;
  // 加固①：若提供了服务账号，落库前先做一次只读测试调用，失败则拒绝保存
  if (sa) {
    const errMsg = await validateMccCredentials(mcc_id.trim(), developer_token?.trim() || "", sa);
    if (errMsg) return apiError(errMsg);
  }

  const account = await prisma.google_mcc_accounts.create({
    data: {
      user_id: BigInt(user.userId),
      mcc_id: mcc_id.trim(),
      mcc_name: mcc_name?.trim() || null,
      currency: currency || "USD",
      service_account_json: sa,
      sheet_url: sheet_url?.trim() || null,
      developer_token: developer_token?.trim() || null,
    },
  });

  // 加固③：审计日志（只记 SA 邮箱，不记私钥）
  await logOperation({
    userId: user.userId,
    username: user.username,
    action: "mcc_create",
    targetType: "mcc",
    targetId: account.id,
    detail: { mcc_id: mcc_id.trim(), mcc_name: mcc_name?.trim() || null, sa_email: extractSaEmail(sa), has_token: !!(developer_token?.trim()) },
    req,
  });

  const sheet_format = await safeDetect(sheet_url);
  return apiSuccess(serializeData({ ...account, sheet_format }));
}

// 更新 MCC 账户
export async function PUT(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return apiError("未授权", 401);

  const { id, mcc_name, currency, service_account_json, sheet_url, developer_token, is_active } = await req.json();
  if (!id) return apiError("缺少 ID");

  // 加固②：属主校验，杜绝越权改他人 MCC（IDOR）
  const existing = await prisma.google_mcc_accounts.findUnique({ where: { id: BigInt(id) } });
  if (!existing || existing.is_deleted === 1) return apiError("MCC 不存在", 404);
  if (existing.user_id !== BigInt(user.userId)) return apiError("无权操作该 MCC", 403);

  const data: Record<string, unknown> = {};
  if (mcc_name !== undefined) data.mcc_name = mcc_name;
  if (currency !== undefined) data.currency = currency;
  if (service_account_json !== undefined) data.service_account_json = service_account_json;
  if (sheet_url !== undefined) data.sheet_url = sheet_url;
  if (developer_token !== undefined && developer_token !== "") data.developer_token = developer_token.trim();
  if (is_active !== undefined) data.is_active = is_active;

  // 加固①：若本次会修改服务账号，落库前用「待保存的 SA + 最终生效的 token」做只读测试
  const saChanged = service_account_json !== undefined && service_account_json !== null && service_account_json.trim() !== "";
  if (saChanged) {
    const effectiveToken =
      (developer_token !== undefined && developer_token !== "" ? developer_token.trim() : existing.developer_token) || "";
    const errMsg = await validateMccCredentials(existing.mcc_id, effectiveToken, service_account_json.trim());
    if (errMsg) return apiError(errMsg);
    data.service_account_json = service_account_json.trim();
  }

  await prisma.google_mcc_accounts.update({ where: { id: BigInt(id) }, data });

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

  // 加固②：属主校验
  const existing = await prisma.google_mcc_accounts.findUnique({ where: { id: BigInt(id) } });
  if (!existing || existing.is_deleted === 1) return apiError("MCC 不存在", 404);
  if (existing.user_id !== BigInt(user.userId)) return apiError("无权操作该 MCC", 403);

  await prisma.google_mcc_accounts.update({ where: { id: BigInt(id) }, data: { is_deleted: 1 } });

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
