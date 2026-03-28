import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml"];
const MAX_SIZE = 10 * 1024 * 1024;
const CACHE_TTL = 86400;

/**
 * GET /api/user/ad-creation/image-proxy?url=xxx
 * 服务端代理外部图片，绕过商家网站防盗链/CORS 限制
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req);
  if (!user) return new NextResponse("Unauthorized", { status: 401 });

  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("Missing url", { status: 400 });

  try {
    new URL(url);
  } catch {
    return new NextResponse("Invalid url", { status: 400 });
  }

  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return new NextResponse("Only http(s) allowed", { status: 400 });
  }

  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "image/*,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(15000),
      redirect: "follow",
    });

    if (!resp.ok) {
      return new NextResponse("Upstream error", { status: 502 });
    }

    const ct = resp.headers.get("content-type") || "";
    if (!ALLOWED_TYPES.some((t) => ct.startsWith(t))) {
      return new NextResponse("Not an image", { status: 400 });
    }

    const cl = parseInt(resp.headers.get("content-length") || "0", 10);
    if (cl > MAX_SIZE) {
      return new NextResponse("Image too large", { status: 413 });
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > MAX_SIZE) {
      return new NextResponse("Image too large", { status: 413 });
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
    console.warn("[ImageProxy] fetch failed:", url, err instanceof Error ? err.message : err);
    return new NextResponse("Fetch failed", { status: 502 });
  }
}
