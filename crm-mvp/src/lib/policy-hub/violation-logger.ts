/**
 * D-041 / Policy Hub — 违规事实表写入器
 *
 * 把 ParsedPolicyError 持久化到 policy_violations 表，作为后续：
 *   - admin 后台违规看板的数据源
 *   - prompt 优化（top 10 违规原因 → 调整 NON-NEGOTIABLE RULES）
 *   - 商家政策画像（top 违规商家 → 调整商家敏感度）
 *
 * 写入策略：upsert by (campaign_id, policy_name, evidence_field, evidence_index)
 *   - 同一广告同一字段同一政策只记一次（避免 RSA 重试导致重复）
 *   - 没有 campaign_id 时（提交前 final gate）用 ad_creation_id 去重
 */

import prisma from "@/lib/prisma";
import type { ParsedPolicyError, ParsedPolicyResult } from "./error-parser";

export interface LogPolicyViolationContext {
  /** 广告系列 DB id（campaigns.id） */
  campaign_id?: bigint | number | null;
  /** 商家 DB id（user_merchants.id 或 merchants.id） */
  user_merchant_id?: bigint | number | null;
  /** 用户 id（提交人） */
  user_id?: bigint | number | null;
  /** MCC id（google_mcc_accounts.id） */
  mcc_id?: bigint | number | null;
  /** Google CID（不带 dash） */
  google_customer_id?: string | null;
  /** 广告系列名（便于 admin 看板显示） */
  campaign_name?: string | null;
  /** 商家域名 */
  merchant_domain?: string | null;
  /** 提交国家 */
  country?: string | null;
  /** 提交时间（默认 now） */
  submitted_at?: Date;
}

/**
 * 写入一次 Google Ads 拒登事件的所有违规条目
 *
 * @returns 实际写入的行数（去重后）
 */
export async function logPolicyViolations(
  parsed: ParsedPolicyError,
  context: LogPolicyViolationContext,
): Promise<number> {
  if (!parsed?.primary?.length) return 0;

  const submittedAt = context.submitted_at ?? new Date();
  const rawJson = parsed.rawBody;
  let written = 0;

  for (const v of parsed.primary) {
    try {
      // 用 (campaign_id, policy_name, evidence_field, evidence_index) 作为去重 key
      const dedupKey = {
        campaign_id: context.campaign_id != null ? BigInt(context.campaign_id) : null,
        policy_name: v.policyName || v.errorCode || "unknown",
        evidence_field: v.readableField || "unknown",
        evidence_index: v.operationIndex ?? -1,
      };

      // 先查是否已存在（手动 upsert，因为唯一约束含 nullable 字段时 Prisma upsert 不可靠）
      // 2026-07-13（第七轮）P0：campaign_id 为 null（提交前 final gate）时，仅靠
      // policy_name+field+index 会让不同商家的违规互相碰撞覆盖（时间戳被别家刷新，
      // countRecentTrademarkRejections 统计随之失真）。此时补 user_merchant_id 收窄归属。
      const existing = await prisma.policy_violations.findFirst({
        where: {
          campaign_id: dedupKey.campaign_id,
          policy_name: dedupKey.policy_name,
          evidence_field: dedupKey.evidence_field,
          evidence_index: dedupKey.evidence_index,
          ...(dedupKey.campaign_id == null
            ? { user_merchant_id: context.user_merchant_id != null ? BigInt(context.user_merchant_id) : null }
            : {}),
        },
        select: { id: true },
      });

      const data = {
        campaign_id: dedupKey.campaign_id,
        user_merchant_id: context.user_merchant_id != null ? BigInt(context.user_merchant_id) : null,
        user_id: context.user_id != null ? BigInt(context.user_id) : null,
        mcc_id: context.mcc_id != null ? BigInt(context.mcc_id) : null,
        google_customer_id: context.google_customer_id ?? null,
        campaign_name: context.campaign_name ?? null,
        merchant_domain: context.merchant_domain ?? null,
        country: context.country ?? null,
        // 政策分类
        policy_category: v.category.category,
        policy_subcategory: v.category.subcategory,
        policy_label_zh: v.category.labelZh,
        policy_official_url: v.category.officialUrl,
        // 来源 errorCode / policyName
        error_code: v.errorCode,
        policy_name: v.policyName || v.errorCode || "unknown",
        external_policy_name: v.externalPolicyName,
        external_policy_description: v.externalPolicyDescription,
        // 违规位置 + 文本
        evidence_field: v.readableField || "unknown",
        evidence_index: v.operationIndex ?? -1,
        violating_text: v.violatingText,
        trigger_value: v.trigger,
        field_path: v.fieldPath,
        // 严重度 + 修复建议
        severity: v.category.severity,
        suggested_fix: v.category.suggestedFix,
        is_exemptible: v.isExemptible ? 1 : 0,
        // 元数据
        google_raw_error_json: rawJson,
        message: v.message,
        submitted_at: submittedAt,
      };

      if (existing) {
        // 已存在 → 更新最新时间和 raw json（保留首次记录的修复进度）
        // 2026-07-13（第七轮）P1：违规再次发生 = 并没有真正修复，清掉 resolved_at，
        // 否则 admin 看板把正在发生的违规显示为"已解决"。
        await prisma.policy_violations.update({
          where: { id: existing.id },
          data: {
            google_raw_error_json: rawJson,
            submitted_at: submittedAt,
            message: v.message,
            resolved_at: null,
          },
        });
      } else {
        await prisma.policy_violations.create({ data });
        written++;
      }
    } catch (err) {
      // 写表失败不能影响主流程（广告失败已经报给员工了）
      console.warn("[PolicyHub] logPolicyViolation 失败:", err instanceof Error ? err.message : err);
    }
  }

  return written;
}

