/*
  Warnings:

  - You are about to drop the column `site_url` on the `publish_sites` table. All the data in the column will be lost.
  - Added the required column `domain` to the `publish_sites` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `ad_creatives` ADD COLUMN `logo_url` VARCHAR(1024) NULL,
    ADD COLUMN `selling_points` JSON NULL;

-- AlterTable
ALTER TABLE `ads_daily_stats` ADD COLUMN `budget` DECIMAL(12, 2) NULL,
    ADD COLUMN `data_source` VARCHAR(8) NULL DEFAULT 'sheet';

-- AlterTable
ALTER TABLE `articles` ADD COLUMN `images` JSON NULL;

-- AlterTable
ALTER TABLE `campaigns` ADD COLUMN `google_status` VARCHAR(16) NOT NULL DEFAULT 'ENABLED',
    ADD COLUMN `last_google_sync_at` DATETIME(0) NULL;

-- AlterTable
ALTER TABLE `google_mcc_accounts` ADD COLUMN `developer_token` VARCHAR(128) NULL,
    ADD COLUMN `sheet_url` VARCHAR(1024) NULL;

-- AlterTable
ALTER TABLE `publish_sites` DROP COLUMN `site_url`,
    ADD COLUMN `article_html_pattern` VARCHAR(100) NULL,
    ADD COLUMN `article_var_name` VARCHAR(100) NULL,
    ADD COLUMN `data_js_path` VARCHAR(200) NULL DEFAULT 'js/articles-index.js',
    ADD COLUMN `domain` VARCHAR(200) NOT NULL,
    ADD COLUMN `site_path` VARCHAR(300) NULL,
    ADD COLUMN `site_type` VARCHAR(30) NULL,
    ADD COLUMN `verified` TINYINT NOT NULL DEFAULT 0,
    MODIFY `deploy_type` VARCHAR(32) NOT NULL DEFAULT 'bt_ssh';

-- CreateTable
CREATE TABLE `notifications` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `type` VARCHAR(32) NOT NULL DEFAULT 'system',
    `title` VARCHAR(255) NOT NULL,
    `content` TEXT NULL,
    `is_read` TINYINT NOT NULL DEFAULT 0,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user_read`(`user_id`, `is_read`, `is_deleted`),
    INDEX `idx_user_created`(`user_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_preferences` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `notify_system` TINYINT NOT NULL DEFAULT 1,
    `notify_merchant` TINYINT NOT NULL DEFAULT 1,
    `notify_article` TINYINT NOT NULL DEFAULT 1,
    `notify_ad` TINYINT NOT NULL DEFAULT 1,
    `notify_alert` TINYINT NOT NULL DEFAULT 1,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_user`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `prompt_preferences` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `ad_writing_style` VARCHAR(32) NOT NULL DEFAULT 'professional',
    `ad_emphasis_tags` JSON NULL,
    `ad_extra_prompt` TEXT NULL,
    `article_type` VARCHAR(32) NOT NULL DEFAULT 'review',
    `article_length` VARCHAR(16) NOT NULL DEFAULT 'medium',
    `article_seo_focus` JSON NULL,
    `article_extra_prompt` TEXT NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_user_prompt`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_insights` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `insight_date` DATE NOT NULL,
    `insight_type` VARCHAR(16) NOT NULL DEFAULT 'daily',
    `content` LONGTEXT NOT NULL,
    `metrics_snapshot` JSON NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user_insight_date`(`user_id`, `insight_date`),
    UNIQUE INDEX `uk_user_date_type`(`user_id`, `insight_date`, `insight_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `operation_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `username` VARCHAR(64) NOT NULL,
    `action` VARCHAR(64) NOT NULL,
    `target_type` VARCHAR(32) NULL,
    `target_id` VARCHAR(64) NULL,
    `detail` TEXT NULL,
    `ip_address` VARCHAR(45) NULL,
    `user_agent` VARCHAR(512) NULL,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user_created`(`user_id`, `created_at`),
    INDEX `idx_action`(`action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mcc_cid_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `mcc_account_id` BIGINT UNSIGNED NOT NULL,
    `customer_id` VARCHAR(32) NOT NULL,
    `customer_name` VARCHAR(255) NULL,
    `is_available` VARCHAR(1) NOT NULL DEFAULT 'Y',
    `status` VARCHAR(16) NOT NULL DEFAULT 'active',
    `last_synced_at` DATETIME(0) NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_mcc_available`(`mcc_account_id`, `is_available`),
    UNIQUE INDEX `uk_mcc_cid`(`mcc_account_id`, `customer_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
