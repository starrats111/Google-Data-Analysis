/**
 * D-050 — 广告拒登事后学习：负样本加载器
 *
 * 07 决策：被 Google 拒登的广告由员工在数据中心手动录入原因（零 API），
 * 下次给同商家 / 同行业生成广告时把这些负样本喂回 prompt：
 *   - 同商家 → 强约束（HARD CONSTRAINT，携带被拒文案，明确禁止重复）
 *   - 同行业 → 软提示（SOFT HINT，仅政策类别 + 原因，不泄露其他商家文案）
 *
 * 全程 try/catch 降级：任何查询失败都返回空负样本，绝不阻断广告生成。
 */

import prisma from "@/lib/prisma";
import { POLICY_CATEGORY_MAP } from "@/lib/policy-hub/policy-categories";
import type { RejectionLesson } from "./evidence-prompt";

const MAX_SAME_MERCHANT = 8;
const MAX_SAME_INDUSTRY = 8;
const REASON_MAX = 200;

/** 政策类别 code → 中文显示名（拿不到映射时回退原始 code） */
export function policyLabelFor(code: string | null | undefined): string {
  if (!code) return "未识别政策";
  return POLICY_CATEGORY_MAP[code]?.labelZh ?? code;
}

function jsonToStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.map((x) => String(x)).filter((s) => s.trim().length > 0);
  return arr.length > 0 ? arr.slice(0, 5) : undefined;
}

export interface RejectionFeedbackBundle {
  sameMerchant: RejectionLesson[];
  sameIndustry: RejectionLesson[];
}

const EMPTY: RejectionFeedbackBundle = { sameMerchant: [], sameIndustry: [] };

/**
 * 加载用于"喂回生成"的拒登负样本。
 *
 * @param userId          广告归属员工（同行业软提示限定在同一员工范围内，避免跨团队串数据）
 * @param userMerchantId  当前商家（同商家强约束按此精确匹配）
 * @param industryId      detectIndustryProfile().id（同行业软提示按此匹配；为空则跳过同行业）
 */
export async function loadRejectionFeedbackForGeneration(params: {
  userId: bigint;
  userMerchantId: bigint;
  industryId?: string | null;
}): Promise<RejectionFeedbackBundle> {
  const { userId, userMerchantId, industryId } = params;
  try {
    const sameMerchantRows = await prisma.ad_rejection_feedback.findMany({
      where: { user_merchant_id: userMerchantId, is_deleted: 0 },
      orderBy: { created_at: "desc" },
      take: MAX_SAME_MERCHANT,
    });

    let sameIndustryRows: typeof sameMerchantRows = [];
    if (industryId) {
      sameIndustryRows = await prisma.ad_rejection_feedback.findMany({
        where: {
          user_id: userId,
          industry_category: industryId,
          is_deleted: 0,
          NOT: { user_merchant_id: userMerchantId },
        },
        orderBy: { created_at: "desc" },
        take: MAX_SAME_INDUSTRY,
      });
    }

    return {
      sameMerchant: sameMerchantRows.map((r) => ({
        policyLabel: policyLabelFor(r.policy_category),
        reason: (r.reason_text || "").slice(0, REASON_MAX),
        headlines: jsonToStringArray(r.rejected_headlines),
      })),
      sameIndustry: sameIndustryRows.map((r) => ({
        policyLabel: policyLabelFor(r.policy_category),
        reason: (r.reason_text || "").slice(0, REASON_MAX),
      })),
    };
  } catch (e) {
    console.warn(
      `[RejectionFeedback] load failed for merchant=${userMerchantId}: ${e instanceof Error ? e.message : e}`,
    );
    return EMPTY;
  }
}