/**
 * 标记某条 violation 为「已修复」（admin 后台 / 员工重新提交成功后）
 */
export async function markViolationResolved(violationId: bigint | number): Promise<void> {
  try {
    await prisma.policy_violations.update({
      where: { id: BigInt(violationId) },
      data: { resolved_at: new Date() },
    });
  } catch (err) {
    console.warn("[PolicyHub] markViolationResolved 失败:", err instanceof Error ? err.message : err);
  }
}

/** 不依赖 prisma 的纯结构化序列化（用于 backfill 脚本与 unit test） */
export function serializeForLog(parsed: ParsedPolicyError, context: LogPolicyViolationContext): Array<Record<string, unknown>> {
  return parsed.primary.map((v: ParsedPolicyResult) => ({
    campaign_id: context.campaign_id ?? null,
    user_merchant_id: context.user_merchant_id ?? null,
    user_id: context.user_id ?? null,
    mcc_id: context.mcc_id ?? null,
    google_customer_id: context.google_customer_id ?? null,
    campaign_name: context.campaign_name ?? null,
    merchant_domain: context.merchant_domain ?? null,
    country: context.country ?? null,
    policy_category: v.category.category,
    policy_subcategory: v.category.subcategory,
    policy_label_zh: v.category.labelZh,
    policy_official_url: v.category.officialUrl,
    error_code: v.errorCode,
    policy_name: v.policyName || v.errorCode || "unknown",
    external_policy_name: v.externalPolicyName,
    external_policy_description: v.externalPolicyDescription,
    evidence_field: v.readableField || "unknown",
    evidence_index: v.operationIndex ?? -1,
    violating_text: v.violatingText,
    trigger_value: v.trigger,
    field_path: v.fieldPath,
    severity: v.category.severity,
    suggested_fix: v.category.suggestedFix,
    is_exemptible: v.isExemptible ? 1 : 0,
    google_raw_error_json: parsed.rawBody,
    message: v.message,
    submitted_at: context.submitted_at ?? new Date(),
  }));
}
