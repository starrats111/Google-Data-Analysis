import type { Agent } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import {
  buildProxyAgent,
  loadProxyConfig,
  type BuiltProxyAgent,
  type LoadedProxyConfig,
} from "@/lib/rival-intel/deps/proxy";
import {
  detectExitIp,
  type ExitIpInfo,
} from "@/lib/rival-intel/deps/proxy";

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 512 * 1024;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface CountryAwareProbeContext {
  countryCode: string;
  proxyTrusted: boolean;
  proxyWarning?: string;
  proxyIp?: string;
  proxyCountryCode?: string;
  proxyUrl?: string;
  agent?: Agent;
}

export interface ProbeRequestResult {
  status: number;
  finalUrl: string;
  body: string;
}

export interface ProbeResult {
  url: string;
  finalUrl: string;
  publishable: boolean;
  headStatus: string;
  getStatus: string;
  reason: "reachable" | "proxy_untrusted" | "not_publishable_status" | "request_error";
  proxyIp?: string;
  proxyCountryCode?: string;
  proxyWarning?: string;
}

export interface HtmlFetchResult {
  ok: boolean;
  url: string;
  finalUrl: string;
  status: string;
  html?: string;
  reason: "ok" | "proxy_untrusted" | "not_ok_status" | "request_error";
  proxyIp?: string;
  proxyCountryCode?: string;
  proxyWarning?: string;
}

export interface CountryAwareProbeDeps {
  loadProxyConfig?: (countryCode: string) => Promise<LoadedProxyConfig | null>;
  buildProxyAgent?: (cfg: LoadedProxyConfig) => BuiltProxyAgent | null;
  detectExitIp?: (agent?: Agent) => Promise<ExitIpInfo | null>;
  request?: (
    url: string,
    init: { method: "HEAD" | "GET"; agent?: Agent; timeoutMs?: number },
  ) => Promise<ProbeRequestResult>;
}

export async function createCountryAwareProbeContext(
  countryCode: string,
  deps: CountryAwareProbeDeps = {},
): Promise<CountryAwareProbeContext> {
  const targetCountry = normalizeCountryCode(countryCode);
  if (!targetCountry) {
    return {
      countryCode: "",
      proxyTrusted: false,
      proxyWarning: "投放国家为空，无法使用国家代理验证站内链接",
    };
  }

  const loadConfig = deps.loadProxyConfig ?? loadProxyConfig;
  const cfg = await loadConfig(targetCountry);
  if (!cfg) {
    return {
      countryCode: targetCountry,
      proxyTrusted: false,
      proxyWarning: `未配置 ${targetCountry} 代理，已跳过站内链接验证`,
    };
  }

  const buildAgent = deps.buildProxyAgent ?? buildProxyAgent;
  const builtProxy = buildAgent(cfg);
  if (!builtProxy) {
    return {
      countryCode: targetCountry,
      proxyTrusted: false,
      proxyWarning: `${targetCountry} 代理未启用或配置无效，已跳过站内链接验证`,
    };
  }

  const detect = deps.detectExitIp ?? detectExitIp;
  const exitIp = await detect(builtProxy.agent).catch(() => null);
  const proxyCountry = normalizeCountryCode(exitIp?.countryCode);
  if (!exitIp?.ip || !proxyCountry) {
    return {
      countryCode: targetCountry,
      proxyTrusted: false,
      proxyUrl: builtProxy.url,
      agent: builtProxy.agent,
      proxyWarning: `${targetCountry} 代理出口国家检测失败，已跳过站内链接验证`,
    };
  }

  const baseContext = {
    countryCode: targetCountry,
    proxyIp: exitIp.ip,
    proxyCountryCode: proxyCountry,
    proxyUrl: builtProxy.url,
    agent: builtProxy.agent,
  };

  if (proxyCountry !== targetCountry) {
    return {
      ...baseContext,
      proxyTrusted: false,
      proxyWarning: `代理出口国家 ${proxyCountry} 与投放国家 ${targetCountry} 不匹配，已跳过站内链接验证`,
    };
  }

  return {
    ...baseContext,
    proxyTrusted: true,
  };
}

