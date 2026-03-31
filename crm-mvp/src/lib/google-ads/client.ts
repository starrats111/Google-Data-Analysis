/**
 * Google Ads API 客户端 - 支持 Service Account 认证
 * 通过 google-auth-library JWT 获取 access_token，
 * 然后直接调用 Google Ads REST API
 */
import { JWT } from "google-auth-library";

const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const ADS_API_VERSION = "v23";
const ADS_BASE_URL = `https://googleads.googleapis.com/${ADS_API_VERSION}`;

const MAX_429_RETRIES = 3;
const MAX_429_WAIT_MS = 200_000;

/** 从 Google Ads 429 错误体中提取 retryDelay（秒） */
function parseRetryDelay(errBody: string): number {
  try {
    const match = errBody.match(/"retryDelay"\s*:\s*"(\d+)s?"/);
    if (match) return parseInt(match[1], 10);
  } catch {}
  return 0;
}

/** 等待指定毫秒 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface MccCredentials {
  mcc_id: string;
  developer_token: string;
  service_account_json: string;
}

/**
 * 获取 developer_token：优先 MCC 数据库字段（支持多用户），兜底环境变量
 */
function resolveDevToken(dbToken: string): string {
  return (dbToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim();
}

/**
 * 从 Service Account JSON 创建 JWT 客户端并获取 access_token
 */
async function getAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson);
  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [GOOGLE_ADS_SCOPE],
    subject: sa.subject || undefined,
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("无法从 Service Account 获取 access_token");
  return token;
}

/**
 * 构建 API 请求头
 */
function buildHeaders(accessToken: string, developerToken: string, loginCustomerId: string): Record<string, string> {
  return {
    "Authorization": `Bearer ${accessToken}`,
    "developer-token": developerToken,
    "login-customer-id": loginCustomerId.replace(/-/g, ""),
    "Content-Type": "application/json",
  };
}

/**
 * 执行 Google Ads 查询（GAQL），含 429 自动重试
 */
export async function queryGoogleAds(
  credentials: MccCredentials,
  customerId: string,
  query: string,
): Promise<Record<string, unknown>[]> {
  const cid = customerId.replace(/-/g, "");
  const devToken = resolveDevToken(credentials.developer_token);

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const token = await getAccessToken(credentials.service_account_json);
    const headers = buildHeaders(token, devToken, credentials.mcc_id);
    const apiUrl = `${ADS_BASE_URL}/customers/${cid}/googleAds:searchStream`;
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    });

    if (resp.ok) {
      const data = await resp.json();
      const results: Record<string, unknown>[] = [];
      if (Array.isArray(data)) {
        for (const batch of data) {
          if (Array.isArray(batch.results)) {
            results.push(...batch.results);
          }
        }
      }
      return results;
    }

    const errBody = await resp.text().catch(() => "");

    if (resp.status === 429 || errBody.includes("RESOURCE_EXHAUSTED")) {
      if (attempt < MAX_429_RETRIES) {
        const delaySec = parseRetryDelay(errBody) || 30 * (attempt + 1);
        const delayMs = Math.min(delaySec * 1000, MAX_429_WAIT_MS);
        console.log(`[GoogleAds] 查询触发 429 限流，等待 ${delaySec}s 后重试 (${attempt + 1}/${MAX_429_RETRIES})`);
        await sleep(delayMs);
        continue;
      }
      throw new Error(`Google Ads API 请求频率超限（explorer access 配额较低）。请等待几分钟后再重试，或在 Google Ads API Center 申请更高级别的 API 访问权限。`);
    }

    if (errBody.includes("DEVELOPER_TOKEN_NOT_APPROVED")) {
      throw new Error("Google Ads API 权限错误：Developer Token 仅被批准用于测试账号，无法访问正式广告账号。请在 Google Ads API Center 申请标准访问权限。");
    }
    if (resp.status === 401 || errBody.includes("UNAUTHENTICATED")) {
      throw new Error("Google Ads API 认证失败：Service Account 凭证无效或已过期，请检查 MCC 配置中的服务账号 JSON。");
    }
    if (errBody.includes("has not been used in project")) {
      const projectMatch = errBody.match(/project (\d+)/);
      const projectId = projectMatch?.[1] || "未知";
      throw new Error(`Google Ads API 未启用：Service Account 所属项目（${projectId}）需在 Google Cloud Console 中启用 Google Ads API。`);
    }
    if (errBody.includes("CUSTOMER_NOT_ENABLED") || errBody.includes("not yet enabled or has been deactivated")) {
      throw new Error(`CID ${customerId} 账户未启用或已停用，无法访问。请同步 CID 列表并选择其他可用账户。`);
    }
    throw new Error(`Google Ads API 查询失败 (${resp.status}): ${errBody.slice(0, 500)}`);
  }

  throw new Error("Google Ads API 查询重试次数已耗尽");
}

