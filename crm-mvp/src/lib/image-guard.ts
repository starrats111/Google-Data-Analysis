// ───────────────────────────────────────────────────────────────
// 2026-07-13（第七轮）：图片安全与合格性共享内核
//
//   ① SSRF 阀（assertPublicImageUrl）：image-proxy / check-image / 提交下载等所有
//      「服务端替用户拉任意 URL」的入口共用。拦截 localhost / 私网段 / 链路本地 /
//      云 metadata 端点（169.254.169.254）等目标——这些路径此前可被用来探测内网。
//   ② 魔数嗅探（sniffImageFormat）：不信 Content-Type / 扩展名，按文件头识别真实格式。
//   ③ 提交前合格性（prepareImageForGoogleAds）：Google Ads image asset 只收
//      JPEG/PNG/GIF(静态)，尺寸过小会拒。一张坏图会让整个 asset 批次 mutate 失败，
//      故提交前统一：解码校验 → WebP/AVIF/SVG 转码 JPEG/PNG → 尺寸不足丢弃 → 超 5MB 重压。
// ───────────────────────────────────────────────────────────────

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// Google Ads 图片素材最小边（正方形 300×300、横向 600×314——取保守下限 300/314 中的 300）
const GOOGLE_ADS_MIN_EDGE = 300;
// Google Ads 图片素材文件大小上限 5120KB
const GOOGLE_ADS_MAX_BYTES = 5 * 1024 * 1024;

export type ImageFormat = "jpeg" | "png" | "gif" | "webp" | "avif" | "svg" | "bmp" | "ico" | "tiff";

/** 按文件头魔数识别真实图片格式（不信 Content-Type / URL 扩展名） */
export function sniffImageFormat(buf: Buffer): ImageFormat | null {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "gif";
  if (buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buf.subarray(8, 12).toString("ascii");
    if (brand.startsWith("avi")) return "avif";
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "bmp";
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return "ico";
  if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) || (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00)) return "tiff";
  // SVG：文本型，找 <svg 标记（跳过 BOM/空白/注释/XML 声明的常见情况）
  const head = buf.subarray(0, 1024).toString("utf8").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.includes("<svg")) return "svg";
  return null;
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;            // 0.0.0.0/8, 10/8, loopback
  if (a === 100 && b >= 64 && b <= 127) return true;            // CGNAT 100.64/10
  if (a === 169 && b === 254) return true;                      // 链路本地 + 云 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;             // 172.16/12
  if (a === 192 && b === 168) return true;                      // 192.168/16
  if (a >= 224) return true;                                    // 组播/保留
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const low = ip.toLowerCase();
  if (low === "::" || low === "::1") return true;               // loopback / unspecified
  if (low.startsWith("fe80:")) return true;                     // 链路本地
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // ULA fc00::/7
  if (low.startsWith("::ffff:")) {                              // IPv4-mapped
    const v4 = low.slice(7);
    if (isIP(v4) === 4) return isPrivateIPv4(v4);
    return true;
  }
  return false;
}

function isPrivateIp(ip: string): boolean {
  const ver = isIP(ip);
  if (ver === 4) return isPrivateIPv4(ip);
  if (ver === 6) return isPrivateIPv6(ip);
  return true; // 不是合法 IP 一律当危险处理
}

/**
 * SSRF 阀：校验目标 URL 是否为「公网 http(s) 资源」。
 * - 仅允许 http/https
 * - 域名解析出的所有 IP 必须是公网地址（挡 localhost / 私网 / 链路本地 / metadata）
 * 通过返回 null，不通过返回中文拒绝原因。
 * 注意：不能防 DNS rebinding（解析与实际连接两次查询间换 IP），但已覆盖绝大多数攻击面。
 */
export async function assertPublicImageUrl(rawUrl: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return "URL 格式非法";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "仅允许 http/https";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "禁止访问内部主机名";
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) return "禁止访问内网 IP";
    return null;
  }
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    if (!addrs.length) return "域名无法解析";
    for (const a of addrs) {
      if (isPrivateIp(a.address)) return `域名解析到内网地址（${a.address}），已拦截`;
    }
  } catch {
    return "域名解析失败";
  }
  return null;
}

