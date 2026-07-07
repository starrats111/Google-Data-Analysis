/**
 * Google Ads API 客户端 - 支持 Service Account 认证
 * 通过 google-auth-library JWT 获取 access_token，
 * 然后直接调用 Google Ads REST API
 */
import { JWT } from "google-auth-library";
import {
  pickCredential,
  hasAlternativeToken,
  reportTokenRateLimited,
  reportTokenInvalid,
  reportTokenOk,
  reportTokenDeniedForMcc,
  recordTokenUse,
  maskToken,
  type TokenCredential,
} from "./token-pool";

const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const ADS_API_VERSION = "v23";
const ADS_BASE_URL = `https://googleads.googleapis.com/${ADS_API_VERSION}`;

const MAX_429_RETRIES = 1;
// 单次请求内最多轮换几个不同的 Developer Token（429 时立即换 token 重试，不等待）
const MAX_TOKEN_ROTATIONS = 3;
const MAX_429_WAIT_MS = 15_000;
const QUERY_TIMEOUT_MS = 30_000;
const MUTATE_TIMEOUT_MS = 60_000;
// D-065：Google Ads 瞬时错误（INTERNAL_ERROR / DEADLINE_EXCEEDED / 5xx）指数退避重试。
// 官方将这类错误归为 transient，建议退避重试；原子 mutate 失败会整体回滚，重试不会产生重复广告。
const MAX_TRANSIENT_RETRIES = 3;

/** 从 Google Ads 429 错误体中提取 retryDelay（秒） */
function parseRetryDelay(errBody: string): number {
  try {
    const match = errBody.match(/"retryDelay"\s*:\s*"(\d+)s?"/);
    if (match) return parseInt(match[1], 10);
  } catch {}
  return 0;
}

/** Developer Token 本身不可用（未获批/被禁/无效）——与账号权限问题区分开 */
function isDevTokenError(errBody: string): boolean {
  return errBody.includes("DEVELOPER_TOKEN_NOT_APPROVED")
    || errBody.includes("DEVELOPER_TOKEN_PROHIBITED")
    || errBody.includes("DEVELOPER_TOKEN_INVALID");
}

/** 该凭证对当前 login-customer-id（MCC）无访问权限（SA 未被加入该 MCC）——换池中下一个凭证可解 */
function isMccPermissionError(errBody: string): boolean {
  return errBody.includes("USER_PERMISSION_DENIED")
    || (errBody.includes("PERMISSION_DENIED") && errBody.includes("authorizationError"));
}

/**
 * CID 级权限错误可能是「CID 已脱离 MCC」而非「凭证对 MCC 无权限」。
 * 用同一凭证对 MCC 本身发一次最小查询确认：MCC 也拒绝 → 真是凭证问题（可标记）；
 * MCC 通过 → 是 CID 自身的问题（换凭证也没用，不能标记，否则会毒化整个池）。
 */
