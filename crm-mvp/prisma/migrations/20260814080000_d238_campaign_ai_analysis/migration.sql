-- D-238 kyads「广告分析」整套并入 CRM 数据中心。
--
-- 1) ads_daily_stats 补四个分析指标列：
--    quality_score / is_budget / is_rank 由新 cron ads-metrics-sync 走 Google Ads API 直拉
--    （campaign 级 IS 按 segments.date 逐日取值，keyword_view 级当前 QS 按当日点击加权）；
--    max_cpc 为最高出价快照（ad_group cpc_bid 最大值）。IS 两列存 API 原始 0-1 分数，展示时 ×100。
--    走 API 直拉而非改各 MCC 的统一 Ads Script（07 拍板：服务端一处改完全员生效）。
--
-- 2) 新表 ai_recommendations：AI 分析结果缓存（kyads 同名表移植，team 维度改 user 维度）。
--    唯一键 (campaign_id, scope_key)：scope_key = 区间+策略+模式指纹，重分析 upsert 覆盖。
--    action_items 存结构化建议 JSON，「一键调整」按它下发 mutate；reason_detail 存完整报告。

-- 3) ai_providers 加 protocol 列：anthropic 协议提供商（aicodewith 的 claude 通道）走 /v1/messages。
--    必须按提供商显式标记：CRM 现网 hajimi 用 OpenAI 协议跑 claude-sonnet 系模型，
--    若照 kyads 按模型名前缀路由会切坏所有既有场景。

ALTER TABLE `ai_providers`
  ADD COLUMN `protocol` VARCHAR(16) NOT NULL DEFAULT 'openai' AFTER `api_base_url`;

ALTER TABLE `ads_daily_stats`
  ADD COLUMN `quality_score` DECIMAL(3, 1) NULL AFTER `data_source`,
  ADD COLUMN `is_budget` DECIMAL(7, 4) NULL AFTER `quality_score`,
  ADD COLUMN `is_rank` DECIMAL(7, 4) NULL AFTER `is_budget`,
  ADD COLUMN `max_cpc` DECIMAL(16, 6) NULL AFTER `is_rank`;

CREATE TABLE `ai_recommendations` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `campaign_id` BIGINT UNSIGNED NOT NULL,
  `google_campaign_id` VARCHAR(64) NULL,
  `campaign_name` VARCHAR(255) NOT NULL,
  `scope_key` VARCHAR(160) NOT NULL,
  `date_range_start` DATE NOT NULL,
  `date_range_end` DATE NOT NULL,
  `impressions` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `clicks` INT UNSIGNED NOT NULL DEFAULT 0,
  `spend` DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
  `orders` INT UNSIGNED NOT NULL DEFAULT 0,
  `commission` DECIMAL(18, 2) NOT NULL DEFAULT 0.00,
  `roi` DECIMAL(18, 4) NOT NULL DEFAULT 0.0000,
  `recommendation_type` VARCHAR(50) NOT NULL DEFAULT 'campaign_ad_analysis',
  `strategy` VARCHAR(16) NOT NULL DEFAULT 'balanced',
  `reason_summary` VARCHAR(500) NOT NULL DEFAULT '',
  `reason_detail` LONGTEXT NULL,
  `action_items` JSON NULL,
  `engine_type` VARCHAR(30) NOT NULL DEFAULT 'rule_plus_ai',
  `status` VARCHAR(20) NOT NULL DEFAULT 'active',
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_campaign_scope` (`campaign_id`, `scope_key`),
  INDEX `idx_user_updated` (`user_id`, `updated_at`),
  INDEX `idx_gcid` (`google_campaign_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
