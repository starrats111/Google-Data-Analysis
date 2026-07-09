/**
 * AdsBot Destination Preflight（自 kyads 移植）
 *
 * 背景：Google Ads 审核落地页用的是 AdsBot-Google 爬虫。部分站点/CDN（Cloudflare、
 * Akamai 等）配置了针对 bot UA 的拦截——浏览器访问正常，但 AdsBot 被 403/503，
 * Google 会以 DESTINATION_NOT_WORKING 拒登整条广告。
 *
 * 探测策略（与 kyads lib/ad-create/destination-preflight.ts 一致）：
 * 1. 用 AdsBot UA GET 最终到达网址（含 final_url_suffix），2xx-3xx 视为可达；
 * 2. AdsBot 不可达 → 再用 Chrome UA 复核：
 *    - 浏览器可达而 AdsBot 不可达 → not_publishable_status（强信号：bot 被针对性拦截）
 *    - 两边都不可达 → server_blocked（本服务器出口问题，不能据此下结论）
 *
 * 使用方（submit 硬闸）只对 not_publishable_status 阻断；server_blocked 交由
 * 已有的 D-050 连接级判定处理，避免重复误杀。
 */

export const ADSBOT_USER_AGENT = "AdsBot-Google (+http://www.google.com/adsbot.html)";
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 10_000;

export type DestinationPreflightReason =
  | "reachable"
  | "invalid_url"
  | "not_publishable_status"
  | "server_blocked"
  | "request_error";

export interface DestinationPreflightInput {
  finalUrl: string;
  finalUrlSuffix?: string | null;
}

export interface DestinationPreflightResult {
  ok: boolean;
  checkedUrl: string;
  finalUrl: string;
  reason: DestinationPreflightReason;
  status?: number;
  errorMessage?: string;
  browserStatus?: number;
  browserErrorMessage?: string;
}

export interface DestinationPreflightDeps {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface ProbeResult {
  ok: boolean;
  finalUrl: string;
  status?: number;
  errorMessage?: string;
}

/** 组装探测 URL：finalUrl + final_url_suffix（换链接后缀也一起验证） */
export function buildDestinationCheckUrl(input: DestinationPreflightInput): string {
  const parsed = new URL(input.finalUrl.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported protocol: ${parsed.protocol}`);
  }

  const suffix = (input.finalUrlSuffix ?? "").trim().replace(/^[?&]+/, "");
  if (!suffix) return parsed.toString();

  const hash = parsed.hash;
  parsed.hash = "";
  const withoutHash = parsed.toString();
  return `${withoutHash}${parsed.search ? "&" : "?"}${suffix}${hash}`;
}

async function probeUrl(
  url: string,
  userAgent: string,
  deps: DestinationPreflightDeps,
): Promise<ProbeResult> {
  const request = deps.fetch ?? fetch;
  try {
    const response = await request(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return {
      ok: response.status >= 200 && response.status < 400,
      finalUrl: response.url || url,
      status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      finalUrl: url,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * AdsBot 可达性预检。不抛异常，永远返回结构化结果，由调用方决定阻断策略。
 */
export async function checkAdsBotDestinationReachable(
  input: DestinationPreflightInput,
  deps: DestinationPreflightDeps = {},
): Promise<DestinationPreflightResult> {
  let checkedUrl: string;
  try {
    checkedUrl = buildDestinationCheckUrl(input);
  } catch (error) {
    return {
      ok: false,
      checkedUrl: input.finalUrl,
      finalUrl: input.finalUrl,
      reason: "invalid_url",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const adsBotProbe = await probeUrl(checkedUrl, ADSBOT_USER_AGENT, deps);
  if (adsBotProbe.ok) {
    return {
      ok: true,
      checkedUrl,
      finalUrl: adsBotProbe.finalUrl,
      reason: "reachable",
      status: adsBotProbe.status,
    };
  }

  const browserProbe = await probeUrl(checkedUrl, BROWSER_USER_AGENT, deps);
  return {
    ok: false,
    checkedUrl,
    finalUrl: adsBotProbe.finalUrl || checkedUrl,
    reason: browserProbe.ok ? "not_publishable_status" : "server_blocked",
    status: adsBotProbe.status,
    errorMessage: adsBotProbe.errorMessage,
    browserStatus: browserProbe.status,
    browserErrorMessage: browserProbe.errorMessage,
  };
}
