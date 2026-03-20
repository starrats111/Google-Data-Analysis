/**
 * Google Ads API 客户端 - 支持 Service Account 认证
 * 通过 google-auth-library JWT 获取 access_token，
 * 然后直接调用 Google Ads REST API
 */
import { JWT } from "google-auth-library";

const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const ADS_API_VERSION = "v23";
const ADS_BASE_URL = `https://googleads.googleapis.com/${ADS_API_VERSION}`;

export interface MccCredentials {
  mcc_id: string;
  developer_token: string;
  service_account_json: string;
}

/**
 * 获取 developer_token：优先 MCC 数据库字段（支持多用户），兜底环境变量
 */
function resolveDevToken(dbToken: string): string {
  return dbToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "";
}

/**
 * 从 Service Account JSON 创建 JWT 客户端并获取 access_token
 */
async function getAccessToken(serviceAccountJson: string): Promise<string> {
  const sa = JSON.parse(serviceAccountJson);
  // #region agent log
  fetch('http://127.0.0.1:7366/ingest/05d05002-39c6-4179-a54f-bba78c014ee4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ea79a9'},body:JSON.stringify({sessionId:'ea79a9',location:'client.ts:getAccessToken',message:'JWT auth attempt',data:{email:sa.client_email,hasKey:!!sa.private_key,subject:sa.subject||null},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [GOOGLE_ADS_SCOPE],
    subject: sa.subject || undefined,
  });
  const { token } = await jwt.getAccessToken();
  // #region agent log
  fetch('http://127.0.0.1:7366/ingest/05d05002-39c6-4179-a54f-bba78c014ee4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ea79a9'},body:JSON.stringify({sessionId:'ea79a9',location:'client.ts:getAccessToken',message:'JWT auth result',data:{gotToken:!!token,tokenLen:token?.length||0},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
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
 * 执行 Google Ads 查询（GAQL）
 */
export async function queryGoogleAds(
  credentials: MccCredentials,
  customerId: string,
  query: string,
): Promise<Record<string, unknown>[]> {
  const token = await getAccessToken(credentials.service_account_json);
  const cid = customerId.replace(/-/g, "");
  const devToken = resolveDevToken(credentials.developer_token);
  const headers = buildHeaders(token, devToken, credentials.mcc_id);

  const apiUrl = `${ADS_BASE_URL}/customers/${cid}/googleAds:searchStream`;
  // #region agent log
  fetch('http://127.0.0.1:7366/ingest/05d05002-39c6-4179-a54f-bba78c014ee4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ea79a9'},body:JSON.stringify({sessionId:'ea79a9',location:'client.ts:queryGoogleAds',message:'API request',data:{url:apiUrl,cid,queryStart:query.trim().slice(0,80)},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  const resp = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    // #region agent log
    fetch('http://127.0.0.1:7366/ingest/05d05002-39c6-4179-a54f-bba78c014ee4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ea79a9'},body:JSON.stringify({sessionId:'ea79a9',location:'client.ts:queryGoogleAds',message:'API query error',data:{status:resp.status,url:apiUrl,body:errBody.slice(0,300)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    throw new Error(`Google Ads API 查询失败 (${resp.status}): ${errBody.slice(0, 500)}`);
  }

  const data = await resp.json();
  // searchStream 返回数组，每个元素有 results
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

/**
 * 执行 Google Ads mutate 操作
 */
export async function mutateGoogleAds(
  credentials: MccCredentials,
  customerId: string,
  operations: Record<string, unknown>[],
): Promise<Record<string, unknown>> {
  const token = await getAccessToken(credentials.service_account_json);
  const cid = customerId.replace(/-/g, "");
  const devToken = resolveDevToken(credentials.developer_token);
  const headers = buildHeaders(token, devToken, credentials.mcc_id);

  const apiUrl = `${ADS_BASE_URL}/customers/${cid}/googleAds:mutate`;
  // #region agent log
  fetch('http://127.0.0.1:7366/ingest/05d05002-39c6-4179-a54f-bba78c014ee4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ea79a9'},body:JSON.stringify({sessionId:'ea79a9',location:'client.ts:mutateGoogleAds',message:'mutate request',data:{url:apiUrl,cid,opCount:operations.length},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  const resp = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ mutate_operations: operations }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => "");
    // #region agent log
    fetch('http://127.0.0.1:7366/ingest/05d05002-39c6-4179-a54f-bba78c014ee4',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ea79a9'},body:JSON.stringify({sessionId:'ea79a9',location:'client.ts:mutateGoogleAds',message:'mutate error',data:{status:resp.status,body:errBody.slice(0,300)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    throw new Error(`Google Ads API 修改失败 (${resp.status}): ${errBody.slice(0, 2000)}`);
  }

  return await resp.json();
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
