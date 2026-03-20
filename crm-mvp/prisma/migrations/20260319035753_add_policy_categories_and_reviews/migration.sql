-- AlterTable
ALTER TABLE `user_merchants` ADD COLUMN `policy_category_code` VARCHAR(32) NULL,
    ADD COLUMN `policy_status` VARCHAR(16) NOT NULL DEFAULT 'pending';

-- CreateTable
CREATE TABLE `ad_policy_categories` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `category_code` VARCHAR(32) NOT NULL,
    `category_name` VARCHAR(64) NOT NULL,
    `category_name_en` VARCHAR(64) NOT NULL,
    `restriction_level` VARCHAR(16) NOT NULL,
    `description` TEXT NULL,
    `allowed_regions` JSON NULL,
    `blocked_regions` JSON NULL,
    `age_targeting` VARCHAR(16) NULL,
    `requires_cert` TINYINT NOT NULL DEFAULT 0,
    `ad_copy_rules` JSON NULL,
    `landing_page_rules` JSON NULL,
    `match_keywords` JSON NULL,
    `match_domains` JSON NULL,
    `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_category_code`(`category_code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `merchant_policy_reviews` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `merchant_name` VARCHAR(255) NOT NULL,
    `merchant_domain` VARCHAR(255) NULL,
    `platform` VARCHAR(8) NULL,
    `policy_category_id` BIGINT UNSIGNED NULL,
    `policy_status` VARCHAR(16) NOT NULL DEFAULT 'clean',
    `matched_rule` VARCHAR(128) NULL,
    `review_method` VARCHAR(16) NOT NULL DEFAULT 'auto',
    `reviewed_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `notes` TEXT NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_policy_status`(`policy_status`),
    UNIQUE INDEX `uk_merchant_platform`(`merchant_name`, `platform`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
