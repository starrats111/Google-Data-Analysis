import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { normalizeImageUrl, hasLiquidPlaceholder } from "@/lib/image-url-normalize";

// avif 需包含在内：Cloudinary f_auto 在 Accept:image/* 下会优先返回 avif
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/svg+xml"];
const MAX_SIZE = 10 * 1024 * 1024;
const CACHE_TTL = 86400;

// 只保留两个 UA：Chrome + Googlebot，减少无效重试次数
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
  "Googlebot-Image/1.0",
];

/** 从 CDN URL 推断商家网站 Referer（防盗链通常要求 Referer 来自商家域名） */
function inferReferer(imageUrl: string): string[] {
  try {
    const u = new URL(imageUrl);
    const cdn = u.hostname;
    // Cloudinary: res.cloudinary.com/<account>/...
    if (cdn === "res.cloudinary.com") {
      // Cloudinary URL 路径第一段是账户名，即品牌名，尝试构造品牌 URL
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
    // Salesforce Commerce Cloud / contentsvc CDN: assets.contentsvc.com/<brand>/...
    // 路径第一段是品牌名
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
    // 品牌自有子域 CDN（如 images.scarosso.com）→ 推断主域名（去掉子域前缀）
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

/**
 * GET /api/user/ad-creation/image-proxy?url=xxx
 * 服务端代理外部图片，绕过商家网站防盗链/CORS 限制。
 * 支持 avif（Cloudinary f_auto 默认返回格式）。
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const rawUrl = req.nextUrl.searchParams.get("url");
  if (!rawUrl) return new NextResponse("Missing url", { status: 400 });

  // C-030：兜底清洗 Shopify Liquid 模板占位符（{width}/{height}），
  // 防止历史爬虫未替换导致 CDN 返回 404。
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

  // 前端可传入商家真实 URL 作为 Referer 提示，优先于自动推断（提高防盗链通过率）
  const refHint = req.nextUrl.searchParams.get("ref");
  const inferredReferers = inferReferer(url);
  // 最多取 2 个 Referer：用户 hint（最准确）+ 推断的第一个；避免 12 次全组合占用服务器
  const allReferers = refHint
    ? [refHint, ...inferredReferers.filter((r) => r !== refHint)]
    : inferredReferers;
  const referers = allReferers.slice(0, 2);
  let lastError = "";

  for (const ua of USER_AGENTS) {
    for (const referer of referers) {
      try {
        const resp = await fetch(url, {
          headers: {
            "User-Agent": ua,
            // 优先 webp/jpeg，兜底接受 avif；避免 CDN 因 Accept:image/* 优先返回 avif 导致误判
            Accept: "image/webp,image/jpeg,image/png,image/avif,image/*;q=0.8",
            Referer: referer,
          },
          // 8s 快速失败：CDN 无声丢包时避免长时间阻塞服务器（原 5s 对大图/高延迟 CDN 过于激进）
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

      return new NextResponse(buffer, {
        headers: {
          "Content-Type": ct,
          "Content-Length": String(buffer.length),
          "Cache-Control": `public, max-age=${CACHE_TTL}`,
          "Access-Control-Allow-Origin": "*",
        },
      });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }  // end for referer
  }  // end for ua

  // 直连全部失败 → 尝试通过动态出口代理重试（绕过商家 CDN 的 IP/地域封锁）
  // 策略：优先 HTTP 代理（Chrome 兼容、实测可达），不可用时降级 SOCKS5
  try {
    const { getHttpProxyUrlForCountry, getProxyUrlForCountry, fetchViaProxy } = await import("@/lib/crawl-proxy");
    // 从图片 URL hostname 推断商家所在国家（CDN 通常与商家同地域，默认 US）
    let proxyCountry = "US";
    try {
      const imgHost = new URL(url).hostname.toLowerCase();
      if (imgHost.endsWith(".co.uk") || imgHost.endsWith(".uk")) proxyCountry = "GB";
      else if (imgHost.endsWith(".de")) proxyCountry = "DE";
      else if (imgHost.endsWith(".fr")) proxyCountry = "FR";
      else if (imgHost.endsWith(".au")) proxyCountry = "AU";
      else if (imgHost.endsWith(".ca")) proxyCountry = "CA";
    } catch {}

    // HTTP 代理优先：实测 arxlabs HTTP 可达，SOCKS5 连接挂起导致 10s Aborted
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
              return new NextResponse(buf, {
                headers: {
                  "Content-Type": ct,
                  "Content-Length": String(buf.length),
                  "Cache-Control": `public, max-age=${CACHE_TTL}`,
                  "Access-Control-Allow-Origin": "*",
                },
              });
            }
          }
        }
        console.warn(`[ImageProxy] ${proxyType}代理也失败: ${url.slice(0, 80)} status=${proxyResp.status}`);
      } catch (proxyErr) {
        console.warn(`[ImageProxy] ${proxyType}代理异常: ${proxyErr instanceof Error ? proxyErr.message : proxyErr}`);
      }
    } else {
      console.warn(`[ImageProxy] 无可用代理配置，跳过代理重试`);
    }
  } catch (proxyErr) {
    console.warn(`[ImageProxy] 代理重试异常: ${proxyErr instanceof Error ? proxyErr.message : proxyErr}`);
  }

  console.warn(
    "[ImageProxy] all attempts failed (incl. proxy):",
    url,
    placeholderFixed ? "(placeholder-fixed)" : "",
    lastError,
  );
  // 代理也失败时返回 1×1 透明 PNG，避免浏览器显示红叉破图
  const TRANSPARENT_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  return new NextResponse(TRANSPARENT_PNG, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(TRANSPARENT_PNG.length),
      "Cache-Control": "public, max-age=60",
      "X-Image-Proxy-Fallback": "true",
    },
  });
}
