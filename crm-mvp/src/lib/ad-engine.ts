/**
 * 上广告引擎标识（D-233：kyads 上广告能力并入 CRM）
 *
 * CRM 里同时存在两套广告生成 + 发布链路，员工在「我的商家」页顶部卡片选一次，
 * 选中的值存 ad_default_settings.ad_engine，之后所有「领取商家 / 新增广告」都走它。
 *
 * - evidence  ：CRM 原生 IntelliCenter 8 步闭环。爬商家自己的落地页，用页面证据约束
 *               AI 生成文案，带政策预检、相似度返工、合规 linter。
 * - rivalIntel：kyads 移植过来的竞品情报链路。读品牌评估里同域名同国家的竞品在投
 *               广告创意 + DataForSEO 品牌词排名，照着对手在跑的打法生成。
 */
export const AD_ENGINES = ["evidence", "rival_intel"] as const;

export type AdEngine = (typeof AD_ENGINES)[number];

export const DEFAULT_AD_ENGINE: AdEngine = "evidence";

export const AD_ENGINE_META: Record<AdEngine, { label: string; hint: string }> = {
  evidence: {
    label: "落地页证据引擎",
    hint: "爬商家自己的落地页，按页面证据生成文案，含政策预检与合规过滤",
  },
  rival_intel: {
    label: "竞品情报引擎",
    hint: "读同域名同国家的竞品在投创意 + 品牌词排名，照对手打法生成",
  },
};

export function parseAdEngine(raw: unknown): AdEngine {
  return AD_ENGINES.includes(raw as AdEngine) ? (raw as AdEngine) : DEFAULT_AD_ENGINE;
}
