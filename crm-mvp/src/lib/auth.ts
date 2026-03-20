import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";

const JWT_SECRET = process.env.JWT_SECRET as string;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET 环境变量未设置，请在 .env 中配置");
}

export interface TokenPayload {
  userId: string;
  username: string;
  role: "admin" | "user" | "leader";
  teamId?: string; // 组长专用：所属小组 ID
}

// Cookie 配置 — 管理员和用户完全隔离
const COOKIE_CONFIG = {
  admin: { name: "admin_token", path: "/", maxAge: 60 * 60 * 24 }, // 1天
  user: { name: "user_token", path: "/", maxAge: 60 * 60 * 24 * 7 }, // 7天
} as const;

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: payload.role === "admin" ? "1d" : "7d" });
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as unknown as TokenPayload;
  } catch {
    return null;
  }
}

// 从 NextRequest 中提取管理员信息
export function getAdminFromRequest(req: NextRequest): TokenPayload | null {
  const token = req.cookies.get(COOKIE_CONFIG.admin.name)?.value;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

// 从 NextRequest 中提取组长信息
export function getLeaderFromRequest(req: NextRequest): TokenPayload | null {
  const token = req.cookies.get(COOKIE_CONFIG.user.name)?.value;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || payload.role !== "leader") return null;
  return payload;
}

// 从 NextRequest 中提取用户信息（user 或 leader 角色）
export function getUserFromRequest(req: NextRequest): TokenPayload | null {
  const token = req.cookies.get(COOKIE_CONFIG.user.name)?.value;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || (payload.role !== "user" && payload.role !== "leader")) return null;
  return payload;
}

// 设置登录 cookie（在 API route 中使用）— leader 复用 user cookie
export async function setLoginCookie(role: "admin" | "user" | "leader", token: string) {
  const cookieKey = role === "admin" ? "admin" : "user";
  const config = COOKIE_CONFIG[cookieKey];
  const cookieStore = await cookies();
  cookieStore.set(config.name, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: config.path,
    maxAge: config.maxAge,
  });
}

// 清除登录 cookie
export async function clearLoginCookie(role: "admin" | "user" | "leader") {
  const cookieKey = role === "admin" ? "admin" : "user";
  const config = COOKIE_CONFIG[cookieKey];
  const cookieStore = await cookies();
  cookieStore.set(config.name, "", { path: config.path, maxAge: 0 });
}

// 从 cookies() 获取管理员（用于 Server Component）
export async function getAdminFromCookies(): Promise<TokenPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_CONFIG.admin.name)?.value;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

// 从 cookies() 获取用户（用于 Server Component）— 兼容 leader
export async function getUserFromCookies(): Promise<TokenPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_CONFIG.user.name)?.value;
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload || (payload.role !== "user" && payload.role !== "leader")) return null;
  return payload;
}

// BigInt JSON 序列化辅助
export function serializeData<T>(data: T): T {
  return JSON.parse(
    JSON.stringify(data, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value
    )
  );
}
