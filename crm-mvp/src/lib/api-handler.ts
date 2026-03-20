/**
 * API 路由统一包装器 — 参考老系统 backend/app/main.py 的全局异常处理
 *
 * 功能：
 * 1. 统一 try-catch，防止 500 裸错误暴露堆栈
 * 2. 统一响应格式 { code, message, data }
 * 3. 请求日志记录
 * 4. 输入验证辅助
 */

import { NextRequest, NextResponse } from "next/server";
import { getAdminFromRequest, getUserFromRequest, getLeaderFromRequest, type TokenPayload } from "./auth";

type ApiHandler = (
  req: NextRequest,
  context: { user: TokenPayload; params?: Record<string, string> }
) => Promise<Response>;

// ─── 统一错误响应 ───
function errorResponse(message: string, status: number = 500) {
  return NextResponse.json({ code: -1, message, data: null }, { status });
}

// ─── 结构化日志 ───
function logRequest(method: string, path: string, userId?: string, error?: unknown) {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] ${method} ${path}`;
  if (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : "";
    console.error(`${base} user=${userId || "anonymous"} ERROR: ${errMsg}`);
    if (stack && process.env.NODE_ENV === "development") {
      console.error(stack);
    }
  }
}

// ─── 用户路由包装器 ───
export function withUser(handler: ApiHandler) {
  return async (req: NextRequest, routeContext?: { params?: Promise<Record<string, string>> }) => {
    const user = getUserFromRequest(req);
    if (!user) {
      return errorResponse("未登录或登录已过期", 401);
    }
    try {
      const params = routeContext?.params ? await routeContext.params : undefined;
      return await handler(req, { user, params });
    } catch (error) {
      logRequest(req.method, req.nextUrl.pathname, user.userId, error);
      return errorResponse(
        process.env.NODE_ENV === "development"
          ? `服务器错误: ${error instanceof Error ? error.message : String(error)}`
          : "服务器内部错误，请稍后重试"
      );
    }
  };
}

// ─── 管理员路由包装器 ───
export function withAdmin(handler: ApiHandler) {
  return async (req: NextRequest, routeContext?: { params?: Promise<Record<string, string>> }) => {
    const user = getAdminFromRequest(req);
    if (!user) {
      return errorResponse("未登录或无管理员权限", 401);
    }
    try {
      const params = routeContext?.params ? await routeContext.params : undefined;
      return await handler(req, { user, params });
    } catch (error) {
      logRequest(req.method, req.nextUrl.pathname, user.userId, error);
      return errorResponse(
        process.env.NODE_ENV === "development"
          ? `服务器错误: ${error instanceof Error ? error.message : String(error)}`
          : "服务器内部错误，请稍后重试"
      );
    }
  };
}

// ─── 组长路由包装器 ───
export function withLeader(handler: ApiHandler) {
  return async (req: NextRequest, routeContext?: { params?: Promise<Record<string, string>> }) => {
    const user = getLeaderFromRequest(req);
    if (!user) {
      return errorResponse("未登录或无组长权限", 401);
    }
    try {
      const params = routeContext?.params ? await routeContext.params : undefined;
      return await handler(req, { user, params });
    } catch (error) {
      logRequest(req.method, req.nextUrl.pathname, user.userId, error);
      return errorResponse(
        process.env.NODE_ENV === "development"
          ? `服务器错误: ${error instanceof Error ? error.message : String(error)}`
          : "服务器内部错误，请稍后重试"
      );
    }
  };
}

// ─── 公开路由包装器（无需认证） ───
export function withPublic(handler: (req: NextRequest) => Promise<Response>) {
  return async (req: NextRequest) => {
    try {
      return await handler(req);
    } catch (error) {
      logRequest(req.method, req.nextUrl.pathname, undefined, error);
      return errorResponse(
        process.env.NODE_ENV === "development"
          ? `服务器错误: ${error instanceof Error ? error.message : String(error)}`
          : "服务器内部错误，请稍后重试"
      );
    }
  };
}

// ─── 输入验证辅助 ───
export function validateRequired(
  data: Record<string, unknown>,
  fields: string[]
): string | null {
  for (const field of fields) {
    if (data[field] === undefined || data[field] === null || data[field] === "") {
      return `缺少必填字段: ${field}`;
    }
  }
  return null;
}

// ─── 字符串长度验证 ───
export function validateLength(
  value: string,
  field: string,
  min: number,
  max: number
): string | null {
  if (value.length < min) return `${field}长度不能少于${min}个字符`;
  if (value.length > max) return `${field}长度不能超过${max}个字符`;
  return null;
}
