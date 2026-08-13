-- D-233：竞品情报引擎（从 kyads 移植的第二套上广告链路）建表
--   隔离维度 team_id → user_id；品牌评估结果与品牌词缓存按 (域名, 国家) 全公司共享。
--   批量上广告（batch job / batch item）不移植。
--   kyads 的 ad_creation_publish_jobs 不建：本引擎发布复用 CRM 的 submit 流水线，
--   发布任务行落在 ad_submit_jobs，六段命名与序号池两个引擎共用一套。

-- CreateTable
CREATE TABLE `ad_creation_drafts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `user_merchant_id` BIGINT UNSIGNED NULL,
    `campaign_id` BIGINT UNSIGNED NULL,
    `domain` VARCHAR(255) NOT NULL,
    `country_code` VARCHAR(10) NOT NULL,
    `language_code` VARCHAR(10) NULL,
    `landing_page_url` VARCHAR(1024) NULL,
    `core_brand_keywords` JSON NULL,
    `headlines` JSON NULL,
    `descriptions` JSON NULL,
    `sitelinks` JSON NULL,
    `negative_keywords` JSON NULL,
    `preview_payload` JSON NULL,
    `gap_report` JSON NULL,
    `source_payload` JSON NULL,
    `sitelink_source_payload` JSON NULL,
    `raw_payload_excerpt` TEXT NULL,
    `generation_mode` VARCHAR(32) NOT NULL DEFAULT 'ai_generate',
    `status` VARCHAR(30) NOT NULL DEFAULT 'draft_generating',
    `current_stage` VARCHAR(50) NULL,
    `completed_stages` JSON NULL,
    `failed_stage` VARCHAR(50) NULL,
    `error_code` VARCHAR(50) NULL,
    `error_message` VARCHAR(1000) NULL,
    `retryable` TINYINT NOT NULL DEFAULT 0,
    `stage_running` TINYINT NOT NULL DEFAULT 0,
    `stage_claimed_at` DATETIME(0) NULL,
    `default_campaign_name` VARCHAR(128) NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_acd_user_status`(`user_id`, `status`),
    INDEX `idx_acd_user_created`(`user_id`, `created_at`),
    INDEX `idx_acd_merchant`(`user_merchant_id`),
    INDEX `idx_acd_domain_country`(`domain`, `country_code`, `status`),
    INDEX `idx_acd_runner_pick`(`status`, `stage_running`, `stage_claimed_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `brand_assessment_jobs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `domain` VARCHAR(255) NOT NULL,
    `countries` JSON NOT NULL,
    `force_refresh` TINYINT NOT NULL DEFAULT 0,
    `estimated_cost_usd` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `actual_cost_usd` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `error_message` VARCHAR(500) NULL,
    `started_at` DATETIME(0) NULL,
    `finished_at` DATETIME(0) NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_baj_status_created`(`status`, `created_at`),
    INDEX `idx_baj_user_created`(`user_id`, `created_at`),
    INDEX `idx_baj_domain`(`domain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `brand_assessment_results` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `job_id` BIGINT UNSIGNED NOT NULL,
    `first_requested_by_user_id` BIGINT UNSIGNED NULL,
    `domain` VARCHAR(255) NOT NULL,
    `country` VARCHAR(8) NOT NULL,
    `brand_token` VARCHAR(120) NULL,
    `country_snapshot` JSON NULL,
    `brand_level` JSON NULL,
    `brand_own_ads` JSON NULL,
    `non_brand_ads` JSON NULL,
    `trends` JSON NULL,
    `transparency` JSON NULL,
    `autocomplete_variants` JSON NULL,
    `engine_status` JSON NOT NULL,
    `llm_output` JSON NULL,
    `warnings` JSON NULL,
    `source` VARCHAR(20) NOT NULL DEFAULT 'fresh',
    `serpapi_cost_usd` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `llm_cost_usd` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `ttl_expires_at` DATETIME(0) NOT NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_bar_domain_country`(`domain`, `country`),
    INDEX `idx_bar_job`(`job_id`),
    INDEX `idx_bar_ttl`(`ttl_expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `brand_intel_cost_ledger` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `ledger_date` DATE NOT NULL,
    `provider` VARCHAR(20) NOT NULL DEFAULT 'all',
    `total_cost_usd` DECIMAL(12, 4) NOT NULL DEFAULT 0,
    `call_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_bicl_date_provider`(`ledger_date`, `provider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dataforseo_brand_keyword_cache` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `domain` VARCHAR(255) NOT NULL,
    `country` VARCHAR(8) NOT NULL,
    `prompt_hash` VARCHAR(64) NOT NULL,
    `top_keywords` JSON NOT NULL,
    `ai_extraction` JSON NULL,
    `cost_usd` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `fetched_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `expires_at` DATETIME(0) NOT NULL,

    UNIQUE INDEX `uk_dfsbkc_domain_country_prompt`(`domain`, `country`, `prompt_hash`),
    INDEX `idx_dfsbkc_expires`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
