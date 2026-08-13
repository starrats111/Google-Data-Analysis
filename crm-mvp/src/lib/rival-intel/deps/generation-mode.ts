/**
 * D-233：kyads 侧原本从 `lib/settings/ai-model-config` 取这个联合类型，
 * 那个模块整体是 kyads 自己的模型配置面板（CRM 已有 ai_model_configs 管理台，不移植），
 * 所以只把类型摘出来单独放这里。
 *
 * - filter      ：只从竞品在投创意里挑现成文案，不让 AI 自由发挥
 * - ai_generate ：把竞品创意当样本，让 AI 照着打法重写
 */
export type AdGenerationMode = "filter" | "ai_generate";
