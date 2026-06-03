import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { normalizeImageUrl, hasLiquidPlaceholder } from "@/lib/image-url-normalize";
import {
  getHostKey,
  isHostChallenged,
  markHostChallenged,
} from "@/lib/crawl-host-cache";

// avif 需包含在内：Cloudinary f_auto 在 Accept:image/* 下会优先返回 avif
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/svg+xml"];
const MAX_SIZE = 10 * 1024 * 1024;
const CACHE_TTL = 86400;

// 只保留两个 UA：Chrome + Googlebot，减少无效重试次数
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Googlebot-Image/1.0",
];

// =====================================================================
// D-031：进程内 LRU 图片缓存（5 分钟 TTL）
// =====================================================================
// 同一商家多人同时查看 / 单次预览页面 14 个 <img> 并发请求时，避免重复下载
// 同一张图。命中走超快路径（直接返回 Buffer，0 网络开销）。

interface CachedImage {
  buffer: Buffer;
  contentType: string;
  expireAt: number;
}

const IMAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const IMAGE_CACHE_MAX = 1000;
const imageCache = new Map<string, CachedImage>();

// =====================================================================
// D-028 v8：image host 失败计数器（避免 challenged host 反复 30s 超时）
// =====================================================================
// 实证 trace（pixibeauty.com 13:40:12-13:41:12）：CF hard-block 站连 puppeteer
// 也访问不到，每张图 30s 超时失败 0/N，5 个 batch × 30s = 2.5 分钟纯浪费。
// 解决：单 host L1 puppeteer 连续失败 ≥ 3 次后，5 分钟内对该 host 所有图片
// 直接返回占位图，跳过 puppeteer。
const IMAGE_HOST_FAIL_THRESHOLD = 3;
const IMAGE_HOST_FAIL_TTL_MS = 5 * 60 * 1000;
const imageHostFailCount = new Map<string, { count: number; expireAt: number }>();

function isImageHostBlocked(host: string): boolean {
  const v = imageHostFailCount.get(host);
  if (!v) return false;
  if (Date.now() > v.expireAt) {
    imageHostFailCount.delete(host);
    return false;
  }
  return v.count >= IMAGE_HOST_FAIL_THRESHOLD;
}

function recordImageHostFail(host: string): void {
  const v = imageHostFailCount.get(host);
  const now = Date.now();
  if (!v || now > v.expireAt) {
    imageHostFailCount.set(host, { count: 1, expireAt: now + IMAGE_HOST_FAIL_TTL_MS });
  } else {
    v.count += 1;
    v.expireAt = now + IMAGE_HOST_FAIL_TTL_MS;
  }
}

function recordImageHostSuccess(host: string): void {
  imageHostFailCount.delete(host);
}

function getImageCache(url: string): CachedImage | null {
  const v = imageCache.get(url);
  if (!v) return null;
  if (Date.now() > v.expireAt) {
    imageCache.delete(url);
    return null;
  }
  return v;
}

function setImageCache(url: string, buffer: Buffer, contentType: string): void {
  imageCache.set(url, {
    buffer,
    contentType,
    expireAt: Date.now() + IMAGE_CACHE_TTL_MS,
  });
  if (imageCache.size > IMAGE_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of imageCache) {
      if (now > v.expireAt) imageCache.delete(k);
      if (imageCache.size <= IMAGE_CACHE_MAX * 0.9) break;
    }
    // 仍超量则按插入序删最早的（Map 遍历是插入序）
    while (imageCache.size > IMAGE_CACHE_MAX) {
      const first = imageCache.keys().next().value;
      if (!first) break;
      imageCache.delete(first);
    }
  }
}

// =====================================================================
// D-031：同 host 200ms 批量 coalescer（L1 Puppeteer）
// =====================================================================
// 前端 14 个 <img> 几乎同时打到 image-proxy，按 host 收集成 1 个 batch，
// 由 fetchImagesViaPuppeteerBatch 共享 1 个 browser 一次性下载全部。

type ImageResolver = (v: { buffer: Buffer; contentType: string } | null) => void;

interface PendingImageBatch {
  refererOrigin: string;
  urls: Set<string>;
  resolvers: Map<string, ImageResolver[]>;
  timer: NodeJS.Timeout | null;
}

