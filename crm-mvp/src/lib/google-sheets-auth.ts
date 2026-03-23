/**
 * Google Sheets API 认证
 *
 * 按以下优先级获取 Service Account：
 * 1. 系统配置 system_configs 表（管理员在控制台配置的 google_sheets_sa_json）
 * 2. 环境变量 GOOGLE_SHEETS_SA_KEY
 * 3. 数据库中任意 MCC 账户的 service_account_json
 */
import { JWT } from "google-auth-library";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

let cachedToken: { token: string; expiry: number } | null = null;

async function tokenFromJson(json: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiry - 60_000) {
    return cachedToken.token;
  }
  const sa = JSON.parse(json);
  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [SHEETS_SCOPE],
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("无法获取 Google Sheets access_token");
  cachedToken = { token, expiry: Date.now() + 3500_000 };
  return token;
}

async function findServiceAccountJson(): Promise<string | null> {
  // 1. 系统配置（管理员控制台）
  try {
    const { getGoogleSheetsSaJson } = await import("@/lib/system-config");
    const json = await getGoogleSheetsSaJson();
    if (json && json.trim()) return json;
  } catch { /* table may not exist yet */ }

  // 2. 环境变量
  const envKey = process.env.GOOGLE_SHEETS_SA_KEY;
  if (envKey) return envKey;

  // 3. MCC 账户
  try {
    const prisma = (await import("@/lib/prisma")).default;
    const mcc = await prisma.google_mcc_accounts.findFirst({
      where: { is_deleted: 0, is_active: 1, service_account_json: { not: null } },
      select: { service_account_json: true },
    });
    return mcc?.service_account_json || null;
  } catch {
    return null;
  }
}

export async function getSheetsAccessToken(): Promise<string | null> {
  const json = await findServiceAccountJson();
  if (!json) return null;
  return tokenFromJson(json);
}

export async function getServiceAccountEmail(): Promise<string | null> {
  const json = await findServiceAccountJson();
  if (!json) return null;
  try {
    return JSON.parse(json).client_email || null;
  } catch {
    return null;
  }
}
