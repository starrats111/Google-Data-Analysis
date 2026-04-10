/**
 * 硬编码的商家归属规则
 *
 * 某些商家的交易会通过特定平台连接进入错误用户的账号（如 novanest CG 账号挂在 wj07 下，
 * 但 NASM 商家实际由 wj02 运营）。这些规则确保在交易同步时，无论由谁触发同步，
 * 交易都被正确归属到实际运营者。
 *
 * 规则在代码中硬编码，避免数据库配置被意外修改或遗漏。
 */

export interface OwnershipRule {
  platform: string;
  merchant_id: string;
  /** 交易来源用户（同步触发者） */
  source_user_id: number;
  /** 实际归属用户 */
  target_user_id: number;
  /** 目标用户的 user_merchants.id */
  target_user_merchant_id: number;
  /** 目标用户的 campaigns.id */
  target_campaign_id: number;
  description?: string;
}

export const MERCHANT_OWNERSHIP_RULES: OwnershipRule[] = [];

/**
 * 检查某笔交易是否需要重定向到其他用户。
 * 在 upsert 前调用，返回 null 表示不需要重定向。
 */
export function getOwnershipOverride(
  currentUserId: bigint,
  platform: string,
  merchantId: string,
): OwnershipRule | null {
  for (const rule of MERCHANT_OWNERSHIP_RULES) {
    if (
      BigInt(rule.source_user_id) === currentUserId &&
      rule.platform === platform &&
      rule.merchant_id === merchantId
    ) {
      return rule;
    }
  }
  return null;
}

/**
 * 获取指定源用户的所有需要排除的商家键（platform_merchantId 格式）。
 * 用于在交易同步时跳过 auto-create merchant，改为重定向。
 */
export function getRedirectedMerchantKeys(sourceUserId: bigint): Map<string, OwnershipRule> {
  const map = new Map<string, OwnershipRule>();
  for (const rule of MERCHANT_OWNERSHIP_RULES) {
    if (BigInt(rule.source_user_id) === sourceUserId) {
      map.set(`${rule.platform}_${rule.merchant_id}`, rule);
    }
  }
  return map;
}