const IMAGE_COALESCE_WINDOW_MS = 200;
const pendingImageBatches = new Map<string, PendingImageBatch>();

function coalescedPuppeteerImageFetch(
  url: string,
  refererOrigin: string,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  return new Promise<{ buffer: Buffer; contentType: string } | null>((resolve) => {
    let batch = pendingImageBatches.get(refererOrigin);
    if (!batch) {
      batch = {
        refererOrigin,
        urls: new Set(),
        resolvers: new Map(),
        timer: null,
      };
      pendingImageBatches.set(refererOrigin, batch);
      batch.timer = setTimeout(() => {
        fireImageBatch(refererOrigin).catch((e) =>
          console.warn("[ImageProxy] fireImageBatch 异常:", e instanceof Error ? e.message : e),
        );
      }, IMAGE_COALESCE_WINDOW_MS);
    }
    batch.urls.add(url);
    const arr = batch.resolvers.get(url) || [];
    arr.push(resolve);
    batch.resolvers.set(url, arr);
  });
}

// D-028 v6：单 host 同时只允许 1 个 batch 在跑，避免 5 个 batch 同时挤 puppeteer slot
// 实证 trace（narscosmetics.co.uk 13:15:36-13:16:07）：5 batch × 5 url = 20 url 同时
// 启动，3 个 normal slot（实际 2 个）扛不住，normalQ=3 → 后 3 个 batch 等 30s slot 超时
// 失败 0/5。改为 host 级互斥锁，前一个 batch 完成后再跑下一个。
const hostBatchLocks = new Map<string, Promise<void>>();

async function fireImageBatch(refererOrigin: string): Promise<void> {
  const batch = pendingImageBatches.get(refererOrigin);
  if (!batch) return;
  // 立刻摘掉，让窗口期后新进来的请求开新 batch
  pendingImageBatches.delete(refererOrigin);
  if (batch.timer) clearTimeout(batch.timer);

  // D-028 v9：修复 v6 互斥锁竞态条件
  // v6 bug：多个 batch 同时 await 同一个 prev，prev 完成后它们同时进入 work
  //        → 实证 trace（scarosso.com 14:04:53-14:05:17）4-7 个 batch 并发挤 slot
  // v9 fix：用 chain 模式，每个新 batch 创建一个包含 "await prev + 执行 work" 的串行
  //        Promise，并立即 set 为新锁。后来者 await 的总是最新的链尾。
  let host = "";
  try { host = new URL(refererOrigin).hostname.toLowerCase(); } catch {}
  const prev = host ? hostBatchLocks.get(host) : undefined;

  const urls = Array.from(batch.urls);
  let result = new Map<string, { buffer: Buffer; contentType: string }>();

  const work = (async () => {
    if (prev) {
      try { await prev; } catch {}
    }
    try {
      const { fetchImagesViaPuppeteerBatch } = await import("@/lib/crawler");
      const { getHttpProxyUrlForCountry, getProxyUrlForCountry } = await import("@/lib/crawl-proxy");

      let proxyCountry = "US";
      try {
        const h = new URL(refererOrigin).hostname.toLowerCase();
        if (h.endsWith(".co.uk") || h.endsWith(".uk")) proxyCountry = "GB";
        else if (h.endsWith(".de")) proxyCountry = "DE";
        else if (h.endsWith(".fr")) proxyCountry = "FR";
        else if (h.endsWith(".au")) proxyCountry = "AU";
        else if (h.endsWith(".ca")) proxyCountry = "CA";
      } catch {}

      const httpProxyUrl = await getHttpProxyUrlForCountry(proxyCountry).catch(() => null);
      const socks5ProxyUrl = httpProxyUrl ? null : await getProxyUrlForCountry(proxyCountry).catch(() => null);
      const proxyUrl = httpProxyUrl ?? socks5ProxyUrl ?? undefined;

      console.warn(
        `[ImageProxy] L1 Puppeteer 批量启动: referer=${refererOrigin} urls=${urls.length} proxy=${proxyUrl ? proxyCountry : "direct"}`,
      );

      const t0 = Date.now();
      // D-028 v8：图片单张 timeout 15s→8s，CF 强反爬站快速放弃，
      // 让 host 失败计数器更快累计到 3 次触发 fast-fail，避免无效等待
      result = await fetchImagesViaPuppeteerBatch(urls, refererOrigin, proxyUrl, {
        perFetchTimeoutMs: 8000,
        navigationTimeoutMs: 12000,
      });
      console.warn(
        `[ImageProxy] L1 Puppeteer 批量完成: 成功 ${result.size}/${urls.length} 张, 耗时 ${Date.now() - t0}ms`,
      );
    } catch (e) {
      console.warn("[ImageProxy] L1 Puppeteer batch 异常:", e instanceof Error ? e.message : e);
    }
  })();

  // 在 work 真正开始之前就 set 锁，后来者 await 的就是这个 work（包含 await prev 链）
  if (host) {
    hostBatchLocks.set(host, work);
    work.finally(() => {
      if (hostBatchLocks.get(host) === work) hostBatchLocks.delete(host);
    });
  }
  await work;

  for (const u of urls) {
    const v = result.get(u) || null;
    if (v) setImageCache(u, v.buffer, v.contentType);
    const resolvers = batch.resolvers.get(u) || [];
    for (const r of resolvers) r(v);
  }
}

