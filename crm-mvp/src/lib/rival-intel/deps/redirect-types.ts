/**
 * D-233：kyads 的跟链验证返回体。
 *
 * kyads 原类型在 `lib/redirect/types`，那整个模块是它自己的换链接子系统（CRM 侧对应
 * `link-resolver` / `affiliate-link-resolver`，不移植）。竞品情报引擎只用到 finalUrl
 * 反推域名这一件事，所以只保留最小结构；实际调用方是 CRM 的跟链结果，字段对得上就行。
 */
export interface AffiliateVerifyResponse {
  success: boolean;
  finalUrl?: string;
  error?: string;
}
