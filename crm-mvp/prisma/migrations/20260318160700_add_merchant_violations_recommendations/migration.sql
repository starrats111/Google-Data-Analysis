-- AlterTable
ALTER TABLE `user_merchants` ADD COLUMN `recommendation_status` VARCHAR(20) NOT NULL DEFAULT 'normal',
    ADD COLUMN `recommendation_time` DATETIME(0) NULL,
    ADD COLUMN `violation_status` VARCHAR(20) NOT NULL DEFAULT 'normal',
    ADD COLUMN `violation_time` DATETIME(0) NULL;

-- CreateTable
CREATE TABLE `merchant_violations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `merchant_name` VARCHAR(255) NOT NULL,
    `platform` VARCHAR(32) NOT NULL DEFAULT '',
    `merchant_domain` VARCHAR(255) NULL,
    `violation_reason` TEXT NULL,
    `violation_time` DATETIME(0) NULL,
    `source` VARCHAR(100) NULL,
    `upload_batch` VARCHAR(64) NOT NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_vio_name`(`merchant_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `merchant_recommendations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `merchant_name` VARCHAR(255) NOT NULL,
    `roi_reference` VARCHAR(64) NULL,
    `commission_info` VARCHAR(64) NULL,
    `settlement_info` VARCHAR(64) NULL,
    `remark` TEXT NULL,
    `share_time` VARCHAR(32) NULL,
    `upload_batch` VARCHAR(64) NOT NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_rec_name`(`merchant_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sheet_configs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `config_type` VARCHAR(32) NOT NULL,
    `sheet_url` TEXT NOT NULL,
    `last_synced_at` DATETIME(0) NULL,
    `updated_by` BIGINT UNSIGNED NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `sheet_configs_config_type_key`(`config_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