async function confirmMccLevelDenied(devToken: string, saJson: string, mccKey: string): Promise<boolean> {
  try {
    const accessToken = await getAccessToken(saJson);
    const resp = await fetch(`${ADS_BASE_URL}/customers/${mccKey}/googleAds:search`, {
      method: "POST",
      headers: buildHeaders(accessToken, devToken, mccKey),
      body: JSON.stringify({ query: "SELECT customer.id FROM customer LIMIT 1" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (resp.ok) return false;
    const body = await resp.text().catch(() => "");
    return isMccPermissionError(body);
  } catch {
    return false; // 确认失败（网络等）时不标记，宁可下次再学
  }
}

/** Google Ads API 错误中单个违规项 */
export interface GoogleAdsViolation {
  errorCode: string;
  message: string;
  trigger?: string;
  fieldPath?: string;
  operationIndex?: number;
}

/** 从 Google Ads API 原始错误体中解析出结构化违规信息 */
export function parseGoogleAdsErrors(errBody: string): GoogleAdsViolation[] {
  const violations: GoogleAdsViolation[] = [];
  try {
    const jsonStart = errBody.indexOf("{");
    const jsonEnd = errBody.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd <= jsonStart) return violations;
    const errObj = JSON.parse(errBody.slice(jsonStart, jsonEnd + 1));
    const details = errObj?.error?.details || errObj?.details || [];
    for (const detail of details) {
      const errors = detail?.errors || [];
      for (const e of errors) {
        const codeParts = e?.errorCode ? Object.entries(e.errorCode) : [];
        const codeStr = codeParts.map(([k, v]) => `${k}:${v}`).join(", ");
        const elements = e?.location?.fieldPathElements || [];
        let opIdx: number | undefined;
        const pathParts: string[] = [];
        for (const el of elements) {
          pathParts.push(el.index != null ? `${el.fieldName}[${el.index}]` : el.fieldName);
          if (el.fieldName === "mutate_operations" && el.index != null) {
            opIdx = Number(el.index);
          }
        }
        violations.push({
          errorCode: codeStr || "UNKNOWN",
          message: e?.message || "",
          trigger: e?.trigger?.stringValue || e?.trigger?.int64Value || undefined,
          fieldPath: pathParts.join(" > ") || undefined,
          operationIndex: opIdx,
        });
      }
    }
  } catch {}
  return violations;
}

const POLICY_ERROR_CODE_LABELS: Record<string, string> = {
  "POLICY_ERROR": "政策违规",
  "PROHIBITED_CONTENT": "内容被禁止",
  "TRADEMARK_VIOLATION": "商标侵权",
  "ADULT_CONTENT": "成人内容",
  "GAMBLING_CONTENT": "赌博内容",
  "HEALTHCARE_CONTENT": "医疗保健受限内容",
  "ALCOHOL_CONTENT": "酒精相关受限内容",
};

/** 将 Google Ads API 的技术 trigger 值翻译成人类可读的中文 */
function translateTrigger(trigger: string, errorCode: string): string {
  // 临时资源名（如 -2、-3）是级联失败标识，直接返回空表示跳过
  if (/^-\d+$/.test(trigger.trim())) return "";

  // 已知广告频道类型枚举
  const channelLabels: Record<string, string> = {
    "SEARCH": "搜索广告（SEARCH）",
    "DISPLAY": "展示广告（DISPLAY）",
    "SHOPPING": "购物广告（SHOPPING）",
    "VIDEO": "视频广告（VIDEO）",
    "MULTI_CHANNEL": "多频道广告",
    "LOCAL": "本地广告",
    "SMART": "智能广告",
    "PERFORMANCE_MAX": "效果最大化广告",
  };
  if (channelLabels[trigger]) return channelLabels[trigger];

  return `「${trigger}」`;
}

/** 将结构化违规信息格式化为用户可读的中文描述 */
export function formatGoogleAdsErrorMessage(violations: GoogleAdsViolation[], rawStatus?: number): string {
  if (violations.length === 0) return "";

  const hasPolicyError = violations.some((v) =>
    v.errorCode.includes("POLICY_ERROR") || v.errorCode.includes("policyViolationError")
  );

  // 判断是否为 "操作不被当前账户支持" 类错误（含级联失败）
  const hasContextError = violations.some((v) =>
    v.errorCode.includes("operationNotPermittedForContext")
    || v.errorCode.includes("OPERATION_NOT_PERMITTED")
    || v.message.toLowerCase().includes("not allowed for the given context")
  );

  // 过滤掉触发值为临时资源名的纯级联失败（如 "-2"、"-3"），它们不是真正的错误来源
  const cascadePattern = /^-\d+$/;
  const primaryViolations = violations.filter((v) => {
    if (v.trigger && cascadePattern.test(v.trigger.trim())) return false;
    // 消息为 "Resource was not found" 且触发值为临时资源名，则是级联失败
    if (v.message?.includes("Resource was not found") && v.trigger && cascadePattern.test(v.trigger.trim())) return false;
    return true;
  });
  const cascadeCount = violations.length - primaryViolations.length;

  const lines: string[] = [];

  if (hasContextError && !hasPolicyError) {
    // 找到具体是哪种资源/频道不被支持
    const contextViolation = primaryViolations.find((v) =>
      v.errorCode.includes("operationNotPermittedForContext")
      || v.message.toLowerCase().includes("not allowed for the given context")
    );
    const channelTrigger = contextViolation?.trigger || "";
    const channelLabel = channelTrigger ? translateTrigger(channelTrigger, contextViolation?.errorCode || "") : "";

    if (channelLabel) {
      lines.push(`当前 Google Ads 账户（CID）不支持创建「${channelLabel.replace(/（.*?）/, "")}」类型广告，系统将自动尝试切换到其他可用账户。`);
      lines.push(`如问题持续，请在「MCC 管理」中检查账户权限，或联系 Google Ads 支持开启该广告类型。`);
    } else {
      lines.push("当前账户（CID）不支持此广告操作，系统将自动尝试切换到其他可用账户。");
    }
    if (cascadeCount > 0) {
      lines.push(`（另有 ${cascadeCount} 个关联操作因账户限制同步失败，不影响切换后的重新提交）`);
    }
    return lines.join("\n");
  }

  if (hasPolicyError) {
    lines.push("广告内容违反了 Google Ads 政策规定，以下内容被拒绝：");
  } else {
    lines.push("Google Ads 请求包含无效参数：");
  }

  const seen = new Set<string>();
  const violationsToShow = primaryViolations.length > 0 ? primaryViolations : violations;
  for (const v of violationsToShow) {
    const parts: string[] = [];
    if (v.trigger) {
      const dedup = `trigger:${v.trigger}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      const label = translateTrigger(v.trigger, v.errorCode);
      if (!label) continue; // 级联失败，跳过
      parts.push(label);
    }
    const policyLabel = Object.entries(POLICY_ERROR_CODE_LABELS)
      .find(([code]) => v.errorCode.includes(code))?.[1];
    if (policyLabel) {
      parts.push(`(${policyLabel})`);
    }
    if (v.message && !v.message.includes("See PolicyViolationDetails")) {
      parts.push(`— ${v.message}`);
    }
    if (parts.length > 0) {
      lines.push(`• ${parts.join(" ")}`);
    }
  }

  if (cascadeCount > 0 && !hasPolicyError) {
    lines.push(`（另有 ${cascadeCount} 个操作因上述错误级联失败，已自动忽略）`);
  }

  if (hasPolicyError) {
    lines.push("请修改上述内容后重新提交。如需了解详情，请参阅 Google Ads 广告政策: https://support.google.com/adspolicy/answer/6008942");
  }

  return lines.join("\n");
}

/** 检查 violations 是否为"当前账户不支持此操作"类错误（需要换 CID 重试） */
export function isOperationNotPermittedError(violations: GoogleAdsViolation[]): boolean {
  return violations.some((v) =>
    v.errorCode.includes("operationNotPermittedForContext")
    || v.message.toLowerCase().includes("not allowed for the given context")
  );
}

/** 等待指定毫秒 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface MccCredentials {
  mcc_id: string;
  developer_token: string;
  /** MCC 自己配置的 Service Account JSON；可为空——组 Token 池配了配对 JSON 时无需员工配置 */
  service_account_json: string;
}

/**
 * 获取 developer_token：优先 MCC 数据库字段（支持多用户），兜底环境变量
 */
function resolveDevToken(dbToken: string): string {
  return (dbToken || process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim();
}

/** MCC 自带凭证对（token 池的兜底候选） */
function ownCredential(credentials: MccCredentials): TokenCredential {
  return {
    token: resolveDevToken(credentials.developer_token),
    saJson: (credentials.service_account_json || "").trim() || null,
  };
}

/** 解析本次请求实际使用的 Service Account JSON：配对 JSON 优先，MCC 自带兜底 */
function resolveSaJson(cred: TokenCredential, own: TokenCredential): string {
  const saJson = cred.saJson || own.saJson;
  if (!saJson) {
    throw new Error(
      "该 MCC 未配置服务账号，且组 Token 池中无配对的 Service Account JSON。" +
      "请让组长在「团队设置 → Token 池」为 Token 配上 JSON，或在 MCC 管理中填写服务账号。",
    );
  }
  return saJson;
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
  const own = ownCredential(credentials);
  const triedTokens = new Set<string>();
  let rotations = 0;
  let waits429 = 0;
  const HARD_CAP = MAX_TOKEN_ROTATIONS + MAX_429_RETRIES + 1;

  for (let attempt = 0; attempt <= HARD_CAP; attempt++) {
    const cred = (await pickCredential(own, credentials.mcc_id, triedTokens)) || own;
    const devToken = cred.token;
    const token = await getAccessToken(resolveSaJson(cred, own));
    const headers = buildHeaders(token, devToken, credentials.mcc_id);
    const apiUrl = `${ADS_BASE_URL}/customers/${cid}/googleAds:searchStream`;
    recordTokenUse(devToken, credentials.mcc_id);
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });

    if (resp.ok) {
      reportTokenOk(devToken, credentials.mcc_id);
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
      const delaySec = parseRetryDelay(errBody) || 10;
      reportTokenRateLimited(devToken, delaySec, errBody);
      triedTokens.add(devToken);
      // 优先立即换池中另一个 token 重试（不等待）
      if (rotations < MAX_TOKEN_ROTATIONS && await hasAlternativeToken(own, credentials.mcc_id, triedTokens)) {
        rotations++;
        console.warn(`[GoogleAds] 查询 429，token ${maskToken(devToken)} 冷却，换池中下一个 token 重试 (${rotations}/${MAX_TOKEN_ROTATIONS})`);
        continue;
      }
      // 池已耗尽：退回等待重试
      if (waits429 < MAX_429_RETRIES) {
        waits429++;
        const delayMs = Math.min(delaySec * 1000, MAX_429_WAIT_MS);
        console.warn(`[GoogleAds] 查询触发 429 限流且 token 池已耗尽，等待 ${delaySec}s 后重试 (${waits429}/${MAX_429_RETRIES})`);
        await sleep(delayMs);
        continue;
      }
      throw new Error(`Google Ads API 请求频率超限（token 池全部触发限流）。请等待几分钟后再重试，或在池中补充更多 Developer Token。`);
    }

    if (isDevTokenError(errBody)) {
      reportTokenInvalid(devToken);
      triedTokens.add(devToken);
      if (await hasAlternativeToken(own, credentials.mcc_id, triedTokens)) {
        console.warn(`[GoogleAds] token ${maskToken(devToken)} 未获批，换池中下一个 token 重试`);
        continue;
      }
      throw new Error("Google Ads API 权限错误：Developer Token 仅被批准用于测试账号，无法访问正式广告账号。请在 Google Ads API Center 申请标准访问权限。");
    }
    if (isMccPermissionError(errBody)) {
      const mccKey = credentials.mcc_id.replace(/-/g, "");
      // 先确认是凭证对 MCC 无权限，还是 CID 自身的问题（后者换凭证无解，且不能标记凭证）
      if (cid !== mccKey && !(await confirmMccLevelDenied(devToken, resolveSaJson(cred, own), mccKey))) {
        throw new Error(`CID ${customerId} 无访问权限（USER_PERMISSION_DENIED）：该 CID 可能已脱离 MCC 或未授权，请同步 CID 列表后重试。`);
      }
      reportTokenDeniedForMcc(devToken, credentials.mcc_id);
      triedTokens.add(devToken);
      if (await hasAlternativeToken(own, credentials.mcc_id, triedTokens)) {
        console.warn(`[GoogleAds] 凭证 ${maskToken(devToken)} 对 MCC ${credentials.mcc_id} 无权限，换池中下一个凭证重试`);
        continue;
      }
      throw new Error(`Google Ads API 权限错误：池中凭证对 MCC ${credentials.mcc_id} 均无访问权限。请确认服务账号已被加入该 MCC（USER_PERMISSION_DENIED）。`);
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
  const own = ownCredential(credentials);
  const triedTokens = new Set<string>();

  let rotations = 0;
  let rateLimitRetries = 0;
  let transientRetries = 0;
  // 硬上限：避免任何意外导致死循环
  const HARD_CAP = MAX_TOKEN_ROTATIONS + MAX_429_RETRIES + MAX_TRANSIENT_RETRIES + 2;

  for (let iteration = 0; iteration <= HARD_CAP; iteration++) {
    const cred = (await pickCredential(own, credentials.mcc_id, triedTokens)) || own;
    const devToken = cred.token;
    const token = await getAccessToken(resolveSaJson(cred, own));
    const headers = buildHeaders(token, devToken, credentials.mcc_id);
    const apiUrl = `${ADS_BASE_URL}/customers/${cid}/googleAds:mutate`;
    recordTokenUse(devToken, credentials.mcc_id);
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ mutate_operations: operations }),
      signal: AbortSignal.timeout(MUTATE_TIMEOUT_MS),
    });

    if (resp.ok) {
      reportTokenOk(devToken, credentials.mcc_id);
      return await resp.json();
    }

    const errBody = await resp.text().catch(() => "");

    if (resp.status === 429 || errBody.includes("RESOURCE_EXHAUSTED")) {
      const delaySec = parseRetryDelay(errBody) || 10;
      reportTokenRateLimited(devToken, delaySec, errBody);
      triedTokens.add(devToken);
      // 429 时 Google 未执行任何变更（RESOURCE_EXHAUSTED 在配额检查阶段拒绝），换 token 重试安全
      if (rotations < MAX_TOKEN_ROTATIONS && await hasAlternativeToken(own, credentials.mcc_id, triedTokens)) {
        rotations++;
        console.warn(`[GoogleAds] Mutate 429，token ${maskToken(devToken)} 冷却，换池中下一个 token 重试 (${rotations}/${MAX_TOKEN_ROTATIONS})`);
        continue;
      }
      if (rateLimitRetries < MAX_429_RETRIES) {
        rateLimitRetries++;
        const delayMs = Math.min(delaySec * 1000, MAX_429_WAIT_MS);
        console.warn(`[GoogleAds] Mutate 触发 429 限流且 token 池已耗尽，等待 ${delaySec}s 后重试 (${rateLimitRetries}/${MAX_429_RETRIES})`);
        await sleep(delayMs);
        continue;
      }
      throw new Error(`Google Ads API 请求频率超限（token 池全部触发限流）。请等待几分钟后再重试，或在池中补充更多 Developer Token。`);
    }

    // D-065：瞬时错误（Google 侧 INTERNAL_ERROR / DEADLINE_EXCEEDED / 5xx）→ 指数退避重试。
    // 只认 status=INTERNAL/DEADLINE_EXCEEDED 或 internalError，避免把真正的 INVALID_ARGUMENT/政策违规误判为瞬时。
    const isTransient =
      resp.status === 500 || resp.status === 503 || resp.status === 504 ||
      errBody.includes("INTERNAL_ERROR") ||
      errBody.includes("\"status\": \"INTERNAL\"") ||
      errBody.includes("DEADLINE_EXCEEDED") ||
      errBody.includes("\"status\": \"UNAVAILABLE\"");
    if (isTransient && transientRetries < MAX_TRANSIENT_RETRIES) {
      transientRetries++;
      const delayMs = Math.min(2000 * 2 ** (transientRetries - 1), 12_000); // 2s,4s,8s
      console.warn(
        `[GoogleAds] Mutate 触发瞬时错误（status=${resp.status}，疑似 Google 侧 INTERNAL/UNAVAILABLE），` +
          `指数退避 ${delayMs}ms 后重试 (${transientRetries}/${MAX_TRANSIENT_RETRIES})`,
      );
      await sleep(delayMs);
      continue;
    }
    // 瞬时错误重试已耗尽：给出明确的"Google 侧临时故障"提示，而非误导性的"无效参数"
    if (isTransient) {
      throw new Error(
        `Google Ads 服务暂时不可用（Google 侧内部错误 INTERNAL_ERROR / 服务抖动），系统已自动退避重试 ${MAX_TRANSIENT_RETRIES} 次仍未成功。` +
          `这通常是 Google API 短时故障，与你的广告内容无关，请稍等 1-2 分钟后重新提交即可。`,
      );
    }

    if (isDevTokenError(errBody)) {
      reportTokenInvalid(devToken);
      triedTokens.add(devToken);
      if (await hasAlternativeToken(own, credentials.mcc_id, triedTokens)) {
        console.warn(`[GoogleAds] token ${maskToken(devToken)} 未获批，换池中下一个 token 重试`);
        continue;
      }
      throw new Error("Google Ads API 权限错误：Developer Token 仅被批准用于测试账号，无法访问正式广告账号。请在 Google Ads API Center 申请标准访问权限。");
    }
    if (isMccPermissionError(errBody)) {
      const mccKey = credentials.mcc_id.replace(/-/g, "");
      if (cid !== mccKey && !(await confirmMccLevelDenied(devToken, resolveSaJson(cred, own), mccKey))) {
        throw new Error(`CID ${customerId} 无访问权限（USER_PERMISSION_DENIED）：该 CID 可能已脱离 MCC 或未授权，请同步 CID 列表后重试。`);
      }
      reportTokenDeniedForMcc(devToken, credentials.mcc_id);
      triedTokens.add(devToken);
      // mutate 在权限校验阶段被拒，Google 未执行任何变更，换凭证重试安全
      if (await hasAlternativeToken(own, credentials.mcc_id, triedTokens)) {
        console.warn(`[GoogleAds] 凭证 ${maskToken(devToken)} 对 MCC ${credentials.mcc_id} 无权限，换池中下一个凭证重试`);
        continue;
      }
      throw new Error(`Google Ads API 权限错误：池中凭证对 MCC ${credentials.mcc_id} 均无访问权限。请确认服务账号已被加入该 MCC（USER_PERMISSION_DENIED）。`);
    }
    if (resp.status === 401 || errBody.includes("UNAUTHENTICATED")) {
      throw new Error("Google Ads API 认证失败：Service Account 凭证无效或已过期，请检查 MCC 配置中的服务账号 JSON。");
    }
    if (errBody.includes("CUSTOMER_NOT_ENABLED") || errBody.includes("not yet enabled or has been deactivated")) {
      throw new Error(`CID ${customerId} 账户未启用或已停用，无法提交广告。请点击「同步 CID」刷新列表，选择其他可用 CID 后重试。`);
    }
    const violations = parseGoogleAdsErrors(errBody);
    if (violations.length > 0) {
      const friendlyMsg = formatGoogleAdsErrorMessage(violations, resp.status);
      const err = new Error(friendlyMsg) as Error & { violations: GoogleAdsViolation[]; rawBody: string };
      err.violations = violations;
      // D-085：政策错误体在操作多时很大，policyViolationDetails 往往在 3000 字之后。
      // 旧截断 3000 会把 externalPolicyName/violatingText 切掉，导致 policy-hub 深度解析
      // 拿到残缺 JSON → readableMessage 为空 → 上层落到「广告系列名当违规内容」的乱码兜底。
      err.rawBody = errBody.slice(0, 20000);
      throw err;
    }
    throw new Error(`Google Ads API 请求失败 (${resp.status}): ${errBody.slice(0, 2000)}`);
  }

  throw new Error("Google Ads API 修改重试次数已耗尽");
}

export interface UnlinkCidResult {
  /** 是否真正执行了置 INACTIVE 的 mutate */
  unlinked: boolean;
  /** 该 CID 与此 MCC 之间不存在 ACTIVE 关联（已解绑/从未绑定），无需操作 */
  alreadyInactive: boolean;
  /** Google Ads 返回的 customerClientLink 资源名 */
  resourceName?: string;
}

/**
 * 从 MCC（manager）侧将某个子账户 CID 解绑（移除管理关系）。
 *
 * 机制：先以 MCC 为目标查 `customer_client_link` 拿到该 CID 对应的 resource_name + status，
 * 若存在 ACTIVE 关联，则调用专用端点 `customers/{MCC}/customerClientLinks:mutate`
 * 把 `status` 置为 `INACTIVE`（即从 MCC 解绑该客户账户）。
 *
 * ⚠️ 不可逆：解绑后该 MCC 不再管理此账户、拉不到其数据；恢复需重新邀请并由对方接受。
 * ⚠️ 需 Service Account 在该 MCC 具备管理权限，否则 PERMISSION_DENIED。
 */
export async function unlinkCidFromMcc(
  credentials: MccCredentials,
  customerId: string,
): Promise<UnlinkCidResult> {
  const mcc = credentials.mcc_id.replace(/-/g, "");
  const cid = customerId.replace(/-/g, "");

  // 1) 从 MCC 侧查该 CID 的 client link
  const rows = await queryGoogleAds(credentials, credentials.mcc_id, `
    SELECT
      customer_client_link.resource_name,
      customer_client_link.client_customer,
      customer_client_link.manager_link_id,
      customer_client_link.status
    FROM customer_client_link
    WHERE customer_client_link.client_customer = 'customers/${cid}'
  `);

  let resourceName = "";
  let foundActive = false;
  for (const row of rows) {
    const link = row.customerClientLink as Record<string, unknown> | undefined;
    const rn = String(link?.resourceName ?? "");
    const status = String(link?.status ?? "");
    if (rn && !resourceName) resourceName = rn;
    if (status === "ACTIVE" && rn) {
      resourceName = rn;
      foundActive = true;
      break;
    }
  }

  if (!foundActive) {
    return { unlinked: false, alreadyInactive: true, resourceName: resourceName || undefined };
  }

  // 2) 置 INACTIVE（专用端点 customerClientLinks:mutate，单 operation）
  const own = ownCredential(credentials);
  const cred = (await pickCredential(own, credentials.mcc_id)) || own;
  const token = await getAccessToken(resolveSaJson(cred, own));
  const headers = buildHeaders(token, cred.token, credentials.mcc_id);
  recordTokenUse(cred.token, credentials.mcc_id);
  const apiUrl = `${ADS_BASE_URL}/customers/${mcc}/customerClientLinks:mutate`;
  const resp = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      operation: {
        update: { resourceName, status: "INACTIVE" },
        updateMask: "status",
      },
    }),
    signal: AbortSignal.timeout(MUTATE_TIMEOUT_MS),
  });

  if (resp.ok) {
    return { unlinked: true, alreadyInactive: false, resourceName };
  }

  const errBody = await resp.text().catch(() => "");
  if (resp.status === 401 || errBody.includes("UNAUTHENTICATED")) {
    throw new Error("解绑失败：Google Ads 认证失败，Service Account 凭证无效或已过期，请检查该 MCC 配置的服务账号 JSON。");
  }
  if (errBody.includes("PERMISSION_DENIED")) {
    throw new Error("解绑失败：Service Account 在该 MCC 无管理权限（PERMISSION_DENIED），无法从 MCC 移除该 CID。请确认该服务账号在此 MCC 拥有管理员权限。");
  }
  if (errBody.includes("DEVELOPER_TOKEN_NOT_APPROVED")) {
    throw new Error("解绑失败：Developer Token 仅被批准用于测试账号，无法操作正式账号。请在 Google Ads API Center 申请标准访问权限。");
  }
  const violations = parseGoogleAdsErrors(errBody);
  if (violations.length > 0) {
    throw new Error(formatGoogleAdsErrorMessage(violations, resp.status) || `从 MCC 移除 CID 失败 (${resp.status})`);
  }
  throw new Error(`从 MCC 移除 CID 失败 (${resp.status}): ${errBody.slice(0, 800)}`);
}

/**
 * 金额转换：美元 → micros（Google Ads 使用 micros 单位）
 */
export function dollarsToMicros(amount: number): number {
  return Math.round(amount * 100) * 10000;
}

/**
 * 金额转换：micros → 美元（保留6位小数，由存储层控制最终精度）
 * 不在此处 toFixed(2) 截断：多条记录若各自提前截断再汇总，会引入累积舍入误差。
 * Google Ads 后台是先汇总所有 micros 再除以 1e6，我们存储全精度后在 DB 聚合，
 * 保证与官方数值偏差不超过 ±$0.01。
 */
export function microsToDollars(micros: number): number {
  return micros / 1_000_000;
}

/**
 * 为 google-ads-api 库创建 Service Account Customer
 * 通过 JWT 获取 access_token，注入到 google-ads-api 的 OAuth2 流程中
 */
export async function createServiceAccountCustomer(
  credentials: MccCredentials,
  customerId: string,
) {
  const own = ownCredential(credentials);
  const cred = (await pickCredential(own, credentials.mcc_id)) || own;
  const sa = JSON.parse(resolveSaJson(cred, own));
  const jwt = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: [GOOGLE_ADS_SCOPE],
    subject: sa.subject || undefined,
  });
  const { token } = await jwt.getAccessToken();
  if (!token) throw new Error("无法从 Service Account 获取 access_token");
  recordTokenUse(cred.token, credentials.mcc_id);

  const { GoogleAdsApi } = await import("google-ads-api");
  const client = new GoogleAdsApi({
    client_id: sa.client_id || sa.client_email || "service-account",
    client_secret: sa.client_secret || "not-used-for-sa",
    developer_token: cred.token,
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