export async function probeUrlForGoogleAds(
  url: string,
  context: CountryAwareProbeContext,
  deps: CountryAwareProbeDeps = {},
): Promise<ProbeResult> {
  if (!context.proxyTrusted) {
    return {
      url,
      finalUrl: url,
      publishable: false,
      headStatus: "SKIPPED",
      getStatus: "SKIPPED",
      reason: "proxy_untrusted",
      proxyIp: context.proxyIp,
      proxyCountryCode: context.proxyCountryCode,
      proxyWarning: context.proxyWarning,
    };
  }

  const request = deps.request ?? requestWithRedirects;
  let head: ProbeRequestResult;
  try {
    head = await request(url, { method: "HEAD", agent: context.agent, timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (err) {
    head = { status: 0, finalUrl: url, body: errorStatus(err) };
  }

  if (isPublishableStatus(head.status)) {
    return buildProbeResult(url, context, head.finalUrl, true, String(head.status), "SKIPPED", "reachable");
  }

  let get: ProbeRequestResult;
  try {
    get = await request(url, { method: "GET", agent: context.agent, timeoutMs: DEFAULT_TIMEOUT_MS });
  } catch (err) {
    get = { status: 0, finalUrl: head.finalUrl || url, body: errorStatus(err) };
  }

  if (isPublishableStatus(get.status)) {
    return buildProbeResult(url, context, get.finalUrl, true, String(head.status), String(get.status), "reachable");
  }

  return buildProbeResult(
    url,
    context,
    get.finalUrl || head.finalUrl || url,
    false,
    statusLabel(head),
    statusLabel(get),
    head.status === 0 || get.status === 0 ? "request_error" : "not_publishable_status",
  );
}

export async function fetchHtmlForSitelinkDiscovery(
  url: string,
  context: CountryAwareProbeContext,
  deps: CountryAwareProbeDeps = {},
): Promise<HtmlFetchResult> {
  if (!context.proxyTrusted) {
    return {
      ok: false,
      url,
      finalUrl: url,
      status: "SKIPPED",
      reason: "proxy_untrusted",
      proxyIp: context.proxyIp,
      proxyCountryCode: context.proxyCountryCode,
      proxyWarning: context.proxyWarning,
    };
  }

  const request = deps.request ?? requestWithRedirects;
  try {
    const response = await request(url, { method: "GET", agent: context.agent, timeoutMs: 10_000 });
    if (!isPublishableStatus(response.status)) {
      return {
        ok: false,
        url,
        finalUrl: response.finalUrl,
        status: String(response.status),
        reason: "not_ok_status",
        proxyIp: context.proxyIp,
        proxyCountryCode: context.proxyCountryCode,
        proxyWarning: context.proxyWarning,
      };
    }
    return {
      ok: true,
      url,
      finalUrl: response.finalUrl,
      status: String(response.status),
      html: response.body,
      reason: "ok",
      proxyIp: context.proxyIp,
      proxyCountryCode: context.proxyCountryCode,
      proxyWarning: context.proxyWarning,
    };
  } catch {
    return {
      ok: false,
      url,
      finalUrl: url,
      status: "ERROR",
      reason: "request_error",
      proxyIp: context.proxyIp,
      proxyCountryCode: context.proxyCountryCode,
      proxyWarning: context.proxyWarning,
    };
  }
}

async function requestWithRedirects(
  url: string,
  init: { method: "HEAD" | "GET"; agent?: Agent; timeoutMs?: number },
): Promise<ProbeRequestResult> {
  let currentUrl = url;
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const response = await requestOnce(currentUrl, init);
    if (response.status >= 300 && response.status < 400 && response.body) {
      currentUrl = new URL(response.body, currentUrl).toString();
      continue;
    }
    return { ...response, finalUrl: currentUrl };
  }
  throw new Error("TOO_MANY_REDIRECTS");
}

function requestOnce(
  url: string,
  init: { method: "HEAD" | "GET"; agent?: Agent; timeoutMs?: number },
): Promise<ProbeRequestResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const requestFn = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestFn(
      parsed,
      {
        method: init.method,
        agent: init.agent,
        headers: {
          "User-Agent": BROWSER_UA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        ...(parsed.protocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          resolve({ status, finalUrl: url, body: location });
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk) => {
          if (init.method === "HEAD") return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size <= MAX_BODY_BYTES) chunks.push(buffer);
        });
        res.on("end", () => {
          resolve({
            status,
            finalUrl: url,
            body: init.method === "HEAD" ? "" : Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    const timeout = setTimeout(() => req.destroy(new Error("REQUEST_TIMEOUT")), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    req.on("error", reject);
    req.on("close", () => clearTimeout(timeout));
    req.end();
  });
}

function buildProbeResult(
  url: string,
  context: CountryAwareProbeContext,
  finalUrl: string,
  publishable: boolean,
  headStatus: string,
  getStatus: string,
  reason: ProbeResult["reason"],
): ProbeResult {
  return {
    url,
    finalUrl,
    publishable,
    headStatus,
    getStatus,
    reason,
    proxyIp: context.proxyIp,
    proxyCountryCode: context.proxyCountryCode,
    proxyWarning: context.proxyWarning,
  };
}

function isPublishableStatus(status: number): boolean {
  return status >= 200 && status < 400;
}

function statusLabel(result: ProbeRequestResult): string {
  return result.status === 0 ? (result.body || "ERROR") : String(result.status);
}

function errorStatus(err: unknown): string {
  return err instanceof Error ? err.message || err.name : "ERROR";
}

function normalizeCountryCode(value: string | null | undefined): string {
  const code = (value ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : "";
}