// =====================================================================
// 工具：从 CDN URL 推断 Referer
// =====================================================================
function inferReferer(imageUrl: string): string[] {
  try {
    const u = new URL(imageUrl);
    const cdn = u.hostname;
    if (cdn === "res.cloudinary.com") {
      const account = u.pathname.split("/").filter(Boolean)[0] || "";
      if (account) {
        return [
          `https://www.${account}.com/`,
          "https://www.google.com/",
          u.origin + "/",
        ];
      }
      return ["https://www.google.com/", u.origin + "/"];
    }
    if (cdn.includes("contentsvc.com") || cdn.includes("commercecloud.salesforce.com")) {
      const brand = u.pathname.split("/").filter(Boolean)[0] || "";
      if (brand) {
        return [
          `https://www.${brand}.com/`,
          `https://${brand}.com/`,
          "https://www.google.com/",
        ];
      }
      return ["https://www.google.com/"];
    }
    const parts = cdn.split(".");
    if (parts.length >= 3) {
      const apex = parts.slice(-2).join(".");
      return [`https://www.${apex}/`, `https://${apex}/`, u.origin + "/"];
    }
    return [u.origin + "/"];
  } catch {
    return ["https://www.google.com/"];
  }
}

/** 从 image url + refHint 取出 L1 Puppeteer navigate 的目标 origin */
function pickRefererOrigin(imageUrl: string, refHint: string | null): string {
  if (refHint) {
    try {
      return new URL(refHint).origin;
    } catch {}
  }
  const inferred = inferReferer(imageUrl)[0] || "";
  try {
    return new URL(inferred).origin;
  } catch {
    try {
      return new URL(imageUrl).origin;
    } catch {
      return "https://www.google.com";
    }
  }
}

