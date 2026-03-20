-- AlterTable
ALTER TABLE `ads_daily_stats` ADD COLUMN `orders` INTEGER UNSIGNED NULL DEFAULT 0;

-- DropTable
DROP TABLE `prompt_preferences`;

-- CreateTable
CREATE TABLE `affiliate_transactions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `user_merchant_id` BIGINT UNSIGNED NOT NULL,
    `campaign_id` BIGINT UNSIGNED NULL,
    `platform` VARCHAR(8) NOT NULL,
    `merchant_id` VARCHAR(64) NOT NULL,
    `merchant_name` VARCHAR(255) NOT NULL,
    `transaction_id` VARCHAR(128) NOT NULL,
    `transaction_time` DATETIME(0) NOT NULL,
    `order_amount` DECIMAL(12, 2) NULL DEFAULT 0.00,
    `commission_amount` DECIMAL(12, 2) NULL DEFAULT 0.00,
    `currency` VARCHAR(8) NOT NULL DEFAULT 'USD',
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `raw_status` VARCHAR(32) NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `idx_user_merchant_id`(`user_id`, `merchant_id`),
    INDEX `idx_user_txn_time`(`user_id`, `transaction_time`),
    INDEX `idx_user_status`(`user_id`, `status`),
    UNIQUE INDEX `uk_platform_txn`(`platform`, `transaction_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