/** 从 CDN URL 推断 Referer（与 image-proxy 同源逻辑的精简版） */
function inferRefererForImage(imageUrl: string): string {
  try {
    const u = new URL(imageUrl);
    const parts = u.hostname.split(".");
    if (parts.length >= 3) {
      const apex = parts.slice(-2).join(".");
      return `https://www.${apex}/`;
    }
    return u.origin + "/";
  } catch {
    return "https://www.google.com/";
  }
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

/**
 * 提交侧图片下载：带浏览器头 + Referer 直连，失败再走出口代理。
 * 2026-07-13（第七轮）：预览页 image-proxy 靠 Referer/代理/Puppeteer 才拿到的图，
 * 提交时旧逻辑用裸 fetch 重新下载必然 403 → 员工看得到图但提交后图片丢失。
 * 本函数与 image-proxy 的 L0a/L0b 同策略（不含 Puppeteer——提交在后台跑，可容忍缺图）。
 */
export async function downloadImageWithFallback(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number; country?: string } = {},
): Promise<Buffer | null> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const referer = inferRefererForImage(url);
  const headers: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: referer,
    "Sec-Fetch-Dest": "image",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "cross-site",
  };
  // L0a：直连
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (resp.ok) {
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length >= 100 && buf.length <= maxBytes) return buf;
    }
  } catch { /* 直连失败 → 代理 */ }
  // L0b：出口代理
  try {
    const { getHttpProxyUrlForCountry, getProxyUrlForCountry, fetchViaProxy } = await import("@/lib/crawl-proxy");
    const country = opts.country || "US";
    const proxyUrl = (await getHttpProxyUrlForCountry(country).catch(() => null))
      ?? (await getProxyUrlForCountry(country).catch(() => null));
    if (!proxyUrl) return null;
    const proxyResp = await fetchViaProxy(url, { headers, signal: AbortSignal.timeout(timeoutMs + 2000) }, proxyUrl);
    if (proxyResp.ok) {
      const buf = await proxyResp.buffer();
      if (buf.length >= 100 && buf.length <= maxBytes) return buf;
    }
  } catch { /* 代理也失败 → null */ }
  return null;
}

export interface PreparedAdImage {
  /** 处理后的图片字节（保证为 jpeg/png/gif 且 ≤5MB） */
  buffer: Buffer;
  format: "jpeg" | "png" | "gif";
  width: number;
  height: number;
  /** 是否发生了转码/重压 */
  transcoded: boolean;
}

/**
 * 提交前把任意来源图片整备成 Google Ads 可收的素材：
 * - 解码失败/非图片 → null（丢弃）
 * - WebP/AVIF/SVG/BMP/TIFF/ICO → 转码（带透明通道转 PNG，否则 JPEG q85）
 * - 最小边 < 300px → null（Google 必拒，且一张坏图会拖垮整个 asset 批次）
 * - 超 5MB → JPEG 重压（q80），仍超则 null
 * sharp 加载失败时退化为「魔数白名单」：jpeg/png/gif 原样放行，其余丢弃。
 */
export async function prepareImageForGoogleAds(input: Buffer): Promise<PreparedAdImage | null> {
  const sniffed = sniffImageFormat(input);
  if (!sniffed) return null;

  let sharpMod: typeof import("sharp") | null = null;
  try {
    sharpMod = (await import("sharp")).default as unknown as typeof import("sharp");
  } catch {
    sharpMod = null;
  }

  if (!sharpMod) {
    // 退化路径：只放行 Google 原生支持的格式，尺寸无法校验（交给 Google 拒单张）
    if ((sniffed === "jpeg" || sniffed === "png" || sniffed === "gif") && input.length <= GOOGLE_ADS_MAX_BYTES) {
      return { buffer: input, format: sniffed, width: 0, height: 0, transcoded: false };
    }
    return null;
  }

  try {
    const img = sharpMod(input, { animated: false, limitInputPixels: 64_000_000 });
    const meta = await img.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < GOOGLE_ADS_MIN_EDGE || height < GOOGLE_ADS_MIN_EDGE) return null;

    const nativeOk = sniffed === "jpeg" || sniffed === "png" || sniffed === "gif";
    if (nativeOk && input.length <= GOOGLE_ADS_MAX_BYTES) {
      return { buffer: input, format: sniffed as "jpeg" | "png" | "gif", width, height, transcoded: false };
    }

    // 需要转码或重压
    const hasAlpha = !!meta.hasAlpha;
    let out: Buffer;
    let outFormat: "jpeg" | "png";
    if (hasAlpha) {
      out = await img.png({ compressionLevel: 9 }).toBuffer();
      outFormat = "png";
      if (out.length > GOOGLE_ADS_MAX_BYTES) {
        // 透明图太大：铺白底转 JPEG
        out = await sharpMod(input, { limitInputPixels: 64_000_000 })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 80 })
          .toBuffer();
        outFormat = "jpeg";
      }
    } else {
      out = await img.jpeg({ quality: 85 }).toBuffer();
      outFormat = "jpeg";
      if (out.length > GOOGLE_ADS_MAX_BYTES) {
        out = await sharpMod(input, { limitInputPixels: 64_000_000 }).jpeg({ quality: 75 }).toBuffer();
      }
    }
    if (out.length > GOOGLE_ADS_MAX_BYTES) return null;
    return { buffer: out, format: outFormat, width, height, transcoded: true };
  } catch {
    return null;
  }
}
