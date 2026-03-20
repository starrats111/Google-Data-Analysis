-- CreateTable
CREATE TABLE `users` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `username` VARCHAR(64) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `role` VARCHAR(16) NOT NULL DEFAULT 'user',
    `status` VARCHAR(16) NOT NULL DEFAULT 'active',
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_username`(`username`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_providers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `provider_name` VARCHAR(32) NOT NULL,
    `api_key` TEXT NOT NULL,
    `api_base_url` VARCHAR(512) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'active',
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_model_configs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `scene` VARCHAR(32) NOT NULL,
    `provider_id` BIGINT UNSIGNED NOT NULL,
    `model_name` VARCHAR(64) NOT NULL,
    `max_tokens` INTEGER UNSIGNED NULL DEFAULT 4096,
    `temperature` DECIMAL(3, 2) NULL DEFAULT 0.70,
    `is_active` TINYINT NOT NULL DEFAULT 1,
    `priority` TINYINT UNSIGNED NOT NULL DEFAULT 1,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_scene_active`(`scene`, `is_active`, `priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_configs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `config_key` VARCHAR(128) NOT NULL,
    `config_value` TEXT NULL,
    `description` VARCHAR(255) NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_config_key`(`config_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_connections` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `platform` VARCHAR(8) NOT NULL,
    `api_key` TEXT NULL,
    `api_secret` TEXT NULL,
    `publisher_id` VARCHAR(64) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'connected',
    `last_synced_at` DATETIME(0) NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user_platform`(`user_id`, `platform`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_merchants` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `platform` VARCHAR(8) NOT NULL,
    `merchant_id` VARCHAR(64) NOT NULL,
    `merchant_name` VARCHAR(255) NOT NULL,
    `merchant_url` VARCHAR(512) NULL,
    `category` VARCHAR(128) NULL,
    `commission_rate` VARCHAR(64) NULL,
    `cookie_duration` INTEGER UNSIGNED NULL,
    `supported_regions` JSON NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'available',
    `claimed_at` DATETIME(0) NULL,
    `target_country` VARCHAR(8) NULL,
    `holiday_name` VARCHAR(128) NULL,
    `tracking_link` VARCHAR(1024) NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user_status`(`user_id`, `status`),
    INDEX `idx_user_platform`(`user_id`, `platform`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ad_default_settings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `bidding_strategy` VARCHAR(32) NOT NULL DEFAULT 'MAXIMIZE_CLICKS',
    `ecpc_enabled` TINYINT NOT NULL DEFAULT 1,
    `max_cpc` DECIMAL(10, 2) NOT NULL DEFAULT 0.30,
    `daily_budget` DECIMAL(10, 2) NOT NULL DEFAULT 2.00,
    `network_search` TINYINT NOT NULL DEFAULT 1,
    `network_partners` TINYINT NOT NULL DEFAULT 0,
    `network_display` TINYINT NOT NULL DEFAULT 0,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_user`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `holiday_calendar` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `country_code` VARCHAR(8) NOT NULL,
    `holiday_name` VARCHAR(128) NOT NULL,
    `holiday_date` DATE NOT NULL,
    `holiday_type` VARCHAR(16) NOT NULL DEFAULT 'commercial',
    `related_holidays` JSON NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_country_date`(`country_code`, `holiday_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campaigns` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `user_merchant_id` BIGINT UNSIGNED NOT NULL,
    `google_campaign_id` VARCHAR(64) NULL,
    `mcc_id` BIGINT UNSIGNED NULL,
    `customer_id` VARCHAR(32) NULL,
    `campaign_name` VARCHAR(255) NULL,
    `daily_budget` DECIMAL(10, 2) NOT NULL DEFAULT 2.00,
    `bidding_strategy` VARCHAR(32) NOT NULL DEFAULT 'MAXIMIZE_CLICKS',
    `max_cpc_limit` DECIMAL(10, 2) NULL,
    `target_country` VARCHAR(8) NOT NULL,
    `geo_target` VARCHAR(16) NULL,
    `language_id` VARCHAR(16) NULL,
    `network_search` TINYINT NOT NULL DEFAULT 1,
    `network_partners` TINYINT NOT NULL DEFAULT 0,
    `network_display` TINYINT NOT NULL DEFAULT 0,
    `status` VARCHAR(16) NOT NULL DEFAULT 'active',
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user`(`user_id`),
    INDEX `idx_user_merchant`(`user_merchant_id`),
    INDEX `idx_google_campaign`(`google_campaign_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ad_groups` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `campaign_id` BIGINT UNSIGNED NOT NULL,
    `google_ad_group_id` VARCHAR(64) NULL,
    `ad_group_name` VARCHAR(255) NULL,
    `keyword_match_type` VARCHAR(16) NOT NULL DEFAULT 'PHRASE',
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_campaign`(`campaign_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `keywords` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `ad_group_id` BIGINT UNSIGNED NOT NULL,
    `keyword_text` VARCHAR(255) NOT NULL,
    `match_type` VARCHAR(16) NOT NULL DEFAULT 'PHRASE',
    `is_negative` TINYINT NOT NULL DEFAULT 0,
    `avg_monthly_searches` INTEGER UNSIGNED NULL,
    `competition` VARCHAR(16) NULL,
    `suggested_bid` DECIMAL(10, 2) NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_ad_group`(`ad_group_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ad_creatives` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `ad_group_id` BIGINT UNSIGNED NOT NULL,
    `final_url` VARCHAR(1024) NOT NULL,
    `display_path1` VARCHAR(15) NULL,
    `display_path2` VARCHAR(15) NULL,
    `headlines` JSON NOT NULL,
    `descriptions` JSON NOT NULL,
    `sitelinks` JSON NULL,
    `callouts` JSON NULL,
    `image_urls` JSON NULL,
    `logo_url` VARCHAR(1024) NULL,
    `selling_points` JSON NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_ad_group`(`ad_group_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `crawl_tasks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_merchant_id` BIGINT UNSIGNED NOT NULL,
    `image_count` INTEGER UNSIGNED NULL DEFAULT 0,
    `valid_link_count` INTEGER UNSIGNED NULL DEFAULT 0,
    `crawl_status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `warnings` JSON NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user_merchant`(`user_merchant_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `publish_sites` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `site_name` VARCHAR(128) NOT NULL,
    `site_url` VARCHAR(512) NOT NULL,
    `deploy_type` VARCHAR(32) NOT NULL DEFAULT 'cloudflare_pages',
    `deploy_config` JSON NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'active',
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `articles` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `user_merchant_id` BIGINT UNSIGNED NOT NULL,
    `campaign_id` BIGINT UNSIGNED NULL,
    `publish_site_id` BIGINT UNSIGNED NULL,
    `title` VARCHAR(512) NULL,
    `slug` VARCHAR(512) NULL,
    `content` LONGTEXT NULL,
    `language` VARCHAR(8) NOT NULL DEFAULT 'en',
    `keywords` JSON NULL,
    `images` JSON NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'generating',
    `published_at` DATETIME(0) NULL,
    `published_url` VARCHAR(1024) NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user`(`user_id`),
    INDEX `idx_user_merchant`(`user_merchant_id`),
    INDEX `idx_status`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ads_daily_stats` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `user_merchant_id` BIGINT UNSIGNED NOT NULL,
    `campaign_id` BIGINT UNSIGNED NOT NULL,
    `date` DATE NOT NULL,
    `budget` DECIMAL(12, 2) NULL,
    `cost` DECIMAL(12, 2) NULL DEFAULT 0.00,
    `clicks` INTEGER UNSIGNED NULL DEFAULT 0,
    `impressions` INTEGER UNSIGNED NULL DEFAULT 0,
    `cpc` DECIMAL(10, 4) NULL,
    `conversions` INTEGER UNSIGNED NULL DEFAULT 0,
    `commission` DECIMAL(12, 2) NULL DEFAULT 0.00,
    `roas` DECIMAL(10, 4) NULL,
    `roi` DECIMAL(10, 4) NULL,
    `original_currency` VARCHAR(8) NULL DEFAULT 'USD',
    `exchange_rate` DECIMAL(10, 6) NULL DEFAULT 1.000000,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user_date`(`user_id`, `date`),
    INDEX `idx_merchant_date`(`user_merchant_id`, `date`),
    UNIQUE INDEX `uk_campaign_date`(`campaign_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_insights` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `user_merchant_id` BIGINT UNSIGNED NOT NULL,
    `report_date` DATE NOT NULL,
    `insight_type` VARCHAR(32) NOT NULL DEFAULT 'daily_summary',
    `content` TEXT NULL,
    `data_snapshot` JSON NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user_date`(`user_id`, `report_date`),
    INDEX `idx_merchant_date`(`user_merchant_id`, `report_date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `google_mcc_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `mcc_id` VARCHAR(32) NOT NULL,
    `mcc_name` VARCHAR(128) NULL,
    `currency` VARCHAR(8) NOT NULL DEFAULT 'USD',
    `service_account_json` TEXT NULL,
    `is_active` TINYINT NOT NULL DEFAULT 1,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `prompt_preferences` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `type` VARCHAR(16) NOT NULL,
    `style` VARCHAR(32) NULL DEFAULT 'professional',
    `emphasis_tags` JSON NULL,
    `article_type` VARCHAR(32) NULL,
    `article_length` VARCHAR(16) NULL DEFAULT 'medium',
    `seo_focus` JSON NULL,
    `tone_level` TINYINT UNSIGNED NULL DEFAULT 3,
    `custom_note` TEXT NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_user_type`(`user_id`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exchange_rates` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `from_currency` VARCHAR(8) NOT NULL,
    `to_currency` VARCHAR(8) NOT NULL,
    `rate` DECIMAL(12, 6) NOT NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_currency_pair`(`from_currency`, `to_currency`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