/**
 * 执行 Google Ads mutate 操作，含 429 自动重试
 */
export async function mutateGoogleAds(
  credentials: MccCredentials,
  customerId: string,
  operations: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const cid = customerId.replace(/-/g, "");
  const devToken = resolveDevToken(credentials.developer_token);

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const token = await getAccessToken(credentials.service_account_json);
    const headers = buildHeaders(token, devToken, credentials.mcc_id);
    const apiUrl = `${ADS_BASE_URL}/customers/${cid}/googleAds:mutate`;
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ mutate_operations: operations }),
    });

    if (resp.ok) {
      return await resp.json();
    }

    const errBody = await resp.text().catch(() => "");

    if (resp.status === 429 || errBody.includes("RESOURCE_EXHAUSTED")) {
      if (attempt < MAX_429_RETRIES) {
        const delaySec = parseRetryDelay(errBody) || 30 * (attempt + 1);
        const delayMs = Math.min(delaySec * 1000, MAX_429_WAIT_MS);
        console.log(`[GoogleAds] Mutate 触发 429 限流，等待 ${delaySec}s 后重试 (${attempt + 1}/${MAX_429_RETRIES})`);
        await sleep(delayMs);
        continue;
      }
      throw new Error(`Google Ads API 请求频率超限（explorer access 配额较低）。请等待几分钟后再重试，或在 Google Ads API Center 申请更高级别的 API 访问权限。`);
    }

    if (errBody.includes("DEVELOPER_TOKEN_NOT_APPROVED")) {
      throw new Error("Google Ads API 权限错误：Developer Token 仅被批准用于测试账号，无法访问正式广告账号。请在 Google Ads API Center 申请标准访问权限。");
    }
    if (resp.status === 401 || errBody.includes("UNAUTHENTICATED")) {
      throw new Error("Google Ads API 认证失败：Service Account 凭证无效或已过期，请检查 MCC 配置中的服务账号 JSON。");
    }
    if (errBody.includes("CUSTOMER_NOT_ENABLED") || errBody.includes("not yet enabled or has been deactivated")) {
      throw new Error(`CID ${customerId} 账户未启用或已停用，无法提交广告。请点击「同步 CID」刷新列表，选择其他可用 CID 后重试。`);
    }
    throw new Error(`Google Ads API 请求失败 (${resp.status}): ${errBody.slice(0, 2000)}`);
  }

  throw new Error("Google Ads API 修改重试次数已耗尽");
}

/**
 * 金额转换：美元 → micros（Google Ads 使用 micros 单位）
 */
export function dollarsToMicros(amount: number): number {
  return Math.round(amount * 100) * 10000;
}

/**
 * 金额转换：micros → 美元
 */
export function microsToDollars(micros: number): number {
  return Number((micros / 1_000_000).toFixed(2));
}

/**
 * 为 google-ads-api 库创建 Service Account Customer
 * 通过 JWT 获取 access_token，注入到 google-ads-api 的 OAuth2 流程中
 */
export async function createServiceAccountCustomer(
  credentials: MccCredentials,
  customerId: string,
) {
  const sa = JSON.parse(credentials.service_account_json);
  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [GOOGLE_ADS_SCOPE],
    subject: sa.subject || undefined,
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("无法从 Service Account 获取 access_token");

  const { GoogleAdsApi } = await import("google-ads-api");
  const client = new GoogleAdsApi({
    client_id: sa.client_id || sa.client_email || "service-account",
    client_secret: sa.client_secret || "not-used-for-sa",
    developer_token: resolveDevToken(credentials.developer_token),
  });

  const customer = client.Customer({
    customer_id: customerId.replace(/-/g, ""),
    login_customer_id: credentials.mcc_id.replace(/-/g, ""),
    refresh_token: "service-account-placeholder",
  });

  // 注入 JWT access_token 到内部 OAuth2Client，跳过 refresh_token 流程
  try {
    const cust = customer as any;
    // google-ads-api 内部会创建一个 OAuth2Client，找到它并设置 access_token
    if (cust.credentials) {
      cust.credentials.access_token = token;
      cust.credentials.expiry_date = Date.now() + 3500000;
    }
    // 另一种内部结构
    if (cust.auth) {
      cust.auth.setCredentials({
        access_token: token,
        token_type: "Bearer",
        expiry_date: Date.now() + 3500000,
      });
    }
    // 第三种：直接在 cust.client 上
    if (cust.client?.auth) {
      cust.client.auth.setCredentials({
        access_token: token,
        token_type: "Bearer",
        expiry_date: Date.now() + 3500000,
      });
    }
  } catch (err) {
    console.warn("[GoogleAds] 注入 access_token 失败，将在 API 调用时重试:", err);
  }

  return customer;
}

// 兼容旧代码
export function createGoogleAdsClient(credentials: MccCredentials) {
  return credentials;
}
