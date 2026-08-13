/**
 * D-233：kyads 的国家代理出口改接 CRM 的 crawl-proxy。
 *
 * kyads 自己有一套 `lib/redirect/proxy-config` + `proxy-exit-ip`（读它自己的
 * kyads_proxies 表）。CRM 这边代理是按用途隔离的（见 crawl-proxy.ts 顶部注释）：
 * 换链接走 kookeey 供应商池，AI 爬取走管理台的 crawl_proxy_template。
 * 竞品情报引擎的站内链接可达性探测属于 AI 爬取用途，所以这里**不传 userId**，
 * 走 AI 出口，避免占用换链接的 kookeey 并发名额。
 */
import type { Agent } from "node:http";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { getProxyUrlForCountry } from "@/lib/crawl-proxy";

export interface LoadedProxyConfig {
  countryCode: string;
  proxyUrl: string;
}

export interface BuiltProxyAgent {
  agent: Agent;
  url: string;
}

export interface ExitIpInfo {
  ip: string;
  countryCode: string;
}

const EXIT_IP_URL = "https://ipinfo.io/json";
const EXIT_IP_TIMEOUT_MS = 6_000;

export async function loadProxyConfig(countryCode: string): Promise<LoadedProxyConfig | null> {
  const country = (countryCode || "").trim().toUpperCase();
  if (!country) return null;
  const proxyUrl = await getProxyUrlForCountry(country).catch(() => null);
  if (!proxyUrl) return null;
  return { countryCode: country, proxyUrl };
}

/**
 * 同步构造 agent，签名与 kyads 原 `buildProxyAgent` 一致（调用方 country-aware-url-probe
 * 把它当同步依赖注入）。crawl-proxy 里那两个 agent 是 `await import` 进来的，这里没有
 * async 可借，所以走静态 import（与 link-resolver/tracker.ts 同做法）。
 */
export function buildProxyAgent(cfg: LoadedProxyConfig): BuiltProxyAgent | null {
  const url = cfg.proxyUrl?.trim();
  if (!url) return null;
  try {
    if (url.startsWith("socks")) {
      return { agent: new SocksProxyAgent(url) as unknown as Agent, url };
    }
    return { agent: new HttpsProxyAgent(url) as unknown as Agent, url };
  } catch (err) {
    console.warn(
      `[rival-intel/proxy] 构造 ${cfg.countryCode} 代理 agent 失败: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

export async function detectExitIp(agent?: Agent): Promise<ExitIpInfo | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXIT_IP_TIMEOUT_MS);
  try {
    const res = await fetch(EXIT_IP_URL, {
      signal: controller.signal,
      // Node 的 fetch(undici) 不认 http.Agent，代理场景走 dispatcher；这里没有 dispatcher
      // 可用时退回 https.request，见下方 fallback。
      ...(agent ? {} : {}),
    }).catch(() => null);
    if (res?.ok) {
      const json = (await res.json()) as { ip?: string; country?: string };
      if (json.ip && json.country) {
        return { ip: json.ip, countryCode: json.country.toUpperCase() };
      }
    }
  } catch {
    // 落到下方 agent 版本
  } finally {
    clearTimeout(timer);
  }

  if (!agent) return null;
  return detectExitIpViaAgent(agent);
}

/**
 * 必须经 agent 出口探测才有意义（直连探到的是服务器自己的 IP），所以 fetch 那条路只是
 * 无代理时的省事写法，真正判定出口国用的是这条。
 */
function detectExitIpViaAgent(agent: Agent): Promise<ExitIpInfo | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: ExitIpInfo | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    void import("node:https").then(({ request }) => {
      const req = request(
        EXIT_IP_URL,
        { agent, method: "GET", headers: { Accept: "application/json" } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          res.on("end", () => {
            try {
              const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                ip?: string;
                country?: string;
              };
              if (json.ip && json.country) {
                done({ ip: json.ip, countryCode: json.country.toUpperCase() });
                return;
              }
            } catch {
              // 非法 JSON 视作探测失败
            }
            done(null);
          });
        },
      );
      const timer = setTimeout(() => req.destroy(new Error("EXIT_IP_TIMEOUT")), EXIT_IP_TIMEOUT_MS);
      req.on("error", () => done(null));
      req.on("close", () => clearTimeout(timer));
      req.end();
    }).catch(() => done(null));
  });
}