/**
 * GET /api/user/ad-creation/image-proxy?url=xxx&ref=yyy
 * 服务端代理外部图片，绕过商家网站防盗链/CORS 限制。
 *
 * D-031 三层兜底：
 *   L-cache: 进程内 LRU 5 分钟命中 → 0s 返回
 *   L0a 直连 2 UA × 2 Referer
 *   L0b HTTP/SOCKS5 出口代理
 *   L1 Puppeteer 真人指纹（同 host 200ms 批量）—— 过 Cloudflare 防盗链
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const rawUrl = req.nextUrl.searchParams.get("url");
  if (!rawUrl) return new NextResponse("Missing url", { status: 400 });

  const url = normalizeImageUrl(rawUrl);
  const placeholderFixed = hasLiquidPlaceholder(rawUrl) && !hasLiquidPlaceholder(url);

  try {
    new URL(url);
  } catch {
    return new NextResponse("Invalid url", { status: 400 });
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return new NextResponse("Only http(s) allowed", { status: 400 });
  }

  // -------- L-cache：进程内 LRU --------
  const cached = getImageCache(url);
  if (cached) {
    return new NextResponse(new Uint8Array(cached.buffer), {
      headers: {
        "Content-Type": cached.contentType,
        "Content-Length": String(cached.buffer.length),
        "Cache-Control": `public, max-age=${CACHE_TTL}`,
        "Access-Control-Allow-Origin": "*",
        "X-Image-Proxy-Source": "lru",
      },
    });
  }

  const refHint = req.nextUrl.searchParams.get("ref");
  const inferredReferers = inferReferer(url);
  const allReferers = refHint
    ? [refHint, ...inferredReferers.filter((r) => r !== refHint)]
    : inferredReferers;
  const referers = allReferers.slice(0, 2);
  let lastError = "";

  const imgHost = getHostKey(url);
  const hostChallenged = imgHost ? isHostChallenged(imgHost) : false;

  // D-028 v8：若该 host 最近 5 分钟内 L1 puppeteer 连续失败 ≥ 3 次，
  // 直接返回占位图，跳过 30s × N 次的无效尝试。pixibeauty.com 实证节省 ~90s。
  if (imgHost && isImageHostBlocked(imgHost)) {
    console.warn(`[ImageProxy] D-028 v8：host=${imgHost} 最近 L1 连续失败，直接返回占位图：${url.slice(0, 80)}`);
    const TRANSPARENT_PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    return new NextResponse(new Uint8Array(TRANSPARENT_PNG), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(TRANSPARENT_PNG.length),
        "Cache-Control": "public, max-age=60",
        "X-Image-Proxy-Fallback": "host-blocked",
      },
    });
  }

  // -------- L0a + L0b：仅当 host 未被标记反爬时跑 --------
  // 已知反爬 host 直接跳 L1，省 5-10s 浪费
  if (!hostChallenged) {
    for (const ua of USER_AGENTS) {
      for (const referer of referers) {
        try {
          const resp = await fetch(url, {
            headers: {
              "User-Agent": ua,
              // D-085：补浏览器级请求头，提升 Scene7/Akamai 等 CDN-WAF 的放行率
              // （部分 CDN 对缺 Accept-Language / Sec-Fetch-* 的“裸”请求直接 403）
              Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
              Referer: referer,
              "Sec-Fetch-Dest": "image",
              "Sec-Fetch-Mode": "no-cors",
              "Sec-Fetch-Site": "cross-site",
            },
            signal: AbortSignal.timeout(8000),
            redirect: "follow",
          });

          if (!resp.ok) {
            lastError = `HTTP ${resp.status} (referer=${referer})`;
            continue;
          }

          const ct = resp.headers.get("content-type") || "";
          if (!ALLOWED_TYPES.some((t) => ct.startsWith(t))) {
            lastError = `Not image: ${ct}`;
            continue;
          }

          const cl = parseInt(resp.headers.get("content-length") || "0", 10);
          if (cl > MAX_SIZE) {
            return new NextResponse("Image too large", { status: 413 });
          }

          const buffer = Buffer.from(await resp.arrayBuffer());
          if (buffer.length > MAX_SIZE) {
            return new NextResponse("Image too large", { status: 413 });
          }
          if (buffer.length < 100) {
            lastError = "Image too small (likely placeholder)";
            continue;
          }

          setImageCache(url, buffer, ct);
          return new NextResponse(new Uint8Array(buffer), {
            headers: {
              "Content-Type": ct,
              "Content-Length": String(buffer.length),
              "Cache-Control": `public, max-age=${CACHE_TTL}`,
              "Access-Control-Allow-Origin": "*",
              "X-Image-Proxy-Source": "direct",
            },
          });
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    // -------- L0b：动态出口代理 --------
    try {
      const { getHttpProxyUrlForCountry, getProxyUrlForCountry, fetchViaProxy } = await import("@/lib/crawl-proxy");
      let proxyCountry = "US";
      try {
        const h = new URL(url).hostname.toLowerCase();
        if (h.endsWith(".co.uk") || h.endsWith(".uk")) proxyCountry = "GB";
        else if (h.endsWith(".de")) proxyCountry = "DE";
        else if (h.endsWith(".fr")) proxyCountry = "FR";
        else if (h.endsWith(".au")) proxyCountry = "AU";
        else if (h.endsWith(".ca")) proxyCountry = "CA";
      } catch {}

      const httpProxyUrl = await getHttpProxyUrlForCountry(proxyCountry).catch(() => null);
      const socks5ProxyUrl = await getProxyUrlForCountry(proxyCountry).catch(() => null);
      const proxyUrl = httpProxyUrl ?? socks5ProxyUrl;

      if (proxyUrl) {
        const proxyType = httpProxyUrl ? "HTTP" : "SOCKS5";
        const referer = inferReferer(url)[0] || "";
        try {
          const proxyResp = await fetchViaProxy(
            url,
            {
              headers: {
                "User-Agent": USER_AGENTS[0],
                "Accept": "image/webp,image/jpeg,image/png,image/avif,image/*;q=0.8",
                ...(referer ? { "Referer": referer } : {}),
              },
              signal: AbortSignal.timeout(12000),
            },
            proxyUrl,
          );
          if (proxyResp.ok) {
            const ct = (proxyResp.headers["content-type"] as string) || "image/jpeg";
            if (ALLOWED_TYPES.some((t) => ct.startsWith(t))) {
              const buf = await proxyResp.buffer();
              if (buf.length >= 100 && buf.length <= MAX_SIZE) {
                console.log(`[ImageProxy] ${proxyType}代理成功: ${url.slice(0, 80)} (${proxyCountry}, ${buf.length}B)`);
                setImageCache(url, buf, ct);
                return new NextResponse(new Uint8Array(buf), {
                  headers: {
                    "Content-Type": ct,
                    "Content-Length": String(buf.length),
                    "Cache-Control": `public, max-age=${CACHE_TTL}`,
                    "Access-Control-Allow-Origin": "*",
                    "X-Image-Proxy-Source": "proxy",
                  },
                });
              }
            }
          }
          lastError = `proxy HTTP ${proxyResp.status}`;
        } catch (proxyErr) {
          lastError = `${proxyType} 代理异常: ${proxyErr instanceof Error ? proxyErr.message : proxyErr}`;
        }
      } else {
        lastError = "无可用代理配置";
      }
    } catch (proxyErr) {
      lastError = `代理重试异常: ${proxyErr instanceof Error ? proxyErr.message : proxyErr}`;
    }

    // L0a + L0b 全军覆没 → 标记 host 反爬，后续同 host 跳直入 L1
    if (imgHost) markHostChallenged(imgHost);
  }

  // -------- L1：Puppeteer 真人指纹（同 host 200ms 批量） --------
  try {
    const refererOrigin = pickRefererOrigin(url, refHint);
    const puppResult = await coalescedPuppeteerImageFetch(url, refererOrigin);
    if (puppResult) {
      const { buffer, contentType } = puppResult;
      if (buffer.length >= 100 && buffer.length <= MAX_SIZE) {
        // D-028 v8：成功 → 重置该 host 失败计数
        if (imgHost) recordImageHostSuccess(imgHost);
        return new NextResponse(new Uint8Array(buffer), {
          headers: {
            "Content-Type": contentType,
            "Content-Length": String(buffer.length),
            "Cache-Control": `public, max-age=${CACHE_TTL}`,
            "Access-Control-Allow-Origin": "*",
            "X-Image-Proxy-Source": "puppeteer",
          },
        });
      }
    }
    lastError = lastError ? `${lastError}; L1 Puppeteer 失败` : "L1 Puppeteer 失败";
    // D-028 v8：L1 失败 → 累加该 host 失败计数（≥3 次则后续 fast-fail）
    if (imgHost) recordImageHostFail(imgHost);
  } catch (e) {
    lastError = lastError
      ? `${lastError}; L1 异常 ${e instanceof Error ? e.message : e}`
      : `L1 异常 ${e instanceof Error ? e.message : e}`;
    if (imgHost) recordImageHostFail(imgHost);
  }

  console.warn(
    "[ImageProxy] all attempts failed (incl. proxy + puppeteer):",
    url,
    placeholderFixed ? "(placeholder-fixed)" : "",
    hostChallenged ? "(host pre-challenged)" : "",
    lastError,
  );

  const TRANSPARENT_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  return new NextResponse(new Uint8Array(TRANSPARENT_PNG), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(TRANSPARENT_PNG.length),
      "Cache-Control": "public, max-age=60",
      "X-Image-Proxy-Fallback": "true",
    },
  });
}
