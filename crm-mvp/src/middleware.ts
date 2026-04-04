import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 公开路由 — 无需认证
const PUBLIC_PATHS = [
  "/",
  "/about",
  "/privacy-policy",
  "/terms-of-service",
  "/admin/login",
  "/user/login",
  "/api/auth/login",
  "/api/health",
];

// 静态资源前缀 — 跳过
const STATIC_PREFIXES = ["/_next", "/favicon.ico", "/images", "/icons"];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 静态资源直接放行
  if (STATIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // 公开路由直接放行
  if (PUBLIC_PATHS.includes(pathname)) {
    return NextResponse.next();
  }

  // ─── 管理员路由保护 ───
  if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
    const token = request.cookies.get("admin_token")?.value;
    if (!token) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { code: -1, message: "未登录或登录已过期", data: null },
          { status: 401 }
        );
      }
      return NextResponse.redirect(new URL("/admin/login", request.url));
    }
    // JWT 验证在 Edge Runtime 中无法使用 jsonwebtoken（Node.js 模块）
    // 这里只做 Cookie 存在性检查，详细验证由 API handler 完成
    return NextResponse.next();
  }

  // ─── 用户路由保护 ───
  if (pathname.startsWith("/user") || pathname.startsWith("/api/user")) {
    const token = request.cookies.get("user_token")?.value;
    if (!token) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { code: -1, message: "未登录或登录已过期", data: null },
          { status: 401 }
        );
      }
      return NextResponse.redirect(new URL("/user/login", request.url));
    }
    return NextResponse.next();
  }

  // ─── v1 API（Google Ads Script 调用，使用 API Key 鉴权，不走 Cookie）───
  if (pathname.startsWith("/api/v1/")) {
    return NextResponse.next();
  }

  // ─── 认证 API（logout / me）需要任一 token ───
  if (pathname.startsWith("/api/auth/")) {
    return NextResponse.next();
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // 匹配所有路径，排除静态资源
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
