-- 需求2：订单/点击比控制刷点击
-- 1) 用户级开关（默认开：新列 DEFAULT 1，存量行在 ADD COLUMN 时也会取到默认值 1）
ALTER TABLE `users`
  ADD COLUMN `click_control_enabled` TINYINT NOT NULL DEFAULT 1 AFTER `link_exchange_disabled`;

-- 2) 联盟「点击日聚合」表（fetchAllClicks 写入；供 C / avg7 基线）
CREATE TABLE `affiliate_click_daily` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `platform` VARCHAR(8) NOT NULL,
  `merchant_id` VARCHAR(64) NOT NULL,
  `platform_connection_id` BIGINT UNSIGNED NULL,
  `click_date` DATE NOT NULL,
  `clicks` INT UNSIGNED NOT NULL DEFAULT 0,
  `is_deleted` TINYINT NOT NULL DEFAULT 0,
  `created_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
  `updated_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0) ON UPDATE CURRENT_TIMESTAMP(0),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_user_plat_merchant_date` (`user_id`, `platform`, `merchant_id`, `click_date`),
  INDEX `idx_click_user_date` (`user_id`, `click_date`),
  INDEX `idx_click_user_merchant_date` (`user_id`, `merchant_id`, `click_date`)
) ENGINE = InnoDB DEFAULT CHARACTER SET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
