-- CreateTable
CREATE TABLE `mcc_cost_adjustments` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `mcc_account_id` BIGINT UNSIGNED NOT NULL,
    `month` VARCHAR(7) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0.00,
    `remark` VARCHAR(200) NULL,
    `is_deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `uk_user_mcc_month`(`user_id`, `mcc_account_id`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
