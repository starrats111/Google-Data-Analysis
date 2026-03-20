-- AlterTable
ALTER TABLE `ad_creatives` MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `ad_default_settings` MODIFY `ecpc_enabled` TINYINT NOT NULL DEFAULT 1,
    MODIFY `network_search` TINYINT NOT NULL DEFAULT 1,
    MODIFY `network_partners` TINYINT NOT NULL DEFAULT 0,
    MODIFY `network_display` TINYINT NOT NULL DEFAULT 0,
    MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `ad_groups` MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `ads_daily_stats` MODIFY `cost` DECIMAL(12, 2) NULL DEFAULT 0.00,
    MODIFY `clicks` INTEGER UNSIGNED NULL DEFAULT 0,
    MODIFY `impressions` INTEGER UNSIGNED NULL DEFAULT 0,
    MODIFY `conversions` INTEGER UNSIGNED NULL DEFAULT 0,
    MODIFY `commission` DECIMAL(12, 2) NULL DEFAULT 0.00,
    MODIFY `original_currency` VARCHAR(8) NULL DEFAULT 'USD',
    MODIFY `exchange_rate` DECIMAL(10, 6) NULL DEFAULT 1.000000,
    MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `ai_insights` MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `ai_model_configs` MODIFY `max_tokens` INTEGER UNSIGNED NULL DEFAULT 4096,
    MODIFY `temperature` DECIMAL(3, 2) NULL DEFAULT 0.70,
    MODIFY `is_active` TINYINT NOT NULL DEFAULT 1,
    MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `ai_providers` MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `articles` MODIFY `published_at` DATETIME(0) NULL,
    MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `campaigns` MODIFY `network_search` TINYINT NOT NULL DEFAULT 1,
    MODIFY `network_partners` TINYINT NOT NULL DEFAULT 0,
    MODIFY `network_display` TINYINT NOT NULL DEFAULT 0,
    MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `crawl_tasks` MODIFY `image_count` INTEGER UNSIGNED NULL DEFAULT 0,
    MODIFY `valid_link_count` INTEGER UNSIGNED NULL DEFAULT 0,
    MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `exchange_rates` MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `google_mcc_accounts` MODIFY `is_active` TINYINT NOT NULL DEFAULT 1,
    MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `holiday_calendar` MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `keywords` MODIFY `is_negative` TINYINT NOT NULL DEFAULT 0,
    MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `platform_connections` MODIFY `last_synced_at` DATETIME(0) NULL,
    MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `prompt_preferences` MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `publish_sites` MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `system_configs` MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `user_merchants` MODIFY `claimed_at` DATETIME(0) NULL,
    MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- AlterTable
ALTER TABLE `users` MODIFY `is_deleted` TINYINT NOT NULL DEFAULT 0,
    MODIFY `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    MODIFY `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0);

-- RenameIndex (skipped: init_crm_mvp_tables already uses correct names)
-- ALTER TABLE `ad_creatives` RENAME INDEX `idx_creative_adgroup` TO `idx_ad_group`;

-- RenameIndex
-- ALTER TABLE `ad_default_settings` RENAME INDEX `ad_default_settings_user_id_key` TO `uk_user`;

-- RenameIndex
-- ALTER TABLE `ad_groups` RENAME INDEX `idx_adgroup_campaign` TO `idx_campaign`;

-- RenameIndex
-- ALTER TABLE `ads_daily_stats` RENAME INDEX `idx_stat_merchant_date` TO `idx_merchant_date`;

-- RenameIndex
-- ALTER TABLE `ads_daily_stats` RENAME INDEX `idx_stat_user_date` TO `idx_user_date`;

-- RenameIndex
-- ALTER TABLE `ai_insights` RENAME INDEX `idx_insight_merchant_date` TO `idx_merchant_date`;

-- RenameIndex
-- ALTER TABLE `ai_insights` RENAME INDEX `idx_insight_user_date` TO `idx_user_date`;

-- RenameIndex
-- ALTER TABLE `articles` RENAME INDEX `idx_article_merchant` TO `idx_user_merchant`;

-- RenameIndex
-- ALTER TABLE `articles` RENAME INDEX `idx_article_status` TO `idx_status`;

-- RenameIndex
-- ALTER TABLE `articles` RENAME INDEX `idx_article_user` TO `idx_user`;

-- RenameIndex
-- ALTER TABLE `campaigns` RENAME INDEX `idx_campaign_merchant` TO `idx_user_merchant`;

-- RenameIndex
-- ALTER TABLE `campaigns` RENAME INDEX `idx_campaign_user` TO `idx_user`;

-- RenameIndex
-- ALTER TABLE `crawl_tasks` RENAME INDEX `idx_crawl_merchant` TO `idx_user_merchant`;

-- RenameIndex
-- ALTER TABLE `google_mcc_accounts` RENAME INDEX `idx_mcc_user` TO `idx_user`;

-- RenameIndex
-- ALTER TABLE `keywords` RENAME INDEX `idx_keyword_adgroup` TO `idx_ad_group`;

-- RenameIndex
-- ALTER TABLE `publish_sites` RENAME INDEX `idx_site_user` TO `idx_user`;

-- RenameIndex
-- ALTER TABLE `system_configs` RENAME INDEX `system_configs_config_key_key` TO `uk_config_key`;

-- RenameIndex
-- ALTER TABLE `user_merchants` RENAME INDEX `idx_user_platform_merchant` TO `idx_user_platform`;

-- RenameIndex
-- ALTER TABLE `users` RENAME INDEX `users_username_key` TO `uk_username`;
