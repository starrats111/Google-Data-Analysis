/**
 * 操作审计日志写入 helper（写 operation_logs 表）。
 *
 * 用于记录破坏性/敏感操作（如管理员撤销 CID）的审计追踪。
 * 设计原则：审计写入失败绝不阻断主业务流程，仅记 error 日志。
 */
import { NextRequest } from "next/server";
import prisma from "@/lib/prisma";

export interface LogOperationInput {
  /** 操作人 user_id（token 中的 userId，字符串/数字/bigint 均可） */
  userId: string | number | bigint;
  /** 操作人用户名 */
  username: string;
  /** 动作标识，如 revoke_cid */
  action: string;
  /** 目标类型，如 cid / user / campaign */
  targetType?: string;
  /** 目标 ID */
  targetId?: string | number | bigint;
  /** 详情，对象会被 JSON.stringify */
  detail?: unknown;
  /** 传入请求以自动提取 IP / User-Agent */
  req?: NextRequest;
}

export async function logOperation(input: LogOperationInput): Promise<void> {
  try {
    let ip: string | undefined;
    let ua: string | undefined;
    if (input.req) {
      ip =
        input.req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        input.req.headers.get("x-real-ip") ||
        undefined;
      ua = input.req.headers.get("user-agent") || undefined;
    }

    const detailStr =
      input.detail === undefined
        ? null
        : (typeof input.detail === "string" ? input.detail : JSON.stringify(input.detail)).slice(0, 60000);

    await prisma.operation_logs.create({
      data: {
        user_id: BigInt(input.userId),
        username: String(input.username).slice(0, 64),
        action: input.action.slice(0, 64),
        target_type: input.targetType ? input.targetType.slice(0, 32) : null,
        target_id: input.targetId != null ? String(input.targetId).slice(0, 64) : null,
        detail: detailStr,
        ip_address: ip ? ip.slice(0, 45) : null,
        user_agent: ua ? ua.slice(0, 512) : null,
      },
    });
  } catch (err) {
    console.error("[operation-log] 写入失败:", err instanceof Error ? err.message : String(err));
  }
}
